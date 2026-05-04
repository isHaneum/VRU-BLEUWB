# Scenario Definitions

## Overview

Each scenario is assigned a canonical ID for use in the `scenario` field of all CSV logs.
Ground-truth event labels come from the iOS ExperimentLogger app.

---

## S1 — Alley Dart-out

| Field | Value |
|-------|-------|
| **Scenario ID** | `S1_ALLEY_DART_OUT` |
| **Description** | A pedestrian emerges suddenly from a narrow alley or from behind parked vehicles into the ego vehicle's path. The ego vehicle has no line-of-sight until the last moment. |
| **Why it matters** | Dart-out is a leading cause of pedestrian fatalities at low speeds in urban areas. BLE/UWB cannot see around corners, so cooperative pre-warning from infrastructure or another vehicle is the only early-warning option. |
| **Expected BLE behavior** | RSSI rises abruptly from a low/noisy baseline to a strong signal within 1–2 scan intervals (~100–200 ms). Hit-count goes from 0 to several in rapid succession. |
| **Expected UWB behavior** | Range drops quickly (e.g., 15 m → 8 m → 4 m in under 2 s). High range-rate indicates fast lateral closure. NLOS → LOS transition may cause a step-change in range accuracy. |
| **Main failure mode** | BLE signal may be blocked by the building/wall until the VRU is already in the road. UWB activation may come too late if BLE trigger is delayed. |
| **Ground-truth event labels** | `ALLEY_ENTRY`, `DART_OUT`, `VISIBLE`, `DANGER_POINT`, `TRUE_DANGER_CASE` |
| **Metrics** | BLE candidate detection time, UWB activation latency, warning lead time before `VISIBLE` |

---

## S2 — Right-turn Conflict

| Field | Value |
|-------|-------|
| **Scenario ID** | `S2_RIGHT_TURN_CONFLICT` |
| **Description** | The ego vehicle turns right at an intersection. A pedestrian or cyclist approaching on the sidewalk or in the crosswalk is occluded by the A-pillar, roadside structures, or other vehicles. |
| **Why it matters** | Right-turn conflicts with pedestrians are a disproportionate cause of urban cyclist and pedestrian fatalities, particularly with trucks and SUVs. |
| **Expected BLE behavior** | VRU beacon is consistently present at moderate RSSI (–65 to –75 dBm). RSSI may fluctuate due to vehicle body shadowing during the turn maneuver. |
| **Expected UWB behavior** | Range decreases as the vehicle turns. Lateral conflict zone can be estimated from range + heading. LOS quality may degrade as the vehicle body interposes. |
| **Main failure mode** | VRU on the sidewalk parallel to the road may look identical to a non-risk pedestrian (S3). Risk filter must use road-entry probability and conflict-zone geometry. |
| **Ground-truth event labels** | `RIGHT_TURN_START`, `CROSSWALK_APPROACH`, `RIGHT_TURN_CONFLICT`, `VISIBLE`, `TRUE_DANGER_CASE` or `FALSE_POSITIVE_CASE` |
| **Metrics** | Conflict detection lead time, false positive rate vs. sidewalk parallel pedestrians |

---

## S3 — Four-lane Sidewalk False Positive

| Field | Value |
|-------|-------|
| **Scenario ID** | `S3_FOUR_LANE_SIDEWALK_FALSE_POSITIVE` |
| **Description** | A pedestrian walking parallel on a sidewalk separated from the road by 4 lanes triggers a BLE candidate because they are within RSSI range. They are not on a collision path. |
| **Why it matters** | In dense urban environments, a naive RSSI-threshold trigger would fire on every sidewalk pedestrian within 30 m. This is the primary source of false positives and is the main reason BLE alone is insufficient. |
| **Expected BLE behavior** | Stable RSSI (~–65 to –75 dBm), slowly varying. Hit count is high and steady. No sudden RSSI rise. |
| **Expected UWB behavior** | Range remains roughly constant or decreases slowly. No rapid range-rate. No lateral entry into road geometry. |
| **Main failure mode** | If the risk filter does not suppress sidewalk-parallel cases, the warning rate becomes unacceptably high. |
| **Ground-truth event labels** | `SIDEWALK_PARALLEL`, `OPPOSITE_SIDEWALK`, `FALSE_POSITIVE_CASE` |
| **Metrics** | False positive suppression rate, RSSI pattern difference vs. S1/S2 |

---

## S4 — Lane-splitting Two-wheeler

| Field | Value |
|-------|-------|
| **Scenario ID** | `S4_LANE_SPLITTING_TWO_WHEELER` |
| **Description** | A motorcycle, bicycle, or e-scooter approaches between lanes or from the rear, outside the ego vehicle's mirror coverage. |
| **Why it matters** | Two-wheelers are 28× more likely to die per km traveled than car occupants. Lane-splitting is difficult to detect with camera/radar due to blind spots. |
| **Expected BLE behavior** | Approaching from behind: RSSI rises steadily as the two-wheeler closes. Direction-of-arrival is ambiguous without angle-of-arrival (AoA) capability. |
| **Expected UWB behavior** | Range decreases at a rate proportional to closing speed. If the two-wheeler is lateral, bearing angle changes rapidly. |
| **Main failure mode** | Without AoA or multiple anchors, lateral position is ambiguous. Range alone is insufficient to determine lane position. |
| **Ground-truth event labels** | `MOTORCYCLE_APPROACH`, `BICYCLE_APPROACH`, `SCOOTER_APPROACH`, `LANE_ENTER`, `DANGER_POINT` |
| **Metrics** | Detection range at first UWB confirmation, warning lead time |

---

## S5 — Carry Position Degradation

| Field | Value |
|-------|-------|
| **Scenario ID** | `S5_CARRY_POSITION_DEGRADATION` |
| **Description** | The VRU's smartphone or BLE/UWB tag is carried in different positions (hand, front pocket, back pocket, bag, body-shadowed) that affect signal quality. This scenario characterizes how much degradation to expect. |
| **Why it matters** | Real-world VRU tags will not always be held optimally. A safety system that works only with a hand-held phone and fails with a pocket phone is not deployable. Quantifying the degradation is essential for setting detection thresholds. |
| **Expected BLE behavior** | Hand-held: strongest and most consistent. Pocket/bag: 5–15 dB reduction, higher packet loss rate. Body-shadowed (tag behind the VRU's body relative to the scanner): worst case, may lose 20+ dB. |
| **Expected UWB behavior** | Similar degradation pattern. Body shadowing causes NLOS conditions, leading to positive range bias (measured range > true range). |
| **Main failure mode** | RSSI thresholds calibrated for hand-held use may miss pocket-carried devices. UWB NLOS bias may cause underestimation of danger. |
| **Ground-truth event labels** | `HELD_IN_HAND`, `INSIDE_POCKET`, `INSIDE_BAG`, `BODY_SHADOWED` |
| **Metrics** | RSSI median/std per carry position, UWB range error vs. carry position |

---

## S6 — Cooperative Warning

| Field | Value |
|-------|-------|
| **Scenario ID** | `S6_COOPERATIVE_WARNING` |
| **Description** | Node A (RSU or leading vehicle) detects and risk-filters a VRU. Node A sends a cooperative warning message to Node B (following vehicle or cross-traffic vehicle) that cannot yet directly detect the VRU. Node B logs the warning before it can independently confirm. |
| **Why it matters** | Occlusion by a leading vehicle or building is the defining scenario for V2X cooperative safety. The value of cooperation is measured as the extra warning lead time provided to Node B. |
| **Expected BLE behavior** | Node B receives no or weak BLE from the VRU directly. Node A's cooperative alert serves as the primary trigger for Node B. |
| **Expected UWB behavior** | Node B may have no UWB range to the VRU yet. Node A's range estimate is relayed in the cooperative message. |
| **Main failure mode** | Message latency and reliability. If the cooperative message arrives after Node B has already detected the VRU independently, the cooperation provides no benefit. |
| **Ground-truth event labels** | `NODE_A_DETECTED`, `COOP_MESSAGE_SENT`, `COOP_MESSAGE_RECEIVED`, `NODE_B_WARNED` |
| **Metrics** | Cooperative warning lead time (time from `NODE_B_WARNED` to `VISIBLE`), message latency, Node B independent detection time |
