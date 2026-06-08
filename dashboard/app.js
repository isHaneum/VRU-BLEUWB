/* PBV Near-Miss Safety HMI Dashboard
 * Unified BLE + UWB live fusion + replay engine + rule-based risk classifier.
 * Pure browser JS, no build step. Open via http:// for Web Serial support.
 */
(function () {
  "use strict";

  // =========================================================================
  // 1. CONSTANTS
  // =========================================================================
  var BLE_STALE_MS = 2000;          // no packet for > 2s -> BLE_NONE
  var BLE_RATE_WINDOW_MS = 3000;    // packets-per-3s for stable check
  var BLE_RATE_MIN_STABLE = 5;
  var BLE_RSSI_NEAR_THRESH = -75;   // dBm
  var BLE_RSSI_WEAK_THRESH = -90;

  var UWB_GOOD_OK_RATIO = 0.8;
  var UWB_UNSTABLE_OK_RATIO = 0.4;
  var UWB_STALE_MS = 1500;          // ms after last OK before STALE
  var UWB_LOST_MS = 3000;           // ms after last OK before LOST
  var UWB_FILTER_ALPHA = 0.4;       // EMA filter coefficient
  var UWB_WINDOW = 10;              // sliding window for quality

  // Diagnostic thresholds for the Live Sensors panel.
  var UWB_NODEB_HEARTBEAT_STALE_MS = 3000;  // > 3s without READY -> heartbeat lost
  var UWB_TIMEOUT_BURST_ALERT      = 10;    // consecutive timeouts -> show responder-down alert

  var RISK_MESSAGES = {
    NONE: {
      msg: "No immediate worker risk detected.",
      action: "Proceed normally.",
    },
    CAUTION: {
      msg: "Worker signal detected near the vehicle. Maintain low speed.",
      action: "Lower speed and stay alert.",
    },
    WARNING: {
      msg: "Worker approaching near the vehicle path. Slow down.",
      action: "Reduce speed immediately.",
    },
    CRITICAL: {
      msg: "High collision risk. Stop immediately.",
      action: "BRAKE NOW.",
    },
    UNCERTAIN: {
      msg: "Worker signal detected, precise range unavailable. Maintain low speed and check blind areas.",
      action: "Proceed with caution. Visual check required.",
    },
  };

  var MANEUVER_ICONS = { NONE: "\u2192", CAUTION: "!", WARNING: "\u25B2", CRITICAL: "\u25A0", UNCERTAIN: "?" };
  var MANEUVER_ACTIONS = { NONE: "PROCEED", CAUTION: "SLOW", WARNING: "SLOW DOWN", CRITICAL: "STOP", UNCERTAIN: "VERIFY" };

  // =========================================================================
  // 2. LIVE BLE STATE
  // =========================================================================
  var LiveBle = {
    port: null, reader: null, connected: false,
    lastSeenMs: 0,
    workerId: null,
    rssi: null,
    rssiHistory: [],          // [{ts, rssi}] last 60s
    rssiHistoryMax: 240,
    packetCount: 0,
    recentTimestamps: [],     // performance.now() of recent packets
    status: "BLE_NONE",
    filterName: "",           // optional: only accept packets matching this name
    filterMac: "",            // optional: only accept packets matching this MAC
  };

  function bleClassify() {
    var now = performance.now();
    if (!LiveBle.lastSeenMs || (now - LiveBle.lastSeenMs) > BLE_STALE_MS) {
      LiveBle.status = "BLE_NONE";
      return;
    }
    // count packets in last BLE_RATE_WINDOW_MS
    var winStart = now - BLE_RATE_WINDOW_MS;
    LiveBle.recentTimestamps = LiveBle.recentTimestamps.filter(function (t) { return t >= winStart; });
    var rateOK = LiveBle.recentTimestamps.length >= BLE_RATE_MIN_STABLE;
    // average RSSI in last window
    var recentRssi = LiveBle.rssiHistory.filter(function (r) { return r.ts >= winStart; });
    var avg = recentRssi.length
      ? recentRssi.reduce(function (s, r) { return s + r.rssi; }, 0) / recentRssi.length
      : (LiveBle.rssi != null ? LiveBle.rssi : -120);

    if (!rateOK) {
      LiveBle.status = (avg < BLE_RSSI_WEAK_THRESH) ? "BLE_WEAK" : "BLE_WEAK";
      return;
    }
    if (avg >= BLE_RSSI_NEAR_THRESH) {
      LiveBle.status = "BLE_NEAR";
    } else {
      LiveBle.status = "BLE_STABLE";
    }
  }

  function bleAvgRssi() {
    var now = performance.now();
    var winStart = now - BLE_RATE_WINDOW_MS;
    var recent = LiveBle.rssiHistory.filter(function (r) { return r.ts >= winStart; });
    if (!recent.length) return LiveBle.rssi;
    return recent.reduce(function (s, r) { return s + r.rssi; }, 0) / recent.length;
  }

  function bleSecondsSince() {
    if (!LiveBle.lastSeenMs) return null;
    return (performance.now() - LiveBle.lastSeenMs) / 1000;
  }

  // =========================================================================
  // 3. LIVE UWB STATE
  // =========================================================================
  var LiveUwb = {
    portA: null, readerA: null, connectedA: false,
    portB: null, readerB: null, connectedB: false,
    rawRangeM: null,
    lastValidRangeM: null,
    lastOkMs: null,
    filteredRangeM: null,
    status: null,                 // last raw firmware status
    history: [],                  // [{ts, range, status, node}]
    historyMax: 200,
    quality: "LOST",              // GOOD | UNSTABLE | LOST | STALE
    countOK: 0,
    countErr: 0,
    minRange: Infinity,
    maxRange: -Infinity,
    sumRange: 0,
  };

  function uwbReclassifyQuality() {
    var now = performance.now();
    var lastOk = LiveUwb.lastOkMs;

    if (!lastOk || (now - lastOk) > UWB_LOST_MS) {
      LiveUwb.quality = "LOST";
      return;
    }
    if ((now - lastOk) > UWB_STALE_MS) {
      LiveUwb.quality = "STALE";
      return;
    }
    // Look at last UWB_WINDOW samples
    var recent = LiveUwb.history.slice(-UWB_WINDOW);
    if (recent.length < 3) {
      LiveUwb.quality = "GOOD";
      return;
    }
    var okCount = recent.filter(function (s) { return s.status === "OK"; }).length;
    var ratio = okCount / recent.length;
    if (ratio >= UWB_GOOD_OK_RATIO) LiveUwb.quality = "GOOD";
    else if (ratio >= UWB_UNSTABLE_OK_RATIO) LiveUwb.quality = "UNSTABLE";
    else LiveUwb.quality = "LOST";
  }

  function uwbSecondsSinceOk() {
    if (!LiveUwb.lastOkMs) return null;
    return (performance.now() - LiveUwb.lastOkMs) / 1000;
  }

  // =========================================================================
  // 3b. UWB DIAGNOSTIC STATE (raw firmware events)
  // =========================================================================
  // Per-event firmware counters for the DWM3000 v1.4 diagnostic upgrade.
  // Names match the on-air event vocabulary exactly so the dashboard table
  // and the firmware emit identical labels.
  function makeCounters(initial) {
    var out = {};
    for (var i = 0; i < initial.length; i++) out[initial[i]] = 0;
    return out;
  }
  // firmwareMode values: "UNKNOWN" | "NEW_DWM3000_V14" | "LEGACY_COMPACT_CSV" | "NO_DATA"
  var LiveDiag = {
    nodeA: {
      boot: false, configLine: "",
      identity: { hardware: null, firmware: null, build: null },
      firmwareMode: "UNKNOWN",   // set by parser
      connectedSinceMs: null,    // performance.now() at port open
      lastLineKind: null,        // most recent parsed line kind for UI
      role: null,
      reinitCount: 0,
      consecutiveTimeout: 0,
      lastOkMs: null, lastTimeoutMs: null, lastSampleMs: null,
      lastTxPollMs: null, lastRangeOkMs: null,
      // new-vocabulary counters (NEW_DWM3000_V14 only)
      counters: makeCounters([
        "TX_POLL", "RX_RESP_OK", "RX_RESP_TIMEOUT", "RX_RESP_ERR",
        "TX_FINAL", "RX_RTINFO_OK", "RX_RTINFO_TIMEOUT",
        "RANGE_OK", "RX_RESTART", "DW_REINIT",
      ]),
      // legacy-vocabulary counters (also incremented for combined display)
      legacyCounters: makeCounters(["RANGE_OK", "RX_RESP_TIMEOUT", "RX_RESP_ERR"]),
    },
    nodeB: {
      boot: false, configLine: "",
      identity: { hardware: null, firmware: null, build: null },
      firmwareMode: "UNKNOWN",
      connectedSinceMs: null,
      lastLineKind: null,
      role: null,
      reinitCount: 0,
      heartbeatSeen: false,
      lastReadyMs: null,
      lastPollMs: null,
      lastTxDoneMs: null,
      lastTxLateMs: null,
      lastEventMs: null,
      counters: makeCounters([
        "READY", "RX_POLL",
        "TX_RESP_SCHEDULED", "TX_RESP_DONE", "TX_RESP_LATE",
        "RX_FINAL_OK", "RX_FINAL_TIMEOUT",
        "TX_RTINFO_DONE", "RX_ERR", "RX_RESTART", "DW_REINIT",
      ]),
      legacyCounters: makeCounters([]),
    },
    // Event timeline for status chart and rate calc.
    // Each item: { ts: performance.now(), node: 'A'|'B', type: 'OK'|'TIMEOUT'|'ERR'|'RESTART'|'REINIT', label: string }
    events: [],
    eventsMax: 600,
    // Per-event time-stamped list for windowed diagnosis rules.
    eventLog: [],         // { ts, node:'A'|'B', event: string }
    eventLogMax: 800,
  };

  function pushEventLog(node, event) {
    LiveDiag.eventLog.push({ ts: performance.now(), node: node, event: event });
    if (LiveDiag.eventLog.length > LiveDiag.eventLogMax) LiveDiag.eventLog.shift();
  }

  function eventCountInWindow(node, event, ms) {
    var cutoff = performance.now() - ms;
    var n = 0;
    for (var i = LiveDiag.eventLog.length - 1; i >= 0; i--) {
      var e = LiveDiag.eventLog[i];
      if (e.ts < cutoff) break;
      if (e.node === node && e.event === event) n++;
    }
    return n;
  }

  function pushDiagEvent(node, type, label) {
    LiveDiag.events.push({ ts: performance.now(), node: node, type: type, label: label || type });
    if (LiveDiag.events.length > LiveDiag.eventsMax) LiveDiag.events.shift();
  }

  function diagCountInWindow(type, ms) {
    var cutoff = performance.now() - ms;
    var n = 0;
    for (var i = LiveDiag.events.length - 1; i >= 0; i--) {
      var e = LiveDiag.events[i];
      if (e.ts < cutoff) break;
      if (e.type === type) n++;
    }
    return n;
  }

  function diagSecondsSince(ms) {
    if (!ms) return null;
    return (performance.now() - ms) / 1000;
  }

  // Compose the link state for the diagnostic panel.
  //  NO_DATA   - never received any UWB line
  //  OK        - last OK < UWB_STALE_MS ago AND consecutive_timeout == 0
  //  TIMEOUT   - currently in a timeout burst (consecutive_timeout > 0, recent)
  //  STALE     - last OK between STALE..LOST
  //  LOST      - last OK > LOST or never
  function uwbLinkState() {
    if (!LiveDiag.nodeA.lastSampleMs) return "NO_DATA";
    var sinceOk = LiveDiag.nodeA.lastOkMs ? (performance.now() - LiveDiag.nodeA.lastOkMs) : Infinity;
    var sinceTo = LiveDiag.nodeA.lastTimeoutMs ? (performance.now() - LiveDiag.nodeA.lastTimeoutMs) : Infinity;
    if (LiveDiag.nodeA.consecutiveTimeout > 0 && sinceTo < 2000) return "TIMEOUT";
    if (sinceOk < UWB_STALE_MS) return "OK";
    if (sinceOk < UWB_LOST_MS)  return "STALE";
    return "LOST";
  }

  function nodeBHeartbeatAlive() {
    if (!LiveDiag.nodeB.lastReadyMs) return false;
    return (performance.now() - LiveDiag.nodeB.lastReadyMs) <= UWB_NODEB_HEARTBEAT_STALE_MS;
  }

  // =========================================================================
  // 4. VEHICLE / REPLAY STATE
  // =========================================================================
  var State = {
    rows: [],
    idx: 0,
    playing: false,
    speed: 1,
    lastTickMs: 0,
    accSimSeconds: 0,
    mode: "driver",                      // ui tab: driver | debug | fleet | live-uwb
    dataSource: "auto",                  // auto | live | replay
    history: [],                         // recent fused samples
    historyMax: 240,
    riskRunStart: null,
    nearMisses: [],
    nearMissSeq: 1,
    responseStats: { total: 0, responded: 0 },
    zoneStats: {},                       // zone -> { total, crit, warn, unc, timeout, bleFallback }
    vehicleStats: {},                    // vehicle -> { total, crit }
    activeWorker: null,
    activeRunMinDist: Infinity,
    activeRunMaxSpeed: 0,
    activeRunBraked: false,
    // Live vehicle (used when no replay row): driver can be stationary observer
    liveVehicle: { vehicle_id: "PBV_01", speed_kmh: 0, brake_pressed: false, zone: "Live" },
    // Fusion metrics
    bleAliveUwbLostStart: null,          // performance.now() when entered UWB_LOST_BLE_ALIVE
    bleFallbackEvents: 0,
    bleFallbackTotalMs: 0,
    dropoutZoneCounts: {},               // zone -> count
  };

  // =========================================================================
  // 5. CSV PARSING (replay)
  // =========================================================================
  function parseCsv(text) {
    var lines = text.replace(/\r/g, "").split("\n").filter(function (l) { return l.trim().length > 0; });
    var header = lines.shift().split(",").map(function (s) { return s.trim(); });
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var cols = lines[i].split(",");
      var row = {};
      for (var j = 0; j < header.length; j++) row[header[j]] = cols[j] !== undefined ? cols[j].trim() : "";
      out.push({
        t: parseFloat(row.timestamp),
        vehicle_id: row.vehicle_id || "PBV_01",
        speed_kmh: parseFloat(row.speed_kmh) || 0,
        brake_pressed: /^(true|1|yes)$/i.test(row.brake_pressed),
        worker_id: row.worker_id || null,
        object_type: row.object_type || null,
        distance_m: row.distance_m === "" ? null : parseFloat(row.distance_m),
        uwb_status: row.uwb_status || (row.distance_m === "" ? null : "OK"),
        ble_detected: /^(true|1|yes)$/i.test(row.ble_detected),
        confidence: parseFloat(row.confidence) || 0,
        zone: row.zone || "Unknown",
        ble_rssi: row.ble_rssi === "" ? null : parseFloat(row.ble_rssi),
        condition: row.condition || "",
      });
    }
    return out;
  }

  // =========================================================================
  // 6. FUSION + RISK
  // =========================================================================

  // Build a single canonical sample from the active data source.
  // ALL renderers and risk engine must call this.
  function getCurrentFusedSample() {
    var liveActive = isLiveActive();

    if (liveActive) {
      return buildLiveFusedSample();
    }
    // Replay fallback: take latest history entry and re-fuse it
    var rep = State.history.length ? State.history[State.history.length - 1] : null;
    if (!rep) return null;
    return rep; // already fused at insertion time
  }

  function isLiveActive() {
    // Live mode is implicit when any live serial source is connected
    if (State.dataSource === "replay") return false;
    if (State.dataSource === "live") return true;
    return LiveBle.connected || LiveUwb.connectedA || LiveUwb.connectedB;
  }

  function buildLiveFusedSample() {
    // Re-classify volatile state on every read
    bleClassify();
    uwbReclassifyQuality();

    var bleDetected = LiveBle.status !== "BLE_NONE";
    var bleRssi = LiveBle.rssi;
    var bleStatus = LiveBle.status;

    var quality = LiveUwb.quality;
    var rawStatus = LiveUwb.status;

    // Fusion state matrix
    var fusion = "CLEAR";
    if (bleDetected && quality === "GOOD") fusion = "UWB_TRACKED";
    else if (bleDetected && quality === "UNSTABLE") fusion = "UWB_UNSTABLE";
    else if (bleDetected && (quality === "LOST" || quality === "STALE")) fusion = "UWB_LOST_BLE_ALIVE";
    else if (bleDetected) fusion = "BLE_CANDIDATE";
    else if (quality === "GOOD" || quality === "UNSTABLE") fusion = "UWB_TRACKED";  // UWB only, rare
    else fusion = "CLEAR";

    // Distance selection
    var distance_m = null;
    var is_stale = false;
    if (quality === "GOOD" && LiveUwb.filteredRangeM != null) {
      distance_m = LiveUwb.filteredRangeM;
    } else if (quality === "UNSTABLE" && LiveUwb.filteredRangeM != null) {
      distance_m = LiveUwb.filteredRangeM;
    } else if (LiveUwb.lastValidRangeM != null) {
      is_stale = true;
    }

    // Confidence
    var confidence = 0;
    if (fusion === "UWB_TRACKED") confidence = bleStatus === "BLE_NEAR" ? 0.95 : 0.85;
    else if (fusion === "UWB_UNSTABLE") confidence = 0.5;
    else if (fusion === "UWB_LOST_BLE_ALIVE") confidence = 0.35;
    else if (fusion === "BLE_CANDIDATE") confidence = bleStatus === "BLE_NEAR" ? 0.45 : 0.2;

    var v = State.liveVehicle;
    var sample = {
      t: performance.now() / 1000,
      vehicle_id: v.vehicle_id,
      speed_kmh: v.speed_kmh,
      brake_pressed: v.brake_pressed,
      worker_id: LiveBle.workerId,
      zone: v.zone,
      condition: "live",
      // BLE
      ble_detected: bleDetected,
      ble_rssi: bleRssi,
      ble_status: bleStatus,
      // UWB
      raw_uwb_status: rawStatus,
      uwb_quality: quality,
      distance_m: distance_m,
      filtered_range_m: LiveUwb.filteredRangeM,
      last_valid_range_m: LiveUwb.lastValidRangeM,
      raw_range_m: LiveUwb.rawRangeM,
      is_range_stale: is_stale,
      // Fusion
      fusion_state: fusion,
      confidence: confidence,
    };
    sample.risk = classifyRisk(sample);
    return sample;
  }

  // Build a fused sample from a replay row.
  function buildReplayFusedSample(row) {
    var bleDetected = row.ble_detected;
    var distance = row.distance_m;
    var rawStatus = row.uwb_status || (distance != null ? "OK" : null);

    var quality = "LOST";
    if (rawStatus === "OK") quality = "GOOD";
    else if (rawStatus === "TIMEOUT" || rawStatus === "RX_RESP_TIMEOUT") quality = "LOST";

    var fusion = "CLEAR";
    if (bleDetected && quality === "GOOD") fusion = "UWB_TRACKED";
    else if (bleDetected && quality === "LOST") fusion = "UWB_LOST_BLE_ALIVE";
    else if (bleDetected) fusion = "BLE_CANDIDATE";
    else if (quality === "GOOD") fusion = "UWB_TRACKED";

    var sample = {
      t: row.t,
      vehicle_id: row.vehicle_id,
      speed_kmh: row.speed_kmh,
      brake_pressed: row.brake_pressed,
      worker_id: row.worker_id,
      zone: row.zone,
      condition: row.condition,
      ble_detected: bleDetected,
      ble_rssi: row.ble_rssi,
      ble_status: bleDetected ? (row.ble_rssi != null && row.ble_rssi > BLE_RSSI_NEAR_THRESH ? "BLE_NEAR" : "BLE_STABLE") : "BLE_NONE",
      raw_uwb_status: rawStatus,
      uwb_quality: quality,
      distance_m: quality === "GOOD" ? distance : null,
      filtered_range_m: quality === "GOOD" ? distance : null,
      last_valid_range_m: distance,
      raw_range_m: distance,
      is_range_stale: false,
      fusion_state: fusion,
      confidence: row.confidence,
    };
    sample.risk = classifyRisk(sample);
    return sample;
  }

  // RISK ENGINE — single function, takes a fused sample.
  // CRITICAL only triggers from fresh, valid filtered UWB range.
  function classifyRisk(s) {
    var fs = s.fusion_state;

    if (fs === "CLEAR") return "NONE";

    if (fs === "UWB_TRACKED") {
      var d = s.filtered_range_m;
      if (d == null) return "CAUTION";
      var moving = (s.speed_kmh || 0) > 1.0;
      if (d <= 5 && moving && !s.brake_pressed) return "CRITICAL";
      if (d <= 5) return "WARNING";
      if (d <= 8) return "WARNING";
      if (d <= 15) return "CAUTION";
      return "NONE";
    }

    if (fs === "UWB_UNSTABLE") {
      // Show CAUTION with low confidence — never CRITICAL
      var df = s.filtered_range_m;
      if (df != null && df <= 5) return "WARNING";
      return "CAUTION";
    }

    if (fs === "UWB_LOST_BLE_ALIVE") {
      // Blind-zone — never CRITICAL even if last valid was close
      return "UNCERTAIN";
    }

    if (fs === "BLE_CANDIDATE") {
      return s.ble_status === "BLE_NEAR" ? "CAUTION" : "CAUTION";
    }

    return "NONE";
  }

  function rankRisk(r) {
    return { NONE: 0, CAUTION: 1, UNCERTAIN: 2, WARNING: 3, CRITICAL: 4 }[r] || 0;
  }

  // =========================================================================
  // 7. SERIAL — Generic helpers (BLE + UWB share these)
  // =========================================================================
  function genericOpenPort() {
    if (!("serial" in navigator)) {
      alert("Web Serial API not supported.\nUse Chrome or Edge, and open via http:// (not file://).");
      return Promise.reject(new Error("Web Serial unavailable"));
    }
    return navigator.serial.requestPort().then(function (port) {
      return port.open({ baudRate: 115200 }).then(function () { return port; });
    });
  }

  function pumpReader(reader, onLine, onClose) {
    var dec = new TextDecoder();
    var buf = "";
    function step() {
      reader.read().then(function (res) {
        if (res.done) { onClose && onClose(); return; }
        buf += dec.decode(res.value, { stream: true });
        var nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          var line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line) onLine(line);
        }
        step();
      }).catch(function (e) {
        if (onClose) onClose(e);
      });
    }
    step();
  }

  // =========================================================================
  // 8. UWB SERIAL
  // Unified parser: recognizes the range CSV, the diagnostic event lines
  // (READY, RX_POLL, TX_DONE, RX_RESTART, DW_REINIT, ...) and the BOOT/CONFIG
  // banners emitted by the new initiator/responder firmware.
  // Returns null for header lines, comments and unrecognized text.
  // Returned shape always includes a 'kind' discriminator.
  // =========================================================================
  function parseUWBLine(line) {
    if (!line) return null;
    if (/^\[/.test(line)) return null;                          // legacy decorative text
    if (/^[#]/.test(line)) return null;
    if (/^timestamp_ms,node_id,seq_id,range_m,status/i.test(line)) return null;

    var p = line.split(",").map(function (s) { return s.trim(); });

    // BOOT / IDENTITY / CONFIG / FATAL banners may omit the timestamp prefix per spec.
    if (p.length >= 3 && /^node_/i.test(p[0]) && (p[1] === "BOOT" || p[1] === "IDENTITY")) {
      // Extract optional identity k=v's: hardware, firmware, build
      var bootMeta = {};
      for (var bi = 3; bi < p.length; bi++) {
        var bkv = p[bi].split("=");
        if (bkv.length >= 2) bootMeta[bkv[0]] = bkv.slice(1).join("=");
      }
      return { kind: "boot", node_id: p[0], role: p[2], meta: bootMeta, isIdentity: p[1] === "IDENTITY" };
    }
    if (p.length >= 3 && /^node_/i.test(p[0]) && p[1] === "CONFIG") {
      return { kind: "config", node_id: p[0], config: p.slice(2).join(",") };
    }
    if (p.length >= 3 && /^node_/i.test(p[0]) && p[1] === "FATAL") {
      return { kind: "fatal", node_id: p[0], detail: p.slice(2).join(",") };
    }

    // All other lines must start with a numeric timestamp.
    var ts = parseInt(p[0], 10);
    if (isNaN(ts) || String(ts) !== p[0]) return null;

    // Range / status CSV: ts,node,seq,range_or_empty,STATUS[,extras]
    if (p.length >= 5 && /^\d+$/.test(p[2])) {
      var rangeStr = p[3];
      var status   = p[4];
      var extras   = p.slice(5);
      var consecutiveTimeout = null;
      var reinitCount = null;
      var reinitReason = null;
      for (var i = 0; i < extras.length; i++) {
        var kv = extras[i].split("=");
        if (kv.length === 2) {
          if      (kv[0] === "consecutive_timeout") consecutiveTimeout = parseInt(kv[1], 10);
          else if (kv[0] === "count")                reinitCount       = parseInt(kv[1], 10);
          else if (kv[0] === "reason")               reinitReason      = kv[1];
        }
      }
      return {
        kind: "sample",
        ts_ms: ts,
        node_id: p[1],
        seq_id: p[2],
        range_m: rangeStr === "" ? null : parseFloat(rangeStr),
        status: status,
        consecutive_timeout: consecutiveTimeout,
        reinit_count: reinitCount,
        reinit_reason: reinitReason,
      };
    }

    // Event line: ts,node,EVENT[,k=v[,k=v...]]
    if (p.length >= 3 && /^node_/i.test(p[1])) {
      var ev = { kind: "event", ts_ms: ts, node_id: p[1], event: p[2], meta: {} };
      var ex = p.slice(3);
      for (var j = 0; j < ex.length; j++) {
        var kv2 = ex[j].split("=");
        if (kv2.length === 2) {
          var k = kv2[0], v = kv2[1];
          ev.meta[k] = v;
          if      (k === "reason")              ev.reason = v;
          else if (k === "count")               ev.count = parseInt(v, 10);
          else if (k === "seq")                 ev.seq = parseInt(v, 10);
          else if (k === "consecutive_timeout") ev.consecutive_timeout = parseInt(v, 10);
          else if (k === "range_m")             ev.range_m = parseFloat(v);
          else if (k === "elapsed_ms")          ev.elapsed_ms = parseInt(v, 10);
        }
      }
      return ev;
    }

    return null;
  }

  function nodeKeyOf(node_id, slotHint) {
    if (node_id === "node_A") return "nodeA";
    if (node_id === "node_B") return "nodeB";
    return slotHint === "A" ? "nodeA" : "nodeB";
  }

  function handleUwbBoot(parsed) {
    var key = nodeKeyOf(parsed.node_id);
    LiveDiag[key].boot = true;
    LiveDiag[key].role = parsed.role || null;
    LiveDiag[key].lastLineKind = "BOOT";
    if (parsed.meta) {
      LiveDiag[key].identity.hardware = parsed.meta.hardware || null;
      LiveDiag[key].identity.firmware = parsed.meta.firmware || null;
      LiveDiag[key].identity.build    = parsed.meta.build    || null;
      if (parsed.meta.hardware && parsed.meta.hardware.indexOf("DWM3000") !== -1) {
        LiveDiag[key].firmwareMode = "NEW_DWM3000_V14";
      }
    }
    if (!parsed.isIdentity) {
      pushDiagEvent(key === "nodeA" ? "A" : "B", "RESTART", "BOOT");
    }
  }
  function handleUwbConfig(parsed) {
    var key = nodeKeyOf(parsed.node_id);
    LiveDiag[key].configLine = parsed.config;
  }
  function handleUwbFatal(parsed) {
    liveLog("[" + parsed.node_id + "] FATAL: " + parsed.detail, "err");
  }

  // Per-firmware event vocabulary. Distinct from range CSV ingestion.
  // The DWM3000 v1.4 firmware emits a richer vocabulary so the dashboard
  // can correlate "node_A missed Response" with "node_B never RX'd Poll" vs
  // "node_B RX'd Poll but TX_RESP failed" vs "node_B TX'd OK but node_A missed".
  function handleUwbEvent(parsed) {
    var now = performance.now();
    var key = nodeKeyOf(parsed.node_id);
    var slot = key === "nodeA" ? "A" : "B";
    LiveDiag[key].lastEventMs = now;
    LiveDiag[key].lastLineKind = parsed.event;

    // Any event from the new firmware vocabulary confirms it.
    if (LiveDiag[key].firmwareMode !== "NEW_DWM3000_V14") {
      LiveDiag[key].firmwareMode = "NEW_DWM3000_V14";
    }

    // Generic counter bump (only for known events; unknown ones are ignored).
    if (LiveDiag[key].counters &&
        Object.prototype.hasOwnProperty.call(LiveDiag[key].counters, parsed.event)) {
      LiveDiag[key].counters[parsed.event]++;
      pushEventLog(slot, parsed.event);
    }

    switch (parsed.event) {
      case "READY":
        LiveDiag[key].heartbeatSeen = true;
        if (key === "nodeB") LiveDiag.nodeB.lastReadyMs = now;
        break;
      case "RX_ARMED":
        break;

      // ----- node_A initiator vocabulary -----
      case "TX_POLL":
        if (key === "nodeA") LiveDiag.nodeA.lastTxPollMs = now;
        break;
      case "RX_RESP_OK":
      case "TX_FINAL":
      case "RX_RTINFO_OK":
        break;
      case "RX_RESP_TIMEOUT":
      case "RX_RTINFO_TIMEOUT":
        if (key === "nodeA") {
          LiveDiag.nodeA.lastTimeoutMs = now;
          if (typeof parsed.consecutive_timeout === "number") {
            LiveDiag.nodeA.consecutiveTimeout = parsed.consecutive_timeout;
          }
        }
        break;
      case "RX_RESP_ERR":
        // counted; nothing else
        break;
      case "RANGE_OK":
        if (key === "nodeA") {
          LiveDiag.nodeA.lastOkMs = now;
          LiveDiag.nodeA.lastRangeOkMs = now;
          LiveDiag.nodeA.consecutiveTimeout = 0;
        }
        break;

      // ----- node_B responder vocabulary -----
      case "RX_POLL":
        if (key === "nodeB") LiveDiag.nodeB.lastPollMs = now;
        break;
      case "TX_RESP_SCHEDULED":
        break;
      case "TX_RESP_DONE":
        if (key === "nodeB") LiveDiag.nodeB.lastTxDoneMs = now;
        break;
      case "TX_RESP_LATE":
        if (key === "nodeB") LiveDiag.nodeB.lastTxLateMs = now;
        break;
      case "RX_FINAL_OK":
      case "RX_FINAL_TIMEOUT":
      case "TX_RTINFO_DONE":
        break;

      // ----- shared -----
      case "RX_ERR":
      case "RX_TIMEOUT":               // legacy responder name; still counted
        pushDiagEvent(slot, "ERR", parsed.event);
        break;
      case "TX_DONE":                  // legacy responder name -> map to RESP_DONE
        if (key === "nodeB") LiveDiag.nodeB.lastTxDoneMs = now;
        break;
      case "RX_RESTART":
      case "RX_WATCHDOG_RESTART":
        pushDiagEvent(slot, "RESTART", parsed.event);
        break;
      case "DW_REINIT":
        if (typeof parsed.count === "number") LiveDiag[key].reinitCount = parsed.count;
        else LiveDiag[key].reinitCount++;
        pushDiagEvent(slot, "REINIT", "DW_REINIT" + (parsed.reason ? ":" + parsed.reason : ""));
        break;
      default:
        break;
    }
  }

  function ingestUwbSample(s, node) {
    var now = performance.now();
    LiveUwb.status = s.status;
    LiveUwb.rawRangeM = s.range_m;

    // history — only count node_A as primary feed
    var primary = (node === "A");
    if (primary) {
      LiveUwb.history.push({ ts: now, range: s.range_m, status: s.status, node: node });
      if (LiveUwb.history.length > LiveUwb.historyMax) LiveUwb.history.shift();
      LiveDiag.nodeA.lastSampleMs = now;
      LiveDiag.nodeA.lastLineKind = "SAMPLE";
      // Mark as legacy compact CSV if we have NOT yet seen a DWM3000 v1.4 BOOT/IDENTITY
      if (LiveDiag.nodeA.firmwareMode !== "NEW_DWM3000_V14") {
        LiveDiag.nodeA.firmwareMode = "LEGACY_COMPACT_CSV";
      }
    }

    if (s.status === "OK" && s.range_m != null) {
      LiveUwb.countOK++;
      LiveUwb.sumRange += s.range_m;
      if (s.range_m < LiveUwb.minRange) LiveUwb.minRange = s.range_m;
      if (s.range_m > LiveUwb.maxRange) LiveUwb.maxRange = s.range_m;
      LiveUwb.lastValidRangeM = s.range_m;
      LiveUwb.lastOkMs = now;
      // EMA filter
      if (LiveUwb.filteredRangeM == null) LiveUwb.filteredRangeM = s.range_m;
      else LiveUwb.filteredRangeM = UWB_FILTER_ALPHA * s.range_m + (1 - UWB_FILTER_ALPHA) * LiveUwb.filteredRangeM;

      if (primary) {
        LiveDiag.nodeA.lastOkMs = now;
        LiveDiag.nodeA.consecutiveTimeout = 0;
        LiveDiag.nodeA.legacyCounters.RANGE_OK++;
        pushEventLog("A", "RANGE_OK");
        pushDiagEvent("A", "OK", "OK");
      }
    } else {
      LiveUwb.countErr++;
      if (primary) {
        if (s.status === "RX_RESP_TIMEOUT") {
          LiveDiag.nodeA.lastTimeoutMs = now;
          LiveDiag.nodeA.legacyCounters.RX_RESP_TIMEOUT++;
          pushEventLog("A", "RX_RESP_TIMEOUT");
          if (typeof s.consecutive_timeout === "number") {
            LiveDiag.nodeA.consecutiveTimeout = s.consecutive_timeout;
          } else {
            LiveDiag.nodeA.consecutiveTimeout++;
          }
          pushDiagEvent("A", "TIMEOUT", "RX_RESP_TIMEOUT");
        } else if (s.status === "RX_RESP_ERR") {
          LiveDiag.nodeA.legacyCounters.RX_RESP_ERR++;
          pushEventLog("A", "RX_RESP_ERR");
          pushDiagEvent("A", "ERR", "RX_RESP_ERR");
        } else if (s.status === "RX_RESTART") {
          pushDiagEvent("A", "RESTART", "RX_RESTART");
        } else if (s.status === "DW_REINIT") {
          if (typeof s.reinit_count === "number") LiveDiag.nodeA.reinitCount = s.reinit_count;
          else LiveDiag.nodeA.reinitCount++;
          pushDiagEvent("A", "REINIT", "DW_REINIT" + (s.reinit_reason ? ":" + s.reinit_reason : ""));
        } else {
          pushDiagEvent("A", "ERR", s.status);
        }
      }
    }
    uwbReclassifyQuality();
  }

  function connectUwb(slot) {
    return genericOpenPort().then(function (port) {
      var reader = port.readable.getReader();
      var connNow = performance.now();
      if (slot === "A") {
        LiveUwb.portA = port; LiveUwb.readerA = reader; LiveUwb.connectedA = true;
        LiveDiag.nodeA.connectedSinceMs = connNow;
        LiveDiag.nodeA.firmwareMode = "UNKNOWN";
      } else {
        LiveUwb.portB = port; LiveUwb.readerB = reader; LiveUwb.connectedB = true;
        LiveDiag.nodeB.connectedSinceMs = connNow;
        LiveDiag.nodeB.firmwareMode = "UNKNOWN";
      }
      setSerialUI("uwb-" + slot.toLowerCase(), true);
      liveLog("[UWB " + slot + "] connected at 115200", "ok");
      pumpReader(reader, function (line) {
        var parsed = parseUWBLine(line);
        if (!parsed) { liveLog(line, "dim"); return; }
        switch (parsed.kind) {
          case "sample":
            liveLog(line, parsed.status === "OK" ? "ok" : "dim");
            ingestUwbSample(parsed, slot);
            break;
          case "event":
            liveLog(line, "dim");
            handleUwbEvent(parsed);
            break;
          case "boot":
            liveLog(line, "ok");
            handleUwbBoot(parsed);
            break;
          case "config":
            liveLog(line, "dim");
            handleUwbConfig(parsed);
            break;
          case "fatal":
            liveLog(line, "err");
            handleUwbFatal(parsed);
            break;
          default:
            liveLog(line, "dim");
        }
        updateLivePanelUwb();
      }, function (err) {
        disconnectUwb(slot, true);
        if (err && err.name !== "AbortError") liveLog("[UWB " + slot + "] read error: " + err.message, "err");
      });
    }).catch(function (e) {
      if (e.name !== "NotFoundError") liveLog("[UWB " + slot + "] connect error: " + e.message, "err");
    });
  }

  function disconnectUwb(slot, fromError) {
    var reader = slot === "A" ? LiveUwb.readerA : LiveUwb.readerB;
    if (reader && !fromError) reader.cancel().catch(function () {});
    if (slot === "A") {
      LiveUwb.readerA = null; LiveUwb.portA = null; LiveUwb.connectedA = false;
      LiveDiag.nodeA.connectedSinceMs = null;
    } else {
      LiveUwb.readerB = null; LiveUwb.portB = null; LiveUwb.connectedB = false;
      LiveDiag.nodeB.connectedSinceMs = null;
    }
    setSerialUI("uwb-" + slot.toLowerCase(), false);
  }

  // =========================================================================
  // 9. BLE SERIAL
  // Expected CSV line: timestamp_ms,node_id,seq_id,device_name,mac,rssi,manufacturer_data_hex
  // =========================================================================
  function parseBLELine(line) {
    if (!line || /^[#]/.test(line) || /^timestamp/.test(line)) return null;
    var p = line.split(",");
    if (p.length < 6) return null;
    var ts = parseInt(p[0], 10);
    if (isNaN(ts)) return null;
    var rssi = parseFloat(p[5]);
    if (isNaN(rssi)) return null;
    return {
      ts_ms: ts,
      node_id: (p[1] || "").trim(),
      seq_id: (p[2] || "").trim(),
      device_name: (p[3] || "").trim(),
      mac: (p[4] || "").trim(),
      rssi: rssi,
      mfr_hex: (p[6] || "").trim(),
    };
  }

  function ingestBleSample(s) {
    // Optional filter
    if (LiveBle.filterName && s.device_name && s.device_name.toLowerCase().indexOf(LiveBle.filterName.toLowerCase()) === -1) return;
    if (LiveBle.filterMac && s.mac && s.mac.toLowerCase() !== LiveBle.filterMac.toLowerCase()) return;

    var now = performance.now();
    LiveBle.lastSeenMs = now;
    LiveBle.rssi = s.rssi;
    // Worker id preference: explicit device_name > MAC > UNKNOWN
    if (s.device_name && s.device_name !== "UNKNOWN") LiveBle.workerId = s.device_name;
    else if (s.mac) LiveBle.workerId = s.mac;
    LiveBle.packetCount++;
    LiveBle.recentTimestamps.push(now);
    LiveBle.rssiHistory.push({ ts: now, rssi: s.rssi });
    while (LiveBle.rssiHistory.length > LiveBle.rssiHistoryMax) LiveBle.rssiHistory.shift();
    bleClassify();
  }

  function connectBle() {
    return genericOpenPort().then(function (port) {
      var reader = port.readable.getReader();
      LiveBle.port = port; LiveBle.reader = reader; LiveBle.connected = true;
      setSerialUI("ble", true);
      liveLog("[BLE] connected at 115200", "ok");
      pumpReader(reader, function (line) {
        var parsed = parseBLELine(line);
        if (parsed) {
          liveLog(line, "ble");
          ingestBleSample(parsed);
        } else {
          liveLog(line, "dim");
        }
      }, function (err) {
        disconnectBle(true);
        if (err && err.name !== "AbortError") liveLog("[BLE] read error: " + err.message, "err");
      });
    }).catch(function (e) {
      if (e.name !== "NotFoundError") liveLog("[BLE] connect error: " + e.message, "err");
    });
  }

  function disconnectBle(fromError) {
    if (LiveBle.reader && !fromError) LiveBle.reader.cancel().catch(function () {});
    LiveBle.reader = null; LiveBle.port = null; LiveBle.connected = false;
    setSerialUI("ble", false);
  }

  function setSerialUI(slotKey, connected) {
    var statusEl = document.getElementById("status-" + slotKey);
    var btnConn  = document.getElementById("btn-connect-" + slotKey);
    var btnDisc  = document.getElementById("btn-disconnect-" + slotKey);
    if (statusEl) {
      statusEl.textContent = connected ? "\u25CF Connected" : "\u25CF Disconnected";
      statusEl.className   = "serial-status" + (connected ? " connected" : "");
    }
    if (btnConn) btnConn.disabled = connected;
    if (btnDisc) btnDisc.disabled = !connected;
  }

  // =========================================================================
  // 10. LIVE LOG
  // =========================================================================
  function liveLog(msg, cls) {
    var el = document.getElementById("live-log");
    if (!el) return;
    var div = document.createElement("div");
    div.className = "ln" + (cls ? " " + cls : "");
    div.textContent = msg;
    el.insertBefore(div, el.firstChild);
    while (el.children.length > 400) el.removeChild(el.lastChild);
  }

  // =========================================================================
  // 11. NEAR-MISS TRACKING (driven by fusion state)
  // =========================================================================
  function trackNearMiss(s) {
    if (!s) return;
    var risk = s.risk;
    var isRisky = risk === "WARNING" || risk === "CRITICAL" || risk === "UNCERTAIN";

    // BLE fallback tracking
    if (s.fusion_state === "UWB_LOST_BLE_ALIVE") {
      if (State.bleAliveUwbLostStart == null) {
        State.bleAliveUwbLostStart = performance.now();
        State.bleFallbackEvents++;
        State.dropoutZoneCounts[s.zone] = (State.dropoutZoneCounts[s.zone] || 0) + 1;
      }
    } else if (State.bleAliveUwbLostStart != null) {
      State.bleFallbackTotalMs += performance.now() - State.bleAliveUwbLostStart;
      State.bleAliveUwbLostStart = null;
    }

    if (isRisky) {
      if (!State.riskRunStart) {
        State.riskRunStart = { level: risk, t: s.t };
        State.activeRunMinDist = Infinity;
        State.activeRunMaxSpeed = 0;
        State.activeRunBraked = false;
      } else if (rankRisk(risk) > rankRisk(State.riskRunStart.level)) {
        State.riskRunStart.level = risk;
      }
      if (s.distance_m != null) State.activeRunMinDist = Math.min(State.activeRunMinDist, s.distance_m);
      State.activeRunMaxSpeed = Math.max(State.activeRunMaxSpeed, s.speed_kmh || 0);
      if (s.brake_pressed) State.activeRunBraked = true;
      State.activeWorker = s.worker_id || State.activeWorker;
    } else if (State.riskRunStart) {
      finalizeNearMiss(s.t, s.zone, s.fusion_state);
    }
  }

  function finalizeNearMiss(endT, zone, fusionState) {
    var start = State.riskRunStart;
    State.riskRunStart = null;
    var duration = endT - start.t;
    if (duration < 1.0) return;
    if (start.level !== "WARNING" && start.level !== "CRITICAL" && start.level !== "UNCERTAIN") return;

    var vehicleId = State.history.length ? State.history[State.history.length - 1].vehicle_id : "PBV_01";
    var responded = State.activeRunBraked || State.activeRunMaxSpeed < 5;
    var sensor;
    if (fusionState === "UWB_LOST_BLE_ALIVE") sensor = "UWB_LOST_BLE_ONLY";
    else if (start.level === "UNCERTAIN") sensor = "UWB_TIMEOUT_BLE_ONLY";
    else sensor = "UWB_OK";

    var ev = {
      event_id: "NM_" + String(State.nearMissSeq++).padStart(4, "0"),
      vehicle_id: vehicleId,
      worker_id: State.activeWorker || "unknown",
      risk_level: start.level,
      min_distance_m: isFinite(State.activeRunMinDist) ? +State.activeRunMinDist.toFixed(2) : null,
      vehicle_speed_kmh: Math.round(State.activeRunMaxSpeed),
      zone: zone || "Unknown",
      duration_s: +duration.toFixed(1),
      sensor_state: sensor,
      driver_response: State.activeRunBraked ? "braked" : (responded ? "slowed_down" : "no_response"),
    };
    State.nearMisses.unshift(ev);
    if (State.nearMisses.length > 200) State.nearMisses.pop();

    State.responseStats.total++;
    if (responded) State.responseStats.responded++;

    var z = State.zoneStats[ev.zone] || (State.zoneStats[ev.zone] = { total: 0, crit: 0, warn: 0, unc: 0, timeout: 0, bleFallback: 0 });
    z.total++;
    if (ev.risk_level === "CRITICAL") z.crit++;
    if (ev.risk_level === "WARNING") z.warn++;
    if (ev.risk_level === "UNCERTAIN") { z.unc++; z.timeout++; }
    if (sensor === "UWB_LOST_BLE_ONLY") z.bleFallback++;

    var v = State.vehicleStats[ev.vehicle_id] || (State.vehicleStats[ev.vehicle_id] = { total: 0, crit: 0 });
    v.total++;
    if (ev.risk_level === "CRITICAL") v.crit++;

    logEvent("\u2691 Near-miss " + ev.event_id + " " + ev.risk_level + " @ " + ev.zone +
      "  min=" + (ev.min_distance_m == null ? "??" : ev.min_distance_m + "m") + "  dur=" + ev.duration_s + "s", ev.risk_level);
  }

  // =========================================================================
  // 12. REPLAY LOOP
  // =========================================================================
  function tick(nowMs) {
    if (!State.playing) { State.lastTickMs = nowMs; requestAnimationFrame(tick); return; }
    var dt = (nowMs - State.lastTickMs) / 1000;
    State.lastTickMs = nowMs;
    State.accSimSeconds += dt * State.speed;

    // Replay-only: advance through CSV rows.
    if (!isLiveActive()) {
      while (State.idx < State.rows.length && State.rows[State.idx].t <= State.accSimSeconds) {
        var row = State.rows[State.idx];
        var fused = buildReplayFusedSample(row);
        pushHistory(fused);
        trackNearMiss(fused);
        eventLogOnRiskChange(fused);
        State.idx++;
      }
      if (State.idx >= State.rows.length) State.playing = false;
    } else {
      // Live mode: snapshot fused state on every tick (~60Hz) — sampled to 10Hz for history
      if (!State.lastLiveSampleMs || (nowMs - State.lastLiveSampleMs) >= 100) {
        State.lastLiveSampleMs = nowMs;
        var live = getCurrentFusedSample();
        if (live) {
          pushHistory(live);
          trackNearMiss(live);
          eventLogOnRiskChange(live);
        }
      }
    }

    render();
    requestAnimationFrame(tick);
  }

  function pushHistory(s) {
    State.history.push(s);
    if (State.history.length > State.historyMax) State.history.shift();
  }

  function eventLogOnRiskChange(s) {
    var prev = State.history.length > 1 ? State.history[State.history.length - 2].risk : "NONE";
    if (prev !== s.risk) {
      logEvent("t=" + s.t.toFixed(1) + "s  risk " + prev + " \u2192 " + s.risk +
        (s.distance_m != null ? "  (d=" + s.distance_m.toFixed(1) + "m)" : "") +
        (s.raw_uwb_status && s.raw_uwb_status !== "OK" ? "  [" + s.raw_uwb_status + "]" : ""), s.risk);
    }
  }

  // =========================================================================
  // 13. RENDER
  // =========================================================================
  function render() {
    var clockEl = document.getElementById("clock");
    if (clockEl) {
      var live = isLiveActive();
      clockEl.textContent = live
        ? "LIVE  \u2022  BLE=" + LiveBle.status + "  UWB=" + LiveUwb.quality
        : "t = " + State.accSimSeconds.toFixed(1) + " s  (" + State.idx + "/" + State.rows.length + ")";
    }
    if (State.mode === "driver") renderDriver();
    else if (State.mode === "debug") renderDebug();
    else if (State.mode === "fleet") renderFleet();
    else if (State.mode === "live-uwb") updateLivePanelUwb();
  }

  // ----- Driver HMI -----
  function renderDriver() {
    var s = getCurrentFusedSample();
    var risk = s ? s.risk : "NONE";

    var shell = document.getElementById("nav-shell");
    if (!shell) return;
    shell.dataset.level = risk;

    document.getElementById("maneuver-icon").textContent = MANEUVER_ICONS[risk];
    document.getElementById("maneuver-action").textContent = MANEUVER_ACTIONS[risk];
    var maneuverDist = document.getElementById("maneuver-distance");
    var maneuverText = document.getElementById("maneuver-text");

    if (s && s.fusion_state === "UWB_TRACKED" && s.filtered_range_m != null) {
      maneuverDist.textContent = s.filtered_range_m.toFixed(2) + " m";
      maneuverText.textContent =
        risk === "CRITICAL" ? "Worker on collision path" :
        risk === "WARNING"  ? "Worker close to vehicle path" :
        risk === "CAUTION"  ? "Worker in surrounding area" :
                              "Worker tracked at safe distance";
    } else if (s && s.fusion_state === "UWB_UNSTABLE") {
      maneuverDist.textContent = s.filtered_range_m != null ? s.filtered_range_m.toFixed(1) + " m" : "UNSTABLE";
      maneuverText.textContent = "UWB ranging unstable \u2013 maintain caution";
    } else if (s && s.fusion_state === "UWB_LOST_BLE_ALIVE") {
      maneuverDist.textContent = "BLIND";
      maneuverText.textContent = "Worker signal nearby, UWB range unavailable";
    } else if (s && s.fusion_state === "BLE_CANDIDATE") {
      maneuverDist.textContent = "BLE";
      maneuverText.textContent = "Worker tag detected nearby";
    } else {
      maneuverDist.textContent = "\u2014";
      maneuverText.textContent = "All clear ahead";
    }

    document.getElementById("risk-chip").textContent = risk;
    document.getElementById("risk-message").textContent = RISK_MESSAGES[risk].msg;
    document.getElementById("risk-action").textContent  = RISK_MESSAGES[risk].action;

    document.getElementById("speed-value").textContent = s ? Math.round(s.speed_kmh) : 0;
    document.getElementById("zone-value").textContent  = s ? s.zone : "\u2014";
    document.getElementById("brake-indicator").classList.toggle("on", !!(s && s.brake_pressed));

    var bleEl = document.getElementById("sensor-ble");
    var uwbEl = document.getElementById("sensor-uwb");
    if (s && s.ble_detected) {
      setSensorPill(bleEl, s.ble_status === "BLE_NEAR" ? "on" : (s.ble_status === "BLE_WEAK" ? "warn" : "on"));
    } else {
      setSensorPill(bleEl, "");
    }
    if (s && (s.uwb_quality === "GOOD")) setSensorPill(uwbEl, "on");
    else if (s && s.uwb_quality === "UNSTABLE") setSensorPill(uwbEl, "warn");
    else if (s && (s.uwb_quality === "LOST" || s.uwb_quality === "STALE")) setSensorPill(uwbEl, "err");
    else setSensorPill(uwbEl, "");

    // Worker Tag card
    document.getElementById("worker-id").textContent = s && s.worker_id ? s.worker_id : "\u2014";

    var distEl = document.getElementById("worker-distance");
    var distEl2 = document.getElementById("worker-distance-secondary");
    if (s && s.fusion_state === "UWB_TRACKED" && s.filtered_range_m != null) {
      distEl.textContent = s.filtered_range_m.toFixed(2) + " m";
      distEl.className = "live-ok";
      if (distEl2) distEl2.textContent = "";
    } else if (s && s.fusion_state === "UWB_UNSTABLE") {
      distEl.textContent = "UWB unstable";
      distEl.className = "live-warn";
      if (distEl2) distEl2.textContent = s.filtered_range_m != null ? "~" + s.filtered_range_m.toFixed(1) + " m" : "";
    } else if (s && (s.fusion_state === "UWB_LOST_BLE_ALIVE")) {
      distEl.textContent = "Range unavailable";
      distEl.className = "live-err";
      if (distEl2) distEl2.textContent = s.last_valid_range_m != null
        ? "Last valid: " + s.last_valid_range_m.toFixed(2) + " m (stale)"
        : "";
    } else if (s && s.fusion_state === "BLE_CANDIDATE") {
      distEl.textContent = "BLE only";
      distEl.className = "live-warn";
      if (distEl2) distEl2.textContent = "";
    } else {
      distEl.textContent = "\u2014";
      distEl.className = "";
      if (distEl2) distEl2.textContent = "";
    }

    document.getElementById("worker-conf").textContent = s ? Math.round(s.confidence * 100) + "%" : "\u2014";
    document.getElementById("worker-rssi").textContent = s && s.ble_rssi != null ? s.ble_rssi.toFixed(0) + " dBm" : "\u2014";
    var bleStatusEl = document.getElementById("worker-ble-status");
    if (bleStatusEl) bleStatusEl.textContent = s ? s.ble_status : "\u2014";

    drawZoneCanvas(s);
  }

  function setSensorPill(node, state) {
    if (!node) return;
    var dot = node.querySelector(".dot");
    if (dot) {
      dot.classList.remove("on", "warn", "err");
      if (state) dot.classList.add(state);
    }
    node.classList.toggle("on", !!state);
    node.classList.toggle("warn", state === "warn");
    node.classList.toggle("err",  state === "err");
  }

  // Canvas: zone map with vehicle and worker arc
  function drawZoneCanvas(s) {
    var canvas = document.getElementById("zone-canvas");
    if (!canvas) return;
    var parent = canvas.parentElement;
    var dpr = window.devicePixelRatio || 1;
    var w = parent.clientWidth, h = parent.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var vx = w / 2, vy = h * 0.78;
    var meters = 22;
    var scale = (h * 0.85) / meters;

    var grd = ctx.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, "#0a1018"); grd.addColorStop(1, "#070b11");
    ctx.fillStyle = grd; ctx.fillRect(0, 0, w, h);

    var roadBot = w * 0.62, roadTop = w * 0.40;
    ctx.beginPath();
    ctx.moveTo(vx - roadBot / 2, h); ctx.lineTo(vx + roadBot / 2, h);
    ctx.lineTo(vx + roadTop / 2, 0); ctx.lineTo(vx - roadTop / 2, 0);
    ctx.closePath();
    ctx.fillStyle = "#11171f"; ctx.fill();

    ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(vx - roadBot / 2, h); ctx.lineTo(vx - roadTop / 2, 0);
    ctx.moveTo(vx + roadBot / 2, h); ctx.lineTo(vx + roadTop / 2, 0);
    ctx.stroke();

    var dashOffset = (performance.now() / 30) % 32;
    ctx.strokeStyle = "rgba(255,206,58,0.55)"; ctx.lineWidth = 4;
    ctx.setLineDash([16, 16]); ctx.lineDashOffset = -dashOffset;
    ctx.beginPath(); ctx.moveTo(vx, h); ctx.lineTo(vx, 0); ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0;

    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.font = "11px Segoe UI";
    for (var d = 5; d <= 18; d += 5) {
      var y = vy - d * scale; if (y < 0) break;
      ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(w - 20, y); ctx.stroke();
      ctx.fillText(d + " m", 24, y - 4);
    }

    var zones = [
      { r: 15, fill: "rgba(255,206,58,0.10)", stroke: "rgba(255,206,58,0.55)" },
      { r: 10, fill: "rgba(255,138,42,0.13)", stroke: "rgba(255,138,42,0.65)" },
      { r: 5,  fill: "rgba(255,59,59,0.18)",  stroke: "rgba(255,59,59,0.80)"  },
    ];
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i];
      ctx.beginPath(); ctx.arc(vx, vy, z.r * scale, 0, Math.PI * 2);
      ctx.fillStyle = z.fill; ctx.fill();
      ctx.strokeStyle = z.stroke; ctx.lineWidth = 1.5; ctx.stroke();
    }

    var COLOR = {
      NONE: "rgba(160,170,185,0.9)", CAUTION: "rgba(255,206,58,1)",
      WARNING: "rgba(255,138,42,1)", CRITICAL: "rgba(255,59,59,1)",
      UNCERTAIN: "rgba(138,123,255,1)",
    };

    if (s && s.fusion_state === "UWB_TRACKED" && s.filtered_range_m != null) {
      var r = s.filtered_range_m * scale;
      var col = COLOR[s.risk];
      ctx.strokeStyle = col; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(vx, vy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.5; ctx.setLineDash([6, 6]); ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.arc(vx, vy, Math.max(0, r - scale), 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(vx, vy, r + scale, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1; ctx.setLineDash([]);
      ctx.font = "bold 14px Segoe UI";
      var label = s.filtered_range_m.toFixed(2) + " m";
      var lw = ctx.measureText(label).width + 16;
      var ly = vy - r - 14;
      ctx.fillStyle = col;
      roundRect(ctx, vx - lw / 2, ly - 14, lw, 22, 11); ctx.fill();
      ctx.fillStyle = "#0a0e14"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, vx, ly - 3);
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    } else if (s && s.fusion_state === "UWB_LOST_BLE_ALIVE") {
      ctx.fillStyle = "rgba(138,123,255,0.16)";
      ctx.beginPath(); ctx.arc(vx, vy, 15 * scale, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(138,123,255,0.9)"; ctx.setLineDash([10, 8]); ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(vx, vy, 15 * scale, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(138,123,255,1)"; ctx.font = "bold 13px Segoe UI"; ctx.textAlign = "center";
      ctx.fillText("UWB LOST  \u2022  BLE only", vx, vy - 15 * scale - 10);
      ctx.textAlign = "left";
    } else if (s && s.fusion_state === "BLE_CANDIDATE") {
      ctx.fillStyle = "rgba(255,206,58,0.08)";
      ctx.beginPath(); ctx.arc(vx, vy, 15 * scale, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,206,58,0.85)"; ctx.font = "12px Segoe UI"; ctx.textAlign = "center";
      ctx.fillText("BLE detected \u2022 awaiting UWB range", vx, vy - 15 * scale - 8);
      ctx.textAlign = "left";
    }

    ctx.save();
    ctx.translate(vx, vy);
    var glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 50);
    glow.addColorStop(0, "rgba(79,209,255,0.45)");
    glow.addColorStop(1, "rgba(79,209,255,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, 50, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -28); ctx.lineTo(16, 12); ctx.lineTo(10, 22);
    ctx.lineTo(-10, 22); ctx.lineTo(-16, 12); ctx.closePath();
    ctx.fillStyle = "#4fd1ff";
    ctx.shadowColor = "rgba(79,209,255,0.6)"; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0;
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ----- Debug Monitor -----
  function renderDebug() {
    drawLineChart("chart-ble", State.history.map(function (h) { return h.ble_rssi; }), {
      yMin: -100, yMax: -40, color: "#4fd1ff", label: "RSSI", suffix: " dBm",
    });
    drawLineChart("chart-uwb", State.history.map(function (h) {
      return h.filtered_range_m != null ? h.filtered_range_m : null;
    }), {
      yMin: 0, yMax: 20, color: "#29d39a", label: "range", suffix: " m",
    });
    drawStatusBar("chart-status", State.history.map(function (h) {
      return { status: h.raw_uwb_status, ble: h.ble_detected, risk: h.risk };
    }));

    // BLE live panel
    var bleRssiCur = document.getElementById("ble-cur-rssi");
    var bleStat    = document.getElementById("ble-cur-status");
    var bleCount   = document.getElementById("ble-cur-count");
    var bleAge     = document.getElementById("ble-cur-age");
    if (bleRssiCur) {
      bleRssiCur.textContent = LiveBle.rssi != null ? LiveBle.rssi.toFixed(0) + " dBm" : "\u2014";
      bleStat.textContent    = LiveBle.status;
      bleStat.className      = "ble-status-badge " + LiveBle.status.toLowerCase();
      bleCount.textContent   = LiveBle.packetCount;
      var age = bleSecondsSince();
      bleAge.textContent     = age != null ? age.toFixed(1) + " s" : "\u2014";
    }
    drawBleRssiTrend();

    // Fusion panel
    var fusEl    = document.getElementById("fusion-state");
    var fusQual  = document.getElementById("fusion-uwb-quality");
    var fusFlag  = document.getElementById("fusion-flag");
    var fusLast  = document.getElementById("fusion-last-valid");
    var fusStale = document.getElementById("fusion-stale-flag");
    if (fusEl) {
      var s = getCurrentFusedSample();
      var fs = s ? s.fusion_state : "CLEAR";
      fusEl.textContent     = fs;
      fusEl.className       = "fusion-badge fusion-" + fs.toLowerCase().replace(/_/g, "-");
      fusQual.textContent   = s ? s.uwb_quality : "\u2014";
      fusFlag.textContent   = (fs === "UWB_LOST_BLE_ALIVE") ? "BLE alive while UWB lost" : "\u2014";
      fusFlag.className     = "fusion-flag " + (fs === "UWB_LOST_BLE_ALIVE" ? "alarm" : "");
      fusLast.textContent   = LiveUwb.lastValidRangeM != null ? LiveUwb.lastValidRangeM.toFixed(2) + " m" : "\u2014";
      fusStale.textContent  = s && s.is_range_stale ? "STALE" : "\u2014";
      fusStale.className    = "stale-flag " + (s && s.is_range_stale ? "on" : "");
    }

    // Current sample table
    var e = getCurrentFusedSample();
    var cur = document.getElementById("debug-current");
    if (cur) {
      cur.innerHTML = "";
      if (e) {
        var fields = [
          ["timestamp", e.t.toFixed(1) + " s"],
          ["fusion_state", e.fusion_state],
          ["risk", e.risk],
          ["vehicle_id", e.vehicle_id],
          ["speed_kmh", Math.round(e.speed_kmh)],
          ["brake_pressed", String(e.brake_pressed)],
          ["worker_id", e.worker_id || "\u2014"],
          ["ble_detected", String(e.ble_detected)],
          ["ble_status", e.ble_status],
          ["ble_rssi", e.ble_rssi != null ? e.ble_rssi.toFixed(0) : "\u2014"],
          ["uwb_quality", e.uwb_quality],
          ["raw_uwb_status", e.raw_uwb_status || "\u2014"],
          ["raw_range_m", e.raw_range_m != null ? e.raw_range_m.toFixed(3) : "\u2014"],
          ["filtered_range_m", e.filtered_range_m != null ? e.filtered_range_m.toFixed(3) : "\u2014"],
          ["last_valid_range_m", e.last_valid_range_m != null ? e.last_valid_range_m.toFixed(3) : "\u2014"],
          ["is_range_stale", String(e.is_range_stale)],
          ["confidence", e.confidence.toFixed(2)],
          ["zone", e.zone],
        ];
        for (var fi = 0; fi < fields.length; fi++) {
          cur.insertAdjacentHTML("beforeend", "<tr><td>" + fields[fi][0] + "</td><td>" + fields[fi][1] + "</td></tr>");
        }
      }
    }

    var tbody = document.querySelector("#debug-events tbody");
    if (tbody) {
      tbody.innerHTML = "";
      var recent = State.history.slice(-20).reverse();
      for (var ri = 0; ri < recent.length; ri++) {
        var r = recent[ri];
        tbody.insertAdjacentHTML("beforeend",
          '<tr class="risk-' + r.risk + '">' +
          "<td>" + r.t.toFixed(1) + "</td>" +
          "<td>" + r.vehicle_id + "</td>" +
          "<td>" + Math.round(r.speed_kmh) + "</td>" +
          "<td>" + (r.brake_pressed ? "Y" : "\u2013") + "</td>" +
          "<td>" + (r.worker_id || "\u2013") + "</td>" +
          "<td>" + (r.filtered_range_m != null ? r.filtered_range_m.toFixed(2) : "\u2013") + "</td>" +
          "<td>" + (r.uwb_quality || "\u2013") + "</td>" +
          "<td>" + (r.ble_detected ? "Y" : "\u2013") + "</td>" +
          "<td>" + (r.ble_rssi != null ? r.ble_rssi.toFixed(0) : "\u2013") + "</td>" +
          "<td>" + r.fusion_state + "</td>" +
          "<td>" + r.zone + "</td>" +
          "<td>" + r.risk + "</td>" +
          "</tr>");
      }
    }
  }

  function drawBleRssiTrend() {
    var canvas = document.getElementById("chart-ble-trend");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#0c121b"; ctx.fillRect(0, 0, w, h);
    var data = LiveBle.rssiHistory;
    if (!data.length) {
      ctx.fillStyle = "#3a4a5a"; ctx.font = "12px monospace"; ctx.textAlign = "center";
      ctx.fillText("no BLE samples", w / 2, h / 2); return;
    }
    var yMin = -100, yMax = -40;
    var t0 = data[0].ts, t1 = data[data.length - 1].ts || t0 + 1;
    function px(t) { return 40 + (t - t0) / (t1 - t0 || 1) * (w - 50); }
    function py(v) { return (1 - (v - yMin) / (yMax - yMin)) * h; }
    ctx.strokeStyle = "#1a2330"; ctx.lineWidth = 1;
    for (var g = -40; g >= -100; g -= 20) {
      var y = py(g);
      ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillStyle = "#778899"; ctx.font = "10px monospace"; ctx.textAlign = "right";
      ctx.fillText(g + "dBm", 36, y + 3);
    }
    // -75 dBm threshold line
    var yT = py(BLE_RSSI_NEAR_THRESH);
    ctx.strokeStyle = "rgba(0,224,139,0.45)"; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(40, yT); ctx.lineTo(w, yT); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.strokeStyle = "#4fd1ff"; ctx.lineWidth = 2;
    for (var i = 0; i < data.length; i++) {
      var pxV = px(data[i].ts), pyV = py(data[i].rssi);
      if (i === 0) ctx.moveTo(pxV, pyV); else ctx.lineTo(pxV, pyV);
    }
    ctx.stroke();
  }

  function drawLineChart(id, series, opt) {
    var canvas = document.getElementById(id);
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var y = (h / 4) * i;
      ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.fillStyle = "#8a96a8"; ctx.font = "10px Segoe UI";
    ctx.fillText(opt.yMax + opt.suffix, 4, 10);
    ctx.fillText(opt.yMin + opt.suffix, 4, h - 2);

    var n = Math.max(series.length, 2);
    function xs(i2) { return 40 + (i2 * (w - 44)) / (n - 1); }
    function ys(v) {
      if (v == null || isNaN(v)) return null;
      var tt = (v - opt.yMin) / (opt.yMax - opt.yMin);
      return h - tt * h;
    }
    ctx.strokeStyle = opt.color; ctx.lineWidth = 2; ctx.beginPath();
    var started = false;
    for (var k = 0; k < series.length; k++) {
      var y2 = ys(series[k]);
      if (y2 == null) { started = false; continue; }
      if (!started) { ctx.moveTo(xs(k), y2); started = true; }
      else ctx.lineTo(xs(k), y2);
    }
    ctx.stroke();

    for (var j = series.length - 1; j >= 0; j--) {
      var v2 = series[j]; var y3 = ys(v2);
      if (y3 != null) {
        ctx.fillStyle = opt.color;
        ctx.beginPath(); ctx.arc(xs(j), y3, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#e6edf5"; ctx.font = "bold 11px Segoe UI";
        var tx = typeof v2 === "number" ? v2.toFixed(opt.suffix === " m" ? 2 : 0) : v2;
        ctx.fillText(opt.label + ": " + tx + opt.suffix, w - 130, 12);
        break;
      }
    }
  }

  function drawStatusBar(id, arr) {
    var canvas = document.getElementById(id);
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    var n = Math.max(arr.length, 1);
    var bw = (w - 44) / n;
    ctx.fillStyle = "#8a96a8"; ctx.font = "10px Segoe UI";
    ctx.fillText("UWB", 4, h / 2 - 4);
    ctx.fillText("BLE", 4, h - 6);
    var halfH = (h - 14) / 2;
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i];
      var c = "#3a4658";
      if (s.status === "OK") c = "#29d39a";
      else if (s.status === "TIMEOUT" || s.status === "RX_RESP_TIMEOUT" || s.status === "LISTEN_TIMEOUT") c = "#8a7bff";
      ctx.fillStyle = c;
      ctx.fillRect(40 + i * bw, 2, Math.max(1, bw - 1), halfH);
      ctx.fillStyle = s.ble ? "#4fd1ff" : "#1f2a38";
      ctx.fillRect(40 + i * bw, halfH + 6, Math.max(1, bw - 1), halfH);
    }
  }

  function logEvent(text, risk) {
    var log = document.getElementById("debug-log");
    if (!log) return;
    var line = document.createElement("div");
    line.className = "ln " + (risk || "");
    line.innerHTML = "<b>[" + new Date().toLocaleTimeString() + "]</b> " + text;
    log.prepend(line);
    while (log.childElementCount > 200) log.removeChild(log.lastChild);
  }

  // ----- Fleet -----
  function renderFleet() {
    var total = State.nearMisses.length;
    var crit = State.nearMisses.filter(function (n) { return n.risk_level === "CRITICAL"; }).length;
    var warn = State.nearMisses.filter(function (n) { return n.risk_level === "WARNING"; }).length;
    var unc  = State.nearMisses.filter(function (n) { return n.risk_level === "UNCERTAIN"; }).length;
    document.getElementById("kpi-total").textContent = total;
    document.getElementById("kpi-crit").textContent  = crit;
    document.getElementById("kpi-warn").textContent  = warn;
    document.getElementById("kpi-unc").textContent   = unc;

    var rs = State.responseStats;
    document.getElementById("kpi-resp").textContent = rs.total
      ? Math.round((rs.responded / rs.total) * 100) + "%" : "\u2014";

    var riskyZone = "\u2014", riskyMax = 0;
    var unrelZone = "\u2014", unrelMax = 0;
    var z, st;
    for (z in State.zoneStats) {
      st = State.zoneStats[z];
      if (st.total > riskyMax)   { riskyMax = st.total;   riskyZone = z; }
      if (st.timeout > unrelMax) { unrelMax = st.timeout; unrelZone = z; }
    }
    document.getElementById("kpi-zone").textContent  = riskyZone + (riskyMax ? " (" + riskyMax + ")" : "");
    document.getElementById("kpi-unrel").textContent = unrelZone + (unrelMax ? " (" + unrelMax + ")" : "");
    document.getElementById("kpi-vehicles").textContent = Object.keys(State.vehicleStats).length;

    // New: BLE fallback metrics
    var kpiFallback = document.getElementById("kpi-ble-fallback");
    if (kpiFallback) kpiFallback.textContent = State.bleFallbackEvents;
    var kpiDropoutZone = document.getElementById("kpi-dropout-zone");
    if (kpiDropoutZone) {
      var dz = "\u2014", dzMax = 0, dk;
      for (dk in State.dropoutZoneCounts) {
        if (State.dropoutZoneCounts[dk] > dzMax) { dzMax = State.dropoutZoneCounts[dk]; dz = dk; }
      }
      kpiDropoutZone.textContent = dz + (dzMax ? " (" + dzMax + ")" : "");
    }
    var kpiFallbackDur = document.getElementById("kpi-fallback-dur");
    if (kpiFallbackDur) {
      var tot = State.bleFallbackTotalMs;
      if (State.bleAliveUwbLostStart != null) tot += performance.now() - State.bleAliveUwbLostStart;
      kpiFallbackDur.textContent = (tot / 1000).toFixed(1) + " s";
    }

    var zt = document.querySelector("#zone-table tbody");
    if (zt) {
      zt.innerHTML = "";
      var entries = Object.keys(State.zoneStats).map(function (k) { return [k, State.zoneStats[k]]; })
        .sort(function (a, b) { return b[1].total - a[1].total; });
      for (var i = 0; i < entries.length; i++) {
        var zone = entries[i][0], stt = entries[i][1];
        zt.insertAdjacentHTML("beforeend",
          "<tr><td>" + zone + "</td><td>" + stt.total + "</td><td>" + stt.crit + "</td>" +
          "<td>" + stt.warn + "</td><td>" + stt.unc + "</td><td>" + stt.timeout + "</td><td>" + (stt.bleFallback || 0) + "</td></tr>");
      }
    }

    var vt = document.querySelector("#vehicle-table tbody");
    if (vt) {
      vt.innerHTML = "";
      var ventries = Object.keys(State.vehicleStats).map(function (k) { return [k, State.vehicleStats[k]]; })
        .sort(function (a, b) { return b[1].total - a[1].total; });
      for (var vi = 0; vi < ventries.length; vi++) {
        vt.insertAdjacentHTML("beforeend",
          "<tr><td>" + ventries[vi][0] + "</td><td>" + ventries[vi][1].total + "</td><td>" + ventries[vi][1].crit + "</td></tr>");
      }
    }

    var nt = document.querySelector("#nearmiss-table tbody");
    if (nt) {
      nt.innerHTML = "";
      var nm = State.nearMisses.slice(0, 30);
      for (var ni = 0; ni < nm.length; ni++) {
        var ev = nm[ni];
        nt.insertAdjacentHTML("beforeend",
          '<tr class="risk-' + ev.risk_level + '">' +
          "<td>" + ev.event_id + "</td><td>" + ev.vehicle_id + "</td><td>" + ev.worker_id + "</td>" +
          "<td>" + ev.risk_level + "</td><td>" + (ev.min_distance_m != null ? ev.min_distance_m : "\u2014") + "</td>" +
          "<td>" + ev.vehicle_speed_kmh + "</td><td>" + ev.zone + "</td><td>" + ev.duration_s + "</td>" +
          "<td>" + ev.sensor_state + "</td><td>" + ev.driver_response + "</td></tr>");
      }
    }
  }

  // ----- Live UWB Panel -----
  function updateLivePanelUwb() {
    var num = document.getElementById("live-range-num");
    if (num) {
      if (LiveUwb.quality === "GOOD" && LiveUwb.filteredRangeM != null) {
        num.textContent = LiveUwb.filteredRangeM.toFixed(3);
      } else {
        num.textContent = "--";
      }
    }
    var badge = document.getElementById("live-status-badge");
    if (badge) {
      badge.textContent = LiveUwb.status || "--";
      badge.className = "live-status-badge" + (LiveUwb.status === "OK" ? " ok" : LiveUwb.status ? " err" : "");
    }
    var qb = document.getElementById("live-quality-badge");
    if (qb) {
      qb.textContent = LiveUwb.quality;
      qb.className = "live-quality-badge q-" + LiveUwb.quality.toLowerCase();
    }
    var elC = document.getElementById("live-count"); if (elC) elC.textContent = LiveUwb.countOK;
    var elN = document.getElementById("live-min");   if (elN) elN.textContent = isFinite(LiveUwb.minRange) ? LiveUwb.minRange.toFixed(3) + " m" : "--";
    var elX = document.getElementById("live-max");   if (elX) elX.textContent = isFinite(LiveUwb.maxRange) ? LiveUwb.maxRange.toFixed(3) + " m" : "--";
    var elA = document.getElementById("live-avg");   if (elA) elA.textContent = LiveUwb.countOK ? (LiveUwb.sumRange / LiveUwb.countOK).toFixed(3) + " m" : "--";
    drawLiveChart();
    updateLiveDiagPanel();
    drawUwbEventTimeline();
  }

  // ----- Live Diagnostic Panel (UWB link / responder heartbeat / rates) -----
  function updateLiveDiagPanel() {
    var nowMs = performance.now();

    var link = uwbLinkState();
    var hb   = nodeBHeartbeatAlive();
    var sinceOk    = diagSecondsSince(LiveDiag.nodeA.lastOkMs);
    var sinceReady = diagSecondsSince(LiveDiag.nodeB.lastReadyMs);
    var lastValidAge = LiveUwb.lastOkMs ? (nowMs - LiveUwb.lastOkMs) / 1000 : null;

    function set(id, val) {
      var el = document.getElementById(id);
      if (el) el.textContent = val;
    }
    function setHTML(id, html) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = html;
    }
    function setBadge(id, cls, text) {
      var el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      el.className = cls;
    }

    setBadge("uwb-link-state", "diag-badge link-" + link.toLowerCase(), link);
    setBadge("uwb-responder-heartbeat",
             "diag-badge hb-" + (hb ? "yes" : "no"),
             hb ? "YES" : "NO");
    set("uwb-since-nodeB-ready",  sinceReady != null ? sinceReady.toFixed(1) + " s" : "—");
    set("uwb-since-last-ok",       sinceOk    != null ? sinceOk.toFixed(1) + " s"    : "—");
    set("uwb-consec-timeout",      String(LiveDiag.nodeA.consecutiveTimeout));

    var okR1  = diagCountInWindow("OK", 1000);
    var okR3  = diagCountInWindow("OK", 3000);
    var okR10 = diagCountInWindow("OK", 10000);
    var toR1  = diagCountInWindow("TIMEOUT", 1000);
    var toR3  = diagCountInWindow("TIMEOUT", 3000);
    var toR10 = diagCountInWindow("TIMEOUT", 10000);
    set("uwb-ok-rate-1s",  okR1  + " ok");
    set("uwb-ok-rate-3s",  okR3  + " ok");
    set("uwb-ok-rate-10s", okR10 + " ok");
    set("uwb-to-rate-1s",  toR1  + " to");
    set("uwb-to-rate-3s",  toR3  + " to");
    set("uwb-to-rate-10s", toR10 + " to");

    set("uwb-reinit-a", String(LiveDiag.nodeA.reinitCount));
    set("uwb-reinit-b", String(LiveDiag.nodeB.reinitCount));
    set("uwb-last-valid-range", LiveUwb.lastValidRangeM != null ? LiveUwb.lastValidRangeM.toFixed(3) + " m" : "—");
    set("uwb-last-valid-age",   lastValidAge != null ? lastValidAge.toFixed(1) + " s" : "—");

    // ---- per-event counters: new + legacy combined ----
    var ca  = LiveDiag.nodeA.counters || {};
    var cal = LiveDiag.nodeA.legacyCounters || {};
    var cb  = LiveDiag.nodeB.counters || {};

    function combined(newVal, legVal) {
      var n = newVal || 0, l = legVal || 0, t = n + l;
      if (l > 0) return t + " <small>new=" + n + " legacy=" + l + "</small>";
      return String(t);
    }
    setHTML("uwb-cnt-a-tx-poll",      String(ca.TX_POLL          || 0));
    setHTML("uwb-cnt-a-rx-resp-to",   combined(ca.RX_RESP_TIMEOUT,   cal.RX_RESP_TIMEOUT));
    setHTML("uwb-cnt-a-rx-rtinfo-to", String(ca.RX_RTINFO_TIMEOUT|| 0));
    setHTML("uwb-cnt-a-range-ok",     combined(ca.RANGE_OK,          cal.RANGE_OK));
    setHTML("uwb-cnt-a-rx-restart",   String(ca.RX_RESTART       || 0));
    setHTML("uwb-cnt-a-dw-reinit",    String(ca.DW_REINIT        || 0));
    setHTML("uwb-cnt-b-rx-poll",      String(cb.RX_POLL          || 0));
    setHTML("uwb-cnt-b-tx-resp-done", String(cb.TX_RESP_DONE     || 0));
    setHTML("uwb-cnt-b-tx-resp-late", String(cb.TX_RESP_LATE     || 0));
    setHTML("uwb-cnt-b-rx-final-ok",  String(cb.RX_FINAL_OK      || 0));
    setHTML("uwb-cnt-b-rx-final-to",  String(cb.RX_FINAL_TIMEOUT || 0));
    setHTML("uwb-cnt-b-tx-rtinfo-done", String(cb.TX_RTINFO_DONE || 0));

    // ---- Firmware / Parser Status panel ----
    function fwModeBadge(mode, connected) {
      if (!connected) return '<span class="fw-badge fw-nc">NOT CONNECTED</span>';
      if (mode === "NEW_DWM3000_V14") return '<span class="fw-badge fw-new">NEW DWM3000 v1.4</span>';
      if (mode === "LEGACY_COMPACT_CSV") return '<span class="fw-badge fw-leg">LEGACY CSV</span>';
      if (mode === "NO_DATA") return '<span class="fw-badge fw-nodata">NO DATA</span>';
      return '<span class="fw-badge fw-unk">UNKNOWN</span>';
    }
    function fmtIdent(node) {
      var id = LiveDiag[node].identity || {};
      var parts = [];
      if (id.hardware) parts.push(id.hardware);
      if (id.firmware) parts.push(id.firmware);
      if (id.build)    parts.push("build " + id.build);
      return parts.length ? parts.join(" · ") : "—";
    }
    var connA = !!LiveUwb.connectedA, connB = !!LiveUwb.connectedB;
    var modeA = LiveDiag.nodeA.firmwareMode, modeB = LiveDiag.nodeB.firmwareMode;
    var identA = fmtIdent("nodeA"), identB = fmtIdent("nodeB");

    // Check NO_DATA: connected for >3s but nothing seen
    if (connA && LiveDiag.nodeA.connectedSinceMs && !LiveDiag.nodeA.lastSampleMs && !LiveDiag.nodeA.lastEventMs) {
      if ((nowMs - LiveDiag.nodeA.connectedSinceMs) > 3000) modeA = "NO_DATA";
    }
    if (connB && LiveDiag.nodeB.connectedSinceMs && !LiveDiag.nodeB.lastPollMs && !LiveDiag.nodeB.lastReadyMs && !LiveDiag.nodeB.lastEventMs) {
      if ((nowMs - LiveDiag.nodeB.connectedSinceMs) > 3000) modeB = "NO_DATA";
    }

    var sinceHb = LiveDiag.nodeB.lastReadyMs ? ((nowMs - LiveDiag.nodeB.lastReadyMs) / 1000).toFixed(1) + " s ago" : "—";
    var fwHTML =
      '<div class="fw-row">' +
        '<div class="fw-col">' +
          '<div class="fw-label">node_A (Initiator)</div>' +
          '<div>Serial: <b>' + (connA ? '<span class="fw-ok">CONNECTED</span>' : '<span class="fw-dim">DISCONNECTED</span>') + '</b></div>' +
          '<div>Firmware: ' + fwModeBadge(modeA, connA) + '</div>' +
          '<div>Identity: <span class="fw-ident">' + identA + '</span></div>' +
          '<div>Last line: <b>' + (LiveDiag.nodeA.lastLineKind || "—") + '</b></div>' +
        '</div>' +
        '<div class="fw-col">' +
          '<div class="fw-label">node_B (Responder)</div>' +
          '<div>Serial: <b>' + (connB ? '<span class="fw-ok">CONNECTED</span>' : '<span class="fw-dim">DISCONNECTED</span>') + '</b></div>' +
          '<div>Firmware: ' + fwModeBadge(modeB, connB) + '</div>' +
          '<div>Identity: <span class="fw-ident">' + identB + '</span></div>' +
          '<div>READY hb: <b>' + (hb ? '<span class="fw-ok">YES</span>' : '<span class="fw-dim">NO</span>') + '</b> &nbsp; ' + sinceHb + '</div>' +
        '</div>' +
      '</div>';
    setHTML("uwb-fw-status", fwHTML);

    // ---- Identity (for legacy inline display) ----
    set("uwb-ident-a", identA);
    set("uwb-ident-b", identB);

    // ---- Diagnostic alerts (truthful rules) ----
    var alerts = [];    // { text, isError }  — isError=false → yellow warning
    var isRangeActive = LiveDiag.nodeA.lastOkMs != null &&
                        (nowMs - LiveDiag.nodeA.lastOkMs) < 3000;

    // --- node_A firmware mode advisories ---
    if (connA && modeA === "LEGACY_COMPACT_CSV") {
      alerts.push({ text: "node_A is producing legacy compact CSV. Flash the latest DWM3000 v1.4 firmware if per-stage diagnostics are required.", isError: false });
    }
    if (connA && modeA !== "NEW_DWM3000_V14" && isRangeActive) {
      alerts.push({ text: "Range is active, but full diagnostics require latest firmware identity and node_B responder heartbeat. Per-stage diagnosis (TX_POLL / RX_RESP_OK / TX_RESP_DONE / etc.) unavailable.", isError: false });
    }
    if (connA && (modeA === "UNKNOWN" || modeA === "NO_DATA") && !isRangeActive) {
      alerts.push({ text: "UWB range is active, but latest DWM3000 v1.4 diagnostic firmware is not confirmed. Reset node_A after connecting to capture BOOT/IDENTITY.", isError: false });
    }

    // --- node_B heartbeat (only if nodeB port actually open) ---
    var connBSince = LiveDiag.nodeB.connectedSinceMs;
    var bConnected3s = connB && connBSince && (nowMs - connBSince) > 3000;
    if (!connB) {
      if (modeA === "NEW_DWM3000_V14") {
        alerts.push({ text: "node_B not connected. Connect responder serial or run node_B independently for full two-node diagnosis.", isError: false });
      }
    } else if (bConnected3s && !LiveDiag.nodeB.lastReadyMs) {
      if (modeB === "NEW_DWM3000_V14") {
        alerts.push({ text: "node_B serial port is open, but no READY heartbeat detected in 3 s. Check node_B responder firmware and wiring.", isError: true });
      } else {
        alerts.push({ text: "node_B connected, but no DWM3000 v1.4 responder identity or READY heartbeat has been observed. Reset node_B after connecting or re-flash responder firmware.", isError: false });
      }
    }

    // --- 4-rule per-stage diagnosis (new firmware only) ---
    if (modeA === "NEW_DWM3000_V14") {
      var toA3     = eventCountInWindow("A", "RX_RESP_TIMEOUT",   3000) +
                     eventCountInWindow("A", "RX_RTINFO_TIMEOUT", 3000);
      var rxPollB3 = eventCountInWindow("B", "RX_POLL",           3000);
      var txDoneB3 = eventCountInWindow("B", "TX_RESP_DONE",      3000);
      var txLateB3 = eventCountInWindow("B", "TX_RESP_LATE",      3000);
      var restartA10 = eventCountInWindow("A", "RX_RESTART", 10000);
      var reinitA10  = eventCountInWindow("A", "DW_REINIT",  10000);

      if (toA3 > 0 && rxPollB3 === 0) {
        alerts.push({ text: "Diagnosis: node_A is timing out but node_B reports no RX_POLL in the last 3s. Poll is not reaching the responder OR responder RX is not armed (check antenna, channel/PAN, distance, obstruction, role assignment).", isError: true });
      } else if (toA3 > 0 && rxPollB3 > 0 && txDoneB3 === 0) {
        var lateNote = txLateB3 > 0 ? " (" + txLateB3 + " TX_RESP_LATE observed)" : "";
        alerts.push({ text: "Diagnosis: responder receives Poll but fails to TX a clean Response" + lateNote + ". Likely delayed-TX margin / SPI stall on node_B.", isError: true });
      } else if (toA3 > 0 && txDoneB3 > 0) {
        alerts.push({ text: "Diagnosis: responder transmitted Response (TX_RESP_DONE seen) but initiator missed it. Check node_A RX timeout, RX timing window, antenna orientation, or RF interference.", isError: true });
      }

      if (!isRangeActive &&
          LiveDiag.nodeA.consecutiveTimeout >= UWB_TIMEOUT_BURST_ALERT &&
          restartA10 === 0 && reinitA10 === 0) {
        alerts.push({ text: "Recovery logic not firing: consecutive timeout ≥ " + UWB_TIMEOUT_BURST_ALERT + " but no RX_RESTART / DW_REINIT in last 10s. Verify SOFT_RECOVERY_THRESHOLD / DW_REINIT_THRESHOLD wiring.", isError: true });
      }
    } else if (modeA === "LEGACY_COMPACT_CSV" &&
               LiveDiag.nodeA.consecutiveTimeout >= UWB_TIMEOUT_BURST_ALERT &&
               !isRangeActive) {
      alerts.push({ text: "Legacy firmware detected. Recovery events cannot be verified because RX_RESTART / DW_REINIT event vocabulary is not available in this firmware.", isError: false });
    }

    var alertEl = document.getElementById("uwb-diag-alerts");
    if (alertEl) {
      if (alerts.length) {
        alertEl.innerHTML = alerts.map(function (a) {
          return '<div class="' + (a.isError ? "diag-alert" : "diag-warn") + '">' + a.text + '</div>';
        }).join("");
      } else if (isRangeActive) {
        alertEl.innerHTML = '<div class="diag-ok">Range active. No diagnostic anomalies detected.</div>';
      } else if (connA || connB) {
        alertEl.innerHTML = '<div class="diag-ok">No diagnostic anomalies detected.</div>';
      } else {
        alertEl.innerHTML = '<div class="diag-dim">Connect node_A serial to start live diagnostics.</div>';
      }
    }

    var cfgEl = document.getElementById("uwb-config-line");
    if (cfgEl) {
      var cfgParts = [];
      if (LiveDiag.nodeA.configLine) cfgParts.push("A: " + LiveDiag.nodeA.configLine);
      if (LiveDiag.nodeB.configLine) cfgParts.push("B: " + LiveDiag.nodeB.configLine);
      cfgEl.textContent = cfgParts.length ? cfgParts.join("  |  ") : "—";
    }
  }

  // ----- UWB Status Timeline (color-coded ticks per event) -----
  var UWB_EVENT_COLORS = {
    OK:      "#00e08b",
    TIMEOUT: "#ff4c4c",
    ERR:     "#ff8a2a",
    REINIT:  "#8a7bff",
    RESTART: "#4fd1ff",
  };
  function drawUwbEventTimeline() {
    var canvas = document.getElementById("chart-uwb-events");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    ctx.fillStyle = "#0c121b"; ctx.fillRect(0, 0, W, H);

    var events = LiveDiag.events;
    if (!events.length) {
      ctx.fillStyle = "#3a4a5a"; ctx.font = "12px monospace"; ctx.textAlign = "center";
      ctx.fillText("No UWB events yet — connect node_A/node_B and wait", W / 2, H / 2);
      return;
    }
    var WINDOW_MS = 30000;
    var now = performance.now();
    var t0 = now - WINDOW_MS;

    // grid: every 5 s
    ctx.strokeStyle = "#1a2330"; ctx.lineWidth = 1; ctx.fillStyle = "#3a4a5a";
    ctx.font = "10px monospace"; ctx.textAlign = "center";
    for (var s = 0; s <= 6; s++) {
      var fx = (s / 6) * W;
      ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, H); ctx.stroke();
      ctx.fillText("-" + (30 - s * 5) + "s", fx, H - 4);
    }

    // tick rows: node A on top half, node B on bottom half
    var rowH = (H - 16) / 2;
    function rowY(node) { return node === "A" ? 0 : rowH; }

    ctx.fillStyle = "#3a4a5a"; ctx.textAlign = "left";
    ctx.fillText("node_A", 4, 12);
    ctx.fillText("node_B", 4, rowH + 12);

    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.ts < t0) continue;
      var x = ((e.ts - t0) / WINDOW_MS) * W;
      var y = rowY(e.node);
      ctx.fillStyle = UWB_EVENT_COLORS[e.type] || "#888";
      var th = (e.type === "REINIT" || e.type === "RESTART") ? rowH - 4 : (rowH - 14);
      var ty = y + (rowH - th) / 2;
      ctx.fillRect(x, ty, 2, th);
    }

    // legend
    var lx = 80, ly = 8, gap = 78;
    var labels = [["OK", UWB_EVENT_COLORS.OK], ["TIMEOUT", UWB_EVENT_COLORS.TIMEOUT],
                  ["ERR", UWB_EVENT_COLORS.ERR], ["RESTART", UWB_EVENT_COLORS.RESTART],
                  ["REINIT", UWB_EVENT_COLORS.REINIT]];
    for (var k = 0; k < labels.length; k++) {
      ctx.fillStyle = labels[k][1];
      ctx.fillRect(lx + k * gap, ly, 8, 8);
      ctx.fillStyle = "#aab";
      ctx.textAlign = "left";
      ctx.fillText(labels[k][0], lx + 12 + k * gap, ly + 8);
    }
  }

  function drawLiveChart() {
    var canvas = document.getElementById("chart-live-range");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    var PAD = { top: 24, right: 24, bottom: 34, left: 62 };
    ctx.fillStyle = "#0c121b"; ctx.fillRect(0, 0, W, H);
    var samples = LiveUwb.history.filter(function (s) { return s.status === "OK" && s.range != null; });
    if (!samples.length) {
      ctx.fillStyle = "#3a4a5a"; ctx.font = "14px monospace"; ctx.textAlign = "center";
      ctx.fillText("No ranging data \u2014 connect node_A and wait for OK samples", W / 2, H / 2);
      return;
    }
    var vals = samples.map(function (s) { return s.range; });
    var yMin = Math.max(0, Math.min.apply(null, vals) - 0.3);
    var yMax = Math.max.apply(null, vals) + 0.3;
    if (yMax - yMin < 0.5) { var mid = (yMax + yMin) / 2; yMin = mid - 0.25; yMax = mid + 0.25; }
    var W2 = W - PAD.left - PAD.right, H2 = H - PAD.top - PAD.bottom;
    function px(i) { return PAD.left + (samples.length > 1 ? i / (samples.length - 1) * W2 : W2 / 2); }
    function py(v) { return PAD.top  + (1 - (v - yMin) / (yMax - yMin)) * H2; }
    ctx.strokeStyle = "#1a2330"; ctx.lineWidth = 1;
    for (var t = 0; t <= 5; t++) {
      var v = yMin + (yMax - yMin) * t / 5, y = py(v);
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
      ctx.fillStyle = "#778899"; ctx.font = "11px monospace"; ctx.textAlign = "right";
      ctx.fillText(v.toFixed(2) + "m", PAD.left - 6, y + 4);
    }
    ctx.beginPath(); ctx.moveTo(px(0), py(vals[0]));
    vals.forEach(function (v, i) { ctx.lineTo(px(i), py(v)); });
    ctx.lineTo(px(vals.length - 1), PAD.top + H2);
    ctx.lineTo(px(0), PAD.top + H2);
    ctx.closePath(); ctx.fillStyle = "rgba(0,200,255,0.07)"; ctx.fill();
    ctx.beginPath(); ctx.strokeStyle = "#00c8ff"; ctx.lineWidth = 2;
    vals.forEach(function (v, i) { i === 0 ? ctx.moveTo(px(i), py(v)) : ctx.lineTo(px(i), py(v)); });
    ctx.stroke();
    var lv = vals[vals.length - 1];
    ctx.beginPath(); ctx.arc(px(vals.length - 1), py(lv), 5, 0, Math.PI * 2);
    ctx.fillStyle = "#00c8ff"; ctx.fill();
    ctx.fillStyle = "#4a5a6a"; ctx.font = "11px monospace"; ctx.textAlign = "center";
    ctx.fillText("\u2190 older   " + vals.length + " OK samples   newer \u2192", W / 2, H - 6);
  }

  function resetLive() {
    LiveUwb.history = [];
    LiveUwb.countOK = 0; LiveUwb.countErr = 0;
    LiveUwb.minRange = Infinity; LiveUwb.maxRange = -Infinity; LiveUwb.sumRange = 0;
    LiveUwb.filteredRangeM = null; LiveUwb.lastValidRangeM = null;
    LiveUwb.lastOkMs = null; LiveUwb.quality = "LOST";
    LiveBle.rssiHistory = []; LiveBle.recentTimestamps = [];
    LiveBle.packetCount = 0; LiveBle.lastSeenMs = 0; LiveBle.rssi = null;
    LiveBle.status = "BLE_NONE";
    State.bleFallbackEvents = 0; State.bleFallbackTotalMs = 0;
    State.bleAliveUwbLostStart = null;
    State.dropoutZoneCounts = {};
    LiveDiag.events = [];
    LiveDiag.nodeA.reinitCount = 0;
    LiveDiag.nodeA.consecutiveTimeout = 0;
    LiveDiag.nodeA.lastOkMs = null;
    LiveDiag.nodeA.lastTimeoutMs = null;
    LiveDiag.nodeA.lastSampleMs = null;
    LiveDiag.nodeB.reinitCount = 0;
    LiveDiag.nodeB.heartbeatSeen = false;
    LiveDiag.nodeB.lastReadyMs = null;
    LiveDiag.nodeB.lastPollMs = null;
    LiveDiag.nodeB.lastTxDoneMs = null;
    var lg = document.getElementById("live-log"); if (lg) lg.innerHTML = "";
    updateLivePanelUwb();
  }

  // =========================================================================
  // 14. CONTROLS
  // =========================================================================
  function setMode(mode) {
    State.mode = mode;
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("active", tabs[i].dataset.mode === mode);
    var modes = document.querySelectorAll(".mode");
    for (var j = 0; j < modes.length; j++) modes[j].classList.toggle("active", modes[j].id === "mode-" + mode);
    render();
  }

  function resetReplay(keepRows) {
    State.idx = 0;
    State.accSimSeconds = 0;
    State.lastTickMs = performance.now();
    State.history = [];
    State.riskRunStart = null;
    State.nearMisses = [];
    State.nearMissSeq = 1;
    State.responseStats = { total: 0, responded: 0 };
    State.zoneStats = {};
    State.vehicleStats = {};
    State.activeWorker = null;
    State.bleFallbackEvents = 0;
    State.bleFallbackTotalMs = 0;
    State.bleAliveUwbLostStart = null;
    State.dropoutZoneCounts = {};
    var dl = document.getElementById("debug-log"); if (dl) dl.innerHTML = "";
    if (!keepRows) State.rows = [];
    render();
  }

  function loadDefaultCsv() {
    fetch("sample_replay.csv").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }).then(function (text) {
      State.rows = parseCsv(text);
      resetReplay(true);
      logEvent("Loaded sample_replay.csv (" + State.rows.length + " rows)", "");
      State.playing = true;
    }).catch(function (err) {
      logEvent("Could not auto-load sample_replay.csv (" + err.message + "). Use 'Load CSV' button.", "");
    });
  }

  function wireUi() {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      (function (t) { t.addEventListener("click", function () { setMode(t.dataset.mode); }); })(tabs[i]);
    }
    var bp = document.getElementById("btn-play");
    if (bp) bp.addEventListener("click", function () { State.playing = true; State.lastTickMs = performance.now(); });
    var bps = document.getElementById("btn-pause");
    if (bps) bps.addEventListener("click", function () { State.playing = false; });
    var br = document.getElementById("btn-reset");
    if (br) br.addEventListener("click", function () { var rows = State.rows; resetReplay(true); State.rows = rows; });
    var ss = document.getElementById("speed-select");
    if (ss) ss.addEventListener("change", function (e) { State.speed = parseFloat(e.target.value); });
    var cf = document.getElementById("csv-file");
    if (cf) cf.addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        State.rows = parseCsv(String(r.result));
        resetReplay(true);
        logEvent("Loaded " + f.name + " (" + State.rows.length + " rows)", "");
        State.playing = true;
      };
      r.readAsText(f);
    });

    var btn_uwbA = document.getElementById("btn-connect-uwb-a");
    if (btn_uwbA) btn_uwbA.addEventListener("click", function () { connectUwb("A"); });
    var btn_uwbB = document.getElementById("btn-connect-uwb-b");
    if (btn_uwbB) btn_uwbB.addEventListener("click", function () { connectUwb("B"); });
    var btn_uwbAd = document.getElementById("btn-disconnect-uwb-a");
    if (btn_uwbAd) btn_uwbAd.addEventListener("click", function () { disconnectUwb("A", false); });
    var btn_uwbBd = document.getElementById("btn-disconnect-uwb-b");
    if (btn_uwbBd) btn_uwbBd.addEventListener("click", function () { disconnectUwb("B", false); });
    var btn_ble = document.getElementById("btn-connect-ble");
    if (btn_ble) btn_ble.addEventListener("click", function () { connectBle(); });
    var btn_bled = document.getElementById("btn-disconnect-ble");
    if (btn_bled) btn_bled.addEventListener("click", function () { disconnectBle(false); });

    var rl = document.getElementById("btn-reset-live");
    if (rl) rl.addEventListener("click", resetLive);

    // BLE filter inputs
    var fName = document.getElementById("ble-filter-name");
    if (fName) fName.addEventListener("change", function () { LiveBle.filterName = fName.value.trim(); });
    var fMac  = document.getElementById("ble-filter-mac");
    if (fMac) fMac.addEventListener("change", function () { LiveBle.filterMac = fMac.value.trim(); });
  }

  // =========================================================================
  // 15. BOOT
  // =========================================================================
  window.addEventListener("DOMContentLoaded", function () {
    wireUi();
    setMode("driver");
    loadDefaultCsv();
    requestAnimationFrame(tick);
    // 2 Hz background refresh for the diagnostic panel so the link state and
    // 'seconds since' counters keep ticking even when no firmware line arrives.
    setInterval(function () {
      if (LiveUwb.connectedA || LiveUwb.connectedB) updateLivePanelUwb();
    }, 500);
  });

  // Expose for inspection
  window.PBV = {
    State: State,
    LiveBle: LiveBle,
    LiveUwb: LiveUwb,
    LiveDiag: LiveDiag,
    getCurrentFusedSample: getCurrentFusedSample,
    classifyRisk: classifyRisk,
    parseCsv: parseCsv,
  };
})();
