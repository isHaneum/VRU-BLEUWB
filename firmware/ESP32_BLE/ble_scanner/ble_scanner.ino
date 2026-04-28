/**
 * ESP32 WROOM-32 — BLE Scanner (Receiver / RSSI Logger)
 *
 * 역할: 주변 VRU BLE Beacon을 스캔하여 RSSI와 타임스탬프를 Serial로 출력한다.
 *       출력 포맷은 CSV이므로 실험 라벨링 앱(ExperimentLogger)의 시간축과
 *       직접 비교할 수 있다.
 *
 * 하드웨어: ESP32-WROOM-32
 * 프레임워크: Arduino (ESP32 Arduino Core)
 * 라이브러리: ESP32 BLE Arduino (내장)
 *
 * Serial 출력 형식:
 *   timestamp_ms,device_name,mac,rssi,manufacturer_data_hex
 */

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>

// ── 설정 ──────────────────────────────────────────────────────────────────────
#define SCAN_DURATION_SEC   1      // 1회 스캔 시간 (초)
#define SCAN_INTERVAL_MS    100    // 스캔 윈도우 간격 (ms)
#define SCAN_WINDOW_MS      99     // 스캔 윈도우 (ms) — 거의 연속 스캔

// 필터: 이 prefix로 시작하는 이름만 수집. 빈 문자열이면 전체 수집.
#define TARGET_NAME_PREFIX  "VRU_"

static BLEScan* pBLEScan = nullptr;

// ── 스캔 콜백 ─────────────────────────────────────────────────────────────────
class ScanCallback : public BLEAdvertisedDeviceCallbacks {
public:
    void onResult(BLEAdvertisedDevice dev) override {
        std::string name = dev.getName();

        // 필터 적용
        if (strlen(TARGET_NAME_PREFIX) > 0) {
            if (name.find(TARGET_NAME_PREFIX) != 0) return;
        }

        uint32_t ts = millis();
        std::string mac = dev.getAddress().toString();
        int rssi = dev.getRSSI();

        // Manufacturer Data를 HEX 문자열로 변환
        String mfrHex = "";
        if (dev.haveManufacturerData()) {
            std::string mfr = dev.getManufacturerData();
            for (size_t i = 0; i < mfr.size(); i++) {
                char buf[3];
                snprintf(buf, sizeof(buf), "%02X", (uint8_t)mfr[i]);
                mfrHex += buf;
            }
        }

        // CSV 출력: timestamp_ms,name,mac,rssi,mfr_hex
        Serial.printf("%u,%s,%s,%d,%s\n",
                      ts,
                      name.empty() ? "UNKNOWN" : name.c_str(),
                      mac.c_str(),
                      rssi,
                      mfrHex.isEmpty() ? "" : mfrHex.c_str());
    }
};

static ScanCallback scanCallback;

void setup() {
    Serial.begin(115200);
    // CSV 헤더 출력
    Serial.println("timestamp_ms,device_name,mac,rssi,manufacturer_data_hex");

    BLEDevice::init("");
    pBLEScan = BLEDevice::getScan();
    pBLEScan->setAdvertisedDeviceCallbacks(&scanCallback, /*wantDuplicates=*/true);
    pBLEScan->setActiveScan(true);
    pBLEScan->setInterval(SCAN_INTERVAL_MS);
    pBLEScan->setWindow(SCAN_WINDOW_MS);
}

void loop() {
    // 연속 스캔: 스캔 완료 후 즉시 재시작
    BLEScanResults results = pBLEScan->start(SCAN_DURATION_SEC, /*is_continue=*/false);
    pBLEScan->clearResults();
}
