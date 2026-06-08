/**
 * UWB DWM3000 v1.4 - TWR Initiator (node_A)
 *
 * Hardware (this project, fixed):
 *   - MCU:        ESP32-WROOM-32
 *   - UWB Module: Qorvo DWM3000 v1.4   (NOT DWM3001 / Nearby Interaction / nRF / Zephyr)
 *
 * Role: This file MUST be flashed ONLY to node_A. It performs DS-TWR as the
 *       initiator: sends Poll, waits for Response, sends Final, waits for
 *       RTInfo, then computes range. It NEVER acts as a responder.
 *
 * Diagnostic emphasis:
 *   - Every TWR stage emits a CSV event line so we can tell whether a missing
 *     OK was caused by node_B not receiving the Poll, node_B failing to TX,
 *     or node_A missing the Response.
 *   - seq_id is propagated into the on-air frame via the senderID byte that
 *     ds_sendFrame() already places in TX buffer offset 0x01; node_B reads
 *     it back via getSenderID(). This is non-invasive (no library change)
 *     and gives us per-cycle correlation in the logs.
 *
 * Build profiles (compile-time):
 *   UWB_PROFILE_ROBUST = 1   -> longer timeouts, larger guard, lower log rate
 *   UWB_PROFILE_ROBUST = 0   -> FAST profile (original aggressive timing)
 *
 *   RAW_UWB_TEST_MODE = 1    -> no decorative text; CSV only for the dashboard
 *                               and for Serial Monitor side-by-side comparison.
 *
 * Serial CSV vocabulary (single source of truth for the dashboard):
 *   Boot:
 *     node_A,BOOT,INITIATOR,hardware=DWM3000_v1.4,firmware=uwb_initiator.ino,build=<__DATE__ __TIME__>
 *     node_A,CONFIG,profile=ROBUST|FAST,channel=5,pan=0x1234,addr=0xA001,peer=0xB001,
 *                   preamble=128,datarate=6.8M,sts=off,
 *                   rx_to_ms=<n>,rtinfo_to_ms=<n>,resp_delay_us=1000,
 *                   soft_thresh=5,reinit_thresh=20,role=INITIATOR
 *   Per TWR cycle (one or more of):
 *     <ms>,node_A,TX_POLL,seq=<n>
 *     <ms>,node_A,RX_RESP_OK,seq=<n>
 *     <ms>,node_A,RX_RESP_TIMEOUT,seq=<n>,consecutive_timeout=<n>
 *     <ms>,node_A,RX_RESP_ERR,seq=<n>
 *     <ms>,node_A,TX_FINAL,seq=<n>
 *     <ms>,node_A,RX_RTINFO_OK,seq=<n>
 *     <ms>,node_A,RX_RTINFO_TIMEOUT,seq=<n>,consecutive_timeout=<n>
 *     <ms>,node_A,RANGE_OK,seq=<n>,range_m=<x.xxx>
 *   Recovery:
 *     <ms>,node_A,RX_RESTART,reason=<reason>
 *     <ms>,node_A,DW_REINIT,reason=<reason>,count=<n>
 *   Legacy compact CSV (kept for the existing dashboard chart):
 *     <ms>,node_A,<seq>,<range_m>,OK              on RANGE_OK
 *     <ms>,node_A,<seq>,,RX_RESP_TIMEOUT,consecutive_timeout=<n>
 *
 * Stale ranges are NEVER reused. consecutive_timeout clears only on RANGE_OK.
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
  #define ROUND_DELAY_MS            220
  #define WAIT_RX_RESP_TIMEOUT_MS    60
  #define WAIT_RX_RTINFO_TIMEOUT_MS  60
  #define GUARD_DELAY_MS              6
#else
  #define PROFILE_NAME              "FAST"
  #define ROUND_DELAY_MS            200
  #define WAIT_RX_RESP_TIMEOUT_MS    30
  #define WAIT_RX_RTINFO_TIMEOUT_MS  30
  #define GUARD_DELAY_MS              4
#endif

#define SOFT_RECOVERY_THRESHOLD       5
#define DW_REINIT_THRESHOLD          20

#define NODE_ID "node_A"

// ---------------------- state ----------------------
static int       currStage = 0;
static int       rxStatus  = 0;
static int       tRoundA   = 0;
static int       tReplyA   = 0;
static long long rxTs      = 0;
static long long txTs      = 0;
static int       clockOffset = 0;
static uint32_t  seqId        = 0;        // 32-bit logical seq; on-air = seqId & 0xFF
static uint32_t  stageStartMs = 0;
static uint32_t  consecutiveTimeout = 0;
static uint32_t  reinitCount        = 0;

static inline uint32_t msSince(uint32_t t0) { return millis() - t0; }
static inline uint8_t  seqByte()            { return (uint8_t)(seqId & 0xFF); }

// ---------------------- CSV emitters ----------------------
static void emitEvent(const char* event) {
    Serial.printf("%u,%s,%s,seq=%u\n", millis(), NODE_ID, event, seqId);
}
static void emitTimeoutEvent(const char* event) {
    Serial.printf("%u,%s,%s,seq=%u,consecutive_timeout=%u\n",
                  millis(), NODE_ID, event, seqId, consecutiveTimeout);
}
static void emitRangeEvent(float rangeM) {
    Serial.printf("%u,%s,RANGE_OK,seq=%u,range_m=%.3f\n",
                  millis(), NODE_ID, seqId, rangeM);
    // legacy compact form, consumed by the existing dashboard chart
    Serial.printf("%u,%s,%u,%.3f,OK\n", millis(), NODE_ID, seqId, rangeM);
}
static void emitTimeoutLegacy(const char* tag) {
    Serial.printf("%u,%s,%u,,%s,consecutive_timeout=%u\n",
                  millis(), NODE_ID, seqId, tag, consecutiveTimeout);
}
static void emitRestart(const char* reason) {
    Serial.printf("%u,%s,RX_RESTART,reason=%s\n", millis(), NODE_ID, reason);
}
static void emitReinit(const char* reason) {
    Serial.printf("%u,%s,DW_REINIT,reason=%s,count=%u\n",
                  millis(), NODE_ID, reason, reinitCount);
}

static void emitBootBanner() {
    // The dashboard parser ignores the legacy header but Serial Monitor users find it useful.
#if !RAW_UWB_TEST_MODE
    Serial.println("timestamp_ms,node_id,seq_id,range_m,status");
#endif
    Serial.print("node_A,BOOT,INITIATOR,hardware=DWM3000_v1.4,firmware=uwb_initiator.ino,build=");
    Serial.print(__DATE__); Serial.print(" "); Serial.println(__TIME__);
    Serial.printf(
        "node_A,CONFIG,profile=%s,channel=5,pan=0x1234,addr=0xA001,peer=0xB001,"
        "preamble=128,datarate=6.8M,sts=off,"
        "rx_to_ms=%u,rtinfo_to_ms=%u,resp_delay_us=1000,"
        "soft_thresh=%u,reinit_thresh=%u,role=INITIATOR\n",
        PROFILE_NAME,
        (unsigned) WAIT_RX_RESP_TIMEOUT_MS,
        (unsigned) WAIT_RX_RTINFO_TIMEOUT_MS,
        (unsigned) SOFT_RECOVERY_THRESHOLD,
        (unsigned) DW_REINIT_THRESHOLD);
}

// ---------------------- DW3000 lifecycle ----------------------
static void applyConfiguration() {
    DW3000.init();
    DW3000.setupGPIO();
    DW3000.configureAsTX();
    DW3000.clearSystemStatus();
}

static void softRxRestart(const char* reason) {
    DW3000.forceIdle();
    DW3000.clearSystemStatus();
    DW3000.standardRX();
    delay(GUARD_DELAY_MS);
    emitRestart(reason);
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
}

static void escalateAfterTimeout() {
    if (consecutiveTimeout >= DW_REINIT_THRESHOLD &&
        (consecutiveTimeout % DW_REINIT_THRESHOLD) == 0) {
        fullReinit("TIMEOUT_BURST");
    } else if (consecutiveTimeout >= SOFT_RECOVERY_THRESHOLD &&
               (consecutiveTimeout % SOFT_RECOVERY_THRESHOLD) == 0) {
        softRxRestart("CONSEC_TIMEOUT");
    } else {
        DW3000.clearSystemStatus();
        DW3000.standardRX();
    }
}

static void onRespTimeout() {
    consecutiveTimeout++;
    emitTimeoutEvent("RX_RESP_TIMEOUT");
    emitTimeoutLegacy("RX_RESP_TIMEOUT");
    escalateAfterTimeout();
    seqId++;
    currStage = 0;
}

static void onRtinfoTimeout() {
    consecutiveTimeout++;
    emitTimeoutEvent("RX_RTINFO_TIMEOUT");
    emitTimeoutLegacy("RX_RTINFO_TIMEOUT");
    escalateAfterTimeout();
    seqId++;
    currStage = 0;
}

static void onRxError(const char* tag) {
    Serial.printf("%u,%s,%s,seq=%u\n", millis(), NODE_ID, tag, seqId);
    consecutiveTimeout++;
    escalateAfterTimeout();
    seqId++;
    currStage = 0;
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
        Serial.println("node_A,FATAL,SPI_ERROR");
        while (true) delay(1000);
    }

    while (!DW3000.checkForIDLE()) delay(50);
    DW3000.softReset();
    delay(150);
    while (!DW3000.checkForIDLE()) delay(50);

    applyConfiguration();
    emitBootBanner();
}

void loop() {
    switch (currStage) {
        case 0:
            // ----- Stage 0: send POLL with seq_id embedded in senderID byte -----
            tRoundA = 0;
            tReplyA = 0;
            DW3000.clearSystemStatus();
            DW3000.setSenderID(seqByte());
            DW3000.ds_sendFrame(1);
            txTs = DW3000.readTXTimestamp();
            emitEvent("TX_POLL");
            stageStartMs = millis();
            currStage = 1;
            break;

        case 1: {
            // ----- Stage 1: wait for RESPONSE with software timeout -----
            rxStatus = DW3000.receivedFrameSucc();
            if (rxStatus == 0) {
                if (msSince(stageStartMs) >= WAIT_RX_RESP_TIMEOUT_MS) {
                    onRespTimeout();
                }
                break;
            }
            DW3000.clearSystemStatus();
            if (rxStatus != 1)            { onRxError("RX_RESP_ERR"); break; }
            if (DW3000.ds_isErrorFrame()) { onRxError("RX_RESP_ERR"); break; }
            if (DW3000.ds_getStage() != 2) {
                DW3000.ds_sendErrorFrame();
                onRxError("RX_RESP_ERR");
                break;
            }
            emitEvent("RX_RESP_OK");
            currStage = 2;
            break;
        }

        case 2:
            // ----- Stage 2: send FINAL with seq_id propagated -----
            rxTs = DW3000.readRXTimestamp();
            DW3000.setSenderID(seqByte());
            DW3000.ds_sendFrame(3);
            tRoundA = static_cast<int>(rxTs - txTs);
            txTs    = DW3000.readTXTimestamp();
            tReplyA = static_cast<int>(txTs - rxTs);
            emitEvent("TX_FINAL");
            stageStartMs = millis();
            currStage = 3;
            break;

        case 3: {
            // ----- Stage 3: wait for RTInfo with software timeout -----
            rxStatus = DW3000.receivedFrameSucc();
            if (rxStatus == 0) {
                if (msSince(stageStartMs) >= WAIT_RX_RTINFO_TIMEOUT_MS) {
                    onRtinfoTimeout();
                }
                break;
            }
            DW3000.clearSystemStatus();
            if (rxStatus != 1)            { onRxError("RX_RESP_ERR"); break; }
            if (DW3000.ds_isErrorFrame()) { onRxError("RX_RESP_ERR"); break; }
            clockOffset = DW3000.getRawClockOffset();
            emitEvent("RX_RTINFO_OK");
            currStage = 4;
            break;
        }

        case 4: {
            // ----- Stage 4: compute range -----
            int tRoundB = static_cast<int>(DW3000.read(0x12, 0x04));
            int tReplyB = static_cast<int>(DW3000.read(0x12, 0x08));
            int rangingTime = static_cast<int>(
                DW3000.ds_processRTInfo(tRoundA, tReplyA, tRoundB, tReplyB, clockOffset));
            float rangeCm = static_cast<float>(DW3000.convertToCM(rangingTime));

            if (rangeCm <= 0.0f || rangeCm > 20000.0f) {
                Serial.printf("%u,%s,INVALID_RANGE,seq=%u,range_m=%.3f\n",
                              millis(), NODE_ID, seqId, rangeCm / 100.0f);
                // do NOT clear consecutive_timeout on an invalid range
            } else {
                emitRangeEvent(rangeCm / 100.0f);
                consecutiveTimeout = 0;     // cleared only on a real OK
            }
            seqId++;
            DW3000.standardRX();
            currStage = 0;
            delay(ROUND_DELAY_MS);
            break;
        }

        default:
            Serial.printf("%u,%s,STATE_RESET,seq=%u\n", millis(), NODE_ID, seqId);
            seqId++;
            DW3000.clearSystemStatus();
            DW3000.standardRX();
            currStage = 0;
            break;
    }
}
