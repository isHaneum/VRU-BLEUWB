
#include "math.h"

static inline int64_t round_to_i64(double x) {
  return (x >= 0.0) ? (int64_t)(x + 0.5) : (int64_t)(x - 0.5);
}

