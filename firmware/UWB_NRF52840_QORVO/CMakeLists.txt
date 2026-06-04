cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(vlos_nrf52840_qorvo_uwb)

target_sources(app PRIVATE
  src/main.c
  src/uwb_adapter_stub.c
)

target_include_directories(app PRIVATE src)