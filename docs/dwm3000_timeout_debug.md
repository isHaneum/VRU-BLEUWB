# DWM3000 v1.4 — Timeout & Recovery Debug Guide

Hardware in scope:
* **Initiator (node_A):** ESP32-WROOM-32 + Qorvo **DWM3000 v1.4**
* **Responder (node_B):** ESP32-WROOM-32 + Qorvo **DWM3000 v1.4**

This document **only** covers the DWM3000 v1.4 + ESP32 stack used in this
project. It does **not** apply to DWM3001 / Nearby Interaction / nRF52840 /
Zephyr-based UWB.

---

## 1. Why this guide exists

The DW3000 helper library ([lib/DW3000Arduino](../lib/DW3000Arduino)) does
DS-TWR with `receivedFrameSucc()` returning **0 forever** when the radio
RX window misses a Response or Final frame. Without a software timeout the
initiator (node_A) stays stuck in stage 1 or stage 3 and never recovers.

A second failure mode is harder to see: the responder *does* receive the
Poll, but the delayed-TX response is scheduled too late, the DW3000 misses
the TX window, and the response is silently dropped. From the initiator's
point of view this looks identical to "no Poll RX at all". Without
correlating the two CSV streams, you cannot tell them apart.

This firmware now emits an event for **every stage of every TWR cycle on
both nodes**, so the dashboard can answer the question:

> "When node_A reports RX_RESP_TIMEOUT, did node_B actually see the Poll,
>  and did node_B's Response TX complete?"

---

## 2. Event vocabulary (single source of truth)

All firmware lines are plain CSV, no decorative text:

### Boot / configuration (each node)
```
node_A,BOOT,INITIATOR,hardware=DWM3000_v1.4,firmware=uwb_initiator.ino,build=<__DATE__ __TIME__>
node_A,CONFIG,profile=ROBUST|FAST,channel=5,pan=0x1234,addr=0xA001,peer=0xB001,
              preamble=128,datarate=6.8M,sts=off,
              rx_to_ms=<n>,rtinfo_to_ms=<n>,resp_delay_us=1000,
              soft_thresh=5,reinit_thresh=20,role=INITIATOR

node_B,BOOT,RESPONDER,hardware=DWM3000_v1.4,firmware=uwb_responder.ino,build=<__DATE__ __TIME__>
node_B,CONFIG,profile=ROBUST|FAST,channel=5,pan=0x1234,addr=0xB001,peer=0xA001,
              preamble=128,datarate=6.8M,sts=off,
              final_to_ms=<n>,watchdog_soft_ms=2000,watchdog_reinit_ms=10000,
              tx_resp_late_ms=<n>,role=RESPONDER
```

### Initiator (node_A) per TWR cycle
| Event | Meaning |
|---|---|
| `TX_POLL,seq=N` | Poll frame was just sent (stage 1) |
| `RX_RESP_OK,seq=N` | Response (stage 2) received cleanly |
| `RX_RESP_TIMEOUT,seq=N,consecutive_timeout=N` | Software timeout before Response arrived |
| `RX_RESP_ERR,seq=N` | Response frame received but invalid stage / error frame |
| `TX_FINAL,seq=N` | Final frame was just sent (stage 3) |
| `RX_RTINFO_OK,seq=N` | RTInfo (stage 4) received cleanly |
| `RX_RTINFO_TIMEOUT,seq=N,consecutive_timeout=N` | Software timeout before RTInfo arrived |
| `RANGE_OK,seq=N,range_m=X.XXX` | Cycle completed, valid range computed |
| `RX_RESTART,reason=...` | Soft recovery: forceIdle + clearStatus + standardRX |
| `DW_REINIT,reason=...,count=N` | Hard recovery: hardReset + softReset + init |

Legacy compact CSV is still emitted on success and on `RX_RESP_TIMEOUT`
so the existing range-history chart keeps working:
```
<ms>,node_A,<seq>,<range_m>,OK
<ms>,node_A,<seq>,,RX_RESP_TIMEOUT,consecutive_timeout=<n>
```

### Responder (node_B) per TWR cycle
| Event | Meaning |
|---|---|
| `READY` | Heartbeat, emitted at 1 Hz from the main loop |
| `RX_ARMED` | RX has been re-armed and the responder is waiting for a new Poll |
| `RX_POLL,seq=N` | Poll received; `seq` is read from the Poll's senderID byte |
| `TX_RESP_SCHEDULED,seq=N` | Response (stage 2) was scheduled |
| `TX_RESP_DONE,seq=N` | Response TX completed within the expected window |
| `TX_RESP_LATE,seq=N,elapsed_ms=N` | Response TX took ≥ `tx_resp_late_ms` (heuristic, see §5) |
| `RX_FINAL_OK,seq=N` | Final (stage 3) received |
| `RX_FINAL_TIMEOUT,seq=N` | Software timeout before Final arrived |
| `TX_RTINFO_DONE,seq=N` | RTInfo (stage 4) sent |
| `RX_ERR` | Unexpected frame (wrong stage, error frame, RX error) |
| `RX_RESTART,reason=...` | Watchdog or RX_ERR triggered soft RX restart |
| `DW_REINIT,reason=...,count=N` | Watchdog escalated to full DW3000 reinit |

---

## 3. seq_id propagation (no library modification)

The DW3000 helper library writes a 4-byte frame for stages 1 / 2 / 3 with
the **senderID** byte at TX buffer offset `0x01`. Because addresses are not
actually used by this project's TWR (single pair, shared channel), we
overload `setSenderID(seq & 0xFF)` to carry the cycle's sequence number.

* **node_A** sets `setSenderID(seqByte)` before `ds_sendFrame(1)` and
  again before `ds_sendFrame(3)`.
* **node_B** reads the seq with `DW3000.getSenderID()` right after a clean
  `RX_POLL` or `RX_FINAL_OK`, then echoes it back via `setSenderID(seq)`
  before `ds_sendFrame(2)`. For the RTInfo frame the library writes
  `destination` to offset `0x01`, so we call `setDestinationID(seq)`
  before `ds_sendRTInfo(...)`.

Result: every event line on both nodes carries the *same* `seq=N` for a
single TWR cycle (modulo 256), and the dashboard can correlate them.

---

## 4. Recovery ladder (per node)

### node_A (initiator)
1. **Software timeout** at stage 1 / 3 when the configured
   `WAIT_RX_RESP_TIMEOUT_MS` / `WAIT_RX_RTINFO_TIMEOUT_MS` elapses
   without `receivedFrameSucc() == 1`.
2. **Soft restart** (`RX_RESTART`) every `SOFT_RECOVERY_THRESHOLD` (=5)
   consecutive timeouts: `forceIdle()` → `clearSystemStatus()` →
   `standardRX()`.
3. **Full reinit** (`DW_REINIT`) every `DW_REINIT_THRESHOLD` (=20)
   consecutive timeouts: `hardReset()` → wait IDLE → `softReset()` →
   wait IDLE → `applyConfiguration()`.

`consecutive_timeout` clears **only** on `RANGE_OK`. An invalid range
(<= 0 or > 200 m) does *not* clear it.

### node_B (responder)
1. **Software timeout** at stage 2 when `WAIT_RX_FINAL_MS` elapses
   without a Final.
2. **1 Hz heartbeat** (`READY`) so the dashboard can prove the responder
   is alive while node_A is timing out.
3. **Watchdog**: if no `RX_POLL` for `WATCHDOG_SOFT_MS` (=2000 ms) →
   soft restart; if no `RX_POLL` for `WATCHDOG_REINIT_MS` (=10000 ms) →
   full reinit.

---

## 5. TX_RESP_LATE — what it actually means

The upstream library's `ds_sendFrame(2)` performs the immediate-after TX
command and then polls `sentFrameSucc()` up to 50 times internally. It
does **not** return a success/failure flag, and it does **not** expose
how long the poll took.

`TX_RESP_LATE` is therefore a **heuristic**: the responder measures the
wall-clock `millis()` delta around `ds_sendFrame(2)` and tags the cycle
LATE if the call took ≥ `tx_resp_late_ms` (default 8 ms in ROBUST,
5 ms in FAST). On a normal TX this delta is sub-millisecond; values
above the threshold indicate either:
* a delayed-TX timestamp that the radio missed (frame likely dropped), or
* SPI / scheduler stall on the ESP32.

A `TX_RESP_LATE` event for `seq=N` followed by node_A reporting
`RX_RESP_TIMEOUT,seq=N` is strong evidence the response never reached
the air for that cycle.

---

## 6. Build profiles

Defined as `#define` at the top of each `.ino` file. Both nodes must be
flashed with the **same** profile:

| Profile | `WAIT_RX_RESP_TIMEOUT_MS` | `WAIT_RX_RTINFO_TIMEOUT_MS` | `WAIT_RX_FINAL_MS` | `ROUND_DELAY_MS` | `GUARD_DELAY_MS` | `TX_RESP_LATE_MS` |
|---|---|---|---|---|---|---|
| `UWB_PROFILE_ROBUST = 1` (default) | 60 | 60 | 60 | 220 | 6 | 8 |
| `UWB_PROFILE_ROBUST = 0` (FAST) | 30 | 30 | 30 | 200 | 4 | 5 |

`RAW_UWB_TEST_MODE = 1` (default) suppresses the legacy CSV header line
so the serial output is pure event records, suitable for direct dashboard
ingestion and for diffing two boards side by side in Arduino Serial
Monitor.

---

## 7. Reading the dashboard

The **UWB LINK DIAGNOSTICS** panel of the dashboard now exposes:
* **node identity**: hardware / firmware / build per node, populated
  from the BOOT banner. If a card shows `—` the node never booted, the
  serial port is wrong, or the firmware is the old (non-identity) build.
* **per-event counters** for every event in §2.
* **diagnosis text** based on a sliding 3-second window:

| Condition (3 s window) | Diagnosis emitted |
|---|---|
| node_A has timeouts, node_B has 0 `RX_POLL` | Poll not reaching responder OR responder RX not armed (check antenna / channel / PAN / role / distance) |
| node_A has timeouts, node_B has `RX_POLL` but 0 `TX_RESP_DONE` | Responder receives Poll but fails Response TX (likely delayed-TX miss; check `TX_RESP_LATE` count) |
| node_A has timeouts, node_B has `TX_RESP_DONE` > 0 | Responder TX'd Response but initiator missed it (check node_A RX timing, antenna orientation, RF interference) |
| `consecutive_timeout` ≥ alert threshold AND 0 `RX_RESTART` and 0 `DW_REINIT` in last 10 s | Recovery logic not firing (verify thresholds) |

---

## 8. Common failure signatures

### A. Hand / body in front of one antenna
Symptom: A bursts `RX_RESP_TIMEOUT`, B keeps logging `RX_POLL` and
`TX_RESP_DONE`. Diagnosis text: "Responder TX'd Response but initiator
missed it." Recovery: SOFT_RECOVERY_THRESHOLD-driven `RX_RESTART`
restores the link once obstruction clears.

### B. node_B firmware crashed or stuck
Symptom: A bursts `RX_RESP_TIMEOUT`, B emits no `READY` heartbeat at all,
node_B identity card is empty. Diagnosis text: "node_B serial port may
be open, but responder heartbeat is not detected." Power-cycle node_B.

### C. Wrong role flashed
Symptom: both nodes BOOT with identical role. Identity cards show
`uwb_initiator.ino` on both, or `uwb_responder.ino` on both. Re-flash
the correct sketch to each.

### D. Channel / PAN / address mismatch
Symptom: B emits `READY` continuously but never `RX_POLL`. Diagnosis
text: "Poll not reaching responder or responder RX not armed." Compare
the CONFIG lines of A and B and align channel / PAN / addr / peer.

### E. Delayed-TX margin too tight on B
Symptom: A bursts `RX_RESP_TIMEOUT`, B logs `RX_POLL` and
`TX_RESP_LATE` (not `TX_RESP_DONE`) for the same seq. Increase
`UWB_PROFILE_ROBUST` margins, raise `tx_resp_late_ms`, or move to a
quieter RF environment. The library's response-delay is currently
1000 µs; if persistent LATE events appear, this margin is too tight on
the DWM3000 v1.4 + ESP32 stack and the library would need adjustment.

---

## 9. What this guide does **not** cover

* DWM3001 / Apple Nearby Interaction / nRF52840 / Zephyr UWB — see the
  separate `firmware/UWB_NRF52840_QORVO/` and `firmware/UWB_DWM3001/`
  trees. None of the event vocabulary here applies there.
* BLE / RSSI sensor fusion — see `docs/cooperative_warning_design.md`.
* Validation test plan (Tests A–F for the recovery ladder) — see
  `docs/uwb_validation_protocol.md`.
