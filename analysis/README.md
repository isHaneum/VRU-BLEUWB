# Analysis Pipeline

## Overview

Python scripts for merging, filtering, and visualizing experiment data.
All scripts use `argparse` and exit gracefully with usage instructions if no data is provided.

## Requirements

```bash
pip install matplotlib
# numpy is not required; all stats are computed with stdlib math
```

Python 3.8+

---

## Script Reference

### 1. `merge_logs.py` — Align BLE, UWB, and iOS logs

```bash
python merge_logs.py \
  --experiment_id alley_dartout_campus_01 \
  --ble   data/raw/alley_dartout_campus_01_ble.csv \
  --uwb   data/raw/alley_dartout_campus_01_uwb.csv \
  --events data/raw/alley_dartout_campus_01_events.csv \
  --offset 0.0 \
  --output data/processed/alley_dartout_campus_01_merged.csv
```

- `--offset`: Manual time correction in seconds if BLE/UWB timestamps are shifted (rare; default 0.0)
- Output: `data/processed/{experiment_id}_merged.csv`

---

### 2. `risk_filter.py` — Apply offline risk state machine

```bash
python risk_filter.py \
  --input  data/processed/alley_dartout_campus_01_merged.csv \
  --output data/processed/alley_dartout_campus_01_merged_filtered.csv
```

Adds columns: `risk_score`, `risk_level`, `state`, `reason`, `suppressed_flag`

See `docs/risk_filter_design.md` for full state machine specification and threshold values.

---

### 3. `compute_metrics.py` — Compute summary statistics

```bash
python compute_metrics.py \
  --input data/processed/alley_dartout_campus_01_merged_filtered.csv \
  --ground_truth_m 5.0 \
  --output_dir data/processed
```

Outputs a `{experiment_id}_metrics.csv` with key statistics including:
- RSSI mean/std/min/max
- UWB timeout rate, range error
- Warning lead time
- False positive rate
- Cooperative warning lead time

---

### 4. `plot_rssi.py` — BLE RSSI over time

```bash
python plot_rssi.py \
  --input data/processed/alley_dartout_campus_01_merged.csv \
  --scenario_label "S1 Alley Dart-out" \
  --output_dir plots/
```

---

### 5. `plot_uwb_error.py` — UWB range and error

```bash
python plot_uwb_error.py \
  --input data/processed/alley_dartout_campus_01_merged.csv \
  --ground_truth_m 5.0 \
  --output_dir plots/
```

---

### 6. `plot_lead_time.py` — Warning lead time distribution

```bash
python plot_lead_time.py \
  --inputs data/processed/exp1_filtered.csv data/processed/exp2_filtered.csv \
  --output_dir plots/
```

Requires filtered CSVs (output of `risk_filter.py`) with `state` column.

---

### 7. `plot_false_positive.py` — TP vs. FP by scenario

```bash
python plot_false_positive.py \
  --inputs data/processed/exp1_filtered.csv data/processed/exp2_filtered.csv \
  --output_dir plots/
```

---

## Typical Workflow

```bash
# 1. Merge after each experiment session
python analysis/merge_logs.py --experiment_id <id> --ble <f> --uwb <f> --events <f>

# 2. Apply risk filter
python analysis/risk_filter.py --input data/processed/<id>_merged.csv

# 3. Compute metrics
python analysis/compute_metrics.py --input data/processed/<id>_merged_filtered.csv --ground_truth_m <m>

# 4. Generate plots
python analysis/plot_rssi.py        --input data/processed/<id>_merged.csv --output_dir plots/
python analysis/plot_uwb_error.py   --input data/processed/<id>_merged.csv --ground_truth_m <m> --output_dir plots/
python analysis/plot_lead_time.py   --inputs data/processed/*_filtered.csv --output_dir plots/
python analysis/plot_false_positive.py --inputs data/processed/*_filtered.csv --output_dir plots/
```

---

## Sample Data

Synthetic sample CSVs are in `data/sample/`. They are clearly labeled `SYNTHETIC SAMPLE` in their `experiment_id` fields and are intended only for testing the pipeline without real hardware.

```bash
python analysis/merge_logs.py \
  --experiment_id SYNTHETIC_SAMPLE_01 \
  --ble   data/sample/sample_ble.csv \
  --uwb   data/sample/sample_uwb.csv \
  --events data/sample/sample_events.csv
```
