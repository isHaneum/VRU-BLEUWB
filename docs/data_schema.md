# Data Schema

## Raw Data Formats

### 1. BLE Scanner Log

**Source:** `firmware/ESP32_BLE/ble_scanner/ble_scanner.ino` → USB Serial at 115200 baud  
**CSV Header:**
```
timestamp_ms,node_id,seq_id,device_name,mac,rssi,manufacturer_data_hex
```

| Field | Type | Description |
|-------|------|-------------|
| `timestamp_ms` | uint32 | ESP32 `millis()` at scan callback |
| `node_id` | string | Node identifier (e.g., `node_A`) |
| `seq_id` | uint32 | Monotonically increasing per-node counter |
| `device_name` | string | BLE advertised name; empty string if not present |
| `mac` | string | Advertiser MAC address (may be Randomized — see note below) |
| `rssi` | int8 | Received signal strength in dBm |
| `manufacturer_data_hex` | string | Raw manufacturer data payload, hex-encoded; empty if absent |

> ⚠️ **MAC Address Warning:** iOS 14+ and Android 10+ use **randomized MAC addresses** that rotate periodically. Do NOT use `mac` as a stable VRU device identifier. Use `device_name` (if constant across sessions) or a fixed byte in `manufacturer_data_hex` as the stable identifier.

---

### 2. UWB Initiator Log

**Source:** `firmware/UWB_DWM3000/uwb_initiator/uwb_initiator.ino` → USB Serial at 115200 baud  
**CSV Header:**
```
timestamp_ms,node_id,seq_id,range_m,status
```

| Field | Type | Description |
|-------|------|-------------|
| `timestamp_ms` | uint32 | ESP32 `millis()` at ranging completion |
| `node_id` | string | Node identifier |
| `seq_id` | uint32 | Monotonically increasing per-node counter |
| `range_m` | float | TWR-computed range in meters; `-1.0` if status != `OK` |
| `status` | string | `OK`, `TIMEOUT`, `INVALID_MSG`, `INVALID_RANGE` |

**Status Definitions:**

| Status | Cause |
|--------|-------|
| `OK` | TWR completed, range value is valid |
| `TIMEOUT` | No response received within RX timeout window |
| `INVALID_MSG` | Response received but message type byte does not match `MSG_RESPONSE` |
| `INVALID_RANGE` | TWR timestamps received but computed range is negative or > `MAX_VALID_RANGE_M` |

---

### 3. iOS ExperimentLogger Event Log

**Source:** `ExportView.swift` ShareSheet → exported as `.csv` file  
**CSV Header:**
```
experiment_id,scenario,target,location,time_s,event,note,road_type,lane_count,ego_lane,target_zone,target_motion,occlusion_state,carry_position,risk_label,node_id
```

| Field | Type | Description |
|-------|------|-------------|
| `experiment_id` | string | User-assigned identifier (e.g., `alley_dartout_01`) |
| `scenario` | string | Selected scenario from `SetupView` (e.g., `S1 Alley Dart-out`) |
| `target` | string | VRU type selected at setup: `Pedestrian`, `Bicycle`, `Motorcycle`, `Scooter`, `Other` |
| `location` | string | Physical location label |
| `time_s` | float | Seconds since experiment start |
| `event` | string | Event code (see event code table below) |
| `note` | string | Optional free-text annotation |
| `road_type` | string | Road type at setup |
| `lane_count` | string | Lane count at setup |
| `ego_lane` | string | Ego vehicle lane position at setup |
| `target_zone` | string | Zone annotation (set per-event, currently empty — future field) |
| `target_motion` | string | Motion annotation (set per-event, currently empty — future field) |
| `occlusion_state` | string | Occlusion annotation (set per-event, currently empty — future field) |
| `carry_position` | string | Carry position annotation (set per-event, currently empty — future field) |
| `risk_label` | string | Risk label annotation (set per-event, currently empty — future field) |
| `node_id` | string | Logger node ID from session setup |

**Event Codes:**

| Category | Code | Meaning |
|----------|------|---------|
| Occlusion | `CAR_OCCLUDED` | VRU occluded by vehicle |
| Occlusion | `HUMAN_OCCLUDED` | VRU occluded by another person |
| Occlusion | `WALL_CORNER` | VRU behind wall or corner |
| Occlusion | `VISIBLE` | VRU becomes visible to ego vehicle |
| Danger | `DANGER_POINT` | Ground-truth moment of maximum conflict / closest approach |
| Movement | `MOVE_START` | VRU starts moving |
| Movement | `SIDEWALK_PARALLEL` | VRU walking parallel on sidewalk (non-risk) |
| Movement | `OPPOSITE_SIDEWALK` | VRU on opposite sidewalk (non-risk) |
| Movement | `CURB_WAITING` | VRU waiting at curb before crossing |
| Movement | `LANE_ENTER` | VRU enters vehicle lane |
| Movement | `LANE_EXIT` | VRU exits vehicle lane |
| Intersection | `CROSSWALK_APPROACH` | VRU approaching crosswalk |
| Intersection | `ALLEY_ENTRY` | VRU exits alley into road |
| Intersection | `DART_OUT` | VRU darts out suddenly |
| Conflict | `RIGHT_TURN_START` | Ego vehicle begins right turn |
| Conflict | `RIGHT_TURN_CONFLICT` | Conflict zone entered during right turn |
| VRU type | `MOTORCYCLE_APPROACH` | Motorcycle approaching |
| VRU type | `BICYCLE_APPROACH` | Bicycle approaching |
| VRU type | `SCOOTER_APPROACH` | Scooter approaching |
| Carry | `HELD_IN_HAND` | Tag held in hand |
| Carry | `INSIDE_POCKET` | Tag in front pocket |
| Carry | `INSIDE_BAG` | Tag in bag |
| Carry | `BODY_SHADOWED` | Tag behind body relative to scanner |
| Cooperative | `NODE_A_DETECTED` | Node A confirms VRU detection |
| Cooperative | `NODE_B_WARNED` | Node B receives cooperative warning |
| Cooperative | `COOP_MESSAGE_SENT` | Cooperative message transmitted |
| Cooperative | `COOP_MESSAGE_RECEIVED` | Cooperative message received |
| Risk label | `FALSE_POSITIVE_CASE` | Ground-truth: this event was a false positive |
| Risk label | `TRUE_DANGER_CASE` | Ground-truth: this was a genuine danger scenario |
| Control | `PAUSE` | Experiment paused |
| Control | `RESUME` | Experiment resumed |
| Control | `END` | Experiment ended |

---

### 4. Cooperative Node Log

**Source:** `firmware/Cooperative_Node/node_a_sender/` and `node_b_receiver/` → USB Serial at 115200 baud  
**CSV Header:**
```
timestamp_ms,node_id,event,msg_id,latency_ms,risk_score,risk_level
```

| Field | Type | Description |
|-------|------|-------------|
| `timestamp_ms` | uint32 | `millis()` at event |
| `node_id` | string | `node_A` or `node_B` |
| `event` | string | `SENT`, `RECEIVED`, `ACK`, `TIMEOUT`, `STALE_DROPPED` |
| `msg_id` | uint32 | Monotonically increasing message counter |
| `latency_ms` | int | Round-trip or one-way latency; `-1` if not measurable |
| `risk_score` | float | risk_score from alert; `-1` if not applicable |
| `risk_level` | string | risk_level from alert; `"N/A"` if not applicable |

---

## Processed Data Format

**Source:** `analysis/merge_logs.py` output  
**File pattern:** `data/processed/{experiment_id}_merged.csv`  
**CSV Header:**
```
experiment_id,time_s,scenario,event,node_id,rssi,uwb_range_m,uwb_status,risk_score,risk_level,ground_truth_m,occlusion_state,carry_position,target_zone,target_motion
```

| Field | Type | Description |
|-------|------|-------------|
| `experiment_id` | string | Experiment identifier |
| `time_s` | float | Relative time from experiment start in seconds |
| `scenario` | string | Scenario ID |
| `event` | string | Event code (from iOS log) or empty if sensor row |
| `node_id` | string | Source node |
| `rssi` | float | BLE RSSI (NaN if not a BLE row) |
| `uwb_range_m` | float | UWB range in meters (NaN if not a UWB row) |
| `uwb_status` | string | UWB status string (empty if not a UWB row) |
| `risk_score` | float | Offline risk filter score (NaN before running `risk_filter.py`) |
| `risk_level` | string | Offline risk filter level (empty before running `risk_filter.py`) |
| `ground_truth_m` | float | Manually measured distance at start of experiment (static reference) |
| `occlusion_state` | string | Most recent occlusion event code |
| `carry_position` | string | Most recent carry position event code |
| `target_zone` | string | Most recent target zone annotation |
| `target_motion` | string | Most recent target motion annotation |
