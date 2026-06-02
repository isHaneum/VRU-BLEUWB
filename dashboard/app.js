/* PBV Near-Miss Safety HMI Dashboard
 * Replay engine + rule-based risk classifier + driver/debug/fleet renderers.
 * Pure browser JS — no build step. Open index.html directly.
 */
(function () {
  "use strict";

  // -------------- State --------------
  const State = {
    rows: [],
    idx: 0,
    playing: false,
    speed: 1,
    lastTickMs: 0,
    accSimSeconds: 0,
    mode: "driver",
    history: [],            // recent samples with risk
    historyMax: 120,         // ~ 2 min @ 1 Hz
    riskRunStart: null,      // {level, t}
    nearMisses: [],
    nearMissSeq: 1,
    responseStats: { total: 0, responded: 0 },
    zoneStats: {},           // zone -> {total,crit,warn,unc,timeout}
    vehicleStats: {},        // vehicle -> {total,crit}
    activeWorker: null,      // last seen worker id during current run
    activeRunMinDist: Infinity,
    activeRunMaxSpeed: 0,
    activeRunBraked: false,
  };

  const RISK_MESSAGES = {
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
      msg: "Worker signal detected, but precise position is unavailable. Keep low speed and check surroundings.",
      action: "Proceed with caution. Visual check required.",
    },
  };

  // -------------- Risk classifier --------------
  function classifyRisk(ev) {
    const d = ev.distance_m;
    const moving = (ev.speed_kmh || 0) > 1.0;

    if (ev.uwb_status === "TIMEOUT" && ev.ble_detected) {
      return "UNCERTAIN";
    }
    if (d != null && d <= 5 && moving && !ev.brake_pressed) {
      return "CRITICAL";
    }
    if (d != null && d <= 5) {
      // close range but braking or stopped
      return "WARNING";
    }
    if (d != null && d <= 8) {
      return "WARNING";
    }
    if (d != null && d <= 15) {
      return "CAUTION";
    }
    if (ev.ble_detected && (ev.confidence || 0) >= 0.4 && d == null) {
      return "CAUTION";
    }
    return "NONE";
  }

  // -------------- CSV parsing --------------
  function parseCsv(text) {
    const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
    const header = lines.shift().split(",").map((s) => s.trim());
    const out = [];
    for (const line of lines) {
      const cols = line.split(",");
      const row = {};
      header.forEach((h, i) => { row[h] = cols[i] !== undefined ? cols[i].trim() : ""; });
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

  // -------------- Replay loop --------------
  function tick(nowMs) {
    if (!State.playing) { State.lastTickMs = nowMs; requestAnimationFrame(tick); return; }
    const dt = (nowMs - State.lastTickMs) / 1000;
    State.lastTickMs = nowMs;
    State.accSimSeconds += dt * State.speed;

    // advance index to all samples whose timestamp <= accSimSeconds
    while (State.idx < State.rows.length && State.rows[State.idx].t <= State.accSimSeconds) {
      processSample(State.rows[State.idx]);
      State.idx++;
    }

    if (State.idx >= State.rows.length) {
      State.playing = false;
    }

    render();
    requestAnimationFrame(tick);
  }

  function processSample(sample) {
    const risk = classifyRisk(sample);
    const entry = { ...sample, risk };
    State.history.push(entry);
    if (State.history.length > State.historyMax) State.history.shift();

    // Near-miss run tracking
    const isRisky = risk === "WARNING" || risk === "CRITICAL" || risk === "UNCERTAIN";
    if (isRisky) {
      if (!State.riskRunStart) {
        State.riskRunStart = { level: risk, t: sample.t };
        State.activeRunMinDist = Infinity;
        State.activeRunMaxSpeed = 0;
        State.activeRunBraked = false;
      } else if (rankRisk(risk) > rankRisk(State.riskRunStart.level)) {
        State.riskRunStart.level = risk; // escalate
      }
      if (sample.distance_m != null) State.activeRunMinDist = Math.min(State.activeRunMinDist, sample.distance_m);
      State.activeRunMaxSpeed = Math.max(State.activeRunMaxSpeed, sample.speed_kmh || 0);
      if (sample.brake_pressed) State.activeRunBraked = true;
      State.activeWorker = sample.worker_id || State.activeWorker;
    } else if (State.riskRunStart) {
      finalizeNearMiss(sample.t, sample.zone);
    }

    // Per-sample event log when risk level changes from previous
    const prev = State.history.length > 1 ? State.history[State.history.length - 2].risk : "NONE";
    if (prev !== risk) {
      logEvent(`t=${sample.t.toFixed(1)}s  risk ${prev} → ${risk}` +
        (sample.distance_m != null ? `  (d=${sample.distance_m.toFixed(1)}m)` : "") +
        (sample.uwb_status === "TIMEOUT" ? "  [UWB TIMEOUT]" : ""), risk);
    }
  }

  function rankRisk(r) {
    return { NONE: 0, CAUTION: 1, UNCERTAIN: 2, WARNING: 3, CRITICAL: 4 }[r] || 0;
  }

  function finalizeNearMiss(endT, zone) {
    const start = State.riskRunStart;
    State.riskRunStart = null;
    const duration = endT - start.t;
    // Threshold: WARNING/CRITICAL >= 1s, UNCERTAIN any (while BLE present already enforced in classifier)
    const meets = (start.level === "WARNING" || start.level === "CRITICAL")
      ? duration >= 1.0
      : start.level === "UNCERTAIN"
        ? duration >= 1.0
        : false;
    if (!meets) return;

    const vehicleId = State.history.length ? State.history[State.history.length - 1].vehicle_id : "PBV_01";
    const responded = State.activeRunBraked || State.activeRunMaxSpeed < 5;
    const sensor = start.level === "UNCERTAIN" ? "UWB_TIMEOUT_BLE_ONLY" : "UWB_OK";
    const ev = {
      event_id: `NM_${String(State.nearMissSeq++).padStart(4, "0")}`,
      vehicle_id: vehicleId,
      worker_id: State.activeWorker || "unknown",
      risk_level: start.level,
      min_distance_m: isFinite(State.activeRunMinDist) ? +State.activeRunMinDist.toFixed(1) : null,
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

    const z = (State.zoneStats[ev.zone] ||= { total: 0, crit: 0, warn: 0, unc: 0, timeout: 0 });
    z.total++;
    if (ev.risk_level === "CRITICAL") z.crit++;
    if (ev.risk_level === "WARNING") z.warn++;
    if (ev.risk_level === "UNCERTAIN") { z.unc++; z.timeout++; }

    const v = (State.vehicleStats[ev.vehicle_id] ||= { total: 0, crit: 0 });
    v.total++;
    if (ev.risk_level === "CRITICAL") v.crit++;

    logEvent(`★ Near-miss ${ev.event_id} ${ev.risk_level} @ ${ev.zone}  min=${ev.min_distance_m}m  dur=${ev.duration_s}s`, ev.risk_level);
  }

  // -------------- Rendering --------------
  function render() {
    const clock = document.getElementById("clock");
    clock.textContent = `t = ${State.accSimSeconds.toFixed(1)} s` +
      `   (${State.idx}/${State.rows.length})`;

    if (State.mode === "driver") renderDriver();
    else if (State.mode === "debug") renderDebug();
    else if (State.mode === "fleet") renderFleet();
  }

  function currentEntry() {
    return State.history.length ? State.history[State.history.length - 1] : null;
  }

  // ----- Driver HMI -----
  const MANEUVER_ICONS = { NONE: "\u2192", CAUTION: "!", WARNING: "\u25B2", CRITICAL: "\u25A0", UNCERTAIN: "?" };
  const MANEUVER_ACTIONS = { NONE: "PROCEED", CAUTION: "SLOW", WARNING: "SLOW DOWN", CRITICAL: "STOP", UNCERTAIN: "VERIFY" };

  function renderDriver() {
    const e = currentEntry();
    const risk = e ? e.risk : "NONE";
    const shell = document.getElementById("nav-shell");
    shell.dataset.level = risk;

    // Maneuver banner — mimics nav app's "next turn" card
    document.getElementById("maneuver-icon").textContent = MANEUVER_ICONS[risk];
    document.getElementById("maneuver-action").textContent = MANEUVER_ACTIONS[risk];
    const maneuverDist = document.getElementById("maneuver-distance");
    const maneuverText = document.getElementById("maneuver-text");
    if (e && e.distance_m != null) {
      maneuverDist.textContent = e.distance_m.toFixed(1) + " m";
      maneuverText.textContent = risk === "CRITICAL" ? "Worker on collision path"
        : risk === "WARNING" ? "Worker close to vehicle path"
        : risk === "CAUTION" ? "Worker in surrounding area"
        : "Worker tracked at safe distance";
    } else if (e && e.uwb_status === "TIMEOUT") {
      maneuverDist.textContent = "—";
      maneuverText.textContent = "UWB signal lost · range unknown";
    } else if (e && e.ble_detected) {
      maneuverDist.textContent = "BLE";
      maneuverText.textContent = "Worker tag detected nearby";
    } else {
      maneuverDist.textContent = "—";
      maneuverText.textContent = "All clear ahead";
    }

    document.getElementById("risk-chip").textContent = risk;
    document.getElementById("risk-message").textContent = RISK_MESSAGES[risk].msg;
    document.getElementById("risk-action").textContent = RISK_MESSAGES[risk].action;

    document.getElementById("speed-value").textContent = e ? Math.round(e.speed_kmh) : 0;
    document.getElementById("zone-value").textContent = e ? e.zone : "—";
    document.getElementById("brake-indicator").classList.toggle("on", !!(e && e.brake_pressed));

    const ble = document.getElementById("sensor-ble");
    const uwb = document.getElementById("sensor-uwb");
    setSensor(ble, e && e.ble_detected ? "on" : "");
    if (!e || e.distance_m == null) {
      setSensor(uwb, e && e.uwb_status === "TIMEOUT" ? "err" : "");
    } else {
      setSensor(uwb, "on");
    }

    document.getElementById("worker-id").textContent = e && e.worker_id ? e.worker_id : "—";
    if (e && e.distance_m != null) {
      document.getElementById("worker-distance").textContent = e.distance_m.toFixed(1) + " m";
    } else if (e && e.uwb_status === "TIMEOUT") {
      document.getElementById("worker-distance").textContent = "UWB timeout";
    } else if (e && e.ble_detected) {
      document.getElementById("worker-distance").textContent = "BLE only (range unknown)";
    } else {
      document.getElementById("worker-distance").textContent = "—";
    }
    document.getElementById("worker-conf").textContent = e ? (e.confidence * 100).toFixed(0) + "%" : "—";
    document.getElementById("worker-rssi").textContent = e && e.ble_rssi != null ? e.ble_rssi + " dBm" : "—";

    drawZoneCanvas(e);
  }

  function setSensor(node, state) {
    const dot = node.querySelector(".dot");
    dot.classList.remove("on", "warn", "err");
    if (state) dot.classList.add(state);
    node.classList.toggle("on", !!state);
  }

  function drawZoneCanvas(e) {
    const canvas = document.getElementById("zone-canvas");
    const parent = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth, h = parent.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Vehicle near the bottom; map shows ~18 m ahead
    const vx = w / 2;
    const vy = h * 0.78;
    const meters = 22;
    const scale = (h * 0.85) / meters;

    // Background (asphalt) gradient
    const grd = ctx.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, "#0a1018"); grd.addColorStop(1, "#070b11");
    ctx.fillStyle = grd; ctx.fillRect(0, 0, w, h);

    // Road as a perspective trapezoid
    const roadBot = w * 0.62, roadTop = w * 0.40;
    ctx.beginPath();
    ctx.moveTo(vx - roadBot / 2, h);
    ctx.lineTo(vx + roadBot / 2, h);
    ctx.lineTo(vx + roadTop / 2, 0);
    ctx.lineTo(vx - roadTop / 2, 0);
    ctx.closePath();
    ctx.fillStyle = "#11171f"; ctx.fill();

    // Road edges
    ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(vx - roadBot / 2, h); ctx.lineTo(vx - roadTop / 2, 0);
    ctx.moveTo(vx + roadBot / 2, h); ctx.lineTo(vx + roadTop / 2, 0);
    ctx.stroke();

    // Animated dashed center lane
    const dashOffset = (performance.now() / 30) % 32;
    ctx.strokeStyle = "rgba(255,206,58,0.55)"; ctx.lineWidth = 4;
    ctx.setLineDash([16, 16]); ctx.lineDashOffset = -dashOffset;
    ctx.beginPath(); ctx.moveTo(vx, h); ctx.lineTo(vx, 0); ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0;

    // 5 m distance ticks
    ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.font = "11px Segoe UI";
    for (let d = 5; d <= 18; d += 5) {
      const y = vy - d * scale; if (y < 0) break;
      ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(w - 20, y); ctx.stroke();
      ctx.fillText(d + " m", 24, y - 4);
    }

    // Range zones around the vehicle
    const zones = [
      { r: 15, fill: "rgba(255,206,58,0.10)", stroke: "rgba(255,206,58,0.55)" },
      { r: 10, fill: "rgba(255,138,42,0.13)", stroke: "rgba(255,138,42,0.65)" },
      { r: 5,  fill: "rgba(255,59,59,0.18)",  stroke: "rgba(255,59,59,0.80)"  },
    ];
    for (const z of zones) {
      ctx.beginPath(); ctx.arc(vx, vy, z.r * scale, 0, Math.PI * 2);
      ctx.fillStyle = z.fill; ctx.fill();
      ctx.strokeStyle = z.stroke; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // Worker range arc (bearing unknown)
    if (e && e.distance_m != null) {
      const r = e.distance_m * scale;
      const COLOR = { NONE: "rgba(160,170,185,0.9)", CAUTION: "rgba(255,206,58,1)",
        WARNING: "rgba(255,138,42,1)", CRITICAL: "rgba(255,59,59,1)", UNCERTAIN: "rgba(138,123,255,1)" };
      const col = COLOR[e.risk];
      ctx.strokeStyle = col; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(vx, vy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.5; ctx.setLineDash([6, 6]); ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.arc(vx, vy, Math.max(0, r - scale), 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(vx, vy, r + scale, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1; ctx.setLineDash([]);

      ctx.font = "bold 14px Segoe UI";
      const label = e.distance_m.toFixed(1) + " m";
      const lw = ctx.measureText(label).width + 16;
      const ly = vy - r - 14;
      ctx.fillStyle = col;
      roundRect(ctx, vx - lw / 2, ly - 14, lw, 22, 11); ctx.fill();
      ctx.fillStyle = "#0a0e14"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, vx, ly - 3);
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";

      ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.font = "10px Segoe UI";
      ctx.fillText("bearing unknown · single anchor", vx + r * 0.65, vy + 4);
    } else if (e && e.uwb_status === "TIMEOUT" && e.ble_detected) {
      ctx.fillStyle = "rgba(138,123,255,0.16)";
      ctx.beginPath(); ctx.arc(vx, vy, 15 * scale, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(138,123,255,0.9)"; ctx.setLineDash([10, 8]); ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(vx, vy, 15 * scale, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(138,123,255,1)"; ctx.font = "bold 13px Segoe UI"; ctx.textAlign = "center";
      ctx.fillText("UWB TIMEOUT · BLE only", vx, vy - 15 * scale - 10);
      ctx.textAlign = "left";
    } else if (e && e.ble_detected) {
      ctx.fillStyle = "rgba(255,206,58,0.08)";
      ctx.beginPath(); ctx.arc(vx, vy, 15 * scale, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,206,58,0.85)"; ctx.font = "12px Segoe UI"; ctx.textAlign = "center";
      ctx.fillText("BLE detected · awaiting UWB range", vx, vy - 15 * scale - 8);
      ctx.textAlign = "left";
    }

    // Vehicle (arrow-shaped PBV) with glow
    ctx.save();
    ctx.translate(vx, vy);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 50);
    glow.addColorStop(0, "rgba(79,209,255,0.45)");
    glow.addColorStop(1, "rgba(79,209,255,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, 50, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -28);
    ctx.lineTo(16, 12);
    ctx.lineTo(10, 22);
    ctx.lineTo(-10, 22);
    ctx.lineTo(-16, 12);
    ctx.closePath();
    ctx.fillStyle = "#4fd1ff";
    ctx.shadowColor = "rgba(79,209,255,0.6)"; ctx.shadowBlur = 12;
    ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(10,14,20,0.55)";
    ctx.beginPath();
    ctx.moveTo(0, -18); ctx.lineTo(10, 0); ctx.lineTo(-10, 0); ctx.closePath();
    ctx.fill();
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
    drawLineChart("chart-ble", State.history.map((h) => h.ble_rssi), {
      yMin: -100, yMax: -40, color: "#4fd1ff", label: "RSSI", suffix: " dBm",
    });
    drawLineChart("chart-uwb", State.history.map((h) => h.distance_m), {
      yMin: 0, yMax: 20, color: "#29d39a", label: "range", suffix: " m",
    });
    drawStatusBar("chart-status", State.history.map((h) => ({
      status: h.uwb_status,
      ble: h.ble_detected,
      risk: h.risk,
    })));

    const e = currentEntry();
    const cur = document.getElementById("debug-current");
    cur.innerHTML = "";
    if (e) {
      const fields = [
        ["timestamp", e.t.toFixed(1) + " s"],
        ["vehicle_id", e.vehicle_id],
        ["speed_kmh", e.speed_kmh],
        ["brake_pressed", String(e.brake_pressed)],
        ["worker_id", e.worker_id || "—"],
        ["distance_m", e.distance_m != null ? e.distance_m.toFixed(2) : "—"],
        ["uwb_status", e.uwb_status || "—"],
        ["ble_detected", String(e.ble_detected)],
        ["ble_rssi", e.ble_rssi != null ? e.ble_rssi : "—"],
        ["confidence", e.confidence.toFixed(2)],
        ["zone", e.zone],
        ["condition", e.condition],
        ["risk", e.risk],
      ];
      for (const [k, v] of fields) {
        cur.insertAdjacentHTML("beforeend", `<tr><td>${k}</td><td>${v}</td></tr>`);
      }
    }

    const tbody = document.querySelector("#debug-events tbody");
    tbody.innerHTML = "";
    const recent = State.history.slice(-20).reverse();
    for (const r of recent) {
      tbody.insertAdjacentHTML("beforeend",
        `<tr class="risk-${r.risk}">
          <td>${r.t.toFixed(1)}</td>
          <td>${r.vehicle_id}</td>
          <td>${Math.round(r.speed_kmh)}</td>
          <td>${r.brake_pressed ? "Y" : "—"}</td>
          <td>${r.worker_id || "—"}</td>
          <td>${r.distance_m != null ? r.distance_m.toFixed(1) : "—"}</td>
          <td>${r.uwb_status || "—"}</td>
          <td>${r.ble_detected ? "Y" : "—"}</td>
          <td>${r.ble_rssi != null ? r.ble_rssi : "—"}</td>
          <td>${r.confidence.toFixed(2)}</td>
          <td>${r.zone}</td>
          <td>${r.condition}</td>
        </tr>`);
    }
  }

  function drawLineChart(id, series, opt) {
    const canvas = document.getElementById(id);
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // grid
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // axis labels
    ctx.fillStyle = "#8a96a8"; ctx.font = "10px Segoe UI";
    ctx.fillText(opt.yMax + opt.suffix, 4, 10);
    ctx.fillText(opt.yMin + opt.suffix, 4, h - 2);

    const n = Math.max(series.length, 2);
    const xs = (i) => 40 + (i * (w - 44)) / (n - 1);
    const ys = (v) => {
      if (v == null || isNaN(v)) return null;
      const t = (v - opt.yMin) / (opt.yMax - opt.yMin);
      return h - t * h;
    };
    ctx.strokeStyle = opt.color; ctx.lineWidth = 2; ctx.beginPath();
    let started = false;
    for (let i = 0; i < series.length; i++) {
      const y = ys(series[i]);
      if (y == null) { started = false; continue; }
      if (!started) { ctx.moveTo(xs(i), y); started = true; }
      else ctx.lineTo(xs(i), y);
    }
    ctx.stroke();

    // current value dot + label
    for (let i = series.length - 1; i >= 0; i--) {
      const v = series[i]; const y = ys(v);
      if (y != null) {
        ctx.fillStyle = opt.color;
        ctx.beginPath(); ctx.arc(xs(i), y, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#e6edf5"; ctx.font = "bold 11px Segoe UI";
        ctx.fillText(`${opt.label}: ${v}${opt.suffix}`, w - 110, 12);
        break;
      }
    }
  }

  function drawStatusBar(id, arr) {
    const canvas = document.getElementById(id);
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const n = Math.max(arr.length, 1);
    const bw = (w - 44) / n;
    ctx.fillStyle = "#8a96a8"; ctx.font = "10px Segoe UI";
    ctx.fillText("UWB", 4, h / 2 - 4);
    ctx.fillText("BLE", 4, h - 6);
    const halfH = (h - 14) / 2;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      // UWB row
      let c = "#3a4658";
      if (s.status === "OK") c = "#29d39a";
      else if (s.status === "TIMEOUT") c = "#8a7bff";
      ctx.fillStyle = c;
      ctx.fillRect(40 + i * bw, 2, Math.max(1, bw - 1), halfH);
      // BLE row
      ctx.fillStyle = s.ble ? "#4fd1ff" : "#1f2a38";
      ctx.fillRect(40 + i * bw, halfH + 6, Math.max(1, bw - 1), halfH);
    }
  }

  function logEvent(text, risk) {
    const log = document.getElementById("debug-log");
    const line = document.createElement("div");
    line.className = "ln " + (risk || "");
    line.innerHTML = `<b>[${new Date().toLocaleTimeString()}]</b> ${text}`;
    log.prepend(line);
    while (log.childElementCount > 200) log.removeChild(log.lastChild);
  }

  // ----- Fleet -----
  function renderFleet() {
    const total = State.nearMisses.length;
    const crit = State.nearMisses.filter((n) => n.risk_level === "CRITICAL").length;
    const warn = State.nearMisses.filter((n) => n.risk_level === "WARNING").length;
    const unc = State.nearMisses.filter((n) => n.risk_level === "UNCERTAIN").length;
    document.getElementById("kpi-total").textContent = total;
    document.getElementById("kpi-crit").textContent = crit;
    document.getElementById("kpi-warn").textContent = warn;
    document.getElementById("kpi-unc").textContent = unc;

    const rs = State.responseStats;
    document.getElementById("kpi-resp").textContent = rs.total
      ? Math.round((rs.responded / rs.total) * 100) + "%"
      : "—";

    // Most risky zone
    let riskyZone = "—", riskyMax = 0;
    let unrelZone = "—", unrelMax = 0;
    for (const [zone, st] of Object.entries(State.zoneStats)) {
      if (st.total > riskyMax) { riskyMax = st.total; riskyZone = zone; }
      if (st.timeout > unrelMax) { unrelMax = st.timeout; unrelZone = zone; }
    }
    document.getElementById("kpi-zone").textContent = riskyZone + (riskyMax ? ` (${riskyMax})` : "");
    document.getElementById("kpi-unrel").textContent = unrelZone + (unrelMax ? ` (${unrelMax})` : "");
    document.getElementById("kpi-vehicles").textContent = Object.keys(State.vehicleStats).length;

    const zt = document.querySelector("#zone-table tbody");
    zt.innerHTML = "";
    for (const [zone, st] of Object.entries(State.zoneStats).sort((a, b) => b[1].total - a[1].total)) {
      zt.insertAdjacentHTML("beforeend",
        `<tr><td>${zone}</td><td>${st.total}</td><td>${st.crit}</td><td>${st.warn}</td><td>${st.unc}</td><td>${st.timeout}</td></tr>`);
    }

    const vt = document.querySelector("#vehicle-table tbody");
    vt.innerHTML = "";
    for (const [v, st] of Object.entries(State.vehicleStats).sort((a, b) => b[1].total - a[1].total)) {
      vt.insertAdjacentHTML("beforeend",
        `<tr><td>${v}</td><td>${st.total}</td><td>${st.crit}</td></tr>`);
    }

    const nt = document.querySelector("#nearmiss-table tbody");
    nt.innerHTML = "";
    for (const ev of State.nearMisses.slice(0, 30)) {
      nt.insertAdjacentHTML("beforeend",
        `<tr class="risk-${ev.risk_level}">
          <td>${ev.event_id}</td>
          <td>${ev.vehicle_id}</td>
          <td>${ev.worker_id}</td>
          <td>${ev.risk_level}</td>
          <td>${ev.min_distance_m != null ? ev.min_distance_m : "—"}</td>
          <td>${ev.vehicle_speed_kmh}</td>
          <td>${ev.zone}</td>
          <td>${ev.duration_s}</td>
          <td>${ev.sensor_state}</td>
          <td>${ev.driver_response}</td>
        </tr>`);
    }
  }

  // -------------- Controls --------------
  function setMode(mode) {
    State.mode = mode;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
    document.querySelectorAll(".mode").forEach((m) => m.classList.toggle("active", m.id === "mode-" + mode));
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
    document.getElementById("debug-log").innerHTML = "";
    if (!keepRows) State.rows = [];
    render();
  }

  function loadDefaultCsv() {
    fetch("sample_replay.csv")
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then((text) => {
        State.rows = parseCsv(text);
        resetReplay(true);
        logEvent(`Loaded sample_replay.csv (${State.rows.length} rows)`, "");
        State.playing = true;
      })
      .catch((err) => {
        // file:// fetch can fail in some browsers — provide an inline fallback message
        logEvent("Could not auto-load sample_replay.csv (" + err.message + "). Use 'Load CSV' button.", "");
      });
  }

  function wireUi() {
    document.querySelectorAll(".tab").forEach((t) => {
      t.addEventListener("click", () => setMode(t.dataset.mode));
    });
    document.getElementById("btn-play").addEventListener("click", () => {
      State.playing = true; State.lastTickMs = performance.now();
    });
    document.getElementById("btn-pause").addEventListener("click", () => { State.playing = false; });
    document.getElementById("btn-reset").addEventListener("click", () => {
      const rows = State.rows; resetReplay(true); State.rows = rows;
    });
    document.getElementById("speed-select").addEventListener("change", (e) => {
      State.speed = parseFloat(e.target.value);
    });
    document.getElementById("csv-file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        State.rows = parseCsv(String(r.result));
        resetReplay(true);
        logEvent(`Loaded ${f.name} (${State.rows.length} rows)`, "");
        State.playing = true;
      };
      r.readAsText(f);
    });
  }

  // -------------- Boot --------------
  window.addEventListener("DOMContentLoaded", () => {
    wireUi();
    setMode("driver");
    loadDefaultCsv();
    requestAnimationFrame(tick);
  });

  // Expose for ad-hoc inspection
  window.PBV = { State, classifyRisk, parseCsv };
})();
