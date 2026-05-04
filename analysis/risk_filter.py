#!/usr/bin/env python3
"""
risk_filter.py — Offline rule-based risk state machine.

Reads a merged CSV (output of merge_logs.py) and computes risk scores and
state transitions per row. Appends risk_score, risk_level, state, reason,
and suppressed_flag columns.

Usage:
    python risk_filter.py --input <merged_csv> [--output <out_csv>]

See docs/risk_filter_design.md for the full specification.
"""

import argparse
import csv
import os
import sys


# ─── Thresholds ──────────────────────────────────────────────────────────────

RSSI_FLOOR            = -90.0
RSSI_CEIL             = -50.0
RSSI_CANDIDATE_DBM    = -75.0
HIT_WINDOW_S          = 0.5
HIT_COUNT_MIN         = 3
RISK_CONFIRM          = 0.60
RISK_SUPPRESS         = 0.25
TIMEOUT_CANDIDATE_S   = 2.0
SUPPRESS_COOLDOWN_S   = 5.0
UWB_MAX_RANGE_M       = 20.0
RANGE_RATE_MAX_MPS    = 3.0
RSSI_STABLE_VAR_THR   = 4.0   # dB²

# Weights
W_BLE   = 0.30
W_UWB   = 0.25
W_ENTRY = 0.25
W_CONF  = 0.20

# Event sets
ROAD_ENTRY_HIGH  = {'LANE_ENTER', 'DART_OUT', 'CROSSWALK_APPROACH'}
ROAD_ENTRY_MED   = {'ALLEY_ENTRY', 'RIGHT_TURN_CONFLICT'}
ROAD_ENTRY_SUPP  = {'SIDEWALK_PARALLEL', 'OPPOSITE_SIDEWALK', 'CURB_WAITING'}
CONFLICT_HIGH    = {'DANGER_POINT', 'RIGHT_TURN_CONFLICT', 'TRUE_DANGER_CASE'}
CONFLICT_ZERO    = {'FALSE_POSITIVE_CASE'}


def rssi_norm(rssi_dbm):
    v = (float(rssi_dbm) - RSSI_FLOOR) / (RSSI_CEIL - RSSI_FLOOR)
    return max(0.0, min(1.0, v))


def compute_ble_score(rssi_dbm, sidewalk_penalty):
    return rssi_norm(rssi_dbm) * (1.0 - sidewalk_penalty)


def compute_uwb_score(range_m, prev_range_m, dt_s, uwb_status):
    if uwb_status != 'OK':
        return 0.0
    try:
        r = float(range_m)
    except (ValueError, TypeError):
        return 0.0
    range_norm = max(0.0, min(1.0, 1.0 - r / UWB_MAX_RANGE_M))
    rate_norm  = 0.0
    if prev_range_m is not None and dt_s > 0:
        rate = (float(prev_range_m) - r) / dt_s   # positive = closing
        rate_norm = max(0.0, min(1.0, rate / RANGE_RATE_MAX_MPS))
    return 0.5 * range_norm + 0.5 * rate_norm


def road_entry_score(event):
    if event in ROAD_ENTRY_HIGH:
        return 1.0
    if event in ROAD_ENTRY_MED:
        return 0.8
    if event in ROAD_ENTRY_SUPP:
        return 0.0
    return 0.3


def conflict_score(event):
    if event == 'DANGER_POINT':
        return 1.0
    if event in CONFLICT_HIGH:
        return 0.8
    if event in CONFLICT_ZERO:
        return 0.0
    return 0.4


FIELDNAMES_OUT = [
    'experiment_id', 'time_s', 'scenario', 'event', 'node_id',
    'rssi', 'uwb_range_m', 'uwb_status',
    'risk_score', 'risk_level', 'state', 'reason', 'suppressed_flag',
    'ground_truth_m', 'occlusion_state', 'carry_position',
    'target_zone', 'target_motion',
]

STATE_IDLE      = 'IDLE'
STATE_CANDIDATE = 'CANDIDATE'
STATE_CONFIRMED = 'CONFIRMED_RISK'
STATE_SUPPRESSED= 'SUPPRESSED'


def risk_level_str(score):
    if score >= 0.80:
        return 'ALERT'
    if score >= 0.60:
        return 'WARN'
    if score >= 0.30:
        return 'LOW'
    return 'NONE'


def run_filter(rows):
    state           = STATE_IDLE
    candidate_entry = None    # time_s when candidate state was entered
    suppress_entry  = None    # time_s when suppressed state was entered

    prev_range_m    = None
    prev_time_s     = None

    # Rolling RSSI window for stability check
    rssi_window     = []   # list of (time_s, rssi_dbm)

    # Hit counter window
    hit_window      = []   # list of time_s

    out = []

    for row in rows:
        try:
            time_s = float(row['time_s'])
        except (ValueError, TypeError):
            time_s = 0.0

        event      = row.get('event', '')
        rssi_raw   = row.get('rssi', '')
        uwb_range  = row.get('uwb_range_m', '')
        uwb_status = row.get('uwb_status', '')

        # Parse RSSI
        try:
            rssi_dbm = float(rssi_raw) if rssi_raw else None
        except ValueError:
            rssi_dbm = None

        # Parse UWB range
        try:
            range_m_val = float(uwb_range) if uwb_range else None
        except ValueError:
            range_m_val = None

        # Update hit window
        if rssi_dbm is not None:
            hit_window.append(time_s)
        hit_window = [t for t in hit_window if time_s - t <= HIT_WINDOW_S]

        # Update RSSI rolling window
        if rssi_dbm is not None:
            rssi_window.append((time_s, rssi_dbm))
        rssi_window = [(t, r) for (t, r) in rssi_window if time_s - t <= 3.0]

        # Sidewalk stability check
        sidewalk_penalty = 0.0
        if event in ROAD_ENTRY_SUPP:
            sidewalk_penalty = 0.6
        elif len(rssi_window) >= 5:
            vals = [r for (_, r) in rssi_window]
            mean = sum(vals) / len(vals)
            var  = sum((r - mean) ** 2 for r in vals) / len(vals)
            if var < RSSI_STABLE_VAR_THR:
                sidewalk_penalty = 0.6

        # Compute component scores
        ble_s  = compute_ble_score(rssi_dbm, sidewalk_penalty) if rssi_dbm is not None else 0.0
        dt_s   = (time_s - prev_time_s) if prev_time_s is not None else 0.0
        uwb_s  = compute_uwb_score(range_m_val, prev_range_m, dt_s, uwb_status)
        re_s   = road_entry_score(event) if event else 0.3
        co_s   = conflict_score(event)   if event else 0.4

        score = W_BLE * ble_s + W_UWB * uwb_s + W_ENTRY * re_s + W_CONF * co_s

        # Override: suppress road entry if event is sidewalk type
        if event in ROAD_ENTRY_SUPP:
            re_s  = 0.0
            score = W_BLE * ble_s + W_UWB * uwb_s + W_ENTRY * re_s + W_CONF * co_s

        reason = ''
        suppressed = '0'

        # ── State machine transitions ──────────────────────────────────────
        triggered = (rssi_dbm is not None and
                     rssi_dbm >= RSSI_CANDIDATE_DBM and
                     len(hit_window) >= HIT_COUNT_MIN)

        if state == STATE_IDLE:
            if triggered:
                state = STATE_CANDIDATE
                candidate_entry = time_s
                reason = 'BLE_TRIGGER'

        elif state == STATE_CANDIDATE:
            if score >= RISK_CONFIRM:
                state = STATE_CONFIRMED
                reason = f'SCORE_CONFIRM_{score:.2f}'
            elif candidate_entry is not None and (time_s - candidate_entry) > TIMEOUT_CANDIDATE_S:
                state = STATE_IDLE
                candidate_entry = None
                reason = 'CANDIDATE_TIMEOUT'
            elif not triggered:
                state = STATE_IDLE
                candidate_entry = None
                reason = 'SIGNAL_LOST'

        elif state == STATE_CONFIRMED:
            if score < RISK_SUPPRESS and event in ROAD_ENTRY_SUPP:
                state = STATE_SUPPRESSED
                suppress_entry = time_s
                reason = f'SIDEWALK_SUPPRESS_{score:.2f}'
                suppressed = '1'
            elif score < RISK_SUPPRESS and not triggered:
                state = STATE_IDLE
                reason = f'SCORE_DROP_{score:.2f}'

        elif state == STATE_SUPPRESSED:
            suppressed = '1'
            if suppress_entry is not None and (time_s - suppress_entry) > SUPPRESS_COOLDOWN_S:
                state = STATE_IDLE
                suppress_entry = None
                suppressed = '0'
                reason = 'SUPPRESS_COOLDOWN_DONE'

        out_row = dict(row)
        out_row['risk_score']      = f'{score:.4f}'
        out_row['risk_level']      = risk_level_str(score)
        out_row['state']           = state
        out_row['reason']          = reason
        out_row['suppressed_flag'] = suppressed

        out.append(out_row)

        # Update prev values
        if range_m_val is not None and uwb_status == 'OK':
            prev_range_m = range_m_val
        prev_time_s = time_s

    return out


def main():
    parser = argparse.ArgumentParser(description='Apply offline risk filter to merged CSV.')
    parser.add_argument('--input',  required=False, default='',
                        help='Merged CSV from merge_logs.py')
    parser.add_argument('--output', required=False, default='',
                        help='Output CSV path (default: <input>_filtered.csv)')
    args = parser.parse_args()

    if not args.input or not os.path.isfile(args.input):
        print("Warning: --input not provided or file not found.")
        print("Example:")
        print("  python risk_filter.py --input data/processed/sample_01_merged.csv")
        sys.exit(0)

    with open(args.input, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    filtered = run_filter(rows)

    out_path = args.output or args.input.replace('.csv', '_filtered.csv')
    out_fieldnames = list(FIELDNAMES_OUT)
    # Preserve any extra columns from input
    for k in (filtered[0].keys() if filtered else []):
        if k not in out_fieldnames:
            out_fieldnames.append(k)

    os.makedirs(os.path.dirname(out_path) if os.path.dirname(out_path) else '.', exist_ok=True)
    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=out_fieldnames, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(filtered)

    print(f"Wrote {len(filtered)} rows → {out_path}")


if __name__ == '__main__':
    main()
