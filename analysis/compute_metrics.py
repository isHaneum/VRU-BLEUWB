#!/usr/bin/env python3
"""
compute_metrics.py — Compute summary metrics from a merged (and optionally
risk-filtered) CSV file.

Metrics computed:
  - BLE detection candidate count
  - UWB timeout rate
  - UWB range error at DANGER_POINT events (requires ground_truth_m)
  - Warning lead time (time from first CANDIDATE state to VISIBLE event)
  - False positive rate (CONFIRMED_RISK reached in S3 scenarios)
  - RSSI statistics (mean, std, min, max per node_id)
  - UWB range statistics

Usage:
    python compute_metrics.py --input <merged_or_filtered_csv>
                              [--ground_truth_m <float>]
                              [--output_dir <dir>]
"""

import argparse
import csv
import os
import sys
import math


def load_csv(path):
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        return list(reader)


def safe_float(v, default=None):
    try:
        return float(v) if v not in ('', None) else default
    except (ValueError, TypeError):
        return default


def compute_metrics(rows, ground_truth_m_override):
    metrics = {}

    # Separate rows by type
    ble_rows   = [r for r in rows if r.get('rssi') not in ('', None)]
    uwb_rows   = [r for r in rows if r.get('uwb_range_m') not in ('', None)]
    event_rows = [r for r in rows if r.get('event') not in ('', None)]

    # ── BLE stats ──────────────────────────────────────────────────────────
    rssi_vals = [safe_float(r['rssi']) for r in ble_rows if safe_float(r['rssi']) is not None]
    metrics['ble_scan_count']   = len(ble_rows)
    if rssi_vals:
        mean_rssi = sum(rssi_vals) / len(rssi_vals)
        std_rssi  = math.sqrt(sum((v - mean_rssi) ** 2 for v in rssi_vals) / len(rssi_vals))
        metrics['rssi_mean_dbm'] = round(mean_rssi, 2)
        metrics['rssi_std_dbm']  = round(std_rssi, 2)
        metrics['rssi_min_dbm']  = round(min(rssi_vals), 2)
        metrics['rssi_max_dbm']  = round(max(rssi_vals), 2)
    else:
        metrics['rssi_mean_dbm'] = None
        metrics['rssi_std_dbm']  = None
        metrics['rssi_min_dbm']  = None
        metrics['rssi_max_dbm']  = None

    # ── UWB stats ──────────────────────────────────────────────────────────
    uwb_ok      = [r for r in uwb_rows if r.get('uwb_status') == 'OK']
    uwb_timeout = [r for r in uwb_rows if r.get('uwb_status') == 'TIMEOUT']
    metrics['uwb_total_attempts'] = len(uwb_rows)
    metrics['uwb_ok_count']       = len(uwb_ok)
    metrics['uwb_timeout_count']  = len(uwb_timeout)
    metrics['uwb_timeout_rate']   = round(len(uwb_timeout) / len(uwb_rows), 4) if uwb_rows else None

    range_vals = [safe_float(r['uwb_range_m']) for r in uwb_ok if safe_float(r['uwb_range_m']) is not None]
    if range_vals:
        mean_range = sum(range_vals) / len(range_vals)
        metrics['uwb_range_mean_m'] = round(mean_range, 3)
        metrics['uwb_range_min_m']  = round(min(range_vals), 3)
        metrics['uwb_range_max_m']  = round(max(range_vals), 3)
    else:
        metrics['uwb_range_mean_m'] = None
        metrics['uwb_range_min_m']  = None
        metrics['uwb_range_max_m']  = None

    # ── UWB range error at DANGER_POINT ────────────────────────────────────
    danger_events = [r for r in event_rows if r.get('event') == 'DANGER_POINT']
    range_errors  = []
    for de in danger_events:
        t_danger = safe_float(de.get('time_s'))
        gt_m     = ground_truth_m_override or safe_float(de.get('ground_truth_m'))
        if t_danger is None or gt_m is None:
            continue
        # Find closest UWB OK row by time
        best_row = min(
            (r for r in uwb_ok),
            key=lambda r: abs(safe_float(r.get('time_s'), 1e9) - t_danger),
            default=None
        )
        if best_row:
            r_m = safe_float(best_row.get('uwb_range_m'))
            if r_m is not None:
                range_errors.append(abs(r_m - gt_m))

    if range_errors:
        metrics['uwb_range_error_mean_m'] = round(sum(range_errors) / len(range_errors), 3)
        metrics['uwb_range_error_max_m']  = round(max(range_errors), 3)
    else:
        metrics['uwb_range_error_mean_m'] = None
        metrics['uwb_range_error_max_m']  = None

    # ── Warning lead time ──────────────────────────────────────────────────
    # Time from first CANDIDATE state to first VISIBLE event
    lead_times = []
    candidate_t = None
    for r in rows:
        state = r.get('state', '')
        event = r.get('event', '')
        t     = safe_float(r.get('time_s'))
        if t is None:
            continue
        if state == 'CANDIDATE' and candidate_t is None:
            candidate_t = t
        if event == 'VISIBLE' and candidate_t is not None:
            lead_times.append(round(t - candidate_t, 3))
            candidate_t = None   # reset for next occurrence

    metrics['warning_lead_time_count'] = len(lead_times)
    metrics['warning_lead_time_mean_s'] = round(
        sum(lead_times) / len(lead_times), 3) if lead_times else None
    metrics['warning_lead_time_min_s']  = round(min(lead_times), 3) if lead_times else None
    metrics['warning_lead_time_max_s']  = round(max(lead_times), 3) if lead_times else None

    # ── False positive analysis ────────────────────────────────────────────
    # Rows where state==CONFIRMED_RISK and event==FALSE_POSITIVE_CASE
    fp_confirmed = [r for r in rows
                    if r.get('state') == 'CONFIRMED_RISK'
                    and r.get('event') == 'FALSE_POSITIVE_CASE']
    tp_confirmed = [r for r in rows
                    if r.get('state') == 'CONFIRMED_RISK'
                    and r.get('event') == 'TRUE_DANGER_CASE']
    metrics['false_positive_confirmed_count'] = len(fp_confirmed)
    metrics['true_positive_confirmed_count']  = len(tp_confirmed)
    total = len(fp_confirmed) + len(tp_confirmed)
    metrics['false_positive_rate'] = round(len(fp_confirmed) / total, 4) if total > 0 else None

    # ── Cooperative lead time ──────────────────────────────────────────────
    coop_warned_t = None
    coop_lead_times = []
    for r in rows:
        event = r.get('event', '')
        t     = safe_float(r.get('time_s'))
        if t is None:
            continue
        if event == 'NODE_B_WARNED':
            coop_warned_t = t
        if event == 'VISIBLE' and coop_warned_t is not None:
            coop_lead_times.append(round(t - coop_warned_t, 3))
            coop_warned_t = None

    metrics['coop_lead_time_count']  = len(coop_lead_times)
    metrics['coop_lead_time_mean_s'] = round(
        sum(coop_lead_times) / len(coop_lead_times), 3) if coop_lead_times else None

    return metrics


def print_metrics(metrics, experiment_id):
    print(f"\n{'='*60}")
    print(f"  Metrics for: {experiment_id}")
    print(f"{'='*60}")
    for k, v in metrics.items():
        print(f"  {k:<40s} {v}")
    print()


def write_metrics_csv(metrics, experiment_id, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    path = os.path.join(output_dir, f'{experiment_id}_metrics.csv')
    with open(path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['metric', 'value'])
        for k, v in metrics.items():
            writer.writerow([k, v])
    print(f"Wrote metrics → {path}")


def main():
    parser = argparse.ArgumentParser(description='Compute summary metrics from merged CSV.')
    parser.add_argument('--input', required=False, default='',
                        help='Merged or risk-filtered CSV path')
    parser.add_argument('--ground_truth_m', type=float, default=None,
                        help='Override ground truth distance in meters at DANGER_POINT')
    parser.add_argument('--output_dir', default='data/processed',
                        help='Directory for metrics CSV output')
    args = parser.parse_args()

    if not args.input or not os.path.isfile(args.input):
        print("Warning: --input not provided or file not found.")
        print("Example:")
        print("  python compute_metrics.py "
              "--input data/processed/sample_01_merged_filtered.csv "
              "--ground_truth_m 5.0")
        sys.exit(0)

    rows = load_csv(args.input)
    experiment_id = rows[0].get('experiment_id', 'unknown') if rows else 'unknown'

    metrics = compute_metrics(rows, args.ground_truth_m)
    print_metrics(metrics, experiment_id)
    write_metrics_csv(metrics, experiment_id, args.output_dir)


if __name__ == '__main__':
    main()
