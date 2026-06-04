# nRF52840 + Qorvo UWB Skeleton

This folder is a starting Zephyr/Nordic Connect SDK application for the user's
`nRF52840-DK + Qorvo shield` setup.

Current scope:

- Targets `nrf52840dk/nrf52840` under Zephyr/NCS.
- Keeps the serial output shape aligned with the dashboard UWB parser.
- Splits role selection into `initiator` and `responder` config overlays.
- Uses a stub UWB adapter for now, because the exact Qorvo shield driver,
  SPI wiring, IRQ line, reset line, and HAL integration are not yet known.

What works today:

- The project layout is ready for VS Code + nRF Connect.
- The app boots, prints role metadata, and emits placeholder status lines.
- The dashboard can distinguish this skeleton state via `DRIVER_STUB`.

What still needs real hardware integration:

- Replace `src/uwb_adapter_stub.c` with a real DW3000 adapter.
- Bind actual SPI, IRQ, reset, and wake pins for the Qorvo shield.
- Map the shield wiring used on the user's nRF52840-DK.
- Add the real Qorvo or Decawave driver layer.

Build examples from a Nordic Connect SDK terminal:

```powershell
west build -b nrf52840dk/nrf52840 firmware/UWB_NRF52840_QORVO -- -DCONF_FILE=prj_initiator.conf
west build -b nrf52840dk/nrf52840 firmware/UWB_NRF52840_QORVO -- -DCONF_FILE=prj_responder.conf
```

Expected serial format for the initiator path:

```text
timestamp_ms,node_id,seq_id,range_m,status
1234,node_A,0,0.000,DRIVER_STUB
```

Responder builds currently log text lines prefixed with `#` until a real driver
is integrated.