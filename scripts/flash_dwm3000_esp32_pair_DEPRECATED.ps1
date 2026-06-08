<#
################################################################################
#  DEPRECATED — ESP32 TARGET ONLY
#
#  Do NOT use this script for Nordic nRF52840 DK + DWM3000 shield.
#  The actual UWB nodes in this project are:
#    Nordic nRF52840 DK + DWM3000 shield
#  They require the Nordic/J-Link/nRF Connect/west workflow, not esptool.py.
#
#  This script only applies to the archived ESP32 + DWM3000 path in:
#    firmware/UWB_DWM3000/   (ESP32 Arduino .ino, NOT active UWB target)
#
#  For Nordic flashing guidance see:
#    firmware/UWB_DWM3000_NRF52840/README.md
################################################################################

.SYNOPSIS
    Flash DWM3000 v1.4 initiator and responder firmware to a pair of ESP32 boards.

.DESCRIPTION
    Both boards must be Qorvo DWM3000 v1.4 + ESP32-WROOM-32.
    This script flashes:
        node_A  <-  firmware/UWB_DWM3000/uwb_initiator  (env: uwb_initiator)
        node_B  <-  firmware/UWB_DWM3000/uwb_responder  (env: uwb_responder)

    WARNING: Do NOT use the default PlatformIO 'Upload' button.
             platformio.ini default_envs = ble_beacon, so the default upload
             would flash BLE beacon firmware instead of the UWB firmware.

.NOTES
    Prerequisites:
        - PlatformIO CLI installed and on PATH  (pio --version)
        - Both boards connected via USB
        - Run from the project root:
              cd "C:\...\VLOS-V2X"
              .\scripts\flash_dwm3000_pair.ps1
#>

param(
    [string]$PortA = "",   # node_A COM port, e.g. COM3
    [string]$PortB = ""    # node_B COM port, e.g. COM5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── helpers ──────────────────────────────────────────────────────────────────
function Write-Step([string]$msg) { Write-Host "`n>>> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    OK: $msg"   -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "    !! $msg"    -ForegroundColor Yellow }
function Write-Err([string]$msg)  { Write-Host "    ERROR: $msg" -ForegroundColor Red }

# ── verify pio available ──────────────────────────────────────────────────────
Write-Step "Checking PlatformIO CLI"
try {
    $pioVer = & pio --version 2>&1
    Write-Ok $pioVer
} catch {
    Write-Err "pio not found. Install PlatformIO CLI: https://docs.platformio.org/en/latest/core/installation.html"
    exit 1
}

# ── list available serial ports ───────────────────────────────────────────────
Write-Step "Available serial / COM ports"
& pio device list 2>&1 | Where-Object { $_ -match "COM|ttyUSB|ttyACM|/dev/" } | ForEach-Object {
    Write-Host "    $_" -ForegroundColor Gray
}

# ── ask for COM ports if not supplied as parameters ───────────────────────────
if (-not $PortA) {
    Write-Host ""
    $PortA = Read-Host "Enter COM port for node_A (initiator, e.g. COM3)"
}
if (-not $PortB) {
    $PortB = Read-Host "Enter COM port for node_B (responder, e.g. COM5)"
}

$PortA = $PortA.Trim().ToUpper()
$PortB = $PortB.Trim().ToUpper()

if ($PortA -eq $PortB) {
    Write-Err "node_A and node_B cannot share the same port ($PortA). Check connections."
    exit 1
}

Write-Host ""
Write-Host "  node_A (initiator)  ->  $PortA" -ForegroundColor White
Write-Host "  node_B (responder)  ->  $PortB" -ForegroundColor White
Write-Host ""
$confirm = Read-Host "Press Enter to flash both boards, or Ctrl+C to abort"

# ── flash node_A: uwb_initiator ───────────────────────────────────────────────
Write-Step "Flashing node_A (uwb_initiator) on $PortA"
Write-Warn "Do NOT reset or disconnect node_A during upload."
& pio run -e uwb_initiator -t upload --upload-port $PortA
if ($LASTEXITCODE -ne 0) {
    Write-Err "Upload to node_A FAILED (exit $LASTEXITCODE)."
    Write-Host @"

  Checklist:
    - Is $PortA the correct port?  Run: pio device list
    - Is node_A powered and not already open in Serial Monitor?
    - Does the ESP32 board have auto-reset circuitry?
      If not, hold BOOT button during upload then release.
"@
    exit 1
}
Write-Ok "node_A flashed successfully."

# ── flash node_B: uwb_responder ───────────────────────────────────────────────
Write-Step "Flashing node_B (uwb_responder) on $PortB"
Write-Warn "Do NOT reset or disconnect node_B during upload."
& pio run -e uwb_responder -t upload --upload-port $PortB
if ($LASTEXITCODE -ne 0) {
    Write-Err "Upload to node_B FAILED (exit $LASTEXITCODE)."
    Write-Host @"

  Checklist:
    - Is $PortB the correct port?  Run: pio device list
    - Is node_B powered and not already open in Serial Monitor?
    - Hold BOOT button if the board has no auto-reset.
"@
    exit 1
}
Write-Ok "node_B flashed successfully."

# ── post-flash instructions ───────────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Both boards flashed.  Now verify boot output." -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host @"

EXPECTED BOOT LOGS (115200 baud)
─────────────────────────────────────────────────────────────────
node_A serial ($PortA):
  node_A,BOOT,INITIATOR,hardware=DWM3000_v1.4,firmware=uwb_initiator.ino,build=...
  node_A,CONFIG,profile=ROBUST,...,role=INITIATOR
  (then per-cycle events every ~220ms)
  <ms>,node_A,TX_POLL,seq=0
  <ms>,node_A,RX_RESP_OK,seq=0
  <ms>,node_A,TX_FINAL,seq=0
  <ms>,node_A,RX_RTINFO_OK,seq=0
  <ms>,node_A,RANGE_OK,seq=0,range_m=X.XXX

node_B serial ($PortB):
  node_B,BOOT,RESPONDER,hardware=DWM3000_v1.4,firmware=uwb_responder.ino,build=...
  node_B,CONFIG,profile=ROBUST,...,role=RESPONDER
  <ms>,node_B,READY                       (repeats every 1 s)
  <ms>,node_B,RX_ARMED
  <ms>,node_B,RX_POLL,seq=0
  <ms>,node_B,TX_RESP_SCHEDULED,seq=0
  <ms>,node_B,TX_RESP_DONE,seq=0
  <ms>,node_B,RX_FINAL_OK,seq=0
  <ms>,node_B,TX_RTINFO_DONE,seq=0

─────────────────────────────────────────────────────────────────
IDENTITY heartbeat: both nodes re-emit their BOOT/IDENTITY line
  every 5 seconds so the dashboard can identify them even when
  you connect after boot.  Look for:
    node_A,IDENTITY,INITIATOR,hardware=DWM3000_v1.4,...
    node_B,IDENTITY,RESPONDER,hardware=DWM3000_v1.4,...

BOOT VERIFICATION CHECKLIST
─────────────────────────────────────────────────────────────────
Symptom                                   | Action
─────────────────────────────────────────────────────────────────
node_A BOOT missing                       | uwb_initiator not flashed or
                                          | wrong COM port used for node_A
node_B BOOT missing                       | uwb_responder not flashed or
                                          | wrong COM port used for node_B
Both nodes show same role (e.g. both      | Swapped ports; re-flash the
INITIATOR)                                | correct firmware to each board
node_B READY missing after boot           | Responder firmware not running;
                                          | check SPI wiring and DWM3000
                                          | power rails
node_A TX_POLL present, node_B RX_POLL   | Poll not reaching responder;
missing                                   | check antenna connection,
                                          | channel / PAN ID match,
                                          | and physical distance
node_B RX_POLL present, TX_RESP_DONE     | Responder TX timing problem;
missing (or TX_RESP_LATE instead)         | check SPI speed and
                                          | delayed-TX margin
node_B TX_RESP_DONE present, node_A      | Initiator missed in-air
RX_RESP_TIMEOUT present (same seq)        | response; check node_A
                                          | RX timeout, antenna angle,
                                          | and RF environment
─────────────────────────────────────────────────────────────────
Do NOT claim UWB hardware failure until both boards show the
correct BOOT identity and role in their serial output.
─────────────────────────────────────────────────────────────────

HOW TO OPEN SERIAL MONITOR (115200 baud)
  PlatformIO:   pio device monitor --port $PortA --baud 115200
                pio device monitor --port $PortB --baud 115200
  Arduino IDE:  Tools > Serial Monitor > 115200 baud
  Dashboard:    Live Sensors tab > Connect UWB (A) / Connect UWB (B)
"@ -ForegroundColor Gray
