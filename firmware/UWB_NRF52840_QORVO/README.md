# nRF52840 DK + DWM3000 Shield — Diagnostic UWB Firmware

Zephyr/nRF Connect SDK application for **two identical nodes**:
`node_A` (initiator) and `node_B` (responder), each using a Nordic
nRF52840 DK with a Qorvo DWM3000 shield on the Arduino header.

## Hardware

| Signal | nRF52840 DK pin | Arduino header |
|--------|----------------|----------------|
| SCK    | P1.15          | D13            |
| MOSI   | P1.13          | D11            |
| MISO   | P1.14          | D12            |
| CS     | P1.12          | D10            |
| IRQ    | P1.11          | D9             |
| RST    | P1.10          | D8             |

## Build

Open a **nRF Connect SDK** (west) terminal.

```powershell
# Build node_A (initiator)
west build -b nrf52840dk_nrf52840 . -- -DCONF_FILE=prj_initiator.conf

# Build node_B (responder)
west build -b nrf52840dk_nrf52840 . -- -DCONF_FILE=prj_responder.conf
```

Run from the `firmware/UWB_NRF52840_QORVO/` directory, or provide the
path as the source argument:

```powershell
west build -b nrf52840dk_nrf52840 firmware/UWB_NRF52840_QORVO `
    -- -DCONF_FILE=prj_initiator.conf
```

## Flash

Flash via J-Link (nRF52840 DK has on-board J-Link):

```powershell
# Flash after build
west flash

# Or specify build directory explicitly
west flash --build-dir build
```

Using nRF Connect for Desktop → Programmer is also supported.

## Serial output

Connect at **115200 baud**.  The firmware emits a Nordic diagnostic CSV
stream defined in `firmware/UWB_DWM3000_NRF52840/diagnostic_protocol.md`.

### Boot sequence (node_A)

```text
node_A,BOOT,INITIATOR,hardware=nRF52840_DK+DWM3000,firmware=vlos_nrf52840_uwb,build=Jan  1 2025 12:00:00
node_A,CONFIG,role=INITIATOR,channel=5,addr=0xA001,soft_thresh=5,reinit_thresh=20
```

### Per-cycle events (node_A initiator)

```text
1234,node_A,TX_POLL,seq=42
1235,node_A,RX_RESP_OK,seq=42
1235,node_A,TX_FINAL,seq=42
1236,node_A,RX_RTINFO_OK,seq=42
1236,node_A,RANGE_OK,seq=42,range_m=3.142
1236,node_A,42,3.142,OK
```

### Per-cycle events (node_B responder)

```text
1234,node_B,READY
1234,node_B,RX_POLL,seq=42
1234,node_B,TX_RESP_SCHEDULED,seq=42
1235,node_B,TX_RESP_DONE,seq=42
1235,node_B,RX_FINAL_OK,seq=42
1235,node_B,TX_RTINFO_DONE,seq=42
1235,node_B,42,,RESP_OK
```

### Recovery events

```text
5000,node_A,RX_RESTART,reason=CONSEC_TIMEOUT
20100,node_A,DW_REINIT,reason=TIMEOUT_BURST,count=1
```

## Kconfig options

| Symbol | Default | Description |
|--------|---------|-------------|
| `VLOS_ROLE_INITIATOR` | y | Initiator role (n = responder) |
| `VLOS_NODE_ID` | `"node_A"` | Identifier in CSV |
| `VLOS_POLL_INTERVAL_MS` | 100 | Main loop sleep |
| `VLOS_UWB_PROFILE_ROBUST` | y | 60 ms RX timeout (vs 30 ms) |
| `VLOS_SOFT_RECOVERY_THRESHOLD` | 5 | Timeouts before RX_RESTART |
| `VLOS_REINIT_THRESHOLD` | 20 | Timeouts before DW_REINIT |
| `VLOS_IDENTITY_INTERVAL_MS` | 5000 | IDENTITY heartbeat period |
| `VLOS_HEARTBEAT_INTERVAL_MS` | 1000 | READY heartbeat period (responder) |
| `VLOS_WATCHDOG_SOFT_MS` | 2000 | Responder soft watchdog |
| `VLOS_WATCHDOG_REINIT_MS` | 10000 | Responder reinit watchdog |
| `VLOS_TX_RESP_LATE_MS` | 8 | TX_RESP_LATE threshold |

## Source layout

| File | Purpose |
|------|---------|
| `src/main.c` | Main loop, CSV emitters, recovery, watchdog |
| `src/uwb_adapter.h` | Adapter interface + diag event callback |
| `src/uwb_adapter_dw3000.c` | Real DW3000 SPI driver (DS-TWR) |
| `src/uwb_adapter_stub.c` | No-op stub (selected when driver not linked) |
| `prj.conf` | Base Zephyr config (serial, log, FPU) |
| `prj_initiator.conf` | node_A overlay |
| `prj_responder.conf` | node_B overlay |