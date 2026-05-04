/*
 * node_a_sender.ino
 * Cooperative Warning Node A — ESP-NOW Sender
 *
 * Role: Detects VRU via BLE RSSI (candidate trigger), applies risk scoring,
 *       and transmits VRU_COOP_ALERT_V1 JSON messages to Node B via ESP-NOW
 *       when risk_level >= WARN.
 *
 * Hardware: ESP32 DevKit V1 (or equivalent)
 * Arduino Core: ESP32 Arduino Core >= 2.0
 * Libraries: WiFi.h, esp_now.h (both built into ESP32 Arduino Core)
 *
 * Serial output (115200 baud, CSV):
 *   timestamp_ms,node_id,event,msg_id,latency_ms,risk_score,risk_level
 *
 * Setup:
 *   1. Set NODE_ID to match your node label (e.g., "node_A").
 *   2. Set NODE_B_MAC to the MAC address of the receiver ESP32.
 *      You can find Node B's MAC by running this sketch on Node B and
 *      reading the printed MAC at startup.
 *   3. Set WIFI_CHANNEL to match your environment (default 1).
 */

#include <WiFi.h>
#include <esp_now.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>

// ─── Configuration ──────────────────────────────────────────────────────────

#define NODE_ID          "node_A"
#define WIFI_CHANNEL     1

// MAC address of Node B (receiver). Replace with actual MAC.
// Example: {0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF}
static uint8_t NODE_B_MAC[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// BLE candidate trigger thresholds
#define RSSI_CANDIDATE_DBM   (-75)
#define HIT_COUNT_MIN        3
#define HIT_WINDOW_MS        500

// Risk thresholds
#define RISK_THRESHOLD_CONFIRM   0.60f
#define RISK_THRESHOLD_SUPPRESS  0.25f

// Only transmit if risk_level >= WARN (risk_score >= 0.60)
#define TRANSMIT_MIN_RISK_SCORE  0.60f

// BLE scan interval
#define BLE_SCAN_WINDOW_MS  500
#define BLE_SCAN_INTERVAL_MS 100

// Target VRU device name (must match ble_beacon.ino DEVICE_NAME)
#define VRU_DEVICE_NAME  "VRU_BLE_01"

// ─── Cooperative Alert Message ───────────────────────────────────────────────

typedef struct {
    char  msg_type[24];      // "VRU_COOP_ALERT_V1"
    char  sender_id[16];
    uint32_t ts_ms;
    char  track_id[20];
    char  target_class[16];
    float range_m;
    int   rssi_dbm;
    float risk_score;
    char  risk_level[8];     // "NONE","LOW","WARN","ALERT"
    char  scenario[32];
    uint16_t ttl_ms;
    uint32_t msg_id;
} CoopAlertMsg;

// ─── Globals ─────────────────────────────────────────────────────────────────

static uint32_t gMsgId       = 0;
static uint32_t gLastSendTs  = 0;
static bool     gPeerAdded   = false;

// BLE scan state
static BLEScan* pBLEScan     = nullptr;
static int      gHitCount    = 0;
static int      gLastRssi    = -100;
static uint32_t gFirstHitTs  = 0;

// Risk state
typedef enum { STATE_IDLE, STATE_CANDIDATE, STATE_CONFIRMED, STATE_SUPPRESSED } RiskState;
static RiskState gState      = STATE_IDLE;
static float     gRiskScore  = 0.0f;

// CSV log header flag
static bool gHeaderPrinted   = false;

// ─── ESP-NOW Send Callback ───────────────────────────────────────────────────

void onDataSent(const uint8_t* mac, esp_now_send_status_t status) {
    uint32_t now = millis();
    if (!gHeaderPrinted) return;
    // Log ACK/FAIL
    if (status == ESP_NOW_SEND_SUCCESS) {
        Serial.printf("%u,%s,ACK,%u,-1,%.3f,%s\n",
            now, NODE_ID, gMsgId, gRiskScore,
            gRiskScore >= 0.80f ? "ALERT" : gRiskScore >= 0.60f ? "WARN" :
            gRiskScore >= 0.30f ? "LOW" : "NONE");
    } else {
        Serial.printf("%u,%s,SEND_FAIL,%u,-1,%.3f,N/A\n",
            now, NODE_ID, gMsgId, gRiskScore);
    }
}

// ─── Risk Score Computation ──────────────────────────────────────────────────

float computeRiskScore(int rssi_dbm, float range_m, bool validUwb) {
    // BLE score (normalized RSSI, no sidewalk penalty in firmware — handled offline)
    float rssiNorm = (float)(rssi_dbm - (-90)) / (float)((-50) - (-90));
    if (rssiNorm < 0.0f) rssiNorm = 0.0f;
    if (rssiNorm > 1.0f) rssiNorm = 1.0f;
    float bleScore = rssiNorm;

    // UWB score (range normalized; 0 if no valid UWB)
    float uwbScore = 0.0f;
    if (validUwb && range_m >= 0.0f) {
        uwbScore = 1.0f - (range_m / 20.0f);
        if (uwbScore < 0.0f) uwbScore = 0.0f;
        if (uwbScore > 1.0f) uwbScore = 1.0f;
    }

    // road_entry and conflict scores: unknown in firmware, use default 0.4 each
    float roadEntry   = 0.40f;
    float conflictScr = 0.40f;

    return 0.30f * bleScore
         + 0.25f * uwbScore
         + 0.25f * roadEntry
         + 0.20f * conflictScr;
}

const char* riskLevel(float score) {
    if (score >= 0.80f) return "ALERT";
    if (score >= 0.60f) return "WARN";
    if (score >= 0.30f) return "LOW";
    return "NONE";
}

// ─── BLE Advertised Device Callback ─────────────────────────────────────────

class VRUScanCallbacks : public BLEAdvertisedDeviceCallbacks {
    void onResult(BLEAdvertisedDevice advertisedDevice) override {
        std::string name = advertisedDevice.getName();
        if (name != VRU_DEVICE_NAME) return;

        int rssi = advertisedDevice.getRSSI();
        uint32_t now = millis();

        gLastRssi = rssi;

        if (gHitCount == 0) gFirstHitTs = now;

        // Count hits within window
        if (now - gFirstHitTs < HIT_WINDOW_MS) {
            gHitCount++;
        } else {
            gHitCount = 1;
            gFirstHitTs = now;
        }
    }
};

// ─── Setup ───────────────────────────────────────────────────────────────────

void setup() {
    Serial.begin(115200);
    delay(200);

    // Print MAC for pairing reference
    WiFi.mode(WIFI_STA);
    Serial.printf("# Node A MAC: %s\n", WiFi.macAddress().c_str());

    // Init ESP-NOW
    if (esp_now_init() != ESP_OK) {
        Serial.println("# ERROR: esp_now_init failed");
        return;
    }
    esp_now_register_send_cb(onDataSent);

    // Add Node B as peer
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, NODE_B_MAC, 6);
    peerInfo.channel = WIFI_CHANNEL;
    peerInfo.encrypt = false;
    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
        Serial.println("# ERROR: Failed to add peer. Check NODE_B_MAC.");
    } else {
        gPeerAdded = true;
        Serial.println("# Node B peer added.");
    }

    // Init BLE scanner
    BLEDevice::init("NLS_V2X_NodeA");
    pBLEScan = BLEDevice::getScan();
    pBLEScan->setAdvertisedDeviceCallbacks(new VRUScanCallbacks());
    pBLEScan->setActiveScan(false);
    pBLEScan->setInterval(BLE_SCAN_INTERVAL_MS);
    pBLEScan->setWindow(BLE_SCAN_WINDOW_MS);

    // CSV header
    Serial.println("timestamp_ms,node_id,event,msg_id,latency_ms,risk_score,risk_level");
    gHeaderPrinted = true;
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

void loop() {
    // Non-blocking BLE scan for 500 ms
    BLEScanResults results = pBLEScan->start(1, false);
    pBLEScan->clearResults();

    uint32_t now = millis();

    // Check candidate trigger
    bool triggered = (gLastRssi >= RSSI_CANDIDATE_DBM) && (gHitCount >= HIT_COUNT_MIN);

    if (gState == STATE_IDLE && triggered) {
        gState     = STATE_CANDIDATE;
        gRiskScore = computeRiskScore(gLastRssi, -1.0f, false);
        Serial.printf("%u,%s,CANDIDATE,%u,-1,%.3f,%s\n",
            now, NODE_ID, gMsgId, gRiskScore, riskLevel(gRiskScore));
    }

    if (gState == STATE_CANDIDATE) {
        gRiskScore = computeRiskScore(gLastRssi, -1.0f, false);
        if (gRiskScore >= RISK_THRESHOLD_CONFIRM) {
            gState = STATE_CONFIRMED;
            Serial.printf("%u,%s,CONFIRMED,%u,-1,%.3f,%s\n",
                now, NODE_ID, gMsgId, gRiskScore, riskLevel(gRiskScore));
        } else if (!triggered) {
            gState = STATE_IDLE;
            gHitCount = 0;
        }
    }

    if (gState == STATE_CONFIRMED && gPeerAdded) {
        // Transmit alert if risk is sufficient
        if (gRiskScore >= TRANSMIT_MIN_RISK_SCORE) {
            gMsgId++;
            CoopAlertMsg msg = {};
            strncpy(msg.msg_type,    "VRU_COOP_ALERT_V1",  sizeof(msg.msg_type) - 1);
            strncpy(msg.sender_id,   NODE_ID,              sizeof(msg.sender_id) - 1);
            msg.ts_ms    = now;
            snprintf(msg.track_id, sizeof(msg.track_id), "vru_temp_%02u", (unsigned)(gMsgId % 100));
            strncpy(msg.target_class, "pedestrian",        sizeof(msg.target_class) - 1);
            msg.range_m    = -1.0f;
            msg.rssi_dbm   = gLastRssi;
            msg.risk_score = gRiskScore;
            strncpy(msg.risk_level, riskLevel(gRiskScore), sizeof(msg.risk_level) - 1);
            strncpy(msg.scenario,   "UNKNOWN",             sizeof(msg.scenario) - 1);
            msg.ttl_ms     = 300;
            msg.msg_id     = gMsgId;

            esp_err_t result = esp_now_send(NODE_B_MAC, (uint8_t*)&msg, sizeof(msg));
            gLastSendTs = now;

            if (result == ESP_OK) {
                Serial.printf("%u,%s,SENT,%u,-1,%.3f,%s\n",
                    now, NODE_ID, gMsgId, gRiskScore, riskLevel(gRiskScore));
            } else {
                Serial.printf("%u,%s,SEND_ERR,%u,-1,%.3f,%s\n",
                    now, NODE_ID, gMsgId, gRiskScore, riskLevel(gRiskScore));
            }
        }

        // Return to idle after sending (one-shot per confirmation event)
        gState    = STATE_IDLE;
        gHitCount = 0;
    }

    delay(10);
}
