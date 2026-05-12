/**
 * UWB DWM3000 (DW3000 칩) — TWR Initiator (Distance Measurement)
 *
 * 역할: Two-Way Ranging(TWR)의 Initiator 역할.
 *       Poll 메시지를 전송하고 Responder의 Response를 수신한 뒤
 *       Final 메시지를 전송하여 비행시간(ToF) 기반 거리를 계산한다.
 *
 * 연구 맥락:
 *   이 코드는 BLE-triggered UWB Ranging + Cooperative Risk Filtering
 *   실험 플랫폼의 UWB confirmation layer다.
 *   BLE pre-trigger로 위험 후보가 식별된 후 UWB burst가 활성화되며,
 *   측정 결과는 analysis/risk_filter.py의 입력으로 사용된다.
 *
 * 하드웨어:
 *   - MCU: ESP32-WROOM-32
 *   - UWB Module: Qorvo DWM3000 (DW3000 기반)
 *
 * 핀 연결 (SPI):
 *   DWM3000    →  ESP32
 *   ─────────────────────
 *   VCC        →  3.3V
 *   GND        →  GND
 *   MOSI (SDA) →  GPIO 23
 *   MISO       →  GPIO 19
 *   SCK        →  GPIO 18
 *   CS / NSS   →  GPIO 5
 *   IRQ        →  GPIO 4
 */
#include <SPI.h>
#include <DW3000.h>

#define NODE_ID "node_A"
#define ROUND_DELAY_MS 200

static int currStage = 0;
static int rxStatus = 0;
static int tRoundA = 0;
static int tReplyA = 0;
static long long rxTs = 0;
static long long txTs = 0;
static int clockOffset = 0;
static uint32_t seqId = 0;

static void printRange(float rangeCm, const char* status) {
    Serial.printf("%u,%s,%u,%.3f,%s\n", millis(), NODE_ID, seqId++, rangeCm / 100.0f, status);
}

void setup() {
    Serial.begin(115200);
    Serial.println("timestamp_ms,node_id,seq_id,range_m,status");

    DW3000.spiSelect(CHIP_SELECT_PIN);
    DW3000.begin();
    DW3000.hardReset();
    delay(200);

    if (!DW3000.checkSPI()) {
        printRange(0.0f, "SPI_ERROR");
        while (true) {
            delay(1000);
        }
    }

    while (!DW3000.checkForIDLE()) {
        delay(100);
    }

    DW3000.softReset();
    delay(200);

    while (!DW3000.checkForIDLE()) {
        delay(100);
    }

    DW3000.init();
    DW3000.setupGPIO();
    DW3000.configureAsTX();
    DW3000.clearSystemStatus();

    Serial.println("[UWB Initiator] Ready.");
}

void loop() {
    switch (currStage) {
        case 0:
            tRoundA = 0;
            tReplyA = 0;
            DW3000.ds_sendFrame(1);
            txTs = DW3000.readTXTimestamp();
            currStage = 1;
            break;

        case 1:
            rxStatus = DW3000.receivedFrameSucc();
            if (!rxStatus) {
                break;
            }

            DW3000.clearSystemStatus();
            if (rxStatus != 1) {
                printRange(0.0f, "RX_ERROR");
                currStage = 0;
                break;
            }

            if (DW3000.ds_isErrorFrame()) {
                printRange(0.0f, "ERROR_FRAME");
                currStage = 0;
                break;
            }

            if (DW3000.ds_getStage() != 2) {
                DW3000.ds_sendErrorFrame();
                printRange(0.0f, "INVALID_STAGE");
                currStage = 0;
                break;
            }

            currStage = 2;
            break;

        case 2:
            rxTs = DW3000.readRXTimestamp();
            DW3000.ds_sendFrame(3);
            tRoundA = static_cast<int>(rxTs - txTs);
            txTs = DW3000.readTXTimestamp();
            tReplyA = static_cast<int>(txTs - rxTs);
            currStage = 3;
            break;

        case 3:
            rxStatus = DW3000.receivedFrameSucc();
            if (!rxStatus) {
                break;
            }

            DW3000.clearSystemStatus();
            if (rxStatus != 1) {
                printRange(0.0f, "RX_ERROR");
                currStage = 0;
                break;
            }

            if (DW3000.ds_isErrorFrame()) {
                printRange(0.0f, "ERROR_FRAME");
                currStage = 0;
                break;
            }

            clockOffset = DW3000.getRawClockOffset();
            currStage = 4;
            break;

        case 4: {
            int tRoundB = static_cast<int>(DW3000.read(0x12, 0x04));
            int tReplyB = static_cast<int>(DW3000.read(0x12, 0x08));
            int rangingTime = static_cast<int>(DW3000.ds_processRTInfo(tRoundA, tReplyA, tRoundB, tReplyB, clockOffset));
            float rangeCm = static_cast<float>(DW3000.convertToCM(rangingTime));

            if (rangeCm <= 0.0f || rangeCm > 20000.0f) {
                printRange(rangeCm, "INVALID_RANGE");
            } else {
                printRange(rangeCm, "OK");
            }

            currStage = 0;
            delay(ROUND_DELAY_MS);
            break;
        }

        default:
            printRange(0.0f, "STATE_RESET");
            currStage = 0;
            break;
    }
}
