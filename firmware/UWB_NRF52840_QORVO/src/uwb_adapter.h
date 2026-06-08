#ifndef VLOS_UWB_ADAPTER_H_
#define VLOS_UWB_ADAPTER_H_

#include <stdbool.h>
#include <stdint.h>

/*
 * Per-stage DS-TWR diagnostic event types.
 * Fired synchronously from within uwb_adapter_step() via the registered
 * callback.  main.c uses these to emit the Nordic diagnostic CSV protocol
 * (see firmware/UWB_DWM3000_NRF52840/diagnostic_protocol.md).
 */
enum uwb_diag_event {
    /* Initiator (node_A) events */
    UWB_EVT_TX_POLL = 0,
    UWB_EVT_RX_RESP_OK,
    UWB_EVT_RX_RESP_TIMEOUT,
    UWB_EVT_RX_RESP_ERR,
    UWB_EVT_TX_FINAL,
    UWB_EVT_RX_RTINFO_OK,
    UWB_EVT_RX_RTINFO_TIMEOUT,
    UWB_EVT_RANGE_OK,
    UWB_EVT_INVALID_RANGE,
    /* Responder (node_B) events */
    UWB_EVT_RX_ARMED,
    UWB_EVT_RX_POLL,
    UWB_EVT_TX_RESP_SCHEDULED,
    UWB_EVT_TX_RESP_DONE,
    UWB_EVT_TX_RESP_LATE,
    UWB_EVT_RX_FINAL_OK,
    UWB_EVT_RX_FINAL_TIMEOUT,
    UWB_EVT_TX_RTINFO_DONE,
    UWB_EVT_RX_ERR,
};

/* Extra data passed with each diagnostic event callback invocation. */
struct uwb_diag_extra {
    uint32_t seq_id;      /* cycle sequence number (echoed on responder) */
    float    range_m;     /* valid for UWB_EVT_RANGE_OK / UWB_EVT_INVALID_RANGE */
    uint32_t elapsed_ms;  /* valid for UWB_EVT_TX_RESP_LATE */
};

typedef void (*uwb_diag_cb_t)(enum uwb_diag_event evt,
                               const struct uwb_diag_extra *extra);

/*
 * Register a diagnostic callback.
 * Must be called before uwb_adapter_init().
 * The callback is invoked synchronously from within uwb_adapter_step().
 */
void uwb_adapter_set_diag_cb(uwb_diag_cb_t cb);

/*
 * Legacy measurement result — preserved for compact CSV backward compatibility.
 */
struct uwb_measurement {
    bool has_range;
    float range_m;
    const char *status;
};

int uwb_adapter_init(bool initiator_role);

/*
 * Run one DS-TWR step.
 * Returns  0       on any completed step (check m->status for result)
 *         -ENOSYS  when no driver is compiled in (stub mode)
 *         <0       on driver-level error
 *
 * If a diag callback is registered it fires once or more during this call
 * for each stage that completes or times out.
 */
int uwb_adapter_step(struct uwb_measurement *measurement);

#endif /* VLOS_UWB_ADAPTER_H_ */