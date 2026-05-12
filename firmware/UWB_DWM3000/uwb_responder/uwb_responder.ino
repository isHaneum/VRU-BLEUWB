/**
 * UWB DWM3000 (DW3000 칩) — TWR Responder
 *
 * 역할: Initiator의 Poll을 수신하고 Response를 반환한다.
 *       Response 페이로드에 자신의 Rx/Tx 타임스탬프를 심어
 *       Initiator가 DS-TWR 거리 계산을 수행할 수 있게 한다.
 *
 * 하드웨어:
 *   - MCU: ESP32-WROOM-32
 *   - UWB Module: Qorvo DWM3000 (DW3000 기반)
 *
 * 핀 연결: uwb_initiator.ino와 동일
 *
 * 프레임워크: Arduino
 * 라이브러리: DW3000 Arduino Driver (thotro/arduino-dw3000)
 */

#include <SPI.h>
#include <DW3000.h>

static int currStage = 0;
static int rxStatus = 0;
static int tRoundB = 0;
static int tReplyB = 0;
static long long rxTs = 0;
static long long txTs = 0;

void setup() {
    Serial.begin(115200);
    Serial.println("[UWB Responder] Initializing...");

    DW3000.spiSelect(CHIP_SELECT_PIN);
    DW3000.begin();
    DW3000.hardReset();
    delay(200);

    if (!DW3000.checkSPI()) {
        Serial.println("[UWB Responder] SPI_ERROR");
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
    DW3000.standardRX();

    Serial.println("[UWB Responder] Ready, waiting for Poll...");
}

void loop() {
    switch (currStage) {
        case 0:
            tRoundB = 0;
            tReplyB = 0;

            rxStatus = DW3000.receivedFrameSucc();
            if (!rxStatus) {
                break;
            }

            DW3000.clearSystemStatus();
            if (rxStatus != 1) {
                Serial.println("[UWB Responder] RX_ERROR");
                DW3000.standardRX();
                break;
            }

            if (DW3000.ds_isErrorFrame()) {
                Serial.println("[UWB Responder] ERROR_FRAME");
                DW3000.standardRX();
                break;
            }

            if (DW3000.ds_getStage() != 1) {
                DW3000.ds_sendErrorFrame();
                Serial.println("[UWB Responder] INVALID_STAGE");
                DW3000.standardRX();
                break;
            }

            currStage = 1;
            break;

        case 1:
            DW3000.ds_sendFrame(2);
            rxTs = DW3000.readRXTimestamp();
            txTs = DW3000.readTXTimestamp();
            tReplyB = static_cast<int>(txTs - rxTs);
            currStage = 2;
            break;

        case 2:
            rxStatus = DW3000.receivedFrameSucc();
            if (!rxStatus) {
                break;
            }

            DW3000.clearSystemStatus();
            if (rxStatus != 1) {
                Serial.println("[UWB Responder] RX_ERROR");
                currStage = 0;
                DW3000.standardRX();
                break;
            }

            if (DW3000.ds_isErrorFrame()) {
                Serial.println("[UWB Responder] ERROR_FRAME");
                currStage = 0;
                DW3000.standardRX();
                break;
            }

            if (DW3000.ds_getStage() != 3) {
                DW3000.ds_sendErrorFrame();
                Serial.println("[UWB Responder] INVALID_STAGE");
                currStage = 0;
                DW3000.standardRX();
                break;
            }

            currStage = 3;
            break;

        case 3:
            rxTs = DW3000.readRXTimestamp();
            tRoundB = static_cast<int>(rxTs - txTs);
            DW3000.ds_sendRTInfo(tRoundB, tReplyB);
            Serial.printf("[UWB Responder] RESPONDED,%d,%d\n", tRoundB, tReplyB);
            currStage = 0;
            break;

        default:
            currStage = 0;
            DW3000.standardRX();
            break;
    }
}
