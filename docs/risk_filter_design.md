# Risk Filter Design

## Purpose

The risk filter transforms raw BLE and UWB sensor observations into a four-stage risk state. Its primary goal is to **suppress false positives from non-risk sidewalk pedestrians** (S3) while maintaining high sensitivity for genuine conflict scenarios (S1, S2, S4).

This is a rule-based prototype. It is not a trained ML model. All parameters (thresholds, weights) are manually tuned from experimental data and must be re-evaluated after each data collection campaign.

---

## State Machine

```
            IDLE
             │
             │ BLE candidate trigger
             │ (rssi ≥ RSSI_CANDIDATE_DBM
             │  AND hit_count ≥ HIT_COUNT_MIN)
             ▼
          CANDIDATE ──────────────────────────────┐
             │                                    │
             │ risk_score ≥ RISK_THRESHOLD_CONFIRM│ signal lost > TIMEOUT_CANDIDATE_MS
             ▼                                    ▼
      CONFIRMED_RISK                           IDLE
             │
             │ risk_score < RISK_THRESHOLD_SUPPRESS
             │ AND scene class == SIDEWALK_PARALLEL
             ▼
         SUPPRESSED ──── timer ≥ SUPPRESS_COOLDOWN_MS ──► IDLE
```

### Stage Definitions

| Stage | Description |
|-------|-------------|
| **IDLE** | No VRU candidate. BLE scanner runs continuously. UWB is off or in low-power poll mode. |
| **CANDIDATE** | BLE trigger fired. Risk score is being computed. UWB ranging is activated. State held for up to `TIMEOUT_CANDIDATE_MS` waiting for UWB confirmation. |
| **CONFIRMED_RISK** | Risk score exceeds confirmation threshold. Warning issued. UWB ranging continues at high rate. |
| **SUPPRESSED** | Scene classified as non-risk (sidewalk parallel, opposite sidewalk). Warning suppressed. Held for `SUPPRESS_COOLDOWN_MS` before returning to IDLE to avoid ping-pong. |

---

## Risk Score Computation

```
risk_score = w_ble   * ble_score
           + w_uwb   * uwb_score
           + w_entry * road_entry_score
           + w_conf  * conflict_score
```

### Weights (default)

| Component | Symbol | Default Weight |
|-----------|--------|----------------|
| BLE signal strength and trend | `w_ble` | 0.30 |
| UWB range and range-rate | `w_uwb` | 0.25 |
| Road-entry probability | `w_entry` | 0.25 |
| Conflict geometry | `w_conf` | 0.20 |

### Component Formulas

**ble_score** — normalized, penalized for sidewalk-stable profiles  
```
rssi_norm = clip((rssi_dbm - RSSI_FLOOR) / (RSSI_CEIL - RSSI_FLOOR), 0.0, 1.0)
ble_score  = rssi_norm * hit_rate * (1 - sidewalk_penalty)
```
- `RSSI_FLOOR = -90 dBm`, `RSSI_CEIL = -50 dBm`
- `sidewalk_penalty = 0.6` if RSSI variance < `RSSI_STABLE_VAR_THRESHOLD` over a 3 s window

**uwb_score** — range + range-rate composite  
```
range_norm      = clip(1.0 - uwb_range_m / UWB_MAX_RANGE_M, 0.0, 1.0)
range_rate_norm = clip(range_rate_mps / RANGE_RATE_MAX_MPS, 0.0, 1.0)
uwb_score       = 0.5 * range_norm + 0.5 * range_rate_norm
uwb_score       = 0.0  if uwb_status != "OK"
```
- `UWB_MAX_RANGE_M = 20.0`, `RANGE_RATE_MAX_MPS = 3.0`

**road_entry_score** — event-code driven  
```
road_entry_score = 1.0  if any of: LANE_ENTER, DART_OUT, CROSSWALK_APPROACH
                 = 0.8  if any of: ALLEY_ENTRY, RIGHT_TURN_CONFLICT
                 = 0.0  if any of: SIDEWALK_PARALLEL, OPPOSITE_SIDEWALK, CURB_WAITING
                 = 0.3  otherwise (unknown)
```

**conflict_score** — event-code driven  
```
conflict_score = 1.0  if DANGER_POINT
               = 0.8  if any of: RIGHT_TURN_CONFLICT, TRUE_DANGER_CASE
               = 0.0  if FALSE_POSITIVE_CASE
               = 0.4  otherwise
```

---

## Thresholds

| Parameter | Default Value | Description |
|-----------|---------------|-------------|
| `RSSI_CANDIDATE_DBM` | –75 dBm | Minimum RSSI to trigger candidate state |
| `HIT_COUNT_MIN` | 3 | Minimum BLE hits in a 500 ms window to trigger candidate |
| `RISK_THRESHOLD_CONFIRM` | 0.60 | risk_score to enter CONFIRMED_RISK |
| `RISK_THRESHOLD_SUPPRESS` | 0.25 | risk_score below which CONFIRMED_RISK → SUPPRESSED |
| `TIMEOUT_CANDIDATE_MS` | 2000 ms | Max time in CANDIDATE without UWB confirmation |
| `SUPPRESS_COOLDOWN_MS` | 5000 ms | Time to hold SUPPRESSED before resetting to IDLE |
| `RSSI_STABLE_VAR_THRESHOLD` | 4.0 dB² | RSSI variance below this → sidewalk-stable profile |

---

## Risk Level Mapping

| risk_score range | risk_level string |
|-----------------|-------------------|
| < 0.30 | `NONE` |
| 0.30 – 0.59 | `LOW` |
| 0.60 – 0.79 | `WARN` |
| ≥ 0.80 | `ALERT` |

---

## Suppression Logic

The filter must suppress non-risk sidewalk pedestrians before they reach CONFIRMED_RISK. Suppression is triggered when:

1. Scene classification includes `SIDEWALK_PARALLEL` or `OPPOSITE_SIDEWALK` AND
2. No road-entry events observed (`LANE_ENTER`, `DART_OUT`, `CROSSWALK_APPROACH` absent) AND
3. `uwb_score` < 0.3 (range is not closing rapidly)

Under these conditions, `road_entry_score` is forced to 0.0, which typically keeps `risk_score` < 0.30.

---

## Implementation Notes

- The `analysis/risk_filter.py` script applies this logic offline to merged CSV logs.
- All state transitions are logged with timestamp, risk_score, risk_level, and `reason` string.
- The `suppressed_flag` column in the output marks rows that were suppressed by the sidewalk-parallel rule.
- Threshold tuning requires balanced labeled data from S1–S3 at minimum.

---

## Limitations

- This filter has no memory across separate experiment sessions.
- There is no probabilistic track management; each experiment is processed independently.
- The weights and thresholds are not validated on held-out data. They are engineering estimates only.
- The filter is designed for pedestrian VRUs. Two-wheelers (S4) may require different road_entry_score logic.
