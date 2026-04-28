/**
 * UWB DWM3000 (DW3000 칩) — TWR Initiator (Distance Measurement)
 *
 * 역할: Two-Way Ranging(TWR)의 Initiator 역할.
 *       Poll 메시지를 전송하고 Responder의 Response를 수신한 뒤
 *       Final 메시지를 전송하여 비행시간(ToF) 기반 거리를 계산한다.
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
 *   RST        →  GPIO 27
 *   WAKEUP     →  GPIO 26 (optional)
 *
 * 프레임워크: Arduino
 * 라이브러리: DW3000 Arduino Driver (Qorvo / thotro fork)
 *   https://github.com/thotro/arduino-dw3000
 *   또는 Qorvo 공식 SDK를 Arduino 래핑한 버전
 *
 * Serial 출력 형식:
 *   timestamp_ms,range_m,status
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
#define POLL_TX_TO_RESP_RX_DLY_US  150   // Poll 전송 후 수신 대기 시작 딜레이
#define RESP_RX_TIMEOUT_US         5000  // Response 수신 타임아웃
#define FINAL_TX_DLY_US            1000  // Response 수신 후 Final 전송 딜레이

// UWB 시간 단위 → 초 변환 (DW3000: 1 UWB tick = 1/(499.2MHz * 128) ≈ 15.65 ps)
#define UWB_TICK_TO_SEC  (1.0 / (499.2e6 * 128.0))
#define SPEED_OF_LIGHT   299702547.0  // m/s (공기 중)

static uint8_t txBuf[12];
static uint8_t rxBuf[20];

// ── 유틸: 40비트 타임스탬프 읽기 ────────────────────────────────────────────────
static uint64_t getTimestamp40(const uint8_t* buf, int offset) {
    uint64_t ts = 0;
    for (int i = 0; i < 5; i++) {
        ts |= ((uint64_t)buf[offset + i]) << (8 * i);
    }
    return ts;
}

static void putTimestamp40(uint8_t* buf, int offset, uint64_t ts) {
    for (int i = 0; i < 5; i++) {
        buf[offset + i] = (uint8_t)(ts >> (8 * i));
    }
}

void setup() {
    Serial.begin(115200);
    Serial.println("timestamp_ms,range_m,status");

    SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_CS);

    DW3000.begin(PIN_IRQ, PIN_RST);
    DW3000.select(PIN_CS);
    DW3000.newConfiguration();
    DW3000.setDefaults();
    DW3000.setChannel(DW_CHANNEL_5);       // Channel 5 (6.5 GHz)
    DW3000.setDataRate(DW_DATARATE_6800KBPS);
    DW3000.setPreambleLength(DW_PREAMBLE_LENGTH_128);
    DW3000.setPulseFrequency(DW_PULSE_FREQ_64MHZ);
    DW3000.setPreambleCode(DW_PREAMBLE_CODE_9);
    DW3000.setAntennaDelay(16436);         // 캘리브레이션 값 (기기별 조정 필요)
    DW3000.commitConfiguration();

    Serial.println("[UWB Initiator] Ready.");
}

void loop() {
    uint32_t loopStart = millis();

    // ── 1. Poll 전송 ─────────────────────────────────────────────────────────
    memset(txBuf, 0, sizeof(txBuf));
    txBuf[0] = MSG_POLL;

    DW3000.newTransmit();
    DW3000.setDefaults();
    DW3000.setData(txBuf, 1);
    DW3000.startTransmit();

    // Poll 전송 타임스탬프 저장
    while (!DW3000.isTransmitDone()) {}
    DW3000.clearTransmitStatus();
    uint64_t pollTxTs = DW3000.getTransmitTimestamp();

    // ── 2. Response 수신 대기 ────────────────────────────────────────────────
    DW3000.newReceive();
    DW3000.setDefaults();
    DW3000.receivePermanently(false);
    DW3000.startReceive();

    uint32_t rxStart = millis();
    bool rxOk = false;
    while ((millis() - rxStart) < (RESP_RX_TIMEOUT_US / 1000 + 10)) {
        if (DW3000.isReceiveDone()) {
            rxOk = true;
            break;
        }
        if (DW3000.isReceiveFailed() || DW3000.isReceiveTimeout()) break;
    }

    if (!rxOk || rxBuf[0] != MSG_RESPONSE) {
        DW3000.clearReceiveStatus();
        Serial.printf("%u,0.000,TIMEOUT\n", millis());
        delay(50);
        return;
    }

    DW3000.getData(rxBuf, 10);
    uint64_t respRxTs = DW3000.getReceiveTimestamp();
    DW3000.clearReceiveStatus();

    // Responder가 심어 놓은 Rx/Tx 타임스탬프 추출
    uint64_t pollRxTs  = getTimestamp40(rxBuf, 1);
    uint64_t respTxTs  = getTimestamp40(rxBuf, 6);

    // ── 3. Final 전송 ────────────────────────────────────────────────────────
    uint64_t finalTxTs = (respRxTs & 0xFFFFFFFE00ULL) + FINAL_TX_DLY_US * 65536ULL;

    memset(txBuf, 0, sizeof(txBuf));
    txBuf[0] = MSG_FINAL;
    putTimestamp40(txBuf, 1, pollTxTs);
    putTimestamp40(txBuf, 6, finalTxTs);

    DW3000.newTransmit();
    DW3000.setDefaults();
    DW3000.setDelay(FINAL_TX_DLY_US);
    DW3000.setData(txBuf, 11);
    DW3000.startTransmit();
    while (!DW3000.isTransmitDone()) {}
    DW3000.clearTransmitStatus();

    // ── 4. 거리 계산 (DS-TWR 공식) ───────────────────────────────────────────
    // Ra = respRxTs  - pollTxTs (initiator 왕복 A)
    // Rb = respTxTs  - pollRxTs (responder 처리 시간)
    // Da = finalTxTs - respRxTs
    // Db = (responder는 Final Rx를 알 수 없으므로 DS-TWR 단순화)
    //
    // Single-sided TWR 근사:
    //   ToF = (Ra - Rb) / 4
    double Ra = (double)((int64_t)(respRxTs  - pollTxTs));
    double Rb = (double)((int64_t)(respTxTs  - pollRxTs));
    double tof_ticks = (Ra - Rb) / 4.0;
    double tof_sec   = tof_ticks * UWB_TICK_TO_SEC;
    double range_m   = tof_sec * SPEED_OF_LIGHT;

    // 음수 또는 비정상 값 필터링
    if (range_m < 0.0 || range_m > 200.0) {
        Serial.printf("%u,%.3f,INVALID\n", millis(), range_m);
    } else {
        Serial.printf("%u,%.3f,OK\n", millis(), range_m);
    }

    delay(50);
}
