/**
 * UWB DWM3000 - TWR Responder (node_B)
 *
 * Role: Receives Poll, schedules Response, then receives Final and replies with
 *       RTInfo. Emits a 1-Hz heartbeat plus per-cycle diagnostic events so the
 *       dashboard can prove whether the responder is alive and receiving polls
 *       during a node_A timeout burst. Performs soft RX restart after 2s of no
 *       poll and a full DW3000 reinit after 10s.
 *
 * Hardware: ESP32-WROOM-32 + Qorvo DWM3000
 *
 * Serial CSV (single source of truth for the dashboard):
 *   Boot:           node_B,BOOT,RESPONDER
 *                   node_B,CONFIG,channel=5,pan=0x1234,addr=0xB001,peer=0xA001,
 *                                 preamble=128,datarate=6.8M,sts=off,
 *                                 final_to_ms=30,watchdog_soft_ms=2000,
 *                                 watchdog_reinit_ms=10000,role=RESPONDER
 *   Heartbeat (1s): timestamp_ms,node_B,READY
 *   Per-cycle:      timestamp_ms,node_B,RX_ARMED
 *                   timestamp_ms,node_B,RX_POLL
 *                   timestamp_ms,node_B,TX_RESP_SCHEDULED
 *                   timestamp_ms,node_B,TX_DONE
 *                   timestamp_ms,node_B,RX_ERR
 *                   timestamp_ms,node_B,RX_TIMEOUT
 *                   timestamp_ms,node_B,RX_RESTART
 *                   timestamp_ms,node_B,RX_WATCHDOG_RESTART
 *                   timestamp_ms,node_B,DW_REINIT,reason=NO_POLL,count=N
 *
 * IMPORTANT: response TX is scheduled BEFORE printing any diagnostic, so logs
 * never push the delayed-TX window. Heartbeat/event prints happen outside the
 * timing-critical send path.
 */

#include <SPI.h>
#include <DW3000.h>

#define TEST_MODE_RAW_UWB 1

#define NODE_ID "node_B"

#define WAIT_RX_FINAL_MS         30      // node_B wait for Final after sending Response
#define HEARTBEAT_INTERVAL_MS    1000
#define WATCHDOG_SOFT_MS         2000    // no valid POLL for 2s -> RX restart
#define WATCHDOG_REINIT_MS       10000   // no valid POLL for 10s -> full reinit
#define GUARD_DELAY_MS           4

static int       currStage = 0;
static int       rxStatus  = 0;
static int       tRoundB   = 0;
static int       tReplyB   = 0;
static long long rxTs      = 0;
static long long txTs      = 0;

static uint32_t  lastHeartbeatMs   = 0;
static uint32_t  lastPollSeenMs    = 0;
static uint32_t  lastWatchdogSoftMs = 0;
static uint32_t  stageStartMs      = 0;
static uint32_t  reinitCount       = 0;
static bool      rxArmedLogged     = false;

static inline uint32_t msSince(uint32_t t0) { return millis() - t0; }

static void emitEvent(const char* event) {
    Serial.printf("%u,%s,%s\n", millis(), NODE_ID, event);
}

static void emitReinit(const char* reason) {
    Serial.printf("%u,%s,DW_REINIT,reason=%s,count=%u\n",
                  millis(), NODE_ID, reason, reinitCount);
}

static void applyConfiguration() {
    DW3000.init();
    DW3000.setupGPIO();
    DW3000.configureAsTX();
    DW3000.clearSystemStatus();
    DW3000.standardRX();
}

static void emitBootBanner() {
    Serial.println("node_B,BOOT,RESPONDER");
    Serial.printf(
        "node_B,CONFIG,channel=5,pan=0x1234,addr=0xB001,peer=0xA001,"
        "preamble=128,datarate=6.8M,sts=off,"
        "final_to_ms=%u,watchdog_soft_ms=%u,watchdog_reinit_ms=%u,role=RESPONDER\n",
        (unsigned) WAIT_RX_FINAL_MS,
        (unsigned) WATCHDOG_SOFT_MS,
        (unsigned) WATCHDOG_REINIT_MS);
}

static void softRxRestart(const char* tag) {
    DW3000.forceIdle();
    DW3000.clearSystemStatus();
    DW3000.standardRX();
    delay(GUARD_DELAY_MS);
    emitEvent(tag);
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
        emitEvent("READY");
    }
}

static void watchdogTick(uint32_t now) {
    if (lastPollSeenMs == 0) return;
    uint32_t since = now - lastPollSeenMs;
    if (since >= WATCHDOG_REINIT_MS) {
        fullReinit("NO_POLL");
        lastPollSeenMs = now;       // avoid storm: reset baseline after reinit
        lastWatchdogSoftMs = now;
    } else if (since >= WATCHDOG_SOFT_MS &&
               (now - lastWatchdogSoftMs) >= WATCHDOG_SOFT_MS) {
        softRxRestart("RX_WATCHDOG_RESTART");
        lastWatchdogSoftMs = now;
    }
}

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
    lastPollSeenMs = millis();   // give watchdog a baseline so we don't fire immediately
    lastWatchdogSoftMs = lastPollSeenMs;
}

void loop() {
    uint32_t now = millis();
    heartbeatTick(now);
    watchdogTick(now);

    switch (currStage) {
        case 0: {
            // Stage 0: wait for Poll (frame 1).  Log RX_ARMED at most once per arming.
            if (!rxArmedLogged) { emitEvent("RX_ARMED"); rxArmedLogged = true; }

            tRoundB = 0;
            tReplyB = 0;

            rxStatus = DW3000.receivedFrameSucc();
            if (rxStatus == 0) break;            // still listening

            DW3000.clearSystemStatus();
            if (rxStatus != 1) {
                emitEvent("RX_ERR");
                softRxRestart("RX_RESTART");
                break;
            }
            if (DW3000.ds_isErrorFrame()) {
                emitEvent("RX_ERR");
                softRxRestart("RX_RESTART");
                break;
            }
            if (DW3000.ds_getStage() != 1) {
                DW3000.ds_sendErrorFrame();
                emitEvent("RX_ERR");
                softRxRestart("RX_RESTART");
                break;
            }
            lastPollSeenMs = now;
            emitEvent("RX_POLL");
            currStage = 1;
            break;
        }

        case 1: {
            // Stage 1: TIMING-CRITICAL.  Schedule Response first, then log.
            DW3000.ds_sendFrame(2);
            rxTs = DW3000.readRXTimestamp();
            txTs = DW3000.readTXTimestamp();
            tReplyB = static_cast<int>(txTs - rxTs);
            stageStartMs = millis();
            emitEvent("TX_RESP_SCHEDULED");
            currStage = 2;
            break;
        }

        case 2: {
            // Stage 2: wait for Final with software timeout.
            rxStatus = DW3000.receivedFrameSucc();
            if (rxStatus == 0) {
                if (msSince(stageStartMs) >= WAIT_RX_FINAL_MS) {
                    emitEvent("RX_TIMEOUT");
                    softRxRestart("RX_RESTART");
                    currStage = 0;
                }
                break;
            }
            DW3000.clearSystemStatus();
            if (rxStatus != 1) {
                emitEvent("RX_ERR");
                softRxRestart("RX_RESTART");
                currStage = 0;
                break;
            }
            if (DW3000.ds_isErrorFrame()) {
                emitEvent("RX_ERR");
                softRxRestart("RX_RESTART");
                currStage = 0;
                break;
            }
            if (DW3000.ds_getStage() != 3) {
                DW3000.ds_sendErrorFrame();
                emitEvent("RX_ERR");
                softRxRestart("RX_RESTART");
                currStage = 0;
                break;
            }
            currStage = 3;
            break;
        }

        case 3: {
            // Stage 3: TIMING-CRITICAL.  Send RTInfo first, then log TX_DONE.
            rxTs = DW3000.readRXTimestamp();
            tRoundB = static_cast<int>(rxTs - txTs);
            DW3000.ds_sendRTInfo(tRoundB, tReplyB);
            emitEvent("TX_DONE");
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
