# Research Overview

## Problem Statement

Vulnerable Road Users (VRUs) — pedestrians, cyclists, and micro-mobility riders — account for a disproportionate share of traffic fatalities. In South Korea, pedestrian fatalities account for approximately 38% of all road deaths (MOLIT, 2022). A key contributing factor is **occlusion**: the ego vehicle cannot see the VRU until the last moment, leaving insufficient time for the driver (or ADAS) to respond.

### Why BLE Alone is Insufficient

Bluetooth Low Energy (BLE) can detect the presence of a nearby VRU carrying a smartphone or BLE tag. However:

1. **RSSI is not a reliable range estimator** in urban multipath environments (±10 dB typical variation).
2. **A sidewalk pedestrian 25 m away looks identical in RSSI** to a dart-out pedestrian 10 m away with an unfavorable antenna orientation.
3. **BLE provides no bearing or lane-position information** without multi-antenna angle-of-arrival hardware.

A system that triggers a warning on every BLE detection within 30 m will have an unacceptably high false positive rate in dense urban environments (Scenario S3).

### Why UWB Alone is Insufficient

Ultra-Wideband (UWB) ranging provides centimeter-accurate distance measurement and is largely immune to multipath. However:

1. **UWB requires active ranging (TWR protocol)** which consumes significant power and requires the responder to be awake and responding.
2. **Continuous UWB polling of all possible VRUs** at a scan rate sufficient for early warning is computationally and power-expensive.
3. **UWB requires prior knowledge of which device to range** — in a public scenario, there is no pre-established connection to the VRU.

### Proposed Architecture

This project proposes a **two-stage detection pipeline**:

```
Stage 1 (Candidate Detection): BLE passive scanning
  → Low power, always-on, ~100 ms scan interval
  → Triggers when RSSI ≥ threshold AND hit_count ≥ minimum
  → Filters: sidewalk-parallel suppression, stable-RSSI suppression

Stage 2 (Ranging Confirmation): UWB TWR
  → Activated only when BLE candidate detected
  → Provides range and range-rate for risk score computation
  → Confirms or rejects the BLE candidate within ~500 ms

Stage 3 (Risk Filtering): Rule-based state machine
  → Combines BLE score, UWB score, road-entry probability, conflict geometry
  → Outputs: IDLE → CANDIDATE → CONFIRMED_RISK / SUPPRESSED
  → Cooperative warning transmitted at CONFIRMED_RISK (risk_level ≥ WARN)
```

This architecture means:
- UWB is only active when BLE has already detected a candidate, reducing duty cycle.
- False positives from sidewalk pedestrians are suppressed before UWB is even activated.
- The cooperative layer allows a second node to receive pre-processed alerts before independent detection.

> *"This project does not claim that BLE alone can detect dangerous VRUs. Instead, BLE is used as a low-power candidate trigger, UWB is used for ranging confirmation, and scenario-aware risk filtering is used to suppress false positives from non-risk sidewalk pedestrians."*

---

## Scenario Taxonomy

Six experimental scenarios are defined:

| ID | Name | Type | Primary Challenge |
|----|------|------|-------------------|
| S1 | Alley Dart-out | True Positive | Sudden emergence from NLOS zone |
| S2 | Right-turn Conflict | True Positive | Occlusion by A-pillar / leading vehicle |
| S3 | Four-lane Sidewalk False Positive | False Positive | Non-risk pedestrian in BLE range |
| S4 | Lane-splitting Two-wheeler | True Positive | Lateral approach, no bearing info |
| S5 | Carry Position Degradation | Characterization | Signal quality vs. tag position |
| S6 | Cooperative Warning | System test | Inter-node V2X alert latency |

Full definitions in [docs/scenario_definitions.md](scenario_definitions.md).

---

## System Components

### Firmware
- **BLE Beacon** (`firmware/ESP32_BLE/ble_beacon/`): VRU-side ESP32, advertises at 100 ms interval with manufacturer data containing VRU type and TX power.
- **BLE Scanner** (`firmware/ESP32_BLE/ble_scanner/`): Infrastructure/vehicle ESP32, logs all detections as CSV via USB Serial.
- **UWB Initiator** (`firmware/UWB_DWM3000/uwb_initiator/`): Infrastructure/vehicle ESP32 + DWM3000, initiates TWR upon BLE trigger.
- **UWB Responder** (`firmware/UWB_DWM3000/uwb_responder/`): VRU-side ESP32 + DWM3000, responds to TWR polls.
- **DWM3001 Initiator/Responder** (`firmware/UWB_DWM3001/`): nRF52833 + DW3110 platform alternative for higher-accuracy ranging.
- **Cooperative Node A** (`firmware/Cooperative_Node/node_a_sender/`): Sends VRU_COOP_ALERT_V1 messages via ESP-NOW.
- **Cooperative Node B** (`firmware/Cooperative_Node/node_b_receiver/`): Receives alerts, logs latency, drives warning indicator.

### iOS ExperimentLogger App
- SwiftUI iOS 16+, forced light mode
- **SetupView**: Configure experiment ID, scenario (S1–S6), target VRU type, road type, lane configuration, node ID
- **RecordingView**: Real-time event logging with 30+ event buttons across 7 categories
- **ExportView**: CSV preview and ShareSheet export

### Analysis Pipeline (Python 3.8+)
- `merge_logs.py`: Align BLE, UWB, and iOS event logs by experiment ID and relative time
- `compute_metrics.py`: Warning lead time, false positive rate, UWB RSSI stats, range error
- `risk_filter.py`: Offline application of the rule-based risk state machine
- `plot_rssi.py`, `plot_uwb_error.py`, `plot_lead_time.py`, `plot_false_positive.py`: Visualization

### Simulation
- `simple_scenario_sim.py`: Kinematic simulation of warning lead time vs. detection delay
- `error_model_from_logs.py`: Placeholder for CARLA/OMNeT++ integration

---

## Evaluation Metrics

| Metric | Definition |
|--------|------------|
| **Warning Lead Time** | Time from first `CANDIDATE` state to `VISIBLE` event (ground truth) |
| **True Positive Rate** | Fraction of S1/S2/S4 trials where `CONFIRMED_RISK` was reached before `VISIBLE` |
| **False Positive Rate** | Fraction of S3 trials where `CONFIRMED_RISK` was reached (should be 0) |
| **UWB Timeout Rate** | Fraction of TWR attempts returning `TIMEOUT` status |
| **UWB Range Error** | `|range_m - ground_truth_m|` at `DANGER_POINT` event |
| **Cooperative Lead Time** | Time from `NODE_B_WARNED` to `VISIBLE` at Node B's position |
| **Message Latency** | `ts_ms(RECEIVED) - ts_ms(SENT)` for cooperative messages |

---

## Repository Structure

```
NLS_V2X/
├── firmware/
│   ├── ESP32_BLE/
│   │   ├── ble_beacon/         VRU-side BLE advertiser
│   │   └── ble_scanner/        Scanner with CSV output
│   ├── UWB_DWM3000/
│   │   ├── uwb_initiator/      TWR initiator (ESP32 + DWM3000)
│   │   └── uwb_responder/      TWR responder
│   ├── UWB_DWM3001/
│   │   ├── uwb_dwm3001_initiator/   nRF52833 + DW3110 initiator
│   │   └── uwb_dwm3001_responder/   nRF52833 + DW3110 responder
│   └── Cooperative_Node/
│       ├── node_a_sender/      ESP-NOW sender + risk score relay
│       └── node_b_receiver/    ESP-NOW receiver + warning output
├── iOS_ExperimentLogger/       SwiftUI iOS app
│   ├── Models.swift
│   ├── ExperimentStore.swift
│   ├── SetupView.swift
│   ├── RecordingView.swift
│   ├── ExportView.swift
│   ├── ExperimentLoggerApp.swift
│   ├── ShareSheet.swift
│   └── Info.plist
├── analysis/
│   ├── merge_logs.py
│   ├── compute_metrics.py
│   ├── risk_filter.py
│   ├── plot_rssi.py
│   ├── plot_uwb_error.py
│   ├── plot_lead_time.py
│   ├── plot_false_positive.py
│   └── README.md
├── simulation/
│   ├── simple_scenario_sim.py
│   ├── error_model_from_logs.py
│   └── README.md
├── docs/
│   ├── research_overview.md
│   ├── scenario_definitions.md
│   ├── experiment_protocol.md
│   ├── risk_filter_design.md
│   ├── cooperative_warning_design.md
│   ├── data_schema.md
│   ├── hardware_setup.md
│   └── limitations.md
├── data/
│   ├── raw/                    Raw CSVs from each experiment trial
│   ├── processed/              Merged logs from merge_logs.py
│   └── sample/                 Synthetic sample data (clearly labeled)
└── README.md
```

---

## References

- IEEE 802.15.4z-2020: UWB physical layer amendment
- FiRa Consortium: UWB Use Case and Regulatory Aspects (2021)
- ETSI EN 302 065: UWB spectrum regulations (EU)
- Qorvo DW3000 User Manual (DWM3000EVB, DWM3001CDK)
- Apple Nearby Interaction Framework: https://developer.apple.com/documentation/nearbyinteraction
- BLE RSSI ranging survey: Zafari et al., IEEE Communications Surveys & Tutorials, 2019
