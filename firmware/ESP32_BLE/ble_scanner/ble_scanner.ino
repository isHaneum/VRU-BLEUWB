/**
 * ESP32 WROOM-32 — BLE Scanner (Receiver / RSSI Logger)
 *
 * 역할: 주변 VRU BLE Beacon을 스캔하여 RSSI와 타임스탬프를 Serial로 출력한다.
 *       출력 포맷은 CSV이므로 실험 라벨링 앱(ExperimentLogger)의 시간축과
 *       직접 비교할 수 있다.
 *
 * 연구 맥락:
 *   BLE는 위험 후보를 빠르게 찾는 pre-trigger layer다.
 *   이 scanner는 BLE hit count, RSSI trend, packet count를 제공하며
 *   analysis/risk_filter.py의 Stage 1 (CANDIDATE) 판단에 사용된다.
 *
 * 중요 주의사항:
 *   BLE MAC 주소(mac 컬럼)는 iOS 14+ 및 Android 10+ 이후 Randomized MAC을
 *   사용하므로 안정적인 기기 ID로 가정하면 안 된다.
 *   실험에서 VRU 태그를 고정 MAC이 아닌 device_name 또는
 *   Manufacturer Data의 고정 ID 필드로 식별할 것.
 *   docs/limitations.md 참조.
 *
 * 하드웨어: ESP32-WROOM-32
 * 프레임워크: Arduino (ESP32 Arduino Core)
 * 라이브러리: ESP32 BLE Arduino (내장)
 *
 * Serial 출력 형식:
 *   timestamp_ms,node_id,seq_id,device_name,mac,rssi,manufacturer_data_hex
 */
 
#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>

// ── 설정 ──────────────────────────────────────────────────────────────────────
#define SCAN_DURATION_SEC   1      // 1회 스캔 시간 (초)
#define SCAN_INTERVAL_MS    100    // 스캔 윈도우 간격 (ms)
#define SCAN_WINDOW_MS      99     // 스캔 윈도우 (ms) — 거의 연속 스캔

// 각 Scanner 노드마다 고유 ID를 지정하라
#define NODE_ID  "node_A"

// 필터: 이 prefix로 시작하는 이름만 수집. 빈 문자열이면 전체 수집.
// NOTE: VRU 태그 기기명을 "VRU_"로 시작하도록 맞춰야 한다.
#define TARGET_NAME_PREFIX  ""

static BLEScan* pBLEScan = nullptr;
static volatile uint32_t seqId = 0;

// ── 스캔 콜백 ─────────────────────────────────────────────────────────────────
class ScanCallback : public BLEAdvertisedDeviceCallbacks {
public:
    void onResult(BLEAdvertisedDevice dev) override {
        String name = String(dev.getName().c_str());

        // 필터 적용
        if (strlen(TARGET_NAME_PREFIX) > 0) {
            if (!name.startsWith(TARGET_NAME_PREFIX)) return;
        }

        uint32_t ts  = millis();
        uint32_t sid = seqId++;
        String mac = String(dev.getAddress().toString().c_str());
        int rssi = dev.getRSSI();

        // NOTE: mac은 Randomized MAC일 수 있어 안정적 식별자가 아님.
        // 기기 식별은 device_name 또는 manufacturer_data_hex 내 고정 필드 사용.

        // Manufacturer Data를 HEX 문자열로 변환
        String mfrHex = "";
        if (dev.haveManufacturerData()) {
            String mfr = String(dev.getManufacturerData().c_str());
            for (size_t i = 0; i < mfr.length(); i++) {
                char buf[3];
                snprintf(buf, sizeof(buf), "%02X", (uint8_t)mfr[i]);
                mfrHex += buf;
            }
        }

        // CSV 출력: timestamp_ms,node_id,seq_id,name,mac,rssi,mfr_hex
        Serial.printf("%u,%s,%u,%s,%s,%d,%s\n",
                      ts,
                      NODE_ID,
                      sid,
                      name.isEmpty() ? "UNKNOWN" : name.c_str(),
                      mac.c_str(),
                      rssi,
                      mfrHex.isEmpty() ? "" : mfrHex.c_str());
    }
};

static ScanCallback scanCallback;

void setup() {
    Serial.begin(115200);
    delay(300);
    // CSV 헤더 출력
    // mac 컬럼은 Randomized MAC으로 실험 간 동일 기기 추적에 사용하지 말 것
    Serial.println("# BLE scanner booted");
    Serial.printf("# filter_prefix=%s,node_id=%s\n", TARGET_NAME_PREFIX, NODE_ID);
    Serial.println("timestamp_ms,node_id,seq_id,device_name,mac,rssi,manufacturer_data_hex");

    BLEDevice::init("");
    pBLEScan = BLEDevice::getScan();
    pBLEScan->setAdvertisedDeviceCallbacks(&scanCallback, /*wantDuplicates=*/true);
    pBLEScan->setActiveScan(true);
    pBLEScan->setInterval(SCAN_INTERVAL_MS);
    pBLEScan->setWindow(SCAN_WINDOW_MS);
}

void loop() {
    // 연속 스캔: 스캔 완료 후 즉시 재시작
    pBLEScan->start(SCAN_DURATION_SEC, /*is_continue=*/false);
    pBLEScan->clearResults();
    Serial.println("# scan cycle complete");
}

