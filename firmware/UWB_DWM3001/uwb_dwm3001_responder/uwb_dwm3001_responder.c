/**
 * UWB DWM3001 — TWR Responder
 *
 * 역할: DWM3001C 모듈을 Responder로 동작시킨다.
 *       Initiator의 Poll을 수신하고 Response를 반환한다.
 *
 * 하드웨어 / 빌드 환경: uwb_dwm3001_initiator.c 참조
 */

#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "dw3000.h"
#include "port.h"
#include "nrf_log.h"

#define UWB_CHANNEL                5
#define POLL_RX_TO_RESP_TX_DLY_US  1000

#define MSG_POLL     0x01
#define MSG_RESPONSE 0x02

static uint8_t rx_buf[24];
static uint8_t tx_buf[16];

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

static void put_ts40(uint8_t* buf, int off, uint64_t ts) {
    for (int i = 0; i < 5; i++) buf[off + i] = (uint8_t)(ts >> (8 * i));
}

void uwb_init(void) {
    port_set_dw_ic_spi_fastrate();
    reset_DWIC();
    Sleep(2);

    dwt_initialise(DWT_DW_IDLE);
    dwt_configure(&dw_config);
    dwt_configuretxrf(&(dwt_txconfig_t){
        .PGdly = 0x34,
        .power = 0xfdfdfdfd,
        .PGcount = 0
    });

    dwt_setrxantennadelay(16436);
    dwt_settxantennadelay(16436);
    dwt_setrxtimeout(0);  // Timeout 없음 — 영구 수신

    NRF_LOG_INFO("[UWB DWM3001 Responder] Ready. Channel=%d", UWB_CHANNEL);
}

void uwb_respond(void) {
    // 수신 시작
    dwt_rxenable(DWT_START_RX_IMMEDIATE);

    // Poll 수신 대기 (블로킹)
    if (dwt_waitforsysstatus(DWT_INT_RXFCG, DWT_INT_ALL_RX_ERR, 0, 0) < 0) {
        dwt_rxreset();
        return;
    }

    dwt_readrxdata(rx_buf, 1, 0);
    if (rx_buf[0] != MSG_POLL) {
        dwt_rxreset();
        return;
    }

    uint64_t poll_rx_ts;
    dwt_readrxtimestamp((uint8_t*)&poll_rx_ts);
    dwt_rxreset();

    // Response TX 예약 시각 계산
    uint64_t resp_tx_ts = (poll_rx_ts & 0xFFFFFFFE00ULL)
                          + (uint64_t)POLL_RX_TO_RESP_TX_DLY_US * 65536ULL;

    memset(tx_buf, 0, sizeof(tx_buf));
    tx_buf[0] = MSG_RESPONSE;
    put_ts40(tx_buf, 1, poll_rx_ts);
    put_ts40(tx_buf, 6, resp_tx_ts);

    dwt_setdelayedtrxtime((uint32_t)(resp_tx_ts >> 8));
    dwt_writetxdata(11, tx_buf, 0);
    dwt_writetxfctrl(11, 0, 1);

    if (dwt_starttx(DWT_START_TX_DELAYED) < 0) {
        NRF_LOG_WARNING("[UWB Responder] TX_LATE");
        return;
    }
    dwt_waitforsysstatus(DWT_INT_TXFRS, 0, 0, 0);

    NRF_LOG_INFO("[UWB Responder] Response sent. pollRxTs=%llu", poll_rx_ts);
}

int main(void) {
    nrf_drv_clock_init();
    nrf_drv_clock_lfclk_request(NULL);

    uwb_init();

    while (1) {
        uwb_respond();
    }
}
