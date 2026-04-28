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

// ── 핀 정의 ───────────────────────────────────────────────────────────────────
#define PIN_SCK   18
#define PIN_MISO  19
#define PIN_MOSI  23
#define PIN_CS    5
#define PIN_IRQ   4
#define PIN_RST   27

// ── TWR 메시지 타입 ────────────────────────────────────────────────────────────
#define MSG_POLL     0x01
#define MSG_RESPONSE 0x02
#define MSG_FINAL    0x03

// ── 타이밍 ────────────────────────────────────────────────────────────────────
#define POLL_RX_TO_RESP_TX_DLY_US  1000  // Poll 수신 후 Response 전송 딜레이
#define RX_TIMEOUT_US              10000 // Poll 수신 타임아웃

static uint8_t rxBuf[20];
static uint8_t txBuf[12];

// ── 유틸: 40비트 타임스탬프 ───────────────────────────────────────────────────
static void putTimestamp40(uint8_t* buf, int offset, uint64_t ts) {
    for (int i = 0; i < 5; i++) {
        buf[offset + i] = (uint8_t)(ts >> (8 * i));
    }
}

void setup() {
    Serial.begin(115200);
    Serial.println("[UWB Responder] Initializing...");

    SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_CS);

    DW3000.begin(PIN_IRQ, PIN_RST);
    DW3000.select(PIN_CS);
    DW3000.newConfiguration();
    DW3000.setDefaults();
    DW3000.setChannel(DW_CHANNEL_5);
    DW3000.setDataRate(DW_DATARATE_6800KBPS);
    DW3000.setPreambleLength(DW_PREAMBLE_LENGTH_128);
    DW3000.setPulseFrequency(DW_PULSE_FREQ_64MHZ);
    DW3000.setPreambleCode(DW_PREAMBLE_CODE_9);
    DW3000.setAntennaDelay(16436);
    DW3000.commitConfiguration();

    Serial.println("[UWB Responder] Ready, waiting for Poll...");
}

void loop() {
    // ── 1. Poll 수신 대기 ─────────────────────────────────────────────────────
    DW3000.newReceive();
    DW3000.setDefaults();
    DW3000.receivePermanently(false);
    DW3000.startReceive();

    uint32_t rxStart = millis();
    bool rxOk = false;
    while ((millis() - rxStart) < (RX_TIMEOUT_US / 1000 + 50)) {
        if (DW3000.isReceiveDone()) { rxOk = true; break; }
        if (DW3000.isReceiveFailed() || DW3000.isReceiveTimeout()) break;
    }

    if (!rxOk) {
        DW3000.clearReceiveStatus();
        return;
    }

    DW3000.getData(rxBuf, 1);
    if (rxBuf[0] != MSG_POLL) {
        DW3000.clearReceiveStatus();
        return;
    }

    uint64_t pollRxTs = DW3000.getReceiveTimestamp();
    DW3000.clearReceiveStatus();

    // ── 2. Response 전송 ─────────────────────────────────────────────────────
    // Response TX 예약 시간 계산
    uint64_t respTxTs = (pollRxTs & 0xFFFFFFFE00ULL)
                        + (uint64_t)POLL_RX_TO_RESP_TX_DLY_US * 65536ULL;

    memset(txBuf, 0, sizeof(txBuf));
    txBuf[0] = MSG_RESPONSE;
    putTimestamp40(txBuf, 1, pollRxTs);   // Responder의 Poll Rx 시각
    putTimestamp40(txBuf, 6, respTxTs);   // Responder의 Response Tx 예약 시각

    DW3000.newTransmit();
    DW3000.setDefaults();
    DW3000.setDelay(POLL_RX_TO_RESP_TX_DLY_US);
    DW3000.setData(txBuf, 11);
    DW3000.startTransmit();

    while (!DW3000.isTransmitDone()) {}
    DW3000.clearTransmitStatus();

    Serial.printf("[UWB Responder] Responded at pollRxTs=%llu\n", pollRxTs);
}
