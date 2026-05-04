# Cooperative Warning Design

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                         Physical Scene                                 │
│                                                                        │
│   [VRU: BLE beacon + UWB tag]                                          │
│         │ BLE advertisement + UWB TWR                                  │
│         ▼                                                              │
│   [Node A: ESP32 + DWM3000]   ──── ESP-NOW / UDP ────►  [Node B]       │
│   (infrastructure RSU, or      VRU_COOP_ALERT_V1 msg    (following     │
│    leading vehicle)             with track, range,        vehicle,     │
│                                 risk_score, risk_level)   cross-       │
│                                                           traffic)     │
└────────────────────────────────────────────────────────────────────────┘
```

**Node A** detects and tracks the VRU directly via BLE scanning and UWB ranging.  
**Node B** receives a pre-processed alert from Node A and can issue a driver warning
before it achieves its own independent detection.

The extra warning time provided to Node B — measured from `COOP_MESSAGE_RECEIVED` to
Node B's own `VISIBLE` event — is the primary metric of the cooperative system's value.

---

## Communication Layer

### Primary: ESP-NOW (preferred for firmware)
- IEEE 802.11 management frames, no Wi-Fi association required
- Max payload: 250 bytes
- Typical latency: 1–3 ms (same channel, same room)
- MAC address pairing required at firmware initialization
- Packet loss rate measurable by Node B (seq_id gaps)

### Alternative: Wi-Fi UDP (for higher-range testing)
- Both nodes connect to same 2.4 GHz AP
- UDP unicast: Node A → Node B IP
- Higher latency (~5–30 ms), range up to ~50 m outdoors
- Easier to extend to multi-node or logging server

---

## Message Format

All cooperative alert messages use the `VRU_COOP_ALERT_V1` JSON schema.

```json
{
  "msg_type":    "VRU_COOP_ALERT_V1",
  "sender_id":   "node_A",
  "ts_ms":       123456,
  "track_id":    "vru_temp_01",
  "target_class":"pedestrian",
  "source":      ["ble", "uwb"],
  "range_m":     8.4,
  "rssi_dbm":    -72,
  "risk_score":  0.78,
  "risk_level":  "WARN",
  "scenario":    "ALLEY_DART_OUT",
  "ttl_ms":      300
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `msg_type` | string | Always `"VRU_COOP_ALERT_V1"` — version control |
| `sender_id` | string | Matches Node A's `NODE_ID` define in firmware |
| `ts_ms` | uint32 | ESP32 `millis()` at time of transmission |
| `track_id` | string | Temporary track ID, stable within one experiment session |
| `target_class` | string | `"pedestrian"`, `"bicycle"`, `"motorcycle"`, `"scooter"` |
| `source` | array | Sensor sources used: `"ble"`, `"uwb"`, or both |
| `range_m` | float | Most recent UWB range to VRU in meters |
| `rssi_dbm` | int | Most recent BLE RSSI in dBm |
| `risk_score` | float | Risk filter output, 0.0–1.0 |
| `risk_level` | string | `"NONE"`, `"LOW"`, `"WARN"`, `"ALERT"` |
| `scenario` | string | Active scenario ID (set manually or from operator input) |
| `ttl_ms` | uint16 | Time-to-live: Node B should discard stale messages beyond this age |

---

## Latency Measurement

Node A logs: `timestamp_ms,node_id,event,msg_id,latency_ms,risk_score,risk_level`  
Node B logs: `timestamp_ms,node_id,event,msg_id,latency_ms,risk_score,risk_level`

Latency is computed as:  
```
latency_ms = ts_ms_received_at_NodeB - ts_ms_sent_from_NodeA
```

⚠️ This requires clock synchronization between Node A and Node B.
In the current PoC, clocks are NOT synchronized. Use relative timestamps only.
Absolute latency requires NTP or PPS-based sync, which is future work.

---

## Node B Warning Output

Node B outputs to Serial at 115200 baud in CSV format:

```
timestamp_ms,event,sender_id,msg_id,range_m,rssi_dbm,risk_score,risk_level
```

Node B also drives a hardware warning indicator:
- `risk_level == "WARN"`: LED blink at 2 Hz
- `risk_level == "ALERT"`: LED solid on + buzzer (if connected)
- `risk_level == "NONE"` or `"LOW"`: LED off

---

## Failure Modes and Mitigations

| Failure Mode | Description | Mitigation |
|--------------|-------------|------------|
| ESP-NOW pairing failure | Node B MAC unknown at startup | Hard-code peer MAC in firmware; log warning on pairing failure |
| Message loss | ESP-NOW packet drop in crowded 2.4 GHz | Retransmit once after 50 ms if no ACK (ESP-NOW supports ACK) |
| Clock drift | ts_ms comparison invalid across nodes | Use relative timestamps; add NTP as future work |
| TTL exceeded | Node B receives stale message after VRU has moved | Node B checks `millis() - ts_ms_received > ttl_ms` and discards |
| False positive relay | Node A sends WARN for sidewalk pedestrian | Risk filter suppression should block low-risk messages; only WARN/ALERT transmitted |
| Channel collision | Both nodes on same Wi-Fi channel as AP | Use ESP-NOW channel matching the AP channel or switch to dedicated channel |

---

## Multi-node Extension (Future Work)

The `VRU_COOP_ALERT_V1` schema is designed for broadcast:
- Change `sender_id` to a dynamic node ID
- Node B can re-broadcast to Node C with incremented `hop_count` field (add in V2)
- Risk score from multiple nodes can be fused: `risk_score_fused = max(scores)` (conservative) or Bayesian combination
