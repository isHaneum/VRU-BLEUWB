/**
 * ESP32 WROOM-32 — BLE Beacon (Advertiser)
 *
 * 역할: VRU(Vulnerable Road User) 식별용 BLE 광고 패킷을 송출한다.
 *       RSSI 기반 거리 추정에 사용할 수 있도록 TX Power를 광고 페이로드에 포함한다.
 *
 * 하드웨어: ESP32-WROOM-32
 * 프레임워크: Arduino (ESP32 Arduino Core)
 * 라이브러리: ESP32 BLE Arduino (내장)
 *
 * 핀 연결: 없음 (BLE 내장)
 *
 * 사용 방법:
 *   1. Arduino IDE 또는 PlatformIO에서 빌드
 *   2. 보드: "ESP32 Dev Module"
 *   3. 파티션 스킴: "Default 4MB"
 */

#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEAdvertising.h>

// ── 설정 ──────────────────────────────────────────────────────────────────────
#define DEVICE_NAME       "VRU_BLE_01"      // BLE 기기 이름 (실험 ID와 맞출 것)
#define TX_POWER_DBM      0                  // 송신 전력 (dBm): -12 ~ 9
#define ADV_INTERVAL_MS   100               // 광고 간격 (ms)

// Company ID (실험용 임의값 — 실제 배포 시 Bluetooth SIG 할당 ID 사용)
#define COMPANY_ID_LOW    0xFF
#define COMPANY_ID_HIGH   0x04

// VRU 타입 코드 (0x01: Pedestrian, 0x02: Bicycle, 0x03: Other)
#define VRU_TYPE          0x01

static BLEAdvertising* pAdvertising = nullptr;

// ── 광고 페이로드 구성 ─────────────────────────────────────────────────────────
static void configureAdvertising() {
    BLEAdvertisementData advData;
    BLEAdvertisementData scanRspData;

    // Flags: LE General Discoverable, BR/EDR Not Supported
    advData.setFlags(ESP_BLE_ADV_FLAG_GEN_DISC | ESP_BLE_ADV_FLAG_BREDR_NOT_SPT);

    // Manufacturer Specific Data:
    //   [COMPANY_ID_LOW][COMPANY_ID_HIGH][VRU_TYPE][TX_POWER]
    std::string mfr;
    mfr += (char)COMPANY_ID_LOW;
    mfr += (char)COMPANY_ID_HIGH;
    mfr += (char)VRU_TYPE;
    mfr += (char)(int8_t)TX_POWER_DBM;  // TX Power 포함 (RSSI 보정용)
    advData.setManufacturerData(mfr);

    // Scan Response: 기기 이름 포함
    scanRspData.setName(DEVICE_NAME);

    pAdvertising->setAdvertisementData(advData);
    pAdvertising->setScanResponseData(scanRspData);
    pAdvertising->setAdvertisementType(ADV_TYPE_NONCONN_IND);  // Non-connectable
    pAdvertising->setMinInterval(ADV_INTERVAL_MS / 0.625);
    pAdvertising->setMaxInterval((ADV_INTERVAL_MS + 10) / 0.625);
}

void setup() {
    Serial.begin(115200);
    Serial.println("[BLE Beacon] Initializing...");

    BLEDevice::init(DEVICE_NAME);
    BLEDevice::setPower(ESP_PWR_LVL_P9);   // 최대 TX 전력

    pAdvertising = BLEDevice::getAdvertising();
    configureAdvertising();
    pAdvertising->start();

    Serial.printf("[BLE Beacon] Advertising as \"%s\" | TX Power: %d dBm\n",
                  DEVICE_NAME, TX_POWER_DBM);
}

void loop() {
    // 광고는 BLE 스택이 자동으로 처리한다.
    // 여기서는 상태만 주기적으로 출력한다.
    delay(5000);
    Serial.println("[BLE Beacon] Still advertising...");
}
