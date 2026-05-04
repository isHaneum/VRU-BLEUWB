#!/usr/bin/env python3
"""
simple_scenario_sim.py — Kinematic simulation of VRU warning lead time.

Simulates an ego vehicle on a straight road and a VRU crossing laterally.
Computes the theoretical warning lead time as a function of detection delay
and cooperative relay delay.

Output: CSV with columns:
    scenario, ego_speed_mps, vru_speed_mps, detection_delay_ms,
    coop_delay_ms, warning_lead_time_s, collision_relevance

Usage:
    python simple_scenario_sim.py [--output simulation_results.csv]
                                  [--plot]
                                  [--plot_output_dir plots/]
"""

import argparse
import csv
import os
import math


# ─── Scenario Definitions ────────────────────────────────────────────────────

SCENARIOS = [
    # (name, ego_speed_mps, vru_speed_mps, vru_start_x_m, road_width_m)
    # vru_start_x_m: lateral distance from the edge of VRU entry point to road center
    # VRU crosses from the side perpendicular to ego direction.
    ('S1_ALLEY_DART_OUT',           8.33,  1.2, 3.0, 3.5),   # 30 km/h, 1.2 m/s walk, 3m alley offset
    ('S1_ALLEY_DART_OUT_FAST',      8.33,  2.5, 3.0, 3.5),   # fast pedestrian
    ('S2_RIGHT_TURN_CONFLICT',      5.56,  1.2, 5.0, 3.5),   # 20 km/h turning speed
    ('S4_LANE_SPLIT_BICYCLE',      11.11,  4.0, 0.5, 7.0),   # 40 km/h ego, 4 m/s bicycle
    ('S4_LANE_SPLIT_MOTORCYCLE',   13.89,  8.0, 0.5, 7.0),   # 50 km/h ego, 8 m/s motorcycle
]

DETECTION_DELAYS_MS  = [0, 100, 200, 300, 500, 800, 1000]
COOP_DELAYS_MS       = [0, 10, 50, 100, 200]


def time_to_conflict(ego_speed_mps, vru_speed_mps, vru_start_x_m):
    """
    Estimate the time (s) from VRU entering the road until the conflict point
    (VRU reaches road center).

    VRU crosses at right angles to the ego vehicle's path.
    conflict_time = vru_start_x_m / vru_speed_mps
    """
    if vru_speed_mps <= 0:
        return float('inf')
    return vru_start_x_m / vru_speed_mps


def warning_lead_time(t_conflict_s, detection_delay_ms, coop_delay_ms=0):
    """
    Lead time = t_conflict - (detection_delay + coop_delay)
    Positive = warning issued before conflict.
    Negative = warning issued after conflict (miss).
    """
    total_delay_s = (detection_delay_ms + coop_delay_ms) / 1000.0
    return t_conflict_s - total_delay_s


def collision_relevance(ego_speed_mps, t_conflict_s, road_width_m):
    """
    Simple check: does the ego vehicle travel through the conflict zone?
    Returns True if the ego vehicle reaches road_width_m within t_conflict_s.
    (Very simplified — real geometry requires heading, position, etc.)
    """
    # Distance ego travels in t_conflict seconds
    dist = ego_speed_mps * t_conflict_s
    # Relevant if ego will be within road_width_m of VRU crossing point
    return dist < road_width_m * 3   # rough threshold: 3 × road width


def run_simulation():
    rows = []
    for (scenario, ego_spd, vru_spd, vru_x, road_w) in SCENARIOS:
        t_conf = time_to_conflict(ego_spd, vru_spd, vru_x)
        col_rel = collision_relevance(ego_spd, t_conf, road_w)
        for dd_ms in DETECTION_DELAYS_MS:
            for cd_ms in COOP_DELAYS_MS:
                wlt = warning_lead_time(t_conf, dd_ms, cd_ms)
                rows.append({
                    'scenario':             scenario,
                    'ego_speed_mps':        round(ego_spd, 2),
                    'vru_speed_mps':        round(vru_spd, 2),
                    'detection_delay_ms':   dd_ms,
                    'coop_delay_ms':        cd_ms,
                    'warning_lead_time_s':  round(wlt, 3),
                    'collision_relevance':  'YES' if col_rel else 'NO',
                })
    return rows


FIELDNAMES = [
    'scenario', 'ego_speed_mps', 'vru_speed_mps',
    'detection_delay_ms', 'coop_delay_ms',
    'warning_lead_time_s', 'collision_relevance',
]


def write_csv(rows, path):
    os.makedirs(os.path.dirname(path) if os.path.dirname(path) else '.', exist_ok=True)
    with open(path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} rows → {path}")


def plot_results(rows, output_dir):
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib not installed — skipping plot. Run: pip install matplotlib")
        return

    os.makedirs(output_dir, exist_ok=True)

    # Group by scenario, coop_delay_ms=0, vary detection_delay_ms
    from collections import defaultdict
    scenario_data = defaultdict(list)
    for r in rows:
        if r['coop_delay_ms'] == 0:
            scenario_data[r['scenario']].append(
                (r['detection_delay_ms'], r['warning_lead_time_s'])
            )

    fig, ax = plt.subplots(figsize=(10, 6))
    linestyles = ['-', '--', ':', '-.', (0, (3, 1, 1, 1))]
    for i, (sc, points) in enumerate(sorted(scenario_data.items())):
        points.sort(key=lambda p: p[0])
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        ls = linestyles[i % len(linestyles)]
        ax.plot(xs, ys, linestyle=ls, color='black', linewidth=1.5, label=sc, marker='o', markersize=4)

    ax.axhline(0, color='red', linewidth=1.0, linestyle='--', label='Zero lead time (miss threshold)')
    ax.set_xlabel('Detection Delay (ms)')
    ax.set_ylabel('Warning Lead Time (s)')
    ax.set_title('Warning Lead Time vs. Detection Delay\n(coop_delay=0, all scenarios)')
    ax.legend(fontsize=7, loc='upper right')
    ax.grid(True, alpha=0.3)
    fig.tight_layout()

    out_path = os.path.join(output_dir, 'sim_lead_time_vs_detection_delay.png')
    fig.savefig(out_path, dpi=150)
    plt.close(fig)
    print(f"Saved → {out_path}")

    # Cooperative benefit plot: scenario S1, vary coop_delay
    s1_rows = [r for r in rows
               if r['scenario'] == 'S1_ALLEY_DART_OUT'
               and r['detection_delay_ms'] == 200]
    if s1_rows:
        s1_rows.sort(key=lambda r: r['coop_delay_ms'])
        fig2, ax2 = plt.subplots(figsize=(8, 4))
        ax2.plot(
            [r['coop_delay_ms'] for r in s1_rows],
            [r['warning_lead_time_s'] for r in s1_rows],
            color='black', marker='s', linewidth=1.5
        )
        ax2.axhline(0, color='red', linewidth=0.8, linestyle='--', label='Miss threshold')
        ax2.set_xlabel('Cooperative Relay Delay (ms)')
        ax2.set_ylabel('Warning Lead Time (s)')
        ax2.set_title('S1 Alley Dart-out: Lead Time vs. Coop Relay Delay\n(detection_delay=200 ms)')
        ax2.legend()
        ax2.grid(True, alpha=0.3)
        fig2.tight_layout()
        out2 = os.path.join(output_dir, 'sim_coop_delay_impact.png')
        fig2.savefig(out2, dpi=150)
        plt.close(fig2)
        print(f"Saved → {out2}")


def main():
    parser = argparse.ArgumentParser(
        description='Kinematic warning lead time simulation.')
    parser.add_argument('--output', default='simulation/simulation_results.csv')
    parser.add_argument('--plot', action='store_true',
                        help='Generate summary plots')
    parser.add_argument('--plot_output_dir', default='plots')
    args = parser.parse_args()

    rows = run_simulation()
    write_csv(rows, args.output)

    # Print summary table
    print(f"\n{'Scenario':<40} {'DetDelay':>10} {'CoopDelay':>10} {'LeadTime_s':>12}")
    print('-' * 76)
    for r in rows:
        if r['coop_delay_ms'] == 0:
            print(f"{r['scenario']:<40} {r['detection_delay_ms']:>10} "
                  f"{r['coop_delay_ms']:>10} {r['warning_lead_time_s']:>12.3f}")

    if args.plot:
        plot_results(rows, args.plot_output_dir)


if __name__ == '__main__':
    main()
