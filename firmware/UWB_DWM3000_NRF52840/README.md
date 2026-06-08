# UWB_DWM3000_NRF52840 — Active UWB Target

## Hardware

| Item | Value |
|---|---|
| MCU | **Nordic nRF52840 DK** |
| UWB module | **Qorvo DWM3000 shield** |
| Two identical nodes | node_A (initiator), node_B (responder) |

## What is NOT used for these boards

- ESP32 Arduino `.ino` firmware (`firmware/UWB_DWM3000/` is deprecated)
- `esptool.py` / PlatformIO `espressif32` upload
- ESP32 BOOT button procedure
- `scripts/flash_dwm3000_esp32_pair_DEPRECATED.ps1`

## Flashing (Nordic / J-Link / nRF Connect)

Use one of:

```
# nRF Connect for VS Code extension (recommended)
  Open the nRF Connect extension → Build → Flash

# west (Zephyr)
  west build -b nrf52840dk_nrf52840 -- -DCONF_FILE=prj_initiator.conf
  west flash

# nrfjprog (J-Link)
  nrfjprog --program build/zephyr/zephyr.hex --chiperase --reset
```

**No BOOT button or esptool is required.** The nRF52840 DK uses J-Link
over USB for programming.

## Current firmware state

The boards currently run **legacy range-only firmware** that emits compact CSV:
```
timestamp_ms,node_A,seq_id,range_m,OK
timestamp_ms,node_A,seq_id,,RX_RESP_TIMEOUT,consecutive_timeout=N
```

The dashboard classifies this as **NORDIC_LEGACY_COMPACT_CSV**.

In this mode the dashboard can report:
- OK count, timeout count, consecutive timeout bursts
- Last valid range, stale/lost link state
- OK/timeout rates per 1s / 3s / 10s

It **cannot** report (requires Nordic diagnostic firmware):
- Whether node_B received the Poll
- Whether node_B transmitted the Response
- Whether node_A missed an in-air Response
- Recovery event details (RX_RESTART / DW_REINIT)

## Target: Nordic diagnostic firmware

The full per-stage event vocabulary is defined in
[diagnostic_protocol.md](diagnostic_protocol.md).

When Nordic diagnostic firmware is implemented and flashed:
- The BOOT line will carry `hardware=nRF52840_DK+DWM3000`
- The dashboard will upgrade the firmware mode badge to **NORDIC DIAGNOSTIC**
- All per-stage counters and 4-rule diagnosis text will become active
