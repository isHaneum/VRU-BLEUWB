<#
.SYNOPSIS
    Check which UWB hardware target is connected to serial ports.

.DESCRIPTION
    Lists available serial devices and classifies them by likely hardware type:
        Nordic / J-Link / SEGGER  ->  Nordic nRF52840 DK (active UWB target)
        CP210x / CH340 / USB Serial  ->  possible ESP32 board (DEPRECATED UWB path)
        Bluetooth Serial Port  ->  not a valid UWB port

    Warns if user may be attempting ESP32/esptool workflow on a Nordic board.

.NOTES
    Run from the project root:
        .\scripts\check_uwb_target.ps1

    The active UWB hardware in this project is:
        Nordic nRF52840 DK + DWM3000 shield
    Flash using J-Link / nRF Connect / west — NOT esptool or PlatformIO espressif32.

    For flashing guidance see:
        firmware/UWB_DWM3000_NRF52840/README.md
#>

Set-StrictMode -Version Latest

function Write-Header([string]$msg) { Write-Host "`n=== $msg" -ForegroundColor Cyan }
function Write-Nordic([string]$msg) { Write-Host "  [NORDIC]  $msg" -ForegroundColor Green }
function Write-Esp32([string]$msg)  { Write-Host "  [ESP32]   $msg" -ForegroundColor Yellow }
function Write-Bt([string]$msg)     { Write-Host "  [BT]      $msg" -ForegroundColor DarkGray }
function Write-Unknown([string]$msg){ Write-Host "  [?]       $msg" -ForegroundColor Gray }
function Write-Warn([string]$msg)   { Write-Host "  !! $msg"        -ForegroundColor Red }

# ── check pio available ───────────────────────────────────────────────────────
try {
    $pioVer = & pio --version 2>&1
    Write-Host "PlatformIO: $pioVer" -ForegroundColor DarkGray
} catch {
    Write-Host "pio not found — install PlatformIO CLI to use this script." -ForegroundColor Yellow
    exit 1
}

# ── query device list ─────────────────────────────────────────────────────────
Write-Header "Serial / COM port inventory"
$rawList = & pio device list 2>&1

$nordicPorts  = @()
$esp32Ports   = @()
$btPorts      = @()
$unknownPorts = @()

$currentPort = $null
foreach ($line in $rawList) {
    # PIO device list format: "COMx" or "/dev/ttyUSBx" lines, then description indented
    if ($line -match '^(COM\d+|/dev/tty\S+)') {
        $currentPort = $matches[1]
    }
    if ($currentPort) {
        $lineUpper = $line.ToUpper()
        if ($lineUpper -match 'SEGGER|J-LINK|JLINK|NRF|NORDIC') {
            if ($nordicPorts -notcontains $currentPort) { $nordicPorts += $currentPort }
        } elseif ($lineUpper -match 'CP210|CH340|USB.?SERIAL|UART|FTDI|PROLIFIC') {
            if ($esp32Ports -notcontains $currentPort) { $esp32Ports += $currentPort }
        } elseif ($lineUpper -match 'BLUETOOTH|BTSPP|RFCOMM') {
            if ($btPorts -notcontains $currentPort) { $btPorts += $currentPort }
        }
    }
}

# Collect all mentioned ports
$allMentioned = $nordicPorts + $esp32Ports + $btPorts
foreach ($line in $rawList) {
    if ($line -match '^(COM\d+|/dev/tty\S+)') {
        $p = $matches[1]
        if ($allMentioned -notcontains $p) { $unknownPorts += $p }
    }
}

if ($rawList -join "" -match "No serial ports found|no devices") {
    Write-Host "  No serial devices found. Check USB connections." -ForegroundColor Red
} else {
    foreach ($p in $nordicPorts)  { Write-Nordic  "$p — Nordic/J-Link/nRF52840 DK (active UWB target)" }
    foreach ($p in $esp32Ports)   { Write-Esp32   "$p — CP210x/CH340/FTDI — possible ESP32 board (DEPRECATED UWB path)" }
    foreach ($p in $btPorts)      { Write-Bt      "$p — Bluetooth serial — NOT a valid UWB port" }
    foreach ($p in $unknownPorts) { Write-Unknown "$p — unclassified" }
}

# ── warnings ─────────────────────────────────────────────────────────────────
Write-Header "Hardware target check"

if ($nordicPorts.Count -gt 0) {
    Write-Host "  Nordic nRF52840 DK detected. Correct UWB target." -ForegroundColor Green
    Write-Host "  Flash using: J-Link / nRF Connect for VS Code / west" -ForegroundColor Green
    Write-Host "  See: firmware/UWB_DWM3000_NRF52840/README.md" -ForegroundColor DarkGray
}

if ($esp32Ports.Count -gt 0) {
    Write-Warn "ESP32-type UART adapter detected on: $($esp32Ports -join ', ')"
    Write-Warn "If this is your UWB node, you are using the DEPRECATED ESP32 path."
    Write-Warn "The active UWB hardware is Nordic nRF52840 DK + DWM3000 shield."
    Write-Warn "Do NOT use: pio run -e uwb_initiator/uwb_responder -t upload"
    Write-Warn "Do NOT use: scripts/flash_dwm3000_esp32_pair_DEPRECATED.ps1"
}

if ($btPorts.Count -gt 0) {
    Write-Host "  Bluetooth serial port(s) found — these are not UWB nodes." -ForegroundColor DarkGray
}

if ($nordicPorts.Count -eq 0 -and $esp32Ports.Count -eq 0 -and $btPorts.Count -eq 0) {
    Write-Host "  No recognised UWB-capable device found." -ForegroundColor Yellow
    Write-Host "  Connect the Nordic nRF52840 DK via USB and run again." -ForegroundColor Yellow
}

# ── reminder ──────────────────────────────────────────────────────────────────
Write-Host @"

REMINDER — Active UWB target
  Hardware : Nordic nRF52840 DK + Qorvo DWM3000 shield
  Flash via : J-Link / nRF Connect / west
  Current firmware mode : NORDIC_LEGACY_COMPACT_CSV
    (compact CSV only; per-stage diagnostics need Nordic diagnostic firmware)
  Diagnostic protocol spec : firmware/UWB_DWM3000_NRF52840/diagnostic_protocol.md

DEPRECATED (do not use for Nordic UWB nodes)
  firmware/UWB_DWM3000/                         ESP32 Arduino .ino
  scripts/flash_dwm3000_esp32_pair_DEPRECATED.ps1
  pio run -e uwb_initiator/uwb_responder -t upload
"@ -ForegroundColor DarkGray
