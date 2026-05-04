# Hardware Setup Guide

## Bill of Materials

### Per Node (Scanner / Infrastructure / Vehicle)

| Component | Model | Purpose | Quantity |
|-----------|-------|---------|----------|
| Microcontroller | ESP32 DevKit V1 (or equivalent) | BLE scanning + UWB trigger control | 1 |
| UWB Module | DWM3000EVB (Qorvo) | UWB ranging (initiator or responder) | 1 |
| USB-A to Micro-B cable | Any | Power + Serial logging | 1 |
| Laptop / PC | Any (Python 3.8+) | Serial data logging | 1 |
| Tripod or mount | Camera tripod | Antenna height stabilization (~1.5 m) | 1 |

### Per VRU

| Component | Model | Purpose | Quantity |
|-----------|-------|---------|----------|
| Microcontroller | ESP32 DevKit V1 | BLE beacon + UWB responder | 1 |
| UWB Module | DWM3000EVB | UWB TWR responder | 1 |
| LiPo battery | 3.7 V, 1000–2000 mAh | Portable power | 1 |
| USB power bank | Any 5V USB output | Backup power for VRU | 1 |

### Optional: DWM3001CDK Platform

| Component | Notes |
|-----------|-------|
| DWM3001CDK (Qorvo) | nRF52833 + DW3110, higher accuracy AoA-capable |
| Segger J-Link | Required for flashing nRF52833 |
| Segger Embedded Studio | Free for Nordic devices (use Nordic license) |
| nRF5 SDK 17.1.0 | Download from Nordic Semiconductor |
| Qorvo DW3000 SDK | Download from Qorvo developer portal (registration required) |

---

## DWM3000EVB — ESP32 SPI Wiring

The DWM3000EVB connects to the ESP32 via SPI. Use the pinout below (matches firmware defaults):

| DWM3000EVB Pin | ESP32 GPIO | Signal |
|----------------|------------|--------|
| MOSI | GPIO 23 | SPI MOSI |
| MISO | GPIO 19 | SPI MISO |
| SCK  | GPIO 18 | SPI Clock |
| CS   | GPIO 5  | SPI Chip Select |
| RST  | GPIO 27 | Module Reset |
| IRQ  | GPIO 34 | Interrupt (input only on ESP32) |
| WAKEUP | GPIO 26 | Wake-up signal |
| VCC  | 3.3 V | Power |
| GND  | GND | Ground |

> ⚠️ **Do not use 5 V on DWM3000EVB VCC.** The DW3110 IC is 3.3 V only. Applying 5 V will permanently damage the module.

> ⚠️ **GPIO 34 is input-only** on most ESP32 variants. Do not use output-capable pins for IRQ.

---

## DWM3000EVB Arduino Library

Install the [thotro/arduino-dw3000](https://github.com/thotro/arduino-dw3000) library:

```bash
# Arduino IDE: Sketch → Include Library → Manage Libraries → search "DW3000"
# Or clone into Arduino/libraries/:
git clone https://github.com/thotro/arduino-dw3000.git ~/Arduino/libraries/arduino-dw3000
```

Board: `ESP32 Dev Module` in Arduino IDE  
Partition: `Default 4MB with spiffs` or larger  
Upload speed: 921600

---

## DWM3001CDK Setup

1. Install **Segger Embedded Studio** (free for Nordic): https://www.segger.com/downloads/embedded-studio/
2. Register for Qorvo DW3000 SDK: https://www.qorvo.com/products/p/DWM3001CDK#documents
3. Install **nRF5 SDK 17.1.0**: https://www.nordicsemi.com/Products/Development-software/nRF5-SDK
4. Copy Qorvo DW3000 SDK library files into the nRF5 SDK `external/` folder as per Qorvo's integration guide.
5. Open `firmware/UWB_DWM3001/uwb_dwm3001_initiator/` project in Segger Embedded Studio.
6. Select target: `DWM3001CDK` with `nRF52833_xxAA` device.
7. Build and flash via J-Link.

Output is on USB-CDC Serial (115200 baud).

---

## Cooperative Node Wiring

Node A and Node B are both ESP32 boards. No additional hardware is required for ESP-NOW communication — the ESP32's built-in Wi-Fi radio is used.

If using a hardware warning indicator on Node B:
- LED: Connect between GPIO 2 (or any free GPIO) and GND, with a 220 Ω series resistor.
- Buzzer: Active buzzer between GPIO 4 and GND. Use a transistor (NPN, e.g., 2N3904) if the buzzer current exceeds ESP32 GPIO source limit (12 mA).

---

## Antenna Placement Recommendations

**For RSU simulation (fixed infrastructure node):**
- Mount scanner at **1.5 m height** above ground on a tripod.
- Antenna should face the expected VRU approach direction.
- Avoid placing the antenna directly against metal surfaces (reflections cause multipath).
- Keep at least 0.5 m clearance from the logging laptop body.

**For vehicle-mounted node:**
- Dashboard mount: ~1.2 m height, windshield facing direction. A-pillar shadowing will affect angular coverage.
- Roof mount: Best for omnidirectional coverage, requires external cable routing.

**For VRU tag:**
- Held-in-hand: Keep the DWM3000 board facing the infrastructure node, not body-shadowed.
- Vest mount: Chest-facing is best. Avoid mounting on the back if the VRU faces away from the scanner.

---

## Serial Logging

Use a terminal program to capture serial output to a file:

**macOS / Linux:**
```bash
# screen
screen -L -Logfile ble_node_a.log /dev/ttyUSB0 115200

# picocom
picocom -b 115200 --logfile ble_node_a.log /dev/ttyUSB0
```

**Windows:**
```
# PuTTY: Connection → Serial, Speed 115200, enable session logging
# TeraTerm: Setup → Serial Port (115200), File → Log
```

**Python serial logger (cross-platform):**
```python
import serial, datetime, sys

port = sys.argv[1]  # e.g., COM5 or /dev/ttyUSB0
out  = sys.argv[2]  # output filename
with serial.Serial(port, 115200, timeout=1) as ser, open(out, 'w') as f:
    while True:
        line = ser.readline().decode('utf-8', errors='replace').rstrip()
        if line:
            f.write(line + '\n')
            print(line)
```

---

## Known Hardware Issues

| Issue | Symptom | Fix |
|-------|---------|-----|
| DW3000 SPI init fail | UWB firmware prints `DW3000 init failed` | Check 3.3 V on VCC, check SPI wiring continuity |
| ESP32 brownout reset | ESP32 resets when DW3000 starts TX | Add 100 µF capacitor on ESP32 3.3 V rail |
| IRQ not firing | UWB ranging hangs | Confirm GPIO 34 is connected to DWM3000 IRQ pin |
| BLE scan not starting | Scanner prints no detections | Confirm ESP32 BLE stack initialized (check Serial output) |
| ESP-NOW pairing fail | Node B receives no messages | Confirm Node A has Node B's MAC address hard-coded correctly |
