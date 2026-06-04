#ifndef VLOS_UWB_ADAPTER_H_
#define VLOS_UWB_ADAPTER_H_

#include <stdbool.h>

struct uwb_measurement {
    bool has_range;
    float range_m;
    const char *status;
};

int uwb_adapter_init(bool initiator_role);
int uwb_adapter_step(struct uwb_measurement *measurement);

#endif