# Experiment Protocol

## Safety Requirements

> **This system is a proof-of-concept only. It provides no certified safety guarantees.**

1. All experiments must be conducted in a **closed, controlled environment** with no public vehicle traffic.
2. A safety spotter must be present at all times when a human VRU participant is used.
3. The ego vehicle must travel at **≤ 20 km/h** during experiments. Faster speeds are outside the scope of this PoC.
4. The experiment operator must brief all participants on the scenario before each trial.
5. The experiment operator holds a physical stop signal (red flag or radio). Any safety concern stops the trial immediately.
6. Hardware (UWB antennas, ESP32 wiring) must be inspected before each session for damage or loose connections.

---

## Equipment Checklist

### VRU Side
- [ ] Smartphone (iOS 16+) running the ExperimentLogger app — or
- [ ] ESP32 running `ble_beacon.ino` (if using embedded BLE tag)
- [ ] DWM3000 or DWM3001CDK running `uwb_responder` firmware (if UWB experiment)
- [ ] Backup battery pack (≥ 5000 mAh)
- [ ] High-visibility vest

### Infrastructure / Vehicle Side (Node A)
- [ ] ESP32 running `ble_scanner.ino`
- [ ] DWM3000 running `uwb_initiator.ino` (if UWB experiment)
- [ ] Serial logging laptop (115200 baud, `screen` or `PuTTY` or `picocom`)
- [ ] USB cables (ESP32 × 2 or × 3)
- [ ] Tripod or mount for scanner antenna height (~1.5 m for RSU simulation)

### Node B (if cooperative scenario S6)
- [ ] ESP32 running `node_b_receiver.ino`
- [ ] Serial logging laptop (separate from Node A)
- [ ] Same 2.4 GHz channel as Node A (confirm in firmware)

### iOS Logger Device
- [ ] iPhone running ExperimentLogger app
- [ ] Screen recording enabled for post-hoc review
- [ ] Sufficient storage (≥ 1 GB free)

---

## Experiment ID Convention

```
{scenario_code}_{location_code}_{date}_{trial_number}

Examples:
  alley_dartout_campus_20250601_01
  right_turn_intersection_20250601_03
  sidewalk_fp_4lane_20250602_01
  carry_pocket_parking_20250601_02
  coop_warning_alley_20250601_01
```

Experiment IDs must be unique across all sessions. The iOS app uses this as the primary key for CSV merging.

---

## Minimum Trial Count

| Scenario | Minimum Trials | Notes |
|----------|---------------|-------|
| S1 Alley Dart-out | 10 | Vary VRU speed: slow (1 m/s), fast (2.5 m/s) |
| S2 Right-turn Conflict | 10 | Vary approach angle: 90°, 45° |
| S3 Sidewalk False Positive | 10 | Primary baseline for FP measurement |
| S4 Lane-splitting Two-wheeler | 10 | Bicycle minimum; motorcycle if available |
| S5 Carry Position | 5 per carry position × 4 positions = 20 | Static ranging test, 3–15 m distances |
| S6 Cooperative Warning | 10 | Vary Node B position: 0 m, 10 m, 20 m behind Node A |

Total minimum: 70 trials.

---

## Ground Truth Measurement

For each trial, the operator records in the memo field or a separate log:

1. **Start distance**: Physical distance between scanner antenna and VRU tag at experiment start (tape measure, ±0.1 m).
2. **Minimum distance**: Closest approach distance at `DANGER_POINT` event.
3. **VRU speed**: Approximate speed in m/s (paced or measured with a phone GPS app).

Ground truth distance is used to compute UWB range error in `analysis/compute_metrics.py`.

---

## Data Collection Procedure

1. Power on all hardware and confirm Serial logging is running.
2. Open iOS ExperimentLogger. Fill in all setup fields. Press "Start Experiment".
3. Operator announces scenario start.
4. VRU performs the scripted movement.
5. Operator presses event buttons in real time.
6. At the end of the trial, press "End Experiment".
7. Export CSV from "Export" tab immediately. Save with filename matching the experiment ID.
8. Rename Serial log files to `{experiment_id}_ble.csv` and `{experiment_id}_uwb.csv`.
9. Copy all three files to `data/raw/` before the next trial.

---

## Clock Synchronization Note

The iOS device clock and ESP32 `millis()` clocks are **not synchronized**. The `merge_logs.py` script uses the `START` event from the iOS log as a time anchor. All BLE and UWB timestamps are offset relative to when the experiment was started on the iOS device.

Accuracy: ±200 ms typical (due to button-press latency and USB logging latency).

For sub-100 ms accuracy, a hardware sync signal (e.g., LED flash detected by all logging cameras) is required — this is outside the scope of the current PoC.

---

## Post-Experiment Verification

After each session:
1. Open the raw CSVs in a text editor and verify:
   - BLE CSV: `seq_id` is monotonically increasing, no large gaps (> 500 sequences dropped).
   - UWB CSV: `status` column has expected mix of `OK` and `TIMEOUT` rows.
   - iOS CSV: `END` event is present, time column is monotonically increasing.
2. Check that `experiment_id` in the iOS CSV matches the BLE/UWB file names.
3. Run `analysis/merge_logs.py` on the new data and verify merge output has no empty sections.
