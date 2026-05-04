# Limitations

This document records the known limitations of the BLE-triggered UWB ranging and cooperative risk filtering system. These limitations must be disclosed in any research publication or report that uses data from this platform.

---

## 1. BLE RSSI is an Unreliable Proximity Measure

BLE RSSI is affected by:
- **Multipath and reflections**: Received power can vary ±10 dB at the same physical distance.
- **Antenna orientation**: 5–10 dB variation depending on body shadowing and tag orientation.
- **Environmental changes**: Moving people, vehicles, and objects change the RF propagation environment between scans.
- **Transmit power variation**: Different devices advertise at different TX powers. The system normalizes using the manufacturer data TX power field, but not all devices include this field.

**Consequence:** RSSI cannot be used alone as a reliable range estimate. It is used only as a candidate trigger, not as a measurement.

---

## 2. MAC Address Randomization Prevents Stable Device Identity

iOS 14+ and Android 10+ rotate the BLE MAC address periodically (typically every 15 minutes or on each new advertising session). This means:

- The `mac` field in the BLE log **cannot be used as a stable VRU identifier** across trials.
- Device identity must be based on `device_name` (constant for VRU-side firmware) or a fixed manufacturer data byte.
- For privacy compliance, the system should not store MAC addresses for longer than necessary.

---

## 3. UWB Is Line-of-Sight Only (Practical Range and Accuracy Limits)

- **NLOS (Non-Line-of-Sight) conditions** cause positive range bias: the measured range is larger than the true range because the signal travels a longer path around obstacles.
- In practice, brick walls cause ~0.5–2 m of bias; human body occlusion causes ~0.2–0.8 m.
- UWB maximum reliable range in this configuration is approximately **20 m indoors, 30–40 m outdoors** in LOS conditions.
- The DWM3000/DWM3001 modules used here are **development/evaluation boards**, not automotive-grade sensors. Temperature drift, mechanical mounting variation, and connector reliability are not characterized.

---

## 4. Single-Sided TWR Approximation Introduces Systematic Error

The ranging formula used is:
```
ToF = (Ra - Rb) / 4
```
This is a simplified approximation valid when the responder's reply delay equals the initiator's measurement window. It is less accurate than double-sided TWR (DS-TWR). Expected additional error: ±5–20 cm depending on crystal accuracy of the ESP32 used.

---

## 5. No Angle-of-Arrival (AoA) Information

The single-anchor configuration provides **only range**, not bearing. This means:

- The system cannot distinguish a VRU at the same range on the right side vs. the left side.
- For lane-splitting detection (S4), lateral position is ambiguous without multiple anchors or AoA-capable hardware (e.g., DWM3001CDK with AoA enabled, or Pozyx).
- Road-entry probability in the risk filter is estimated from event codes (operator-labeled), not from geometry.

---

## 6. Clock Synchronization is Absent

The iOS device clock and ESP32 `millis()` are not synchronized. Timestamp merging in `analysis/merge_logs.py` uses the iOS START event as anchor with ±200 ms accuracy. Sub-100 ms event correlation (e.g., measuring the exact BLE detection lead time before `VISIBLE`) requires hardware synchronization not present in this PoC.

---

## 7. Smartphone OS Constraints

- **iOS background BLE scanning** is restricted when the app is not in the foreground. The ExperimentLogger app must remain active during experiments.
- **Android scan intervals** may be throttled by the OS if the app is in the background or if too many BLE scans are active. This PoC targets iOS only; Android is not tested.
- **BLE scan interval on ESP32** is configured at 100 ms. iOS SDK scan intervals are OS-controlled and may differ.

---

## 8. Cooperative Communication Range and Reliability are Not Characterized

- ESP-NOW range outdoors is not measured as part of this PoC. Published figures are 200+ m, but obstacles, 2.4 GHz interference, and antenna placement degrade this significantly.
- The cooperative message JSON payload is not encrypted or authenticated. An attacker in the same Wi-Fi range could inject false alerts. This is a PoC limitation and must be addressed before any deployment.

---

## 9. Proof-of-Concept Scope — Not a Deployable Product

This system is a **research proof-of-concept** for studying detection feasibility and false positive filtering. It is **not**:

- A certified automotive safety component
- A replacement for camera, LIDAR, or radar
- A real-time hard-real-time embedded safety system
- Validated on production vehicles or public roads

All experiments must be conducted in controlled, closed environments. The system must not be used to make safety decisions for real traffic.

---

## 10. No Generalization Claim

Results from this platform apply to:
- The specific hardware used (ESP32 + DWM3000 or DWM3001CDK)
- The specific physical environments tested
- The specific scenarios defined in `docs/scenario_definitions.md`

Results do NOT generalize to:
- Different antenna placements
- Different urban geometries
- Different VRU body types or clothing
- High-speed scenarios (> 20 km/h ego speed)
- Multi-VRU scenarios (this PoC assumes one VRU per experiment)
