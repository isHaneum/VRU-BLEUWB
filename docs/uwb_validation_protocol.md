# UWB Validation Protocol — RX_RESP_TIMEOUT Burst Suppression

This document defines the acceptance tests for the UWB TWR diagnostic and
recovery patch. The goal is to verify that a single `RX_RESP_TIMEOUT` cannot
develop into an unrecoverable burst, and that the dashboard makes the cause of
any remaining failure observable.

The tests assume the new firmware in `firmware/UWB_DWM3000/` and the updated
Live Sensors tab in `dashboard/`.

---

## Firmware vocabulary under test

Initiator (`node_A`) emits one of:

```
node_A,BOOT,INITIATOR
node_A,CONFIG,channel=...,pan=...,addr=...,peer=...,role=INITIATOR
timestamp_ms,node_A,seq,range_m,OK
timestamp_ms,node_A,seq,,RX_RESP_TIMEOUT,consecutive_timeout=N
timestamp_ms,node_A,seq,,RX_RESP_ERR
timestamp_ms,node_A,seq,,RX_RESTART
timestamp_ms,node_A,seq,,DW_REINIT,reason=TIMEOUT_BURST,count=N
```

Responder (`node_B`) emits one of:

```
node_B,BOOT,RESPONDER
node_B,CONFIG,channel=...,pan=...,addr=...,peer=...,role=RESPONDER
timestamp_ms,node_B,READY                          # every 1 s
timestamp_ms,node_B,RX_ARMED
timestamp_ms,node_B,RX_POLL
timestamp_ms,node_B,TX_RESP_SCHEDULED
timestamp_ms,node_B,TX_DONE
timestamp_ms,node_B,RX_ERR
timestamp_ms,node_B,RX_TIMEOUT
timestamp_ms,node_B,RX_RESTART
timestamp_ms,node_B,RX_WATCHDOG_RESTART            # 2 s no POLL
timestamp_ms,node_B,DW_REINIT,reason=NO_POLL,count=N   # 10 s no POLL
```

Recovery thresholds (initiator):
- `WAIT_RX_RESP_TIMEOUT_MS = 30` ms, `WAIT_RX_FINAL_RTINFO_MS = 30` ms
- `SOFT_RECOVERY_THRESHOLD = 5` consecutive timeouts → `forceIdle` + clear + `standardRX`
- `DW_REINIT_THRESHOLD = 20` consecutive timeouts → full `hardReset`+`softReset`+`init`
- Counter clears only on successful `OK`

Watchdog (responder):
- `WATCHDOG_SOFT_MS = 2000` ms without `RX_POLL` → soft RX restart
- `WATCHDOG_REINIT_MS = 10000` ms without `RX_POLL` → full DW3000 reinit

---

## Test A — Serial-only baseline

1. Close the dashboard (no Web Serial client active).
2. Open the Arduino IDE Serial Monitor on `node_A` only at 115200.
3. Power `node_B` and let the responder firmware run.
4. Place both boards at fixed positions, 1 m LOS, no hand contact, 30 seconds.

**Expected**
- node_A emits a dense `,OK` stream (target: ≥ 4 OK / second).
- If any `RX_RESP_TIMEOUT` line appears, the next `,OK` must arrive within
  ≤ 1 s on its own (no manual reset).
- No `DW_REINIT` line during the 30 s window in a healthy environment.

**Record**: OK count, RX_RESP_TIMEOUT count, longest run of consecutive
timeouts, any `RX_RESTART` / `DW_REINIT` lines.

---

## Test B — Responder heartbeat

1. Open the Serial Monitor on `node_B` (in addition to or instead of A).
2. Confirm `node_B,READY` appears every ≈ 1 s, with no large gaps.
3. Once `node_A` starts ranging, confirm a `RX_POLL` → `TX_RESP_SCHEDULED`
   → `TX_DONE` triplet per cycle.

**Expected**
- When `node_A` is healthy: `READY` heartbeat plus a per-cycle
  `RX_POLL`/`TX_DONE` pair.
- When `node_A` is in a timeout burst: `READY` continues, `RX_POLL` count
  drops or stops — proving where the silence is. If `RX_POLL` keeps arriving
  while `node_A` reports `RX_RESP_TIMEOUT`, the loss is downstream of the
  responder (responder reply not received by initiator).

---

## Test C — node_B reset test

1. While `node_A` is showing a timeout burst, reset only `node_B` (button
   press, not USB unplug).

**Expected**
- If `node_A` returns to `,OK` within 2 s after responder boot completes,
  the responder state machine was stuck.
- Record the time-to-recovery and whether `node_A` reported its own
  `DW_REINIT` before recovery.

---

## Test D — node_A reset test

1. While `node_A` is showing a timeout burst, reset only `node_A`.

**Expected**
- If `node_A` returns to `,OK` quickly without touching node_B, the initiator
  state machine was stuck.
- Record whether `node_B` ever logged `RX_WATCHDOG_RESTART` or
  `DW_REINIT,reason=NO_POLL` before the reset.

---

## Test E — Dashboard interference test

1. Run Test A first (serial-only baseline) and record numbers.
2. Close the Serial Monitor, open the dashboard at
   `http://127.0.0.1:7788/dashboard/index.html`, connect node_A in
   the Live Sensors tab.
3. Run for 30 s under the same conditions.

**Expected**
- OK rate should be within ≈ 10 % of the serial-only baseline.
- If OK rate collapses only when the dashboard is connected, the
  Web Serial parsing or rendering is interfering (e.g. blocking parses,
  long synchronous chart redraws).

---

## Test F — RF placement test

1. Place both boards 50 cm away from the laptop using a USB extension.
2. Mount on non-metal supports. Do not hold by hand.
3. Run for 30 s.

**Expected**
- If OK rate improves substantially vs the laptop-adjacent baseline,
  laptop RF / hand absorption is a major contributor.

---

## Suppression success criteria

The fix passes only if **all** of the following hold:

- A single `RX_RESP_TIMEOUT` does not lead to a long unrecoverable burst.
- After `≥ 5` consecutive timeouts, `node_A` performs `RX_RESTART`.
- After `≥ 20` consecutive timeouts, `node_A` performs `DW_REINIT`.
- After `≥ 10 s` without `RX_POLL`, `node_B` performs `DW_REINIT,reason=NO_POLL`.
- The dashboard shows the responder heartbeat state, the timeout burst counter,
  the rolling OK / TIMEOUT rates, and the per-node reinit counts.
- `CURRENT UWB RANGE` is never shown during `TIMEOUT` / `LOST`.
- `Last valid range` is shown with its age and flagged as stale.
- OK ranging can recover without physically unplugging or resetting both boards.

---

## Quick acceptance script

When running Test A through F, fill out this table:

| Test | Setup                       | OK / 30s | Max consecutive TO | RX_RESTART count | DW_REINIT count | Notes |
|------|-----------------------------|---------:|-------------------:|-----------------:|----------------:|-------|
| A    | Serial-only baseline        |          |                    |                  |                 |       |
| B    | Heartbeat verification      |    n/a   |                    |                  |                 |       |
| C    | node_B reset during burst   |          |                    |                  |                 | Recovery time = ___ s |
| D    | node_A reset during burst   |          |                    |                  |                 | Recovery time = ___ s |
| E    | Dashboard connected         |          |                    |                  |                 |       |
| F    | 50 cm away, non-metal mount |          |                    |                  |                 |       |
