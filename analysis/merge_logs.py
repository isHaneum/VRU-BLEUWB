#!/usr/bin/env python3
"""
merge_logs.py — Merge BLE, UWB, and iOS event logs by experiment_id.

Usage:
    python merge_logs.py --experiment_id <id>
                         --ble <ble_csv>
                         --uwb <uwb_csv>
                         --events <ios_event_csv>
                         [--offset <seconds_float>]
                         [--output <output_csv>]

The iOS START button press is used as the time anchor (t=0).
BLE and UWB timestamps (millis()) are aligned to this anchor.

Output: data/processed/{experiment_id}_merged.csv
"""

import argparse
import csv
import os
import sys


def load_ios_events(path):
    rows = []
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    return rows


def load_ble_csv(path):
    rows = []
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    return rows


def load_uwb_csv(path):
    rows = []
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    return rows


def find_start_millis(ble_rows, uwb_rows, ios_rows):
    """
    Estimate the ESP32 millis() value corresponding to iOS time t=0 (START).
    Strategy: Use the first BLE/UWB row timestamp as a rough anchor.
    The --offset flag allows manual correction.
    Returns a float (millis offset to subtract from ESP timestamps).
    """
    # Use the smallest timestamp across BLE and UWB as start reference
    min_ts = None
    for row in ble_rows:
        try:
            ts = int(row['timestamp_ms'])
            if min_ts is None or ts < min_ts:
                min_ts = ts
        except (KeyError, ValueError):
            pass
    for row in uwb_rows:
        try:
            ts = int(row['timestamp_ms'])
            if min_ts is None or ts < min_ts:
                min_ts = ts
        except (KeyError, ValueError):
            pass
    return float(min_ts) if min_ts is not None else 0.0


def millis_to_rel_s(ts_ms, origin_ms, offset_s):
    return (float(ts_ms) - origin_ms) / 1000.0 + offset_s


def merge(experiment_id, ble_rows, uwb_rows, ios_rows, offset_s):
    """
    Merge all three sources into a unified list of dicts sorted by time_s.
    """
    merged = []
    origin_ms = find_start_millis(ble_rows, uwb_rows, ios_rows)

    # Get scenario from iOS events (first non-empty)
    scenario = ''
    node_id  = ''
    for row in ios_rows:
        if row.get('scenario'):
            scenario = row['scenario']
        if row.get('node_id'):
            node_id = row['node_id']
        if scenario and node_id:
            break

    # iOS events
    for row in ios_rows:
        try:
            time_s = float(row.get('time_s', 0))
        except ValueError:
            time_s = 0.0
        merged.append({
            'experiment_id':  experiment_id,
            'time_s':         round(time_s + offset_s, 4),
            'scenario':       row.get('scenario', scenario),
            'event':          row.get('event', ''),
            'node_id':        row.get('node_id', node_id),
            'rssi':           '',
            'uwb_range_m':    '',
            'uwb_status':     '',
            'risk_score':     '',
            'risk_level':     '',
            'ground_truth_m': '',
            'occlusion_state': row.get('occlusion_state', ''),
            'carry_position': row.get('carry_position', ''),
            'target_zone':    row.get('target_zone', ''),
            'target_motion':  row.get('target_motion', ''),
        })

    # BLE rows
    for row in ble_rows:
        try:
            ts_ms = int(row['timestamp_ms'])
        except (KeyError, ValueError):
            continue
        time_s = millis_to_rel_s(ts_ms, origin_ms, offset_s)
        merged.append({
            'experiment_id':  experiment_id,
            'time_s':         round(time_s, 4),
            'scenario':       scenario,
            'event':          '',
            'node_id':        row.get('node_id', ''),
            'rssi':           row.get('rssi', ''),
            'uwb_range_m':    '',
            'uwb_status':     '',
            'risk_score':     '',
            'risk_level':     '',
            'ground_truth_m': '',
            'occlusion_state': '',
            'carry_position': '',
            'target_zone':    '',
            'target_motion':  '',
        })

    # UWB rows
    for row in uwb_rows:
        try:
            ts_ms = int(row['timestamp_ms'])
        except (KeyError, ValueError):
            continue
        time_s = millis_to_rel_s(ts_ms, origin_ms, offset_s)
        merged.append({
            'experiment_id':  experiment_id,
            'time_s':         round(time_s, 4),
            'scenario':       scenario,
            'event':          '',
            'node_id':        row.get('node_id', ''),
            'rssi':           '',
            'uwb_range_m':    row.get('range_m', ''),
            'uwb_status':     row.get('status', ''),
            'risk_score':     '',
            'risk_level':     '',
            'ground_truth_m': '',
            'occlusion_state': '',
            'carry_position': '',
            'target_zone':    '',
            'target_motion':  '',
        })

    merged.sort(key=lambda r: float(r['time_s']))
    return merged


FIELDNAMES = [
    'experiment_id', 'time_s', 'scenario', 'event', 'node_id',
    'rssi', 'uwb_range_m', 'uwb_status', 'risk_score', 'risk_level',
    'ground_truth_m', 'occlusion_state', 'carry_position',
    'target_zone', 'target_motion',
]


def write_output(rows, output_path):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} rows → {output_path}")


def main():
    parser = argparse.ArgumentParser(description='Merge BLE, UWB, and iOS event logs.')
    parser.add_argument('--experiment_id', required=True, help='Experiment ID string')
    parser.add_argument('--ble',    required=False, default='', help='BLE CSV file path')
    parser.add_argument('--uwb',    required=False, default='', help='UWB CSV file path')
    parser.add_argument('--events', required=False, default='', help='iOS event CSV path')
    parser.add_argument('--offset', type=float, default=0.0,
                        help='Additional time offset in seconds to apply to ESP timestamps')
    parser.add_argument('--output', default='',
                        help='Output CSV path (default: data/processed/{id}_merged.csv)')
    args = parser.parse_args()

    ble_rows   = load_ble_csv(args.ble)    if args.ble    and os.path.isfile(args.ble)    else []
    uwb_rows   = load_uwb_csv(args.uwb)   if args.uwb    and os.path.isfile(args.uwb)    else []
    ios_rows   = load_ios_events(args.events) if args.events and os.path.isfile(args.events) else []

    if not ble_rows and not uwb_rows and not ios_rows:
        print("Warning: No input files found or all paths are empty. "
              "Pass --ble, --uwb, --events with valid paths.")
        print("Example (using sample data):")
        print("  python merge_logs.py --experiment_id sample_01 "
              "--ble data/sample/sample_ble.csv "
              "--uwb data/sample/sample_uwb.csv "
              "--events data/sample/sample_events.csv")
        sys.exit(0)

    merged = merge(args.experiment_id, ble_rows, uwb_rows, ios_rows, args.offset)

    output_path = args.output or os.path.join(
        'data', 'processed', f'{args.experiment_id}_merged.csv'
    )
    write_output(merged, output_path)


if __name__ == '__main__':
    main()
