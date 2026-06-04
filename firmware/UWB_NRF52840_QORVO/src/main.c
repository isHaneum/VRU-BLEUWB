#include <errno.h>
#include <stdint.h>
#include <stdio.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "uwb_adapter.h"

LOG_MODULE_REGISTER(vlos_uwb, LOG_LEVEL_INF);

static uint32_t seq_id;

static bool vlos_is_initiator(void)
{
#if defined(CONFIG_VLOS_ROLE_INITIATOR)
    return IS_ENABLED(CONFIG_VLOS_ROLE_INITIATOR);
#else
    return false;
#endif
}

static void print_boot_banner(bool initiator_role)
{
    printk("# VLOS nRF52840 UWB skeleton booted\n");
    printk("# role=%s,node_id=%s\n", initiator_role ? "initiator" : "responder", CONFIG_VLOS_NODE_ID);
    printk("timestamp_ms,node_id,seq_id,range_m,status\n");
}

static void emit_measurement_row(const struct uwb_measurement *measurement)
{
    const uint32_t timestamp_ms = k_uptime_get_32();
    const uint32_t next_seq_id = seq_id++;

    if (measurement->has_range) {
        printk("%u,%s,%u,%.3f,%s\n",
               timestamp_ms,
               CONFIG_VLOS_NODE_ID,
               next_seq_id,
               (double)measurement->range_m,
               measurement->status);
        return;
    }

    printk("%u,%s,%u,,%s\n",
           timestamp_ms,
           CONFIG_VLOS_NODE_ID,
           next_seq_id,
           measurement->status);
}

int main(void)
{
    const bool initiator_role = vlos_is_initiator();
    const int log_period_ms = CONFIG_VLOS_DRIVER_STUB_LOG_PERIOD_MS;
    int64_t last_stub_log_ms = 0;
    int ret;

    print_boot_banner(initiator_role);

    ret = uwb_adapter_init(initiator_role);
    if (ret != 0) {
        LOG_ERR("uwb_adapter_init failed: %d", ret);
        struct uwb_measurement failed = {
            .has_range = false,
            .range_m = 0.0f,
            .status = "INIT_ERROR",
        };
        emit_measurement_row(&failed);
    }

    while (1) {
        struct uwb_measurement measurement = {
            .has_range = false,
            .range_m = 0.0f,
            .status = initiator_role ? "WAITING" : "RESPONDER_IDLE",
        };

        ret = uwb_adapter_step(&measurement);

        if (initiator_role) {
            if (ret == -ENOSYS) {
                const int64_t now_ms = k_uptime_get();
                if (now_ms - last_stub_log_ms >= log_period_ms) {
                    emit_measurement_row(&measurement);
                    last_stub_log_ms = now_ms;
                }
            } else {
                emit_measurement_row(&measurement);
            }
        } else if (ret == -ENOSYS) {
            const int64_t now_ms = k_uptime_get();
            if (now_ms - last_stub_log_ms >= log_period_ms) {
                emit_measurement_row(&measurement);
                last_stub_log_ms = now_ms;
            }
        } else {
            if (ret < 0) {
                measurement.has_range = false;
                measurement.status = "RESPONDER_ERROR";
            }
            emit_measurement_row(&measurement);
        }

        k_sleep(K_MSEC(CONFIG_VLOS_POLL_INTERVAL_MS));
    }

    return 0;
}