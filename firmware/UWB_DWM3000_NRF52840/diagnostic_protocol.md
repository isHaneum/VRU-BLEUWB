# Nordic nRF52840 DK + DWM3000 — Diagnostic CSV Protocol

This document defines the exact serial CSV vocabulary that the Nordic
diagnostic firmware must emit. The dashboard parser is already implemented
for this vocabulary. Implementing this in the Nordic/Zephyr firmware will
unlock full per-stage diagnosis in the Live Sensors tab.

Hardware target: **Nordic nRF52840 DK + Qorvo DWM3000 shield**

---

## 1. BOOT / IDENTITY (emitted at startup and every 5 s)

```
node_A,BOOT,INITIATOR,hardware=nRF52840_DK+DWM3000,firmware=<file>,build=<__DATE__ __TIME__>
node_A,CONFIG,channel=5,pan=0x1234,addr=0xA001,peer=0xB001,role=INITIATOR,...

node_B,BOOT,RESPONDER,hardware=nRF52840_DK+DWM3000,firmware=<file>,build=<__DATE__ __TIME__>
node_B,CONFIG,channel=5,pan=0x1234,addr=0xB001,peer=0xA001,role=RESPONDER,...
```

- The `hardware=` field must contain the string `nRF` for the dashboard to
  classify the node as **NORDIC_DIAGNOSTIC_CSV** (not NORDIC_LEGACY_COMPACT_CSV).
- IDENTITY re-emits every 5 s so dashboards connecting after boot still
  identify the firmware version within one IDENTITY interval:
  ```
  node_A,IDENTITY,INITIATOR,hardware=nRF52840_DK+DWM3000,...
  node_B,IDENTITY,RESPONDER,hardware=nRF52840_DK+DWM3000,...
  ```

---

## 2. Initiator (node_A) per TWR cycle

| Line | Emitted when |
|---|---|
| `<ms>,node_A,TX_POLL,seq=N` | Poll frame sent (stage 1) |
| `<ms>,node_A,RX_RESP_OK,seq=N` | Response (stage 2) received |
| `<ms>,node_A,RX_RESP_TIMEOUT,seq=N,consecutive_timeout=N` | Software timeout before Response |
| `<ms>,node_A,RX_RESP_ERR,seq=N` | Response invalid / error frame |
| `<ms>,node_A,TX_FINAL,seq=N` | Final frame sent (stage 3) |
| `<ms>,node_A,RX_RTINFO_OK,seq=N` | RTInfo (stage 4) received |
| `<ms>,node_A,RX_RTINFO_TIMEOUT,seq=N,consecutive_timeout=N` | Timeout before RTInfo |
| `<ms>,node_A,RANGE_OK,seq=N,range_m=X.XXX` | Valid range computed |
| `<ms>,node_A,RX_RESTART,reason=<str>` | Soft RX recovery |
| `<ms>,node_A,DW_REINIT,reason=<str>,count=N` | Full DW3000 reinit |

Legacy compact lines (backward compat with dashboard range chart):
```
<ms>,node_A,<seq>,<range_m>,OK
<ms>,node_A,<seq>,,RX_RESP_TIMEOUT,consecutive_timeout=N
```

---

## 3. Responder (node_B) per TWR cycle

| Line | Emitted when |
|---|---|
| `<ms>,node_B,READY` | 1 Hz heartbeat (main loop) |
| `<ms>,node_B,RX_ARMED` | RX re-armed, waiting for Poll |
| `<ms>,node_B,RX_POLL,seq=N` | Poll received; seq from Poll's address byte |
| `<ms>,node_B,TX_RESP_SCHEDULED,seq=N` | Response TX scheduled |
| `<ms>,node_B,TX_RESP_DONE,seq=N` | Response TX completed normally |
| `<ms>,node_B,TX_RESP_LATE,seq=N,elapsed_ms=N` | Response TX took longer than threshold |
| `<ms>,node_B,RX_FINAL_OK,seq=N` | Final received |
| `<ms>,node_B,RX_FINAL_TIMEOUT,seq=N` | Timeout before Final |
| `<ms>,node_B,TX_RTINFO_DONE,seq=N` | RTInfo sent |
| `<ms>,node_B,RX_ERR` | Unexpected / error frame |
| `<ms>,node_B,RX_RESTART,reason=<str>` | Soft RX recovery |
| `<ms>,node_B,DW_REINIT,reason=<str>,count=N` | Full DW3000 reinit |

---

## 4. seq_id propagation

The `seq` field ties both nodes' event lines together for a single TWR cycle.
The initiator places `seq & 0xFF` into the UWB frame payload (or address byte)
so the responder can echo it back. This allows correlation of:

> "node_A reported RX_RESP_TIMEOUT,seq=42 — did node_B see RX_POLL,seq=42?"

---

## 5. Recovery behaviour

### node_A
1. **Software timeout** (configurable `rx_to_ms`) at stage 1 / stage 3
2. **Soft restart** (`RX_RESTART`) every `soft_thresh` consecutive timeouts
3. **Full reinit** (`DW_REINIT`) every `reinit_thresh` consecutive timeouts

`consecutive_timeout` clears only on `RANGE_OK`. Invalid ranges do not clear it.

### node_B
1. **Software timeout** at stage 2 (Final window)
2. **1 Hz READY heartbeat** for dashboard alive check
3. **Watchdog**: soft restart after 2 s without Poll; full reinit after 10 s

---

## 6. Dashboard firmware mode classification

| Firmware mode | Trigger condition |
|---|---|
| `NORDIC_LEGACY_COMPACT_CSV` | First compact `OK` CSV without prior BOOT/IDENTITY |
| `NORDIC_DIAGNOSTIC_CSV` | BOOT/IDENTITY with `hardware` containing `nRF` |
| `ESP32_DIAGNOSTIC_CSV_DEPRECATED` | BOOT/IDENTITY with `hardware` containing `DWM3000` but not `nRF` (old ESP32 path) |
| `UNKNOWN` | Connected, no valid line received yet |
| `NO_DATA` | Connected > 3 s with no parseable data |

---

## 7. Dashboard diagnosis rules (active only for NORDIC_DIAGNOSTIC_CSV)

| Condition (3 s window) | Dashboard alert |
|---|---|
| node_A timeouts > 0 AND node_B RX_POLL == 0 | Poll not reaching responder |
| node_A timeouts > 0 AND node_B RX_POLL > 0 AND TX_RESP_DONE == 0 | Responder Poll RX OK but Response TX failed |
| node_A timeouts > 0 AND node_B TX_RESP_DONE > 0 | Initiator missed in-air Response |
| consecutive_timeout ≥ threshold AND no RX_RESTART/DW_REINIT in 10 s | Recovery logic not firing |

In **NORDIC_LEGACY_COMPACT_CSV** mode the dashboard can only observe:
- OK and timeout counts and rates
- Last valid range and link state (OK/STALE/LOST)
- Consecutive timeout counter

It **cannot** disambiguate the four failure modes above.
