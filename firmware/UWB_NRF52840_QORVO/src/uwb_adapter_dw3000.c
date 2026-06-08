/*
 * uwb_adapter_dw3000.c  –  Zephyr DS-TWR driver for DWM3000EVB (DW3000 chip)
 *
 * Implements the uwb_adapter.h interface using the exact same 4-frame
 * Double-Sided Two-Way Ranging protocol used in firmware/UWB_DWM3000/:
 *   Stage 1: Poll  (Initiator → Responder)
 *   Stage 2: Response (Responder → Initiator)
 *   Stage 3: Final  (Initiator → Responder)
 *   Stage 4: RTinfo  (Responder → Initiator, carries tRoundB + tReplyB)
 *
 * References:
 *   lib/DW3000Arduino/src/DW3000.cpp  – SPI framing + DS-TWR algorithm
 *   lib/DW3000Arduino/src/DW3000Constants.h – register addresses
 *   firmware/UWB_DWM3000/uwb_initiator/ – Arduino initiator sketch
 *   firmware/UWB_DWM3000/uwb_responder/ – Arduino responder sketch
 *
 * Hardware (nRF52840 DK + DWM3000EVB shield, Arduino header):
 *   SPI3  SCK  = P1.15 (D13)
 *   SPI3  MOSI = P1.13 (D11)
 *   SPI3  MISO = P1.14 (D12)
 *   CS         = P1.12 (D10)
 *   IRQ        = P1.11 (D9)
 *   RST        = P1.10 (D8)
 */

#include "uwb_adapter.h"

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/drivers/gpio.h>
#include <math.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(uwb_dw3000, LOG_LEVEL_INF);

/* -----------------------------------------------------------------------
 * Devicetree node references
 * ----------------------------------------------------------------------- */
#define DW3000_NODE  DT_NODELABEL(dw3000)

static const struct spi_dt_spec g_spi = SPI_DT_SPEC_GET(
    DW3000_NODE,
    SPI_OP_MODE_MASTER | SPI_WORD_SET(8) | SPI_TRANSFER_MSB,
    0);

static const struct gpio_dt_spec g_irq = GPIO_DT_SPEC_GET(DW3000_NODE, int_gpios);
static const struct gpio_dt_spec g_rst = GPIO_DT_SPEC_GET(DW3000_NODE, reset_gpios);
static const struct gpio_dt_spec g_wak = GPIO_DT_SPEC_GET_OR(DW3000_NODE, wakeup_gpios, {0});

/* -----------------------------------------------------------------------
 * DW3000 register base addresses  (from DW3000Constants.h)
 * ----------------------------------------------------------------------- */
#define REG_GEN_CFG_LOW   0x00
#define REG_GEN_CFG_HIGH  0x01
#define REG_DRX           0x06
#define REG_CIA1          0x0C
#define REG_RX_BUF0       0x12
#define REG_TX_BUF        0x14
#define REG_PMSC          0x11
#define REG_RF_CONF       0x07
#define REG_RF_CAL        0x08
#define REG_FS_CTRL       0x09
#define REG_AON           0x0A
#define REG_OTP_IF        0x0B
#define REG_RX_TUNE       0x03
#define REG_EXT_SYNC      0x04
#define REG_STS_CFG       0x02

/* Sub-register offsets */
#define SUB_SYS_STATUS    0x44   /* in REG_GEN_CFG_LOW */
#define SUB_TX_FCTRL      0x24   /* in REG_GEN_CFG_LOW – frame control/length */
#define SUB_TX_TS         0x74   /* in REG_GEN_CFG_LOW – TX timestamp (5 B) */
#define SUB_RX_TS         0x00   /* in REG_CIA1        – RX timestamp (5 B) */
#define SUB_CLK_OFFSET    0x29   /* in REG_DRX         – 21-bit signed */
#define SUB_ANT_DELAY     0x04   /* in REG_GEN_CFG_HIGH */
#define SUB_CHAN_CTRL     0x14   /* in REG_GEN_CFG_HIGH */

/* SYS_STATUS flag bits */
#define TXFRS_BIT         BIT(7)        /* frame sent */
#define RXFCG_BIT         BIT(13)       /* RX CRC good */
#define RXERR_MASK        0x04279000UL  /* any RX error */

/* Additional register file IDs not already defined */
#define REG_DIG_DIAG      0x0F
#define REG_CIA3          0x0E

/* DW3000 fast-command opcodes */
#define CMD_TX_W4R        0x0CU   /* TX then auto-enter RX */
#define CMD_RX_ENABLE     0x02U   /* enable receiver */
#define CMD_CLR_STATUS    0x00U   /* soft-reset status via writeSysConfig */

/* DS-TWR frame layout in TX/RX buffers */
#define FRAME_OFFSET_MODE  0x00
#define FRAME_OFFSET_SRC   0x01
#define FRAME_OFFSET_DST   0x02
#define FRAME_OFFSET_STAGE 0x03
#define FRAME_OFFSET_DATA  0x04

#define DS_TWR_MODE        1

/* Clock/distance constants (from DW3000Constants.h) */
#define CLOCK_OFFSET_CH5   (-0.5731e-3f)  /* ppm-ish correction for CH5 */
#define DW3000_TICK_S      (15.6500400641025641e-12)  /* seconds per tick */
#define SPEED_OF_LIGHT     (299702547.0)              /* m/s in air */

/* Antenna delay applied to both TX and RX paths */
#define ANTENNA_DELAY      0x3FCA

/* Timeouts — ROBUST profile uses longer RX window for obstructed environments */
#define TX_TIMEOUT_US      5000    /* 5 ms for TX done */
#if defined(CONFIG_VLOS_UWB_PROFILE_ROBUST) && (CONFIG_VLOS_UWB_PROFILE_ROBUST == 1)
#define RX_TIMEOUT_US      60000   /* 60 ms — ROBUST profile */
#else
#define RX_TIMEOUT_US      30000   /* 30 ms — FAST profile */
#endif
#define POLL_SLEEP_US      50

/* -----------------------------------------------------------------------
 * Role flag set by uwb_adapter_init()
 * ----------------------------------------------------------------------- */
static bool g_is_initiator;

/* -----------------------------------------------------------------------
 * Diagnostic callback infrastructure
 * ----------------------------------------------------------------------- */
static uwb_diag_cb_t g_diag_cb;
static uint32_t      g_diag_seq;  /* monotonically incremented per initiator step */
static uint8_t       g_rx_seq;    /* seq byte echoed from received Poll frame */

void uwb_adapter_set_diag_cb(uwb_diag_cb_t cb)
{
    g_diag_cb = cb;
}

static inline void fire_cb(enum uwb_diag_event evt, float range_m,
                           uint32_t elapsed_ms)
{
    if (!g_diag_cb) {
        return;
    }
    struct uwb_diag_extra ex = {
        .seq_id     = g_is_initiator ? g_diag_seq : (uint32_t)g_rx_seq,
        .range_m    = range_m,
        .elapsed_ms = elapsed_ms,
    };
    g_diag_cb(evt, &ex);
}

/* -----------------------------------------------------------------------
 * Low-level SPI helpers
 * ----------------------------------------------------------------------- */

/* Build DW3000 SPI header.  Returns header length (1 or 2 bytes).
 *
 * The DW3000 encodes a 7-bit sub-address across the two header bytes:
 *   byte 0 bit 6 = EAM flag
 *   byte 0 bit 0 = sub[6]       ← sub bit-6 overflows into byte 0 LSB
 *   byte 1 bits 7:2 = sub[5:0]  ← lower 6 bits of sub, shifted left 2
 *
 * This mirrors the Arduino library which builds a 16-bit header word as:
 *   header  = (base << 1) | 0x40          (+ 0x80 for write)
 *   header  = header << 8
 *   header |= sub << 2                    (sub bit6 overflows into byte0 bit0)
 *   byte0 = header >> 8,  byte1 = header & 0xFF
 */
static int build_header(uint8_t base, uint16_t sub, bool write,
                        uint8_t *hdr)
{
    if (sub == 0) {
        hdr[0] = (write ? 0x80U : 0x00U) | ((base & 0x1FU) << 1);
        return 1;
    }
    /* EAM mode: sub[6] overflows into byte 0 bit 0 */
    hdr[0] = (write ? 0x80U : 0x00U) | ((base & 0x1FU) << 1) | 0x40U
             | ((sub >> 6) & 0x01U);
    hdr[1] = (uint8_t)(sub << 2);   /* sub[5:0] in bits 7:2; bits 1:0 = mode=0 */
    return 2;
}

/* Transmit a fast command (1-byte opcode). */
static void fast_cmd(uint8_t cmd)
{
    uint8_t b = 0x80U | ((cmd & 0x1FU) << 1) | 0x01U;
    uint8_t dummy = 0;
    struct spi_buf txb = {&b, 1};
    struct spi_buf rxb = {&dummy, 1};
    struct spi_buf_set tx_set = {&txb, 1};
    struct spi_buf_set rx_set = {&rxb, 1};
    spi_transceive_dt(&g_spi, &tx_set, &rx_set);
}

/* Write n bytes from src to register base:sub. */
static void dw_write(uint8_t base, uint16_t sub,
                     const uint8_t *src, uint16_t n)
{
    uint8_t buf[2 + n];
    int hlen = build_header(base, sub, true, buf);
    memcpy(&buf[hlen], src, n);

    struct spi_buf txb = {buf, hlen + n};
    struct spi_buf_set tx_set = {&txb, 1};
    struct spi_buf_set rx_set = {NULL, 0};
    spi_transceive_dt(&g_spi, &tx_set, &rx_set);
}

/* Read n bytes from register base:sub into dst. */
static void dw_read(uint8_t base, uint16_t sub,
                    uint8_t *dst, uint16_t n)
{
    uint8_t tx[2 + n];
    uint8_t rx[2 + n];
    memset(tx, 0, sizeof(tx));
    int hlen = build_header(base, sub, false, tx);

    struct spi_buf txb = {tx, hlen + n};
    struct spi_buf rxb = {rx, hlen + n};
    struct spi_buf_set tx_set = {&txb, 1};
    struct spi_buf_set rx_set = {&rxb, 1};
    spi_transceive_dt(&g_spi, &tx_set, &rx_set);
    memcpy(dst, &rx[hlen], n);
}

/* Convenience wrappers for single-byte and 32-bit values */
static void dw_write8(uint8_t base, uint16_t sub, uint8_t val)
{
    dw_write(base, sub, &val, 1);
}

static uint8_t dw_read8(uint8_t base, uint16_t sub)
{
    uint8_t v;
    dw_read(base, sub, &v, 1);
    return v;
}

static void dw_write32(uint8_t base, uint16_t sub, uint32_t val)
{
    uint8_t buf[4] = {
        (uint8_t)(val),
        (uint8_t)(val >> 8),
        (uint8_t)(val >> 16),
        (uint8_t)(val >> 24),
    };
    dw_write(base, sub, buf, 4);
}

static uint32_t dw_read32(uint8_t base, uint16_t sub)
{
    uint8_t buf[4];
    dw_read(base, sub, buf, 4);
    return (uint32_t)buf[0]
         | ((uint32_t)buf[1] << 8)
         | ((uint32_t)buf[2] << 16)
         | ((uint32_t)buf[3] << 24);
}

/* -----------------------------------------------------------------------
 * Timestamp and status helpers
 * ----------------------------------------------------------------------- */

/* Read 40-bit TX timestamp from TX_TS register */
static uint64_t read_tx_ts(void)
{
    uint8_t b[5];
    dw_read(REG_GEN_CFG_LOW, SUB_TX_TS, b, 5);
    return (uint64_t)b[0]
         | ((uint64_t)b[1] << 8)
         | ((uint64_t)b[2] << 16)
         | ((uint64_t)b[3] << 24)
         | ((uint64_t)b[4] << 32);
}

/* Read 40-bit RX timestamp from CIA1 */
static uint64_t read_rx_ts(void)
{
    uint8_t b[5];
    dw_read(REG_CIA1, SUB_RX_TS, b, 5);
    return (uint64_t)b[0]
         | ((uint64_t)b[1] << 8)
         | ((uint64_t)b[2] << 16)
         | ((uint64_t)b[3] << 24)
         | ((uint64_t)b[4] << 32);
}

/* Read raw 21-bit signed clock offset (DRX register) */
static int32_t read_raw_clock_offset(void)
{
    uint32_t raw = dw_read32(REG_DRX, SUB_CLK_OFFSET) & 0x1FFFFFUL;
    /* Sign-extend from 21-bit */
    if (raw & BIT(20)) {
        raw |= ~0x1FFFFFUL;
    }
    return (int32_t)raw;
}

/* Read 32-bit SYS_STATUS */
static uint32_t read_status(void)
{
    return dw_read32(REG_GEN_CFG_LOW, SUB_SYS_STATUS);
}

static void clear_status(void)
{
    /* Writing 1s clears the corresponding bits */
    dw_write32(REG_GEN_CFG_LOW, SUB_SYS_STATUS, 0xFFFFFFFFUL);
}

/* Poll for TXFRS with timeout_us. Returns 0 on success, -ETIMEDOUT. */
static int wait_tx_done(void)
{
    for (int i = 0; i < TX_TIMEOUT_US / POLL_SLEEP_US; i++) {
        uint32_t st = read_status();
        if (st & TXFRS_BIT) {
            return 0;
        }
        k_usleep(POLL_SLEEP_US);
    }
    return -ETIMEDOUT;
}

/* Poll for RXFCG or RXERR. Returns 1 = good frame, -ETIMEDOUT, -EIO. */
static int wait_rx_frame(void)
{
    for (int i = 0; i < RX_TIMEOUT_US / POLL_SLEEP_US; i++) {
        uint32_t st = read_status();
        if (st & RXFCG_BIT) {
            return 1;
        }
        if (st & RXERR_MASK) {
            return -EIO;
        }
        k_usleep(POLL_SLEEP_US);
    }
    LOG_WRN("RX timeout");
    return -ETIMEDOUT;
}

/* Set TX frame length (payload bytes, FCS added by HW).
 * TX_FCTRL sub-register: bits 9:0 = TXFLEN (includes 2-byte FCS) */
static void set_frame_length(uint8_t payload_len)
{
    uint32_t fctrl = dw_read32(REG_GEN_CFG_LOW, SUB_TX_FCTRL);
    fctrl = (fctrl & ~0x3FFUL) | ((uint32_t)(payload_len + 2) & 0x3FFUL);
    dw_write32(REG_GEN_CFG_LOW, SUB_TX_FCTRL, fctrl);
}

/* Transmit (TX_W4R = TX then immediately enable RX) */
static void do_tx_w4r(void)
{
    fast_cmd(CMD_TX_W4R);
}

/* Enable RX only */
static void do_rx_enable(void)
{
    fast_cmd(CMD_RX_ENABLE);
}

/* -----------------------------------------------------------------------
 * DS-TWR frame builders
 * ----------------------------------------------------------------------- */

/* Write a standard 4-byte DS-TWR frame into TX buffer.
 * seq is placed in the SRC byte (offset 0x01) for dashboard correlation. */
static void write_std_frame(uint8_t stage, uint8_t seq)
{
    dw_write8(REG_TX_BUF, FRAME_OFFSET_MODE,  DS_TWR_MODE);
    dw_write8(REG_TX_BUF, FRAME_OFFSET_SRC,   seq);
    dw_write8(REG_TX_BUF, FRAME_OFFSET_DST,   0x00);
    dw_write8(REG_TX_BUF, FRAME_OFFSET_STAGE, stage);
    set_frame_length(4);
}

/* Write the RTinfo frame (12 bytes) with tRoundB and tReplyB */
static void write_rtinfo_frame(int32_t t_round_b, int32_t t_reply_b)
{
    dw_write8(REG_TX_BUF, FRAME_OFFSET_MODE,  DS_TWR_MODE);
    dw_write8(REG_TX_BUF, FRAME_OFFSET_SRC,   0x00);
    dw_write8(REG_TX_BUF, FRAME_OFFSET_DST,   0x00);
    dw_write8(REG_TX_BUF, FRAME_OFFSET_STAGE, 4);
    dw_write32(REG_TX_BUF, FRAME_OFFSET_DATA,     (uint32_t)t_round_b);
    dw_write32(REG_TX_BUF, FRAME_OFFSET_DATA + 4, (uint32_t)t_reply_b);
    set_frame_length(12);
}

/* Read stage byte from RX buffer */
static uint8_t get_rx_stage(void)
{
    return dw_read8(REG_RX_BUF0, FRAME_OFFSET_STAGE) & 0x07U;
}

/* Read seq byte from RX buffer SRC field (seq propagation) */
static uint8_t get_rx_seq(void)
{
    return dw_read8(REG_RX_BUF0, FRAME_OFFSET_SRC);
}

/* -----------------------------------------------------------------------
 * DS-TWR range computation  (mirrors ds_processRTInfo in DW3000.cpp)
 * ----------------------------------------------------------------------- */
static float compute_range_m(int32_t t_round_a, int32_t t_reply_a,
                              int32_t t_round_b, int32_t t_reply_b,
                              int32_t raw_clk_off)
{
    int64_t reply_diff = (int64_t)t_reply_a - t_reply_b;
    double co = (double)raw_clk_off * CLOCK_OFFSET_CH5 / 1000000.0;
    double clock_factor = (t_reply_a > t_reply_b) ? (1.0 + co) : (1.0 - co);
    int64_t first_rt  = (int64_t)t_round_a - t_reply_b;
    int64_t second_rt = (int64_t)t_round_b - t_reply_a;
    double combined   = ((double)first_rt + (double)second_rt
                        - ((double)reply_diff - (double)reply_diff * clock_factor))
                       / 2.0;
    double t_prop = combined / 2.0;
    return (float)(t_prop * DW3000_TICK_S * SPEED_OF_LIGHT);
}

/* -----------------------------------------------------------------------
 * OTP read helper  (mirrors DW3000Class::readOTP)
 * ----------------------------------------------------------------------- */
static uint32_t otp_read(uint8_t addr)
{
    dw_write8(REG_OTP_IF, 0x04, addr);
    dw_write8(REG_OTP_IF, 0x08, 0x02);
    return dw_read32(REG_OTP_IF, 0x10);
}

/* Check if chip is in IDLE state (mirrors checkForIDLE) */
static bool check_idle(void)
{
    /* Method 1: PMSC state == 0x3 in DIG_DIAG:0x30 */
    uint32_t pmsc = dw_read32(REG_DIG_DIAG, 0x30);
    if (((pmsc >> 16) & 0x3U) == 0x3U) {
        return true;
    }
    /* Method 2: SPIRDY | RCINIT set in SYS_STATUS:0x44 */
    uint32_t status = dw_read32(REG_GEN_CFG_LOW, SUB_SYS_STATUS);
    if (((status >> 16) & 0x180U) == 0x180U) {
        return true;
    }
    return false;
}

/* Soft reset sequence  (mirrors DW3000Class::softReset + clearAONConfig) */
static void soft_reset(void)
{
    /* clearAONConfig */
    uint8_t z2[2] = {0x00, 0x00};
    dw_write(REG_AON, 0x00, z2, 2);
    dw_write8(REG_AON, 0x14, 0x00);
    dw_write8(REG_AON, 0x04, 0x00);
    dw_write8(REG_AON, 0x04, 0x02);
    k_msleep(1);

    /* Force clock to FAST_RC/4 */
    dw_write8(REG_PMSC, 0x04, 0x01);

    /* init reset: 2 bytes of 0x00 to PMSC:0x00 */
    dw_write(REG_PMSC, 0x00, z2, 2);
    k_msleep(100);

    /* Return to normal: 0xFFFF to PMSC:0x00 */
    uint8_t ff2[2] = {0xFF, 0xFF};
    dw_write(REG_PMSC, 0x00, ff2, 2);

    /* Clock back to Auto mode */
    dw_write8(REG_PMSC, 0x04, 0x00);
}

/* -----------------------------------------------------------------------
 * DW3000 hardware initialisation
 * Closely mirrors DW3000Class::init() + writeSysConfig() from DW3000.cpp
 * ----------------------------------------------------------------------- */
static int dw3000_hw_init(void)
{
    /* Drive WAKEUP HIGH — forces DW3000 out of DEEPSLEEP */
    if (g_wak.port != NULL) {
        gpio_pin_configure_dt(&g_wak, GPIO_OUTPUT_ACTIVE);
        k_msleep(2);
        LOG_INF("DW3000: WAKEUP driven HIGH");
    } else {
        LOG_WRN("DW3000: no wakeup-gpios in DT");
    }

    /* --- Raw SPI sanity check (before reset) --- */
    {
        uint8_t tx[5] = {0x00, 0x00, 0x00, 0x00, 0x00};
        uint8_t rx[5] = {0};
        struct spi_buf     txb = {tx, 5};
        struct spi_buf     rxb = {rx, 5};
        struct spi_buf_set txs = {&txb, 1};
        struct spi_buf_set rxs = {&rxb, 1};
        int r = spi_transceive_dt(&g_spi, &txs, &rxs);
        LOG_INF("SPI pre-rst: ret=%d [%02x %02x %02x %02x %02x]",
                r, rx[0], rx[1], rx[2], rx[3], rx[4]);
    }

    /* WAKEUP via SPI CS: hold CS low for 1 ms.
     * DW3000 exits DEEPSLEEP on CS assertion >= 500 µs.
     * We use the SPI CS GPIO from the SPI spec directly.
     */
    {
        const struct gpio_dt_spec *cs = &g_spi.config.cs.gpio;
        if (cs->port != NULL) {
            gpio_pin_configure_dt(cs, GPIO_OUTPUT_ACTIVE);  /* CS low */
            k_msleep(1);
            gpio_pin_configure_dt(cs, GPIO_OUTPUT_INACTIVE); /* CS high */
            k_msleep(5);
            LOG_INF("DW3000: CS wakeup pulse sent");
        } else {
            LOG_WRN("DW3000: CS GPIO not found in SPI spec");
        }
    }

    /* Hard-reset: drive RST low 10 ms, then release as INPUT (matches Arduino
     * library behaviour – DWM3000EVB has external pull-up on RST).
     */
    gpio_pin_configure_dt(&g_rst, GPIO_OUTPUT_ACTIVE);
    k_msleep(10);
    gpio_pin_configure_dt(&g_rst, GPIO_INPUT);   /* float – external pull-up releases DW3000 */
    k_msleep(300);   /* 300 ms: DW3000 needs up to ~250 ms after hard reset */

    /* --- Raw SPI sanity check (after reset, before IDLE loop) --- */
    {
        uint8_t tx[5] = {0x00, 0x00, 0x00, 0x00, 0x00};
        uint8_t rx[5] = {0};
        struct spi_buf     txb = {tx, 5};
        struct spi_buf     rxb = {rx, 5};
        struct spi_buf_set txs = {&txb, 1};
        struct spi_buf_set rxs = {&rxb, 1};
        int r = spi_transceive_dt(&g_spi, &txs, &rxs);
        LOG_INF("SPI post-rst: ret=%d [%02x %02x %02x %02x %02x]",
                r, rx[0], rx[1], rx[2], rx[3], rx[4]);
    }

    /* -- Wait for IDLE (stage 1) -- */
    bool idle = false;
    for (int i = 0; i < 50; i++) {
        if (check_idle()) { idle = true; break; }
        k_msleep(10);
    }
    if (!idle) {
        LOG_WRN("DW3000: IDLE not reached (stage 1)");
    }

    /* Enable access bit in GEN_CFG_AES_LOW:0x10 bit 4 */
    uint32_t cfg_tmp = dw_read32(REG_GEN_CFG_LOW, 0x10);
    dw_write32(REG_GEN_CFG_LOW, 0x10, cfg_tmp | BIT(4));

    /* Soft reset */
    soft_reset();
    k_msleep(200);

    /* -- Wait for IDLE (stage 2) -- */
    idle = false;
    for (int i = 0; i < 50; i++) {
        if (check_idle()) { idle = true; break; }
        k_msleep(10);
    }
    if (!idle) {
        LOG_WRN("DW3000: IDLE not reached (stage 2)");
    }

    /* Verify device ID: expect 0xDECA03xx */
    uint32_t dev_id = dw_read32(REG_GEN_CFG_LOW, 0x00);
    if ((dev_id & 0xFFFF0000UL) != 0xDECA0000UL) {
        LOG_ERR("DW3000 device ID mismatch: 0x%08X", dev_id);
        return -ENODEV;
    }
    LOG_INF("DW3000 device ID: 0x%08X", dev_id);

    /* -- Read OTP calibration values -- */
    uint32_t ldo_low   = otp_read(0x04);
    uint32_t ldo_high  = otp_read(0x05);
    uint32_t bias_tune = otp_read(0x0A);
    bias_tune = (bias_tune >> 16) & 0x1FU;
    if (ldo_low != 0 && ldo_high != 0 && bias_tune != 0) {
        dw_write32(REG_PMSC, 0x1F, bias_tune);
        dw_write32(REG_OTP_IF, 0x08, 0x0100UL);
    }

    uint32_t xtrim = otp_read(0x1E);
    xtrim = (xtrim == 0) ? 0x2EUL : xtrim;
    dw_write8(REG_FS_CTRL, 0x14, (uint8_t)xtrim);

    /* =========================================================
     * writeSysConfig() equivalent
     * ========================================================= */

    /* SYS_CFG: standard config 0x0188 (PHR_MODE_STANDARD, PHR_RATE_850KB) */
    dw_write32(REG_GEN_CFG_LOW, 0x10, 0x00000188UL);

    /* OTP_CFG: preamble 128 (< 256) → 0x1400 */
    dw_write32(REG_OTP_IF, 0x08, 0x00001400UL);

    /* DRX DTUNE0: reset + set PAC8 = 0x00 */
    dw_write8(REG_DRX, 0x00, 0x00);

    /* STS_CFG: STS length = 64/8-1 = 7 */
    dw_write8(REG_STS_CFG, 0x00, 7);

    /* CLK_OFFSET: reset in GEN_CFG_AES_LOW:0x29 */
    dw_write8(REG_GEN_CFG_LOW, 0x29, 0x00);

    /* DRX DTUNE config */
    dw_write32(REG_DRX, 0x0C, 0xAF5F584CUL);

    /* CHAN_CTRL: channel 5, preamble code 9 (TX+RX), PRF bit */
    uint32_t chan_ctrl = dw_read32(REG_GEN_CFG_HIGH, SUB_CHAN_CTRL);
    chan_ctrl &= ~0x00001FFFUL;
    chan_ctrl |= 0x00000000UL;               /* CHANNEL_5 = 0 */
    chan_ctrl |= (9UL << 8) & 0x1F00UL;      /* TX preamble code 9 */
    chan_ctrl |= (9UL << 3) & 0x00F8UL;      /* RX preamble code 9 */
    chan_ctrl |= (1UL << 1) & 0x0006UL;      /* PRF 64 MHz */
    dw_write32(REG_GEN_CFG_HIGH, SUB_CHAN_CTRL, chan_ctrl);

    /* TX_FCTRL: preamble 128 (=5<<12), datarate 6.8Mbps (=1<<10) */
    uint32_t tx_fctrl = dw_read32(REG_GEN_CFG_LOW, SUB_TX_FCTRL);
    tx_fctrl |= (5UL << 12);
    tx_fctrl |= (1UL << 10);
    dw_write32(REG_GEN_CFG_LOW, SUB_TX_FCTRL, tx_fctrl);

    /* DRX: set STS/DTUNE mode byte (1 byte = 0x81 at sub 0x02) */
    dw_write8(REG_DRX, 0x02, 0x81);

    /* RF_TX_CTRL_2: channel 5 value */
    dw_write32(REG_RF_CONF, 0x1C, 0x1C071134UL);

    /* PLL_CFG: channel 5 value 0x1F3C  ← was wrong (0x01400000) */
    dw_write32(REG_FS_CTRL, 0x00, 0x00001F3CUL);

    /* LDO_RLOAD */
    dw_write8(REG_RF_CONF, 0x51, 0x14);

    /* RF_TX_CTRL_1 */
    dw_write8(REG_RF_CONF, 0x1A, 0x0E);

    /* PLL_CAL: trigger calibration */
    dw_write8(REG_FS_CTRL, 0x08, 0x81);

    /* Clear SYS_STATUS, then wait for CPLOCK (bit 1) in SYS_STATUS:0x44 */
    dw_write32(REG_GEN_CFG_LOW, SUB_SYS_STATUS, 0xFFFFFFFFUL);

    /* PMSC: set clock to auto mode */
    dw_write32(REG_PMSC, 0x04, 0x00300200UL);

    /* PMSC sub-0x08 setup (2 bytes: 0x38, 0x01) */
    {
        uint8_t pmsc_08[2] = {0x38, 0x01};
        dw_write(REG_PMSC, 0x08, pmsc_08, 2);
    }

    /* Wait for CPLOCK in SYS_STATUS bit 1 */
    bool pll_locked = false;
    uint32_t final_sys = 0;
    for (int i = 0; i < 100; i++) {
        final_sys = dw_read32(REG_GEN_CFG_LOW, SUB_SYS_STATUS);
        if (final_sys & 0x2UL) {
            pll_locked = true;
            break;
        }
        k_usleep(1000);
    }
    if (!pll_locked) {
        LOG_ERR("DW3000: PLL FAILED to lock, SYS_STATUS=0x%08X", final_sys);
        return -EIO;
    }
    LOG_INF("DW3000 PLL locked (SYS_STATUS=0x%08X)", final_sys);
    /* Clear CPLOCK flag */
    dw_write32(REG_GEN_CFG_LOW, SUB_SYS_STATUS, 0xFFFFFFFFUL);

    /* OTP update: set bit 6 (and 0x2000 for channel 9, skip for channel 5) */
    uint32_t otp_val = dw_read32(REG_OTP_IF, 0x08);
    otp_val |= 0x40UL;
    dw_write32(REG_OTP_IF, 0x08, otp_val);

    /* RX_TUNE DTUNE3 */
    dw_write8(REG_RX_TUNE, 0x19, 0xF0);

    /* PGF (LDO) calibration sequence */
    uint32_t ldo_ctrl_saved = dw_read32(REG_RF_CONF, 0x48);
    dw_write32(REG_RF_CONF, 0x48, 0x0000010FUL);
    dw_write32(REG_EXT_SYNC, 0x0C, 0x00020000UL);  /* calibrate RX */
    (void)dw_read32(REG_EXT_SYNC, 0x0C);           /* dummy read */
    k_msleep(20);
    dw_write32(REG_EXT_SYNC, 0x0C, 0x00000011UL);  /* enable calibration */

    bool pgf_ok = false;
    for (int i = 0; i < 100; i++) {
        if (dw_read32(REG_EXT_SYNC, 0x20)) { pgf_ok = true; break; }
        k_msleep(10);
    }
    if (!pgf_ok) {
        LOG_WRN("DW3000: PGF calibration inconclusive");
    }

    /* Check PGF cal result */
    if ((dw_read32(REG_EXT_SYNC, 0x14) & 0x1FFFFFFFUL) == 0x1FFFFFFFUL) {
        LOG_WRN("DW3000: PGF_CAL stage I result invalid");
    }
    if ((dw_read32(REG_EXT_SYNC, 0x1C) & 0x1FFFFFFFUL) == 0x1FFFFFFFUL) {
        LOG_WRN("DW3000: PGF_CAL stage Q result invalid");
    }

    dw_write32(REG_EXT_SYNC, 0x0C, 0x00UL);
    dw_write32(REG_EXT_SYNC, 0x20, 0x01UL);
    dw_write32(REG_RF_CONF, 0x48, ldo_ctrl_saved);  /* restore LDO_CTRL */

    /* Enable full CIA diagnostics */
    dw_write8(REG_CIA3, 0x02, 0x01);

    /* =========================================================
     * init() additional setup (after writeSysConfig)
     * ========================================================= */

    /* SYS_ENABLE: enable all status events */
    dw_write32(REG_GEN_CFG_LOW, 0x3C, 0xFFFFFFFFUL);
    {
        uint8_t en16[2] = {0xFF, 0xFF};
        dw_write(REG_GEN_CFG_LOW, 0x40, en16, 2);
    }

    /* AON: auto-rx calibration and GO2IDLE on wakeup */
    {
        uint8_t aon3[3] = {0x00, 0x09, 0x00};
        dw_write(REG_AON, 0x00, aon3, 3);
    }

    /* DGC config for channel 5 (correct sub-addresses) */
    dw_write32(REG_RX_TUNE, 0x1C, 0x10000240UL);  /* DGC_CFG0 */
    dw_write32(REG_RX_TUNE, 0x20, 0x1B6DA489UL);  /* DGC_CFG1 */
    dw_write32(REG_RX_TUNE, 0x38, 0x0001C0FDUL);  /* DGC_LUT_0 */
    dw_write32(REG_RX_TUNE, 0x3C, 0x0001C43EUL);  /* DGC_LUT_1 */
    dw_write32(REG_RX_TUNE, 0x40, 0x0001C6BEUL);  /* DGC_LUT_2 */
    dw_write32(REG_RX_TUNE, 0x44, 0x0001C77EUL);  /* DGC_LUT_3 */
    dw_write32(REG_RX_TUNE, 0x48, 0x0001CF36UL);  /* DGC_LUT_4 */
    dw_write32(REG_RX_TUNE, 0x4C, 0x0001CFB5UL);  /* DGC_LUT_5 */
    dw_write32(REG_RX_TUNE, 0x50, 0x0001CFF5UL);  /* DGC_LUT_6 */
    dw_write32(REG_RX_TUNE, 0x18, 0x0000E5E5UL);  /* THR_64 */

    /* EXT_SYNC read (dummy, mirrors Arduino) */
    (void)dw_read32(REG_EXT_SYNC, 0x20);

    /* DRX: PAC to 32, DTUNE0 (3 bytes: 0x1C, 0x10, 0x81) */
    dw_write32(REG_DRX, 0x00, 0x0081101CUL);

    /* Temp sensor enable */
    dw_write8(REG_RF_CONF, 0x34, 0x04);

    /* RF/FS final setup (matches end of Arduino init()) */
    dw_write8(REG_RF_CONF, 0x48, 0x14);
    dw_write8(REG_RF_CONF, 0x1A, 0x0E);
    dw_write32(REG_RF_CONF, 0x1C, 0x1C071134UL);
    dw_write32(REG_FS_CTRL, 0x00, 0x00001F3CUL);
    /* (removed: dw_write8(REG_FS_CTRL, 0x80, 0x81) — sub 0x80 > 0x7F is invalid) */

    /* PMSC timing registers */
    dw_write32(REG_PMSC, 0x04, 0x00B40200UL);
    dw_write32(REG_PMSC, 0x08, 0x80030738UL);

    /* Antenna delay (TX path only – mirrors setTXAntennaDelay) */
    uint16_t ant = ANTENNA_DELAY;
    dw_write(REG_GEN_CFG_HIGH, SUB_ANT_DELAY, (uint8_t *)&ant, 2);

    clear_status();

    /* Post-init diagnostic: read SYS_STATUS and device ID */
    uint32_t post_status = dw_read32(REG_GEN_CFG_LOW, SUB_SYS_STATUS);
    uint32_t post_devid  = dw_read32(REG_GEN_CFG_LOW, 0x00);
    LOG_INF("DW3000 init complete: DEV_ID=0x%08X SYS_STATUS=0x%08X",
            post_devid, post_status);
    return 0;
}

/* -----------------------------------------------------------------------
 * Public interface
 * ----------------------------------------------------------------------- */

int uwb_adapter_init(bool initiator_role)
{
    g_is_initiator = initiator_role;

    if (!spi_is_ready_dt(&g_spi)) {
        LOG_ERR("SPI device not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&g_irq)) {
        LOG_ERR("IRQ GPIO not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&g_rst)) {
        LOG_ERR("RST GPIO not ready");
        return -ENODEV;
    }

    /* Configure IRQ pin as input (not used for polling, just ensure direction) */
    gpio_pin_configure_dt(&g_irq, GPIO_INPUT);

    int ret = dw3000_hw_init();
    if (ret < 0) {
        return ret;
    }

    LOG_INF("UWB adapter ready as %s", initiator_role ? "INITIATOR" : "RESPONDER");
    return 0;
}

/* -----------------------------------------------------------------------
 * Initiator: executes one full DS-TWR exchange (Poll→Resp→Final→RTinfo)
 * Diagnostic callback fires at each stage; seq propagated via SRC byte.
 * ----------------------------------------------------------------------- */
static int initiator_step(struct uwb_measurement *m)
{
    int rc;
    uint8_t seq_byte = (uint8_t)(g_diag_seq & 0xFFU);

    /* Reset transceiver to IDLE and clear any leftover status from prior cycle */
    fast_cmd(0x00);          /* CMD_TXRXOFF */
    clear_status();

    /* ----- Stage 0: Send Poll (stage=1, seq embedded in SRC byte) ----- */
    write_std_frame(1, seq_byte);
    do_tx_w4r();

    rc = wait_tx_done();
    if (rc < 0) {
        uint32_t st = dw_read32(REG_GEN_CFG_LOW, SUB_SYS_STATUS);
        static int n = 0;
        if (n < 3) {
            LOG_WRN("TX_POLL fail #%d: SYS=0x%08X", n, st);
            n++;
        }
        m->status = "TX_POLL_ERR";
        g_diag_seq++;
        return 0;
    }
    uint64_t tx_ts_poll = read_tx_ts();
    clear_status();
    fire_cb(UWB_EVT_TX_POLL, 0.0f, 0);

    /* ----- Stage 1: Wait for Response (stage=2) ----- */
    rc = wait_rx_frame();
    if (rc < 0) {
        if (rc == -ETIMEDOUT) {
            fire_cb(UWB_EVT_RX_RESP_TIMEOUT, 0.0f, 0);
            m->status = "RX_RESP_TIMEOUT";
        } else {
            fire_cb(UWB_EVT_RX_RESP_ERR, 0.0f, 0);
            m->status = "RX_RESP_ERR";
        }
        clear_status();
        do_rx_enable();
        g_diag_seq++;
        return 0;
    }
    if (get_rx_stage() != 2) {
        fire_cb(UWB_EVT_RX_RESP_ERR, 0.0f, 0);
        m->status = "BAD_STAGE_RESP";
        clear_status();
        do_rx_enable();
        g_diag_seq++;
        return 0;
    }
    fire_cb(UWB_EVT_RX_RESP_OK, 0.0f, 0);
    uint64_t rx_ts_resp = read_rx_ts();
    clear_status();

    /* ----- Stage 2: Compute tRoundA/tReplyA, send Final (stage=3) ----- */
    int32_t t_round_a = (int32_t)(rx_ts_resp - tx_ts_poll);

    write_std_frame(3, seq_byte);
    do_tx_w4r();

    rc = wait_tx_done();
    if (rc < 0) {
        m->status = "TX_FINAL_ERR";
        g_diag_seq++;
        return 0;
    }
    uint64_t tx_ts_final = read_tx_ts();
    int32_t t_reply_a = (int32_t)(tx_ts_final - rx_ts_resp);
    clear_status();
    fire_cb(UWB_EVT_TX_FINAL, 0.0f, 0);

    /* ----- Stage 3: Wait for RTinfo (stage=4) ----- */
    rc = wait_rx_frame();
    if (rc < 0) {
        if (rc == -ETIMEDOUT) {
            fire_cb(UWB_EVT_RX_RTINFO_TIMEOUT, 0.0f, 0);
            m->status = "RX_RTI_TIMEOUT";
        } else {
            m->status = "RX_RTI_ERR";
        }
        clear_status();
        do_rx_enable();
        g_diag_seq++;
        return 0;
    }
    fire_cb(UWB_EVT_RX_RTINFO_OK, 0.0f, 0);
    int32_t raw_clk_off = read_raw_clock_offset();
    clear_status();

    /* ----- Stage 4: Read tRoundB/tReplyB, compute range ----- */
    int32_t t_round_b = (int32_t)dw_read32(REG_RX_BUF0, FRAME_OFFSET_DATA);
    int32_t t_reply_b = (int32_t)dw_read32(REG_RX_BUF0, FRAME_OFFSET_DATA + 4);

    float range_m = compute_range_m(t_round_a, t_reply_a,
                                    t_round_b, t_reply_b,
                                    raw_clk_off);

    if (range_m <= 0.0f || range_m > 200.0f) {
        fire_cb(UWB_EVT_INVALID_RANGE, range_m, 0);
        m->status = "INVALID_RANGE";
        m->has_range = false;
        m->range_m   = range_m;
        g_diag_seq++;
        return 0;
    }

    fire_cb(UWB_EVT_RANGE_OK, range_m, 0);
    m->has_range = true;
    m->range_m   = range_m;
    m->status    = "OK";

    g_diag_seq++;
    do_rx_enable();
    return 0;
}

/* -----------------------------------------------------------------------
 * Responder: waits for Poll, sends Response, waits for Final, sends RTinfo
 * Diagnostic callback fires at each stage; seq echoed from Poll SRC byte.
 * ----------------------------------------------------------------------- */
static int responder_step(struct uwb_measurement *m)
{
    int rc;

    /* Reset transceiver to IDLE and clear any leftover status from prior cycle */
    fast_cmd(0x00);          /* CMD_TXRXOFF */
    clear_status();

    /* ----- Stage 0: Listen for Poll (stage=1) ----- */
    do_rx_enable();
    fire_cb(UWB_EVT_RX_ARMED, 0.0f, 0);

    rc = wait_rx_frame();
    if (rc < 0) {
        fire_cb(UWB_EVT_RX_ERR, 0.0f, 0);
        m->status = (rc == -ETIMEDOUT) ? "LISTEN_TIMEOUT" : "POLL_RX_ERR";
        clear_status();
        return 0;
    }
    if (get_rx_stage() != 1) {
        fire_cb(UWB_EVT_RX_ERR, 0.0f, 0);
        m->status = "BAD_STAGE_POLL";
        clear_status();
        return 0;
    }
    g_rx_seq = get_rx_seq();
    uint64_t rx_ts_poll = read_rx_ts();
    clear_status();
    fire_cb(UWB_EVT_RX_POLL, 0.0f, 0);

    /* ----- Stage 1: Send Response (stage=2, echo seq in SRC byte) ----- */
    fire_cb(UWB_EVT_TX_RESP_SCHEDULED, 0.0f, 0);
    write_std_frame(2, g_rx_seq);
    do_tx_w4r();

    uint32_t t0_resp     = k_uptime_get_32();
    rc = wait_tx_done();
    uint32_t elapsed_ms  = k_uptime_get_32() - t0_resp;

    if (rc < 0) {
        m->status = "TX_RESP_ERR";
        return 0;
    }
    uint64_t tx_ts_resp = read_tx_ts();
    int32_t t_reply_b = (int32_t)(tx_ts_resp - rx_ts_poll);
    clear_status();

    if (elapsed_ms >= (uint32_t)CONFIG_VLOS_TX_RESP_LATE_MS) {
        fire_cb(UWB_EVT_TX_RESP_LATE, 0.0f, elapsed_ms);
    } else {
        fire_cb(UWB_EVT_TX_RESP_DONE, 0.0f, 0);
    }

    /* ----- Stage 2: Wait for Final (stage=3) ----- */
    rc = wait_rx_frame();
    if (rc < 0) {
        if (rc == -ETIMEDOUT) {
            fire_cb(UWB_EVT_RX_FINAL_TIMEOUT, 0.0f, 0);
        } else {
            fire_cb(UWB_EVT_RX_ERR, 0.0f, 0);
        }
        m->status = (rc == -ETIMEDOUT) ? "RX_FINAL_TIMEOUT" : "RX_FINAL_ERR";
        clear_status();
        return 0;
    }
    if (get_rx_stage() != 3) {
        fire_cb(UWB_EVT_RX_ERR, 0.0f, 0);
        m->status = "BAD_STAGE_FINAL";
        clear_status();
        return 0;
    }
    uint64_t rx_ts_final = read_rx_ts();
    int32_t t_round_b = (int32_t)(rx_ts_final - tx_ts_resp);
    clear_status();
    fire_cb(UWB_EVT_RX_FINAL_OK, 0.0f, 0);

    /* ----- Stage 3: Send RTinfo (stage=4) with tRoundB + tReplyB ----- */
    write_rtinfo_frame(t_round_b, t_reply_b);
    do_tx_w4r();

    rc = wait_tx_done();
    if (rc < 0) {
        m->status = "TX_RTI_ERR";
        return 0;
    }
    clear_status();
    fire_cb(UWB_EVT_TX_RTINFO_DONE, 0.0f, 0);

    m->has_range = false;
    m->range_m   = 0.0f;
    m->status    = "RESP_OK";
    return 0;
}

/* -----------------------------------------------------------------------
 * Public entry point called by main.c in while(1)
 * ----------------------------------------------------------------------- */
int uwb_adapter_step(struct uwb_measurement *m)
{
    m->has_range = false;
    m->range_m   = 0.0f;
    m->status    = "IDLE";

    if (g_is_initiator) {
        return initiator_step(m);
    } else {
        return responder_step(m);
    }
}
