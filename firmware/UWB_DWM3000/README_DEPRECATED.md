# UWB_DWM3000 — ESP32 Path (DEPRECATED / NOT ACTIVE UWB TARGET)

> **WARNING: This folder targets ESP32 + DWM3000 only.**
> It is **not compatible** with the actual Nordic nRF52840 DK + DWM3000 shield
> used in this project.

## What this folder is

`firmware/UWB_DWM3000/` contains Arduino `.ino` firmware for an
**ESP32-WROOM-32 + DWM3000** module combination. It was developed during an
earlier phase of the project when the hardware target was an ESP32-based board.

The firmware here compiles and was used to generate legacy compact CSV output
(`timestamp_ms,node_A,seq,range_m,OK`) that the dashboard can still parse.

## Why it is deprecated

The active UWB hardware in this project is:

| Item | Value |
|---|---|
| MCU | **Nordic nRF52840 DK** |
| UWB shield | **Qorvo DWM3000** |
| Upload tool | **J-Link / nRF Connect / west** |

The ESP32 Arduino workflow (`esptool.py`, PlatformIO `espressif32` platform,
ESP32 BOOT button) does **not** apply to the Nordic boards.

## Correct target

See [firmware/UWB_DWM3000_NRF52840/README.md](../UWB_DWM3000_NRF52840/README.md)
for the active UWB firmware target and flashing instructions.

## Do not use

- `scripts/flash_dwm3000_esp32_pair_DEPRECATED.ps1` — ESP32 only, not for Nordic
- `pio run -e uwb_initiator -t upload` — flashes ESP32, not Nordic board
- PlatformIO Upload button (default_envs = ble_beacon anyway)
- ESP32 BOOT button procedure
