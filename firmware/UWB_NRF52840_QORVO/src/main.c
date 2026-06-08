#include <errno.h>
#include <stdint.h>
#include <stdio.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "uwb_adapter.h"

LOG_MODULE_REGISTER(vlos_uwb, LOG_LEVEL_INF);

/* -----------------------------------------------------------------------
 * Role helpers
 * ----------------------------------------------------------------------- */
#if defined(CONFIG_VLOS_ROLE_INITIATOR)
#define IS_INITIATOR IS_ENABLED(CONFIG_VLOS_ROLE_INITIATOR)
#else
#define IS_INITIATOR false
#endif

#define NODE_ID  CONFIG_VLOS_NODE_ID

/* -----------------------------------------------------------------------
 * Recovery / watchdog state (main-thread only — no locking needed)
 * ----------------------------------------------------------------------- */
static uint32_t g_consecutive_timeout;
static uint32_t g_reinit_count;

static int64_t g_last_identity_ms;
static int64_t g_last_heartbeat_ms;

/* Responder watchdog */
static int64_t g_last_poll_seen_ms;
static int64_t g_watchdog_soft_stamp_ms;

/* -----------------------------------------------------------------------
 * CSV identity / config emitters
 * ----------------------------------------------------------------------- */
static void emit_identity(bool is_boot)
{
    const char *tag  = is_boot ? "BOOT" : "IDENTITY";
    const char *role = IS_INITIATOR ? "INITIATOR" : "RESPONDER";

    printk("%s,%s,%s,hardware=nRF52840_DK+DWM3000,"
           "firmware=vlos_nrf52840_uwb,build=%s %s\n",
           NODE_ID, tag, role, __DATE__, __TIME__);
    printk("%s,CONFIG,role=%s,channel=5,"
           "addr=%s,soft_thresh=%d,reinit_thresh=%d\n",
           NODE_ID, role,
           IS_INITIATOR ? "0xA001" : "0xB001",
           CONFIG_VLOS_SOFT_RECOVERY_THRESHOLD,
           CONFIG_VLOS_REINIT_THRESHOLD);

    g_last_identity_ms = k_uptime_get();
}

/* -----------------------------------------------------------------------
 * Recovery event emitters
 * ----------------------------------------------------------------------- */
static void emit_restart(const char *reason)
{
    printk("%u,%s,RX_RESTART,reason=%s\n",
           k_uptime_get_32(), NODE_ID, reason);
}

static void emit_reinit(const char *reason)
{
    g_reinit_count++;
    printk("%u,%s,DW_REINIT,reason=%s,count=%u\n",
           k_uptime_get_32(), NODE_ID, reason, g_reinit_count);
}

/* -----------------------------------------------------------------------
 * Recovery logic — called after each initiator step
 * ----------------------------------------------------------------------- */
static void check_recovery(void)
{
    if (g_consecutive_timeout == 0) {
        return;
    }

    if ((g_consecutive_timeout % CONFIG_VLOS_REINIT_THRESHOLD) == 0) {
        emit_reinit("TIMEOUT_BURST");
        uwb_adapter_init(IS_INITIATOR);
    } else if ((g_consecutive_timeout % CONFIG_VLOS_SOFT_RECOVERY_THRESHOLD) == 0) {
        emit_restart("CONSEC_TIMEOUT");
    }
}

/* -----------------------------------------------------------------------
 * Diagnostic callback — fired synchronously from inside uwb_adapter_step()
 *
 * Because this executes on the main thread it has direct access to all
 * main.c globals (g_consecutive_timeout, g_last_poll_seen_ms, etc.).
 * ----------------------------------------------------------------------- */
static void on_diag_event(enum uwb_diag_event evt,
                          const struct uwb_diag_extra *extra)
{
    uint32_t ts  = k_uptime_get_32();
    uint32_t seq = extra ? extra->seq_id : 0U;

    switch (evt) {

    /* ---- Initiator events ---- */
    case UWB_EVT_TX_POLL:
        printk("%u,%s,TX_POLL,seq=%u\n", ts, NODE_ID, seq);
        break;

    case UWB_EVT_RX_RESP_OK:
        printk("%u,%s,RX_RESP_OK,seq=%u\n", ts, NODE_ID, seq);
        break;

    case UWB_EVT_RX_RESP_TIMEOUT:
        g_consecutive_timeout++;
        printk("%u,%s,RX_RESP_TIMEOUT,seq=%u,consecutive_timeout=%u\n",
               ts, NODE_ID, seq, g_consecutive_timeout);
        /* Legacy compact form — preserves backward compat with range chart */
        printk("%u,%s,%u,,RX_RESP_TIMEOUT\n", ts, NODE_ID, seq);
        break;

    case UWB_EVT_RX_RESP_ERR:
        g_consecutive_timeout++;
        printk("%u,%s,RX_RESP_ERR,seq=%u,consecutive_timeout=%u\n",
               ts, NODE_ID, seq, g_consecutive_timeout);
        break;

    case UWB_EVT_TX_FINAL:
        printk("%u,%s,TX_FINAL,seq=%u\n", ts, NODE_ID, seq);
        break;

    case UWB_EVT_RX_RTINFO_OK:
        printk("%u,%s,RX_RTINFO_OK,seq=%u\n", ts, NODE_ID, seq);
        break;

    case UWB_EVT_RX_RTINFO_TIMEOUT:
        g_consecutive_timeout++;
        printk("%u,%s,RX_RTINFO_TIMEOUT,seq=%u,consecutive_timeout=%u\n",
               ts, NODE_ID, seq, g_consecutive_timeout);
        break;

    case UWB_EVT_RANGE_OK:
        g_consecutive_timeout = 0;
        printk("%u,%s,RANGE_OK,seq=%u,range_m=%.3f\n",
               ts, NODE_ID, seq, (double)extra->range_m);
        /* Legacy compact form */
        printk("%u,%s,%u,%.3f,OK\n",
               ts, NODE_ID, seq, (double)extra->range_m);
        break;

    case UWB_EVT_INVALID_RANGE:
        printk("%u,%s,INVALID_RANGE,seq=%u,range_m=%.3f\n",
               ts, NODE_ID, seq, (double)extra->range_m);
        break;

    /* ---- Responder events ---- */
    case UWB_EVT_RX_ARMED:
        /* High-frequency — only emit if debugging is needed */
        break;

    case UWB_EVT_RX_POLL:
        g_last_poll_seen_ms     = k_uptime_get();
        g_watchdog_soft_stamp_ms = g_last_poll_seen_ms;
        printk("%u,%s,RX_POLL,seq=%u\n", ts, NODE_ID, seq);
        break;

    case UWB_EVT_TX_RESP_SCHEDULED:
        printk("%u,%s,TX_RESP_SCHEDULED,seq=%u\n", ts, NODE_ID, seq);
        break;

    case UWB_EVT_TX_RESP_DONE:
        printk("%u,%s,TX_RESP_DONE,seq=%u\n", ts, NODE_ID, seq);
        break;

    case UWB_EVT_TX_RESP_LATE:
        printk("%u,%s,TX_RESP_LATE,seq=%u,elapsed_ms=%u\n",
               ts, NODE_ID, seq, extra->elapsed_ms);
        break;

    case UWB_EVT_RX_FINAL_OK:
        printk("%u,%s,RX_FINAL_OK,seq=%u\n", ts, NODE_ID, seq);
        break;

    case UWB_EVT_RX_FINAL_TIMEOUT:
        printk("%u,%s,RX_FINAL_TIMEOUT,seq=%u\n", ts, NODE_ID, seq);
        break;

    case UWB_EVT_TX_RTINFO_DONE:
        printk("%u,%s,TX_RTINFO_DONE,seq=%u\n", ts, NODE_ID, seq);
        /* Legacy compact form for responder */
        printk("%u,%s,%u,,RESP_OK\n", ts, NODE_ID, seq);
        break;

    case UWB_EVT_RX_ERR:
        printk("%u,%s,RX_ERR\n", ts, NODE_ID);
        break;

    default:
        break;
    }
}

/* -----------------------------------------------------------------------
 * Responder watchdog (polled once per main-loop iteration)
 * ----------------------------------------------------------------------- */
static void responder_watchdog_tick(void)
{
    if (g_last_poll_seen_ms == 0) {
        return;
    }

    int64_t now   = k_uptime_get();
    int64_t since = now - g_last_poll_seen_ms;
    int64_t since_soft = now - g_watchdog_soft_stamp_ms;

    if (since >= CONFIG_VLOS_WATCHDOG_REINIT_MS) {
        emit_reinit("NO_POLL");
        uwb_adapter_init(false);
        g_last_poll_seen_ms      = now;
        g_watchdog_soft_stamp_ms = now;
    } else if (since_soft >= CONFIG_VLOS_WATCHDOG_SOFT_MS) {
        emit_restart("WATCHDOG_NO_POLL");
        g_watchdog_soft_stamp_ms = now;
    }
}

/* -----------------------------------------------------------------------
 * main
 * ----------------------------------------------------------------------- */
int main(void)
{
    /* Brief delay for serial console stabilisation */
    k_msleep(50);

    /* Register diagnostic callback BEFORE init so boot events fire */
    uwb_adapter_set_diag_cb(on_diag_event);

    /* BOOT banner */
    emit_identity(true);

    int ret = uwb_adapter_init(IS_INITIATOR);
    if (ret != 0) {
        printk("%s,FATAL,INIT_ERROR,code=%d\n", NODE_ID, ret);
    }

    /* Seed watchdog timestamps */
    g_last_poll_seen_ms      = k_uptime_get();
    g_watchdog_soft_stamp_ms = g_last_poll_seen_ms;
    g_last_heartbeat_ms      = k_uptime_get();

    int64_t last_stub_ms = 0;

    while (1) {
        int64_t now_ms = k_uptime_get();

        /* IDENTITY heartbeat every CONFIG_VLOS_IDENTITY_INTERVAL_MS (5 s) */
        if ((now_ms - g_last_identity_ms) >= CONFIG_VLOS_IDENTITY_INTERVAL_MS) {
            emit_identity(false);
        }

        if (!IS_INITIATOR) {
            /* READY heartbeat (1 Hz) */
            if ((now_ms - g_last_heartbeat_ms) >= CONFIG_VLOS_HEARTBEAT_INTERVAL_MS) {
                printk("%u,%s,READY\n", k_uptime_get_32(), NODE_ID);
                g_last_heartbeat_ms = now_ms;
            }
            responder_watchdog_tick();
        }

        /* Run one TWR step — per-stage events fire via on_diag_event() */
        struct uwb_measurement meas = {
            .has_range = false,
            .range_m   = 0.0f,
            .status    = "IDLE",
        };

        ret = uwb_adapter_step(&meas);

        if (ret == -ENOSYS) {
            /* Stub mode: throttled status line */
            if ((now_ms - last_stub_ms) >= CONFIG_VLOS_DRIVER_STUB_LOG_PERIOD_MS) {
                printk("%u,%s,,,%s\n",
                       k_uptime_get_32(), NODE_ID, meas.status);
                last_stub_ms = now_ms;
            }
        } else if (IS_INITIATOR) {
            check_recovery();
        }

        k_sleep(K_MSEC(CONFIG_VLOS_POLL_INTERVAL_MS));
    }

    return 0;
}
