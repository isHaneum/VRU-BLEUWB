#!/usr/bin/env python3
"""
plot_lead_time.py — Plot warning lead time distribution across experiments.

Reads one or more filtered CSVs and plots a bar chart of warning lead time
(time from first CANDIDATE state to VISIBLE event) per experiment.

Usage:
    python plot_lead_time.py --inputs <csv1> [<csv2> ...]
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


def extract_lead_times(rows):
    """Return list of (scenario, lead_time_s) tuples."""
    results = []
    candidate_t = None
    scenario    = rows[0].get('scenario', '') if rows else ''
    for r in rows:
        state = r.get('state', '')
        event = r.get('event', '')
        t     = safe_float(r.get('time_s'))
        if t is None:
            continue
        if state == 'CANDIDATE' and candidate_t is None:
            candidate_t = t
        if event == 'VISIBLE' and candidate_t is not None:
            results.append((scenario, round(t - candidate_t, 3)))
            candidate_t = None
    return results


def main():
    parser = argparse.ArgumentParser(description='Plot warning lead time distribution.')
    parser.add_argument('--inputs',     nargs='+', default=[],
                        help='One or more filtered CSV paths')
    parser.add_argument('--output_dir', default='plots')
    args = parser.parse_args()

    if not args.inputs:
        print("Warning: --inputs not provided.")
        print("Example: python plot_lead_time.py "
              "--inputs data/processed/exp1_filtered.csv data/processed/exp2_filtered.csv")
        sys.exit(0)

    valid_inputs = [p for p in args.inputs if os.path.isfile(p)]
    if not valid_inputs:
        print("Warning: None of the provided --inputs files exist.")
        sys.exit(0)

    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        print("Error: matplotlib not installed. Run: pip install matplotlib")
        sys.exit(1)

    all_labels     = []
    all_lead_times = []

    for path in valid_inputs:
        rows = load_csv(path)
        exp_id = rows[0].get('experiment_id', os.path.basename(path)) if rows else path
        lts = extract_lead_times(rows)
        for (scenario, lt) in lts:
            all_labels.append(f"{exp_id}\n({scenario})")
            all_lead_times.append(lt)

    if not all_lead_times:
        print("No warning lead time data found (need CANDIDATE state + VISIBLE event).")
        sys.exit(0)

    fig, ax = plt.subplots(figsize=(max(8, len(all_labels) * 1.2), 5))
    x = range(len(all_labels))
    ax.bar(x, all_lead_times, color='black', edgecolor='black', width=0.6)
    ax.axhline(0, color='gray', linewidth=0.5)
    ax.set_xticks(list(x))
    ax.set_xticklabels(all_labels, fontsize=7, rotation=30, ha='right')
    ax.set_ylabel('Warning Lead Time (s)')
    ax.set_title('Warning Lead Time per Experiment\n(Time from CANDIDATE to VISIBLE)')
    ax.grid(True, axis='y', alpha=0.3)
    fig.tight_layout()

    os.makedirs(args.output_dir, exist_ok=True)
    out_path = os.path.join(args.output_dir, 'lead_time_distribution.png')
    fig.savefig(out_path, dpi=150)
    plt.close(fig)
    print(f"Saved → {out_path}")


if __name__ == '__main__':
    main()
