/**
 * UWB DWM3000 - TWR Initiator (node_A)
 *
 * Role: Two-Way Ranging initiator. Sends Poll/Final, computes range from RTInfo.
 *       Includes software RX timeout and tiered recovery
 *       (light re-arm -> soft RX restart -> full DW3000 reinit) so that a single
 *       RX_RESP_TIMEOUT does not develop into an unrecoverable burst.
 *
 * Hardware: ESP32-WROOM-32 + Qorvo DWM3000
 *
 * Serial CSV (single source of truth for the dashboard):
 *   OK range:      timestamp_ms,node_A,seq,range_m,OK
 *   Resp timeout:  timestamp_ms,node_A,seq,,RX_RESP_TIMEOUT,consecutive_timeout=N
 *   RX error:      timestamp_ms,node_A,seq,,RX_RESP_ERR
 *   Recovery:      timestamp_ms,node_A,seq,,RX_RESTART
 *                  timestamp_ms,node_A,seq,,DW_REINIT,reason=TIMEOUT_BURST,count=N
 *   Boot/config:   node_A,BOOT,INITIATOR
 *                  node_A,CONFIG,channel=5,pan=0x1234,addr=0xA001,peer=0xB001,
 *                                preamble=128,datarate=6.8M,sts=off,
 *                                rx_to_ms=30,final_to_ms=30,resp_delay_us=1000,
 *                                soft_thresh=5,reinit_thresh=20,role=INITIATOR
 *
 * TEST_MODE_RAW_UWB: when 1, no decorative text, CSV only.
 */
#include <SPI.h>
#include <DW3000.h>

#define TEST_MODE_RAW_UWB 1

#define NODE_ID "node_A"

#define ROUND_DELAY_MS             200
#define WAIT_RX_RESP_TIMEOUT_MS     30   // node_A wait for Response after Poll
#define WAIT_RX_FINAL_RTINFO_MS     30   // node_A wait for RTInfo after Final
#define SOFT_RECOVERY_THRESHOLD      5   // consecutive timeouts -> soft RX restart
#define DW_REINIT_THRESHOLD         20   // consecutive timeouts -> full DW3000 reinit
#define GUARD_DELAY_MS               4

static int       currStage = 0;
static int       rxStatus  = 0;
static int       tRoundA   = 0;
static int       tReplyA   = 0;
static long long rxTs      = 0;
static long long txTs      = 0;
static int       clockOffset = 0;
static uint32_t  seqId       = 0;
static uint32_t  stageStartMs = 0;
static uint32_t  consecutiveTimeout = 0;
static uint32_t  reinitCount        = 0;

static inline uint32_t msSince(uint32_t t0) { return millis() - t0; }

static void emitRange(float rangeCm) {
    Serial.printf("%u,%s,%u,%.3f,OK\n", millis(), NODE_ID, seqId, rangeCm / 100.0f);
}

static void emitStatus(const char* status) {
    Serial.printf("%u,%s,%u,,%s\n", millis(), NODE_ID, seqId, status);
}

static void emitTimeout() {
    Serial.printf("%u,%s,%u,,RX_RESP_TIMEOUT,consecutive_timeout=%u\n",
                  millis(), NODE_ID, seqId, consecutiveTimeout);
}

static void emitRestart() {
    Serial.printf("%u,%s,%u,,RX_RESTART\n", millis(), NODE_ID, seqId);
}

static void emitReinit(const char* reason) {
    Serial.printf("%u,%s,%u,,DW_REINIT,reason=%s,count=%u\n",
                  millis(), NODE_ID, seqId, reason, reinitCount);
}

static void applyConfiguration() {
    DW3000.init();
    DW3000.setupGPIO();
    DW3000.configureAsTX();
    DW3000.clearSystemStatus();
}

static void emitBootBanner() {
    Serial.println("timestamp_ms,node_id,seq_id,range_m,status");
    Serial.println("node_A,BOOT,INITIATOR");
    Serial.printf(
        "node_A,CONFIG,channel=5,pan=0x1234,addr=0xA001,peer=0xB001,"
        "preamble=128,datarate=6.8M,sts=off,"
        "rx_to_ms=%u,final_to_ms=%u,resp_delay_us=1000,"
        "soft_thresh=%u,reinit_thresh=%u,role=INITIATOR\n",
        (unsigned) WAIT_RX_RESP_TIMEOUT_MS,
        (unsigned) WAIT_RX_FINAL_RTINFO_MS,
        (unsigned) SOFT_RECOVERY_THRESHOLD,
        (unsigned) DW_REINIT_THRESHOLD);
}

static void softRxRestart() {
    DW3000.forceIdle();
    DW3000.clearSystemStatus();
    DW3000.standardRX();
    delay(GUARD_DELAY_MS);
    emitRestart();
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
        softRxRestart();
    } else {
        DW3000.clearSystemStatus();
        DW3000.standardRX();
    }
}

static void onTimeoutEvent() {
    consecutiveTimeout++;
    emitTimeout();
    escalateAfterTimeout();
    seqId++;
    currStage = 0;
}

static void onRxErrorEvent(const char* tag) {
    emitStatus(tag);
    consecutiveTimeout++;
    escalateAfterTimeout();
    seqId++;
    currStage = 0;
}

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
            tRoundA = 0;
            tReplyA = 0;
            DW3000.clearSystemStatus();
            DW3000.ds_sendFrame(1);
            txTs = DW3000.readTXTimestamp();
            stageStartMs = millis();
            currStage = 1;
            break;

        case 1: {
            rxStatus = DW3000.receivedFrameSucc();
            if (rxStatus == 0) {
                if (msSince(stageStartMs) >= WAIT_RX_RESP_TIMEOUT_MS) {
                    onTimeoutEvent();
                }
                break;
            }
            DW3000.clearSystemStatus();
            if (rxStatus != 1)             { onRxErrorEvent("RX_RESP_ERR"); break; }
            if (DW3000.ds_isErrorFrame())  { onRxErrorEvent("RX_RESP_ERR"); break; }
            if (DW3000.ds_getStage() != 2) {
                DW3000.ds_sendErrorFrame();
                onRxErrorEvent("INVALID_STAGE");
                break;
            }
            currStage = 2;
            break;
        }

        case 2:
            rxTs = DW3000.readRXTimestamp();
            DW3000.ds_sendFrame(3);
            tRoundA = static_cast<int>(rxTs - txTs);
            txTs    = DW3000.readTXTimestamp();
            tReplyA = static_cast<int>(txTs - rxTs);
            stageStartMs = millis();
            currStage = 3;
            break;

        case 3: {
            rxStatus = DW3000.receivedFrameSucc();
            if (rxStatus == 0) {
                if (msSince(stageStartMs) >= WAIT_RX_FINAL_RTINFO_MS) {
                    onTimeoutEvent();
                }
                break;
            }
            DW3000.clearSystemStatus();
            if (rxStatus != 1)             { onRxErrorEvent("RX_RESP_ERR"); break; }
            if (DW3000.ds_isErrorFrame())  { onRxErrorEvent("RX_RESP_ERR"); break; }
            clockOffset = DW3000.getRawClockOffset();
            currStage = 4;
            break;
        }

        case 4: {
            int tRoundB = static_cast<int>(DW3000.read(0x12, 0x04));
            int tReplyB = static_cast<int>(DW3000.read(0x12, 0x08));
            int rangingTime = static_cast<int>(
                DW3000.ds_processRTInfo(tRoundA, tReplyA, tRoundB, tReplyB, clockOffset));
            float rangeCm = static_cast<float>(DW3000.convertToCM(rangingTime));

            if (rangeCm <= 0.0f || rangeCm > 20000.0f) {
                emitStatus("INVALID_RANGE");
            } else {
                emitRange(rangeCm);
                consecutiveTimeout = 0;  // spec: clear only after successful OK
            }
            seqId++;
            DW3000.standardRX();
            currStage = 0;
            delay(ROUND_DELAY_MS);
            break;
        }

        default:
            emitStatus("STATE_RESET");
            seqId++;
            DW3000.clearSystemStatus();
            DW3000.standardRX();
            currStage = 0;
            break;
    }
}
