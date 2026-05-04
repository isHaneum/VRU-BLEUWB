# Simulation

## Overview

Kinematic and error-model simulation scripts for the BLE/UWB VRU warning system.

These scripts do not require hardware. They are used to:
1. Estimate theoretical warning lead time bounds under various detection delay assumptions.
2. Fit error models from experimental data for potential co-simulation integration.

---

## Scripts

### `simple_scenario_sim.py` — Kinematic warning lead time simulation

Simulates 5 scenario variants across a grid of detection delays and cooperative relay delays.

```bash
# Run simulation and print summary table
python simulation/simple_scenario_sim.py

# Run with plot generation
python simulation/simple_scenario_sim.py --plot --plot_output_dir plots/

# Specify output CSV
python simulation/simple_scenario_sim.py --output simulation/simulation_results.csv --plot
```

**Output columns:**
```
scenario, ego_speed_mps, vru_speed_mps, detection_delay_ms,
coop_delay_ms, warning_lead_time_s, collision_relevance
```

**Scenarios simulated:**

| Scenario | Ego Speed | VRU Speed | Notes |
|----------|-----------|-----------|-------|
| S1_ALLEY_DART_OUT | 30 km/h | 1.2 m/s | Slow pedestrian |
| S1_ALLEY_DART_OUT_FAST | 30 km/h | 2.5 m/s | Fast pedestrian |
| S2_RIGHT_TURN_CONFLICT | 20 km/h | 1.2 m/s | Vehicle in turn |
| S4_LANE_SPLIT_BICYCLE | 40 km/h | 4.0 m/s | Lane-splitting bicycle |
| S4_LANE_SPLIT_MOTORCYCLE | 50 km/h | 8.0 m/s | Lane-splitting motorcycle |

**Model:** Single-axis kinematic. VRU crosses perpendicular to ego.  
`warning_lead_time = (vru_start_x_m / vru_speed_mps) - detection_delay_s - coop_delay_s`

This is a first-order approximation. It does not model:
- Ego vehicle heading change (turns)
- VRU path curvature
- Detection probability vs. distance
- Multi-VRU scenarios

---

### `error_model_from_logs.py` — Error model from experimental data (placeholder)

Reads `data/processed/*_metrics.csv` files produced by `analysis/compute_metrics.py` and
fits simple BLE RSSI and UWB range error models.

```bash
python simulation/error_model_from_logs.py \
  --metrics_dir data/processed \
  --output simulation/error_model.json
```

**Current status:** PLACEHOLDER. The output JSON describes model parameters and outlines
future integration paths for CARLA, OpenCDA, and OMNeT++.

---

## Limitations

- These simulations are **not validated against real experiment data**. They are pre-experiment theoretical bounds.
- The kinematic model assumes ideal instantaneous detection at `detection_delay_ms`. Real systems have probabilistic detection.
- Co-simulation integration (CARLA, OMNeT++) is future work.
