/*
 * node_b_receiver.ino
 * Cooperative Warning Node B — ESP-NOW Receiver
 *
 * Role: Receives VRU_COOP_ALERT_V1 messages from Node A. Logs received
 *       messages with arrival timestamp. Drives LED/buzzer warning output
 *       based on risk_level. Measures message age against TTL and discards
 *       stale messages.
 *
 * Hardware: ESP32 DevKit V1 (or equivalent)
 *   - LED:    Connect between WARNING_LED_PIN and GND via 220 Ω resistor
 *   - Buzzer: Active buzzer between BUZZER_PIN and GND (NPN transistor recommended)
 *
 * Serial output (115200 baud, CSV):
 *   timestamp_ms,node_id,event,msg_id,latency_ms,risk_score,risk_level
 *
 * Setup:
 *   1. Set NODE_ID to "node_B".
 *   2. Run this sketch on the receiver ESP32 first to read its MAC address
 *      from Serial output. Set that MAC in node_a_sender.ino as NODE_B_MAC.
 *   3. Set WIFI_CHANNEL to the same value as in node_a_sender.ino.
 */

#include <WiFi.h>
#include <esp_now.h>

// ─── Configuration ──────────────────────────────────────────────────────────

#define NODE_ID        "node_B"
#define WIFI_CHANNEL   1

#define WARNING_LED_PIN   2     // Built-in LED on most ESP32 boards
#define BUZZER_PIN        4     // Optional active buzzer

// Blink timing
#define BLINK_INTERVAL_WARN_MS   500   // 2 Hz blink for WARN
#define BLINK_INTERVAL_ALERT_MS  100   // 10 Hz blink for ALERT

// ─── Cooperative Alert Message (must match node_a_sender.ino) ───────────────

typedef struct {
    char     msg_type[24];
    char     sender_id[16];
    uint32_t ts_ms;
    char     track_id[20];
    char     target_class[16];
    float    range_m;
    int      rssi_dbm;
    float    risk_score;
    char     risk_level[8];
    char     scenario[32];
    uint16_t ttl_ms;
    uint32_t msg_id;
} CoopAlertMsg;

// ─── Globals ─────────────────────────────────────────────────────────────────

static volatile bool     gMsgAvailable  = false;
static volatile CoopAlertMsg gLatestMsg = {};
static volatile uint32_t gRxTimestamp   = 0;

static uint32_t gLastBlinkToggle = 0;
static bool     gLedState        = false;
static char     gCurrentLevel[8] = "NONE";

static bool gHeaderPrinted = false;

// ─── ESP-NOW Receive Callback ────────────────────────────────────────────────

void onDataReceived(const uint8_t* mac, const uint8_t* data, int len) {
    if (len != sizeof(CoopAlertMsg)) return;

    memcpy((void*)&gLatestMsg, data, sizeof(CoopAlertMsg));
    gRxTimestamp  = millis();
    gMsgAvailable = true;
}

// ─── LED / Buzzer Control ────────────────────────────────────────────────────

void updateWarningOutput() {
    uint32_t now = millis();

    if (strcmp(gCurrentLevel, "ALERT") == 0) {
        // Solid LED + buzzer
        digitalWrite(WARNING_LED_PIN, HIGH);
        digitalWrite(BUZZER_PIN, HIGH);
        return;
    }

    if (strcmp(gCurrentLevel, "WARN") == 0) {
        // 2 Hz blink, no buzzer
        digitalWrite(BUZZER_PIN, LOW);
        if (now - gLastBlinkToggle >= BLINK_INTERVAL_WARN_MS) {
            gLedState = !gLedState;
            digitalWrite(WARNING_LED_PIN, gLedState ? HIGH : LOW);
            gLastBlinkToggle = now;
        }
        return;
    }

    // LOW or NONE: all off
    digitalWrite(WARNING_LED_PIN, LOW);
    digitalWrite(BUZZER_PIN, LOW);
    gLedState = false;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

void setup() {
    Serial.begin(115200);
    delay(200);

    pinMode(WARNING_LED_PIN, OUTPUT);
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(WARNING_LED_PIN, LOW);
    digitalWrite(BUZZER_PIN, LOW);

    // Print MAC for pairing reference
    WiFi.mode(WIFI_STA);
    Serial.printf("# Node B MAC: %s\n", WiFi.macAddress().c_str());
    Serial.printf("# Set this MAC as NODE_B_MAC in node_a_sender.ino\n");

    // Init ESP-NOW
    if (esp_now_init() != ESP_OK) {
        Serial.println("# ERROR: esp_now_init failed");
        return;
    }
    esp_now_register_recv_cb(onDataReceived);

    // CSV header
    Serial.println("timestamp_ms,node_id,event,msg_id,latency_ms,risk_score,risk_level");
    gHeaderPrinted = true;
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

void loop() {
    if (gMsgAvailable) {
        gMsgAvailable = false;

        // Local copy to avoid volatile access in computations
        CoopAlertMsg msg;
        uint32_t rxTs;
        noInterrupts();
        memcpy(&msg, (const void*)&gLatestMsg, sizeof(msg));
        rxTs = gRxTimestamp;
        interrupts();

        uint32_t now = millis();

        // Check TTL: discard stale messages
        uint32_t age_ms = now - rxTs;
        if (age_ms > msg.ttl_ms) {
            Serial.printf("%u,%s,STALE_DROPPED,%u,%u,%.3f,%s\n",
                now, NODE_ID, msg.msg_id, age_ms, msg.risk_score, msg.risk_level);
            return;
        }

        // Compute one-way latency estimate (note: clocks NOT synchronized)
        // This is the age at processing time, not true network latency.
        int latency_ms = (int)age_ms;

        // Log received message
        Serial.printf("%u,%s,RECEIVED,%u,%d,%.3f,%s\n",
            now, NODE_ID, msg.msg_id, latency_ms, msg.risk_score, msg.risk_level);

        // Update warning state
        strncpy(gCurrentLevel, msg.risk_level, sizeof(gCurrentLevel) - 1);
    }

    updateWarningOutput();
    delay(10);
}
