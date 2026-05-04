# VRU-BLEUWB

## BLE-Triggered UWB Ranging and Cooperative Risk Filtering for Occluded VRUs

A research proof-of-concept platform for studying the feasibility of detecting
occluded Vulnerable Road Users (VRUs) using a two-stage sensing pipeline:
**BLE as a low-power candidate trigger** and **UWB as a ranging confirmation layer**,
combined with a **scenario-aware risk filter** to suppress false positives from
non-risk sidewalk pedestrians.

> *"This project does not claim that BLE alone can detect dangerous VRUs. Instead,
> BLE is used as a low-power candidate trigger, UWB is used for ranging confirmation,
> and scenario-aware risk filtering is used to suppress false positives from non-risk
> sidewalk pedestrians."*

**Status:** Proof-of-Concept · Closed-environment experiments only · Not a certified safety system

---

## Problem Statement

Pedestrians, cyclists, and micro-mobility riders (VRUs) account for a disproportionate
share of traffic fatalities. Occlusion — the inability of the ego vehicle to see the VRU
until the last moment — is a key contributing factor.

**Why BLE alone is insufficient:** RSSI is unreliable in multipath environments.
A sidewalk pedestrian at 25 m looks identical to a dart-out pedestrian at 10 m with body shadowing.

**Why UWB alone is insufficient:** Continuous UWB polling of unknown VRU devices is
power-expensive and requires prior device pairing.

**Proposed approach:** Use BLE as an always-on low-power trigger, activate UWB only
when a candidate is detected, then apply a rule-based risk filter to suppress false
positives before issuing a driver warning.

---

## Architecture

```
[VRU phone / tag]  ──BLE adv──▶  [RSU ESP32 scanner]
                                         │
                                   BLE RSSI trigger
                                         │
                                         ▼
                         [RSU ESP32 + DWM3000 initiator]
                                   UWB TWR ranging
                                         │
                                   risk_score = 0.30*BLE
                                            + 0.25*UWB
                                            + 0.25*road_entry
                                            + 0.20*conflict
                                         │
                                   IDLE → CANDIDATE → CONFIRMED
                                         │
                              [Cooperative Node A] ──ESP-NOW──▶ [Node B]
                                                                  warning
```

---

## Scenario Taxonomy

| ID | Scenario | Expected Outcome |
|----|----------|-----------------|
| S1 | Alley Dart-out | CONFIRMED_RISK before VISIBLE |
| S2 | Right-turn Conflict | CONFIRMED_RISK before VISIBLE |
| S3 | Four-lane Sidewalk False Positive | SUPPRESSED (not CONFIRMED) |
| S4 | Lane-splitting Two-wheeler | CONFIRMED_RISK before VISIBLE |
| S5 | Carry Position Degradation | Characterize RSSI degradation |
| S6 | Cooperative Warning | Node B warned before Node B sees VRU |

Full definitions: [docs/scenario_definitions.md](docs/scenario_definitions.md)

---

## Repository Structure

```
NLS_V2X/
├── firmware/
│   ├── ESP32_BLE/ble_beacon/           VRU-side BLE advertiser
│   ├── ESP32_BLE/ble_scanner/          Infrastructure BLE scanner
│   ├── UWB_DWM3000/uwb_initiator/      TWR initiator (ESP32 + DWM3000EVB)
│   ├── UWB_DWM3000/uwb_responder/      TWR responder
│   ├── UWB_DWM3001/uwb_dwm3001_initiator/  nRF52833 + DW3110 initiator
│   ├── UWB_DWM3001/uwb_dwm3001_responder/  nRF52833 + DW3110 responder
│   └── Cooperative_Node/
│       ├── node_a_sender/              ESP-NOW sender + risk relay
│       └── node_b_receiver/            ESP-NOW receiver + warning output
├── *.swift                             iOS ExperimentLogger app (SwiftUI iOS 16+)
├── analysis/
│   ├── merge_logs.py                   Align BLE + UWB + iOS event logs by time
│   ├── risk_filter.py                  Offline rule-based risk state machine
│   ├── compute_metrics.py              Warning lead time, FP rate, UWB error
│   ├── plot_rssi.py                    RSSI over time plot
│   ├── plot_uwb_error.py               UWB range and absolute error plot
│   ├── plot_lead_time.py               Lead time distribution bar chart
│   └── plot_false_positive.py          TP vs FP by scenario
├── simulation/
│   ├── simple_scenario_sim.py          Kinematic warning lead time simulation
│   └── error_model_from_logs.py        Error model placeholder (CARLA/OMNeT++)
├── docs/
│   ├── research_overview.md
│   ├── scenario_definitions.md
│   ├── experiment_protocol.md
│   ├── risk_filter_design.md
│   ├── cooperative_warning_design.md
│   ├── data_schema.md
│   ├── hardware_setup.md
│   └── limitations.md
└── data/
    ├── raw/                            Raw CSVs from experiments (add yours here)
    ├── processed/                      Merged + filtered outputs
    └── sample/                         Synthetic sample data (pipeline testing only)
```

---

## Quick Start

### 1. Flash Firmware

**VRU side (BLE beacon):**
```
Arduino IDE → ESP32 Dev Module
Open: firmware/ESP32_BLE/ble_beacon/ble_beacon.ino → Flash
```

**Infrastructure side (BLE scanner + UWB initiator):**
```
firmware/ESP32_BLE/ble_scanner/ble_scanner.ino → Flash to ESP32 #1
firmware/UWB_DWM3000/uwb_initiator/uwb_initiator.ino → Flash to ESP32 #2
Log Serial at 115200 baud, save to data/raw/
```

See [docs/hardware_setup.md](docs/hardware_setup.md) for wiring (SPI pinout, antenna placement).

### 2. Build iOS ExperimentLogger

1. Xcode → **File > New > Project** → iOS > App (SwiftUI, Swift, iOS 16.0)
2. Replace auto-generated files with the `.swift` files in this repo
3. Build and run on physical iPhone (⌘R)

### 3. Analyze Data

```bash
pip install matplotlib

# Merge BLE + UWB + event logs
python analysis/merge_logs.py \
  --experiment_id alley_dartout_01 \
  --ble   data/raw/alley_dartout_01_ble.csv \
  --uwb   data/raw/alley_dartout_01_uwb.csv \
  --events data/raw/alley_dartout_01_events.csv

# Apply risk filter
python analysis/risk_filter.py \
  --input data/processed/alley_dartout_01_merged.csv

# Compute metrics
python analysis/compute_metrics.py \
  --input data/processed/alley_dartout_01_merged_filtered.csv \
  --ground_truth_m 5.0

# Plots
python analysis/plot_rssi.py --input data/processed/alley_dartout_01_merged.csv
python analysis/plot_lead_time.py --input data/processed/alley_dartout_01_merged_filtered.csv
```

See [analysis/README.md](analysis/README.md) for the full pipeline.

### 4. Run Simulation

```bash
python simulation/simple_scenario_sim.py --plot
```

---

## Key Metrics

| Metric | Definition |
|--------|------------|
| Warning Lead Time | Time from BLE candidate trigger to VISIBLE event |
| True Positive Rate | CONFIRMED_RISK before VISIBLE in S1/S2/S4 |
| False Positive Rate | CONFIRMED_RISK in S3 (sidewalk non-risk, target: ~0) |
| UWB Timeout Rate | Fraction of TWR attempts returning TIMEOUT |
| UWB Range Error | `|measured - ground_truth|` at DANGER_POINT event |
| Cooperative Lead Time | Time from NODE_B_WARNED to VISIBLE at Node B |

---

## Hardware Overview

| Module | Role | Interface |
|--------|------|-----------|
| ESP32-WROOM-32 | BLE beacon (VRU tag) / BLE scanner (RSU) | BLE 5.0 built-in |
| ESP32 + DWM3000EVB | UWB initiator / responder | SPI (MOSI=23, MISO=19, SCK=18, CS=5) |
| DWM3001CDK | UWB initiator / responder (nRF52833+DW3110) | USB-CDC via J-Link |

Full details: [docs/hardware_setup.md](docs/hardware_setup.md)

---

## Documentation

| Document | Description |
|----------|-------------|
| [docs/research_overview.md](docs/research_overview.md) | Problem statement, architecture, metrics |
| [docs/scenario_definitions.md](docs/scenario_definitions.md) | S1–S6 scenario specifications |
| [docs/experiment_protocol.md](docs/experiment_protocol.md) | Safety rules, procedure, ground-truth checklist |
| [docs/risk_filter_design.md](docs/risk_filter_design.md) | State machine, thresholds, formulas |
| [docs/cooperative_warning_design.md](docs/cooperative_warning_design.md) | ESP-NOW architecture, VRU_COOP_ALERT_V1 schema |
| [docs/data_schema.md](docs/data_schema.md) | All CSV column definitions |
| [docs/hardware_setup.md](docs/hardware_setup.md) | Wiring, BOM, library setup |
| [docs/limitations.md](docs/limitations.md) | Known limitations and scope |

---

## Limitations

This is a research PoC. Key limitations include:

- BLE RSSI is unreliable for absolute ranging (±10 dB typical multipath error)
- MAC address randomization (iOS 14+, Android 10+) prevents stable VRU identity via MAC
- UWB is LOS-only; NLOS causes positive range bias
- Single-anchor UWB provides range only — no bearing/angle
- Clocks not synchronized between iOS app and ESP32 (±200 ms typical offset)
- Cooperative (ESP-NOW) range not certified; effective range ~50–200 m in open space

Full list: [docs/limitations.md](docs/limitations.md)

---

## License

Research prototype. No warranty. Not for production or safety-critical use.
