#!/usr/bin/env python3
"""
plot_uwb_error.py — Plot UWB range measurements and error vs. ground truth.

Usage:
    python plot_uwb_error.py --input <merged_csv>
                             [--ground_truth_m <float>]
                             [--output_dir plots/]
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
    parser = argparse.ArgumentParser(description='Plot UWB range and error.')
    parser.add_argument('--input',          required=False, default='')
    parser.add_argument('--ground_truth_m', type=float, default=None,
                        help='True distance in meters (constant reference)')
    parser.add_argument('--output_dir',     default='plots')
    args = parser.parse_args()

    if not args.input or not os.path.isfile(args.input):
        print("Warning: --input not provided or file not found.")
        print("Example: python plot_uwb_error.py --input data/processed/sample_01_merged.csv --ground_truth_m 5.0")
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

    uwb_times  = []
    uwb_ranges = []
    for r in rows:
        t  = safe_float(r.get('time_s'))
        rm = safe_float(r.get('uwb_range_m'))
        if t is not None and rm is not None and r.get('uwb_status') == 'OK':
            uwb_times.append(t)
            uwb_ranges.append(rm)

    event_times  = []
    event_labels = []
    for r in rows:
        e = r.get('event', '')
        t = safe_float(r.get('time_s'))
        if e and t is not None:
            event_times.append(t)
            event_labels.append(e)

    if not uwb_times:
        print("No valid UWB OK rows found in input file.")
        sys.exit(0)

    fig, axes = plt.subplots(2, 1, figsize=(12, 8), sharex=True)

    # ── Top: Range over time ────────────────────────────────────────────────
    ax = axes[0]
    ax.plot(uwb_times, uwb_ranges, color='black', linewidth=1.0, label='UWB range (m)')
    if args.ground_truth_m is not None:
        ax.axhline(args.ground_truth_m, color='blue', linestyle='--',
                   linewidth=0.9, label=f'Ground truth ({args.ground_truth_m:.1f} m)')

    key_events = {'VISIBLE', 'DANGER_POINT', 'LANE_ENTER', 'DART_OUT'}
    colors = {'VISIBLE': 'blue', 'DANGER_POINT': 'red', 'LANE_ENTER': 'orange', 'DART_OUT': 'red'}
    plotted = set()
    for t, e in zip(event_times, event_labels):
        if e in key_events:
            c = colors.get(e, 'purple')
            lbl = e if e not in plotted else None
            ax.axvline(t, color=c, linestyle=':', linewidth=1.2, label=lbl)
            plotted.add(e)

    ax.set_ylabel('Range (m)')
    ax.set_title(f'UWB Range — {experiment_id}')
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    # ── Bottom: Range error ────────────────────────────────────────────────
    ax2 = axes[1]
    if args.ground_truth_m is not None:
        errors = [abs(r - args.ground_truth_m) for r in uwb_ranges]
        ax2.plot(uwb_times, errors, color='black', linewidth=1.0, label='|error| (m)')
        ax2.axhline(0.3, color='gray', linestyle='--', linewidth=0.8, label='0.3 m threshold')
        ax2.set_ylabel('|Range Error| (m)')
        ax2.legend(fontsize=8)
        ax2.grid(True, alpha=0.3)
    else:
        ax2.text(0.5, 0.5, 'Provide --ground_truth_m to show range error',
                 ha='center', va='center', transform=ax2.transAxes, fontsize=10)

    ax2.set_xlabel('Time (s)')
    fig.tight_layout()

    os.makedirs(args.output_dir, exist_ok=True)
    out_path = os.path.join(args.output_dir, f'{experiment_id}_uwb_error.png')
    fig.savefig(out_path, dpi=150)
    plt.close(fig)
    print(f"Saved → {out_path}")


if __name__ == '__main__':
    main()
