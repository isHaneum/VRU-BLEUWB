# PBV Near-Miss Safety HMI Dashboard

A browser-only prototype that turns cooperative BLE/UWB worker signals into a
**PBV in-vehicle safety warning HMI** plus a **fleet-level near-miss analytics
dashboard**. Runs without any live hardware via CSV replay.

> Open `dashboard/index.html` directly in a modern browser. No build step,
> no `npm install`, no server required.

---

## 1. Purpose

Modern Purpose-Built Vehicles (PBVs) — last-mile delivery shuttles, factory
floor pods, airport ground vehicles — operate in shared spaces with workers on
foot. Cooperative sensing (workers carry BLE tags, the PBV carries a UWB
anchor) can detect occluded workers before line-of-sight sensors do.

But raw BLE RSSI and raw UWB ranges are not what a driver should see. This
dashboard demonstrates the translation layer:

- **Sensor input** → BLE detection, UWB range, UWB status
- **Risk classifier** → `NONE / CAUTION / WARNING / CRITICAL / UNCERTAIN`
- **Driver HMI** → simple, calm, automotive-grade warning surface
- **Fleet operations view** → near-miss event log, zone risk ranking, UWB
  reliability per zone

## 2. Why the project pivoted

The earlier direction was a raw BLE/UWB detection demo. Two issues forced a
pivot:

1. **BLE alone cannot tell "dangerous worker" from "passer-by"** — RSSI is too
   noisy. Raw BLE alerts are not safe to surface to a driver.
2. **UWB hardware (DWM3000 / DWM3001 / NRF52840) is unstable in this project
   at this stage.** Solving driver/Zephyr/SDK problems is a long-running
   firmware effort that should not block the research story.

So the project's deliverable is now the **HMI + analytics layer** that sits on
top of cooperative sensing. BLE/UWB remain as sensor input sources (live or
replayed). The risk logic, HMI states, and near-miss event pipeline can be
designed, evaluated, and demonstrated even before the UWB stack is fully
stable.

## 3. How to run

```text
1. git clone <this repo>
2. Open dashboard/index.html in Chrome, Edge, or Firefox.
3. (Optional) Click "Load CSV" to replay your own log.
```

If your browser blocks `fetch()` for local CSV files (some `file://` builds of
Firefox do), use the **Load CSV** button to load `sample_replay.csv` manually.

Controls (top bar):

- **Driver HMI / Debug Monitor / Fleet Safety** — switch between the three views
- **Play / Pause / Reset** — replay controls
- **Speed** — 0.5× to 4× replay speed
- **Load CSV** — replay any log that matches the schema below

## 4. CSV replay schema

`sample_replay.csv` columns (one row per sample, typically 1 Hz):

| column         | type    | description                                            |
|----------------|---------|--------------------------------------------------------|
| `timestamp`    | float   | Seconds from start of recording                        |
| `vehicle_id`   | string  | e.g. `PBV_01`                                          |
| `speed_kmh`    | float   | Vehicle speed                                          |
| `brake_pressed`| bool    | `true` / `false`                                       |
| `worker_id`    | string  | Worker tag identifier (empty when no worker)           |
| `object_type`  | string  | `worker`, `cart`, … (free-form)                        |
| `distance_m`   | float   | UWB range in meters (empty when no UWB fix)            |
| `uwb_status`   | string  | `OK`, `TIMEOUT`, empty                                 |
| `ble_detected` | bool    | Whether a cooperative BLE advert was heard             |
| `confidence`   | float   | 0.0 – 1.0 fused confidence in the worker presence      |
| `zone`         | string  | Operating area label (e.g. `Loading Area B`)           |
| `ble_rssi`     | int     | BLE RSSI in dBm (negative)                             |
| `condition`    | string  | Free-form scenario tag (`caution_zone`, `uwb_timeout`) |

## 5. Risk engine rules

Implemented in `app.js` as `classifyRisk(event)`. Plain, rule-based, easy to
audit:

```text
if uwb_status == TIMEOUT and ble_detected           → UNCERTAIN
if distance ≤ 5 m  and moving  and !brake_pressed   → CRITICAL
if distance ≤ 5 m  (braking or stopped)             → WARNING
if distance ≤ 8 m                                   → WARNING
if distance ≤ 15 m                                  → CAUTION
if BLE detected and confidence ≥ 0.4 and no UWB     → CAUTION
otherwise                                           → NONE
```

A **near-miss event** is generated when `WARNING / CRITICAL / UNCERTAIN`
persists for at least 1 second. Each near-miss record contains:

```json
{
  "event_id": "NM_0001",
  "vehicle_id": "PBV_01",
  "worker_id": "worker_03",
  "risk_level": "WARNING",
  "min_distance_m": 5.6,
  "vehicle_speed_kmh": 11,
  "zone": "Loading Area B",
  "duration_s": 3.2,
  "sensor_state": "UWB_OK",
  "driver_response": "slowed_down"
}
```

## 6. The three modes

### Driver HMI
The in-vehicle infotainment view. The driver sees:

- A large color-coded **risk card** (`NONE / CAUTION / WARNING / CRITICAL / UNCERTAIN`)
- A short driver-friendly message and a recommended action
- Vehicle speed, brake state, current zone
- BLE / UWB / Replay status dots
- A vehicle-centered radar showing the **15 m / 10 m / 5 m** zones

**Important visualization rule:** A single UWB anchor only gives *distance*,
not *bearing*. The dashboard therefore draws a **range ring** around the
vehicle (with a ±1 m dashed uncertainty band), not a fake 2D point. When UWB
times out but BLE is still present, the dashboard paints the entire 15 m
disc as an **UNCERTAIN blind zone** instead of inventing a position.

### Debug Monitor
The engineering view used to verify the pipeline:

- BLE RSSI time-series
- UWB range time-series
- UWB status timeline (OK / TIMEOUT) and BLE detected band
- Current raw sample (key–value)
- Recent raw sample table (last 20 rows)
- Event log (risk transitions, near-miss generation)

### Fleet Safety Dashboard
The PBV operator / fleet manager view. Aggregates near-miss events into KPIs:

- Total / Critical / Warning / Uncertain near-miss counts
- Driver response rate (braked or slowed down)
- Most risky zone, most unreliable UWB zone
- Zone-level breakdown table
- Vehicle ranking
- Recent near-miss event log

## 7. Connecting live BLE/UWB later

The replay loop and the renderers consume the same shape of object that
live sensors would produce. To go live, replace `loadDefaultCsv()` with a
streaming source (WebSocket, Web Serial, MQTT-over-WS, etc.) that calls
`processSample({ t, vehicle_id, speed_kmh, brake_pressed, worker_id,
distance_m, uwb_status, ble_detected, confidence, zone, ble_rssi })` for each
new sample. Everything downstream — risk classification, HMI, near-miss
generation, fleet KPIs — works unchanged.

Suggested ingestion bridges (out of scope for this prototype):

- ESP32 BLE scanner → serial → small Node/Python bridge → WebSocket → dashboard
- DWM3000 / DWM3001 / nRF52840 UWB anchor → MQTT → dashboard
- Existing iOS `ExperimentLogger` app → CSV export → load via the **Load CSV**
  button

## Files

```
dashboard/
  index.html          Layout for all three modes
  styles.css          Dark automotive HMI styling
  app.js              Replay engine, risk classifier, renderers
  sample_replay.csv   Demo scenario (NONE → CAUTION → WARNING → CRITICAL → UNCERTAIN → recovery)
  README.md           This file
```

The previous React/Vite serial-monitor dashboard has been preserved under
`dashboard-legacy/` and is not required to run this prototype.
