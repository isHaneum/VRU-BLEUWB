#!/usr/bin/env python3
"""
plot_false_positive.py — Visualize false positive vs. true positive confirmation rates
across scenarios from one or more filtered CSVs.

Usage:
    python plot_false_positive.py --inputs <csv1> [<csv2> ...]
                                  [--output_dir plots/]
"""

import argparse
import csv
import os
import sys
from collections import defaultdict


def load_csv(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def main():
    parser = argparse.ArgumentParser(description='Plot false positive rate by scenario.')
    parser.add_argument('--inputs',     nargs='+', default=[])
    parser.add_argument('--output_dir', default='plots')
    args = parser.parse_args()

    if not args.inputs:
        print("Warning: --inputs not provided.")
        print("Example: python plot_false_positive.py "
              "--inputs data/processed/exp1_filtered.csv")
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

    # Count TP and FP per scenario
    scenario_tp = defaultdict(int)
    scenario_fp = defaultdict(int)

    for path in valid_inputs:
        rows = load_csv(path)
        for r in rows:
            state = r.get('state', '')
            event = r.get('event', '')
            sc    = r.get('scenario', 'unknown')
            if state == 'CONFIRMED_RISK':
                if event == 'TRUE_DANGER_CASE':
                    scenario_tp[sc] += 1
                elif event == 'FALSE_POSITIVE_CASE':
                    scenario_fp[sc] += 1

    scenarios = sorted(set(list(scenario_tp.keys()) + list(scenario_fp.keys())))
    if not scenarios:
        print("No CONFIRMED_RISK + TRUE/FALSE_POSITIVE_CASE events found.")
        sys.exit(0)

    tp_vals = [scenario_tp.get(s, 0) for s in scenarios]
    fp_vals = [scenario_fp.get(s, 0) for s in scenarios]

    x = range(len(scenarios))
    width = 0.35

    fig, ax = plt.subplots(figsize=(max(8, len(scenarios) * 1.5), 5))
    ax.bar([i - width / 2 for i in x], tp_vals, width,
           label='True Positive (CONFIRMED_RISK)', color='black', edgecolor='black')
    ax.bar([i + width / 2 for i in x], fp_vals, width,
           label='False Positive (CONFIRMED_RISK)', color='white', edgecolor='black', hatch='//')

    ax.set_xticks(list(x))
    ax.set_xticklabels(scenarios, fontsize=8, rotation=20, ha='right')
    ax.set_ylabel('Count')
    ax.set_title('True vs. False Positive CONFIRMED_RISK Events by Scenario')
    ax.legend()
    ax.grid(True, axis='y', alpha=0.3)
    fig.tight_layout()

    os.makedirs(args.output_dir, exist_ok=True)
    out_path = os.path.join(args.output_dir, 'false_positive_by_scenario.png')
    fig.savefig(out_path, dpi=150)
    plt.close(fig)
    print(f"Saved → {out_path}")


if __name__ == '__main__':
    main()
