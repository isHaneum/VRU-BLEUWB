#include "uwb_adapter.h"

#include <errno.h>
#include <stddef.h>
#include <stdbool.h>

static bool g_initiator_role;

/* No-op: stub has no per-stage events to emit */
void uwb_adapter_set_diag_cb(uwb_diag_cb_t cb)
{
    (void)cb;
}

int uwb_adapter_init(bool initiator_role)
{
    g_initiator_role = initiator_role;
    return 0;
}

int uwb_adapter_step(struct uwb_measurement *measurement)
{
    if (measurement != NULL) {
        measurement->has_range = false;
        measurement->range_m = 0.0f;
        measurement->status = g_initiator_role ? "DRIVER_STUB" : "RESPONDER_IDLE";
    }

    return -ENOSYS;
}