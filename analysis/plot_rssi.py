#!/usr/bin/env python3
"""
plot_rssi.py — Plot BLE RSSI over time from a merged CSV.

Usage:
    python plot_rssi.py --input <merged_csv>
                        [--output_dir plots/]
                        [--scenario_label <str>]
"""

import argparse
import csv
import os
import sys


def load_csv(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def safe_float(v):
    try:
        return float(v) if v not in ('', None) else None
    except (ValueError, TypeError):
        return None


def main():
    parser = argparse.ArgumentParser(description='Plot RSSI over time.')
    parser.add_argument('--input',          required=False, default='')
    parser.add_argument('--output_dir',     default='plots')
    parser.add_argument('--scenario_label', default='')
    args = parser.parse_args()

    if not args.input or not os.path.isfile(args.input):
        print("Warning: --input not provided or file not found.")
        print("Example: python plot_rssi.py --input data/processed/sample_01_merged.csv")
        sys.exit(0)

    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        print("Error: matplotlib not installed. Run: pip install matplotlib")
        sys.exit(1)

    rows = load_csv(args.input)
    experiment_id = rows[0].get('experiment_id', 'unknown') if rows else 'unknown'

    ble_times = []
    ble_rssi  = []
    for r in rows:
        t    = safe_float(r.get('time_s'))
        rssi = safe_float(r.get('rssi'))
        if t is not None and rssi is not None:
            ble_times.append(t)
            ble_rssi.append(rssi)

    event_times  = []
    event_labels = []
    for r in rows:
        e = r.get('event', '')
        t = safe_float(r.get('time_s'))
        if e and t is not None and e not in ('', None):
            event_times.append(t)
            event_labels.append(e)

    if not ble_times:
        print("No BLE RSSI data found in input file.")
        sys.exit(0)

    fig, ax = plt.subplots(figsize=(12, 5))
    ax.plot(ble_times, ble_rssi, color='black', linewidth=1.0, label='RSSI (dBm)')
    ax.axhline(-75, color='gray', linestyle='--', linewidth=0.8, label='Candidate threshold (−75 dBm)')

    # Mark key events
    key_events = {'VISIBLE', 'DANGER_POINT', 'LANE_ENTER', 'DART_OUT',
                  'SIDEWALK_PARALLEL', 'FALSE_POSITIVE_CASE', 'TRUE_DANGER_CASE'}
    colors = {
        'VISIBLE':             'blue',
        'DANGER_POINT':        'red',
        'LANE_ENTER':          'orange',
        'DART_OUT':            'red',
        'SIDEWALK_PARALLEL':   'green',
        'FALSE_POSITIVE_CASE': 'green',
        'TRUE_DANGER_CASE':    'red',
    }
    plotted_labels = set()
    for t, e in zip(event_times, event_labels):
        if e in key_events:
            c = colors.get(e, 'purple')
            lbl = e if e not in plotted_labels else None
            ax.axvline(t, color=c, linestyle=':', linewidth=1.2, label=lbl)
            plotted_labels.add(e)

    label = args.scenario_label or experiment_id
    ax.set_title(f'BLE RSSI over Time — {label}')
    ax.set_xlabel('Time (s)')
    ax.set_ylabel('RSSI (dBm)')
    ax.legend(fontsize=8, loc='lower right')
    ax.grid(True, alpha=0.3)
    fig.tight_layout()

    os.makedirs(args.output_dir, exist_ok=True)
    out_path = os.path.join(args.output_dir, f'{experiment_id}_rssi.png')
    fig.savefig(out_path, dpi=150)
    plt.close(fig)
    print(f"Saved → {out_path}")


if __name__ == '__main__':
    main()
