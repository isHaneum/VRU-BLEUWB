/**
 * UWB DWM3000 v1.4 - TWR Responder (node_B)
 *
 * Hardware (this project, fixed):
 *   - MCU:        ESP32-WROOM-32
 *   - UWB Module: Qorvo DWM3000 v1.4   (NOT DWM3001 / Nearby Interaction / nRF / Zephyr)
 *
 * Role: This file MUST be flashed ONLY to node_B. It performs DS-TWR as the
 *       responder: waits for Poll, schedules Response, waits for Final, then
 *       sends RTInfo. It NEVER starts ranging as an initiator.
 *
 * Diagnostic emphasis:
 *   - 1 Hz READY heartbeat so the dashboard can prove the responder is alive
 *     during a node_A timeout burst.
 *   - Per-cycle events tagged with the same seq_id node_A embedded in the
 *     Poll's senderID byte (see uwb_initiator.ino), so a missing OK on node_A
 *     can be correlated with whether node_B actually received that exact
 *     Poll and whether the Response TX completed.
 *   - TX_RESP_LATE is emitted when the response TX took noticeably longer than
 *     the expected on-air time. It is a heuristic (the upstream DW3000 helper
 *     library only exposes a polled sentFrameSucc()) but is sufficient to
 *     distinguish "response transmitted normally" from "response TX stalled".
 *   - Watchdog: > 2s without RX_POLL -> soft RX restart;
 *                > 10s without RX_POLL -> full DW3000 reinit.
 *
 * Build profiles (compile-time):
 *   UWB_PROFILE_ROBUST = 1   -> larger final-RX timeout and guard delay
 *   RAW_UWB_TEST_MODE  = 1   -> CSV only, no decorative text
 *
 * Serial CSV vocabulary:
 *   node_B,BOOT,RESPONDER,hardware=DWM3000_v1.4,firmware=uwb_responder.ino,build=<__DATE__ __TIME__>
 *   node_B,CONFIG,profile=ROBUST|FAST,channel=5,pan=0x1234,addr=0xB001,peer=0xA001,
 *                 preamble=128,datarate=6.8M,sts=off,
 *                 final_to_ms=<n>,watchdog_soft_ms=2000,watchdog_reinit_ms=10000,
 *                 tx_resp_late_ms=<n>,role=RESPONDER
 *   <ms>,node_B,READY
 *   <ms>,node_B,RX_ARMED
 *   <ms>,node_B,RX_POLL,seq=<n>
 *   <ms>,node_B,TX_RESP_SCHEDULED,seq=<n>
 *   <ms>,node_B,TX_RESP_DONE,seq=<n>
 *   <ms>,node_B,TX_RESP_LATE,seq=<n>,elapsed_ms=<n>
 *   <ms>,node_B,RX_FINAL_OK,seq=<n>
 *   <ms>,node_B,RX_FINAL_TIMEOUT,seq=<n>
 *   <ms>,node_B,TX_RTINFO_DONE,seq=<n>
 *   <ms>,node_B,RX_ERR
 *   <ms>,node_B,RX_RESTART,reason=<reason>
 *   <ms>,node_B,DW_REINIT,reason=<reason>,count=<n>
 *
 * Critical: Response TX is SCHEDULED first; the diagnostic print happens only
 * after the radio command. Logging never pushes the delayed-TX timing window.
 */

#include <SPI.h>
#include <DW3000.h>

// ---------------------- build-time configuration ----------------------
#ifndef RAW_UWB_TEST_MODE
#define RAW_UWB_TEST_MODE 1
#endif

#ifndef UWB_PROFILE_ROBUST
#define UWB_PROFILE_ROBUST 1
#endif

#if UWB_PROFILE_ROBUST
  #define PROFILE_NAME              "ROBUST"
  #define WAIT_RX_FINAL_MS           60
  #define GUARD_DELAY_MS              6
  #define TX_RESP_LATE_MS             8       // > this elapsed -> declare LATE
#else
  #define PROFILE_NAME              "FAST"
  #define WAIT_RX_FINAL_MS           30
  #define GUARD_DELAY_MS              4
  #define TX_RESP_LATE_MS             5
#endif

#define HEARTBEAT_INTERVAL_MS    1000
#define WATCHDOG_SOFT_MS         2000
#define WATCHDOG_REINIT_MS       10000

#define NODE_ID "node_B"

// ---------------------- state ----------------------
static int       currStage = 0;
static int       rxStatus  = 0;
static int       tRoundB   = 0;
static int       tReplyB   = 0;
static long long rxTs      = 0;
static long long txTs      = 0;

static uint32_t  lastHeartbeatMs    = 0;
static uint32_t  lastPollSeenMs     = 0;
static uint32_t  lastWatchdogSoftMs = 0;
static uint32_t  stageStartMs       = 0;
static uint32_t  reinitCount        = 0;
static bool      rxArmedLogged      = false;
static uint8_t   currentSeq         = 0;   // seq_id of the in-flight TWR cycle

static inline uint32_t msSince(uint32_t t0) { return millis() - t0; }

// ---------------------- CSV emitters ----------------------
static void emitEventBare(const char* event) {
    Serial.printf("%u,%s,%s\n", millis(), NODE_ID, event);
}
static void emitSeqEvent(const char* event, uint8_t seq) {
    Serial.printf("%u,%s,%s,seq=%u\n", millis(), NODE_ID, event, seq);
}
static void emitLateEvent(uint8_t seq, uint32_t elapsed) {
    Serial.printf("%u,%s,TX_RESP_LATE,seq=%u,elapsed_ms=%u\n",
                  millis(), NODE_ID, seq, elapsed);
}
static void emitRestart(const char* reason) {
    Serial.printf("%u,%s,RX_RESTART,reason=%s\n", millis(), NODE_ID, reason);
}
static void emitReinit(const char* reason) {
    Serial.printf("%u,%s,DW_REINIT,reason=%s,count=%u\n",
                  millis(), NODE_ID, reason, reinitCount);
}

static void emitBootBanner() {
    Serial.print("node_B,BOOT,RESPONDER,hardware=DWM3000_v1.4,firmware=uwb_responder.ino,build=");
    Serial.print(__DATE__); Serial.print(" "); Serial.println(__TIME__);
    Serial.printf(
        "node_B,CONFIG,profile=%s,channel=5,pan=0x1234,addr=0xB001,peer=0xA001,"
        "preamble=128,datarate=6.8M,sts=off,"
        "final_to_ms=%u,watchdog_soft_ms=%u,watchdog_reinit_ms=%u,"
        "tx_resp_late_ms=%u,role=RESPONDER\n",
        PROFILE_NAME,
        (unsigned) WAIT_RX_FINAL_MS,
        (unsigned) WATCHDOG_SOFT_MS,
        (unsigned) WATCHDOG_REINIT_MS,
        (unsigned) TX_RESP_LATE_MS);
}

// ---------------------- DW3000 lifecycle ----------------------
static void applyConfiguration() {
    DW3000.init();
    DW3000.setupGPIO();
    DW3000.configureAsTX();
    DW3000.clearSystemStatus();
    DW3000.standardRX();
}

static void softRxRestart(const char* reason) {
    DW3000.forceIdle();
    DW3000.clearSystemStatus();
    DW3000.standardRX();
    delay(GUARD_DELAY_MS);
    emitRestart(reason);
    rxArmedLogged = false;
}

static void fullReinit(const char* reason) {
    reinitCount++;
    emitReinit(reason);
    DW3000.hardReset();
    delay(50);
    while (!DW3000.checkForIDLE()) delay(10);
    DW3000.softReset();
    delay(50);
    while (!DW3000.checkForIDLE()) delay(10);
    applyConfiguration();
    delay(GUARD_DELAY_MS);
    rxArmedLogged = false;
}

static void heartbeatTick(uint32_t now) {
    if (now - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatMs = now;
        emitEventBare("READY");
    }
}

static void watchdogTick(uint32_t now) {
    if (lastPollSeenMs == 0) return;
    uint32_t since = now - lastPollSeenMs;
    if (since >= WATCHDOG_REINIT_MS) {
        fullReinit("NO_POLL");
        lastPollSeenMs = now;
        lastWatchdogSoftMs = now;
    } else if (since >= WATCHDOG_SOFT_MS &&
               (now - lastWatchdogSoftMs) >= WATCHDOG_SOFT_MS) {
        softRxRestart("WATCHDOG_NO_POLL");
        lastWatchdogSoftMs = now;
    }
}

// ---------------------- Arduino setup/loop ----------------------
void setup() {
    Serial.begin(115200);
    delay(50);

    DW3000.spiSelect(CHIP_SELECT_PIN);
    DW3000.begin();
    DW3000.hardReset();
    delay(200);

    if (!DW3000.checkSPI()) {
        Serial.println("node_B,FATAL,SPI_ERROR");
        while (true) delay(1000);
    }

    while (!DW3000.checkForIDLE()) delay(50);
    DW3000.softReset();
    delay(150);
    while (!DW3000.checkForIDLE()) delay(50);

    applyConfiguration();
    emitBootBanner();
    lastPollSeenMs     = millis();
    lastWatchdogSoftMs = lastPollSeenMs;
}

void loop() {
    uint32_t now = millis();
    heartbeatTick(now);
    watchdogTick(now);

    switch (currStage) {
        case 0: {
            // ----- Stage 0: wait for POLL -----
            if (!rxArmedLogged) { emitEventBare("RX_ARMED"); rxArmedLogged = true; }

            tRoundB = 0;
            tReplyB = 0;

            rxStatus = DW3000.receivedFrameSucc();
            if (rxStatus == 0) break;

            DW3000.clearSystemStatus();
            if (rxStatus != 1) {
                emitEventBare("RX_ERR");
                softRxRestart("RX_ERR");
                break;
            }
            if (DW3000.ds_isErrorFrame()) {
                emitEventBare("RX_ERR");
                softRxRestart("ERROR_FRAME");
                break;
            }
            if (DW3000.ds_getStage() != 1) {
                DW3000.ds_sendErrorFrame();
                emitEventBare("RX_ERR");
                softRxRestart("WRONG_STAGE");
                break;
            }
            // seq_id was carried in the senderID byte of the Poll frame
            currentSeq    = (uint8_t)(DW3000.getSenderID() & 0xFF);
            lastPollSeenMs = now;
            emitSeqEvent("RX_POLL", currentSeq);
            currStage = 1;
            break;
        }

        case 1: {
            // ----- Stage 1: TIMING-CRITICAL: schedule RESPONSE, then log -----
            //
            // Echo the seq_id back to node_A via the senderID byte of the Response.
            DW3000.setSenderID(currentSeq);

            uint32_t t0 = millis();
            DW3000.ds_sendFrame(2);
            uint32_t elapsed = millis() - t0;

            rxTs = DW3000.readRXTimestamp();
            txTs = DW3000.readTXTimestamp();
            tReplyB = static_cast<int>(txTs - rxTs);
            stageStartMs = millis();

            emitSeqEvent("TX_RESP_SCHEDULED", currentSeq);
            if (elapsed >= TX_RESP_LATE_MS) {
                emitLateEvent(currentSeq, elapsed);
            } else {
                emitSeqEvent("TX_RESP_DONE", currentSeq);
            }
            currStage = 2;
            break;
        }

        case 2: {
            // ----- Stage 2: wait for FINAL with software timeout -----
            rxStatus = DW3000.receivedFrameSucc();
            if (rxStatus == 0) {
                if (msSince(stageStartMs) >= WAIT_RX_FINAL_MS) {
                    emitSeqEvent("RX_FINAL_TIMEOUT", currentSeq);
                    softRxRestart("FINAL_TIMEOUT");
                    currStage = 0;
                }
                break;
            }
            DW3000.clearSystemStatus();
            if (rxStatus != 1) {
                emitEventBare("RX_ERR");
                softRxRestart("RX_ERR_FINAL");
                currStage = 0;
                break;
            }
            if (DW3000.ds_isErrorFrame()) {
                emitEventBare("RX_ERR");
                softRxRestart("ERROR_FRAME_FINAL");
                currStage = 0;
                break;
            }
            if (DW3000.ds_getStage() != 3) {
                DW3000.ds_sendErrorFrame();
                emitEventBare("RX_ERR");
                softRxRestart("WRONG_STAGE_FINAL");
                currStage = 0;
                break;
            }
            // Final from initiator should carry the same seq
            currentSeq = (uint8_t)(DW3000.getSenderID() & 0xFF);
            emitSeqEvent("RX_FINAL_OK", currentSeq);
            currStage = 3;
            break;
        }

        case 3: {
            // ----- Stage 3: TIMING-CRITICAL: send RTInfo, then log TX_RTINFO_DONE -----
            //
            // ds_sendRTInfo writes destination -> 0x01, sender -> 0x02. To keep the
            // seq byte at offset 0x01 (where initiator/responder both read it), put
            // the seq into destinationID before scheduling.
            DW3000.setDestinationID(currentSeq);

            rxTs = DW3000.readRXTimestamp();
            tRoundB = static_cast<int>(rxTs - txTs);
            DW3000.ds_sendRTInfo(tRoundB, tReplyB);

            emitSeqEvent("TX_RTINFO_DONE", currentSeq);
            DW3000.standardRX();
            rxArmedLogged = false;
            currStage = 0;
            break;
        }

        default:
            currStage = 0;
            DW3000.clearSystemStatus();
            DW3000.standardRX();
            rxArmedLogged = false;
            break;
    }
}
