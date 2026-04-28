/**
 * UWB DWM3001 — TWR Initiator (Integrated Module)
 *
 * 역할: Qorvo DWM3001CDK(또는 DWM3001C 모듈)를 사용한 TWR Initiator.
 *       DWM3001은 nRF52833 MCU + DW3110 UWB 트랜시버가 통합된 모듈이다.
 *       이 코드는 모듈의 nRF52833을 타겟으로 하며, SES(Segger Embedded Studio)
 *       또는 Nordic SDK / Zephyr + Qorvo UWB SDK 환경에서 빌드한다.
 *
 *       실험 환경에서는 USB-CDC Serial(USB J-Link via DWM3001CDK)로
 *       측정 결과를 출력한다.
 *
 * 하드웨어:
 *   - Module: Qorvo DWM3001C (DW3110 UWB + nRF52833 BLE)
 *   - Dev Kit: DWM3001CDK (USB 연결만으로 동작)
 *
 * 빌드 환경:
 *   - SDK: nRF5 SDK 17.x + DW3000 SDK (Qorvo)
 *   - IDE: Segger Embedded Studio 또는 VS Code + nRF Connect
 *   - Softdevice: S140 v7 (BLE 동시 사용 시)
 *
 * Serial 출력: timestamp_ms,range_m,status
 *
 * NOTE: 이 파일은 Arduino-style 의사코드(pseudocode)로 작성되어 있습니다.
 *       실제 빌드 시 Qorvo DW3000 C driver API로 교체하세요.
 *       API 레퍼런스: https://www.qorvo.com/products/p/DWM3001C#documents
 */

#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "dw3000.h"          // Qorvo DW3000 driver
#include "port.h"            // HAL: SPI, IRQ, delay
#include "nrf_log.h"

// ── 설정 ──────────────────────────────────────────────────────────────────────
#define UWB_CHANNEL         5       // UWB Channel 5 (6.5 GHz center)
#define POLL_TX_INTERVAL_MS 50      // 측정 주기 (ms)
#define RESP_TIMEOUT_US     5000

// UWB 시간 → 미터 변환
#define UWB_TICK_TO_SEC     (1.0 / (499.2e6 * 128.0))
#define SPEED_OF_LIGHT      299702547.0

// ── 메시지 타입 ───────────────────────────────────────────────────────────────
#define MSG_POLL     0x01
#define MSG_RESPONSE 0x02
#define MSG_FINAL    0x03

static uint8_t tx_buf[16];
static uint8_t rx_buf[24];

// ── DW3000 기본 설정 ──────────────────────────────────────────────────────────
static dwt_config_t dw_config = {
    .chan            = UWB_CHANNEL,
    .txPreambLength  = DWT_PLEN_128,
    .rxPAC           = DWT_PAC8,
    .txCode          = 9,
    .rxCode          = 9,
    .sfdType         = DWT_SFD_DW_8,
    .dataRate        = DWT_BR_6M8,
    .phrMode         = DWT_PHRMODE_STD,
    .phrRate         = DWT_PHRRATE_STD,
    .sfdTO           = (128 + 1 + 8 - 8),
    .stsMode         = DWT_STS_MODE_OFF,
    .stsLength       = DWT_STS_LEN_64,
    .pdoaMode        = DWT_PDOA_M0
};

// ── タイムスタンプ ヘルパ ──────────────────────────────────────────────────────
static uint64_t get_ts40(const uint8_t* buf, int off) {
    uint64_t ts = 0;
    for (int i = 0; i < 5; i++) ts |= ((uint64_t)buf[off + i]) << (8 * i);
    return ts;
}
static void put_ts40(uint8_t* buf, int off, uint64_t ts) {
    for (int i = 0; i < 5; i++) buf[off + i] = (uint8_t)(ts >> (8 * i));
}

// ── 초기화 ────────────────────────────────────────────────────────────────────
void uwb_init(void) {
    port_set_dw_ic_spi_fastrate();
    reset_DWIC();
    Sleep(2);

    if (dwt_initialise(DWT_DW_IDLE) < 0) {
        NRF_LOG_ERROR("[UWB] dwt_initialise failed");
        return;
    }

    if (dwt_configure(&dw_config) < 0) {
        NRF_LOG_ERROR("[UWB] dwt_configure failed");
        return;
    }

    dwt_configuretxrf(&(dwt_txconfig_t){
        .PGdly = 0x34,
        .power = 0xfdfdfdfd,
        .PGcount = 0
    });

    dwt_setrxantennadelay(16436);
    dwt_settxantennadelay(16436);
    dwt_setrxaftertxdelay(60);
    dwt_setrxtimeout(RESP_TIMEOUT_US);

    NRF_LOG_INFO("[UWB DWM3001] Initiator ready. Channel=%d", UWB_CHANNEL);
    printf("timestamp_ms,range_m,status\n");
}

// ── 1回 TWR Ranging ──────────────────────────────────────────────────────────
void uwb_do_ranging(void) {
    uint32_t t_start = get_systick_ms();  // HAL 타이머

    // 1. Poll 전송
    memset(tx_buf, 0, sizeof(tx_buf));
    tx_buf[0] = MSG_POLL;
    dwt_writetxdata(1, tx_buf, 0);
    dwt_writetxfctrl(1, 0, 1);
    dwt_starttx(DWT_START_TX_IMMEDIATE | DWT_RESPONSE_EXPECTED);

    // 2. Response 수신 대기
    if (dwt_waitforsysstatus(DWT_INT_RXFCG, DWT_INT_ALL_RX_ERR | DWT_INT_RXRFTO, 0, 0) < 0) {
        printf("%u,0.000,TIMEOUT\n", get_systick_ms());
        dwt_rxreset();
        return;
    }

    dwt_readrxdata(rx_buf, 10, 0);
    if (rx_buf[0] != MSG_RESPONSE) {
        printf("%u,0.000,BAD_MSG\n", get_systick_ms());
        return;
    }

    uint64_t poll_tx_ts  = dwt_readtxtimestamphi32();  // 32bit 근사 (충분)
    poll_tx_ts           = (poll_tx_ts << 8);          // 40bit 스케일
    uint64_t resp_rx_ts;
    dwt_readrxtimestamp((uint8_t*)&resp_rx_ts);

    uint64_t poll_rx_ts  = get_ts40(rx_buf, 1);
    uint64_t resp_tx_ts  = get_ts40(rx_buf, 6);

    // 3. Final 전송
    uint64_t final_tx_ts = (resp_rx_ts & 0xFFFFFFFE00ULL) + 1000ULL * 65536ULL;
    memset(tx_buf, 0, sizeof(tx_buf));
    tx_buf[0] = MSG_FINAL;
    put_ts40(tx_buf, 1, poll_tx_ts);
    put_ts40(tx_buf, 6, final_tx_ts);

    dwt_setdelayedtrxtime((uint32_t)(final_tx_ts >> 8));
    dwt_writetxdata(11, tx_buf, 0);
    dwt_writetxfctrl(11, 0, 1);
    if (dwt_starttx(DWT_START_TX_DELAYED) < 0) {
        printf("%u,0.000,TX_LATE\n", get_systick_ms());
        return;
    }
    dwt_waitforsysstatus(DWT_INT_TXFRS, 0, 0, 0);

    // 4. 거리 계산
    double Ra  = (double)((int64_t)(resp_rx_ts - poll_tx_ts));
    double Rb  = (double)((int64_t)(resp_tx_ts  - poll_rx_ts));
    double tof = (Ra - Rb) / 4.0 * UWB_TICK_TO_SEC;
    double d   = tof * SPEED_OF_LIGHT;

    if (d < 0.0 || d > 200.0) {
        printf("%u,%.3f,INVALID\n", get_systick_ms(), d);
    } else {
        printf("%u,%.3f,OK\n", get_systick_ms(), d);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────
int main(void) {
    // Nordic SDK 초기화 (logging, clock, etc.)
    nrf_drv_clock_init();
    nrf_drv_clock_lfclk_request(NULL);

    uwb_init();

    while (1) {
        uwb_do_ranging();
        nrf_delay_ms(POLL_TX_INTERVAL_MS);
    }
}
