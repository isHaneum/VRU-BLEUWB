# VRU-BLEUWB

**BLE / UWB 기반 보행자(VRU) 위치 인식 실험 플랫폼**

BLE RSSI 거리 추정과 UWB Two-Way Ranging(TWR)을 동시에 수집하여  
실험 라벨링 앱의 타임스탬프와 비교 분석하기 위한 레포지토리입니다.

---

## 프로젝트 구조

```
VRU-BLEUWB/
├── iOS_ExperimentLogger/          # iOS SwiftUI 실험 라벨링 앱
│   ├── ExperimentLoggerApp.swift
│   ├── Models.swift
│   ├── ExperimentStore.swift
│   ├── SetupView.swift
│   ├── RecordingView.swift
│   ├── ExportView.swift
│   ├── ShareSheet.swift
│   └── Info.plist
│
└── firmware/
    ├── ESP32_BLE/
    │   ├── ble_beacon/            # BLE 광고 송출 (VRU 측)
    │   └── ble_scanner/           # BLE RSSI 수집 (RSU 측)
    │
    ├── UWB_DWM3000/               # ESP32 + DWM3000 (DW3000 칩)
    │   ├── uwb_initiator/         # TWR Initiator (RSU)
    │   └── uwb_responder/         # TWR Responder (VRU)
    │
    └── UWB_DWM3001/               # DWM3001CDK (nRF52833 + DW3110)
        ├── uwb_dwm3001_initiator/ # TWR Initiator
        └── uwb_dwm3001_responder/ # TWR Responder
```

---

## 하드웨어 구성

| 모듈 | 역할 | 인터페이스 |
|------|------|-----------|
| ESP32-WROOM-32 | BLE Beacon (VRU 태그) / BLE Scanner (RSU) | BLE 5.0 내장 |
| ESP32-WROOM-32 + DWM3000 | UWB Initiator / Responder | SPI (GPIO 18/19/23/5) |
| DWM3001CDK | UWB Initiator / Responder (통합 모듈) | USB-CDC (J-Link 내장) |

### ESP32 + DWM3000 핀 연결

| DWM3000 핀 | ESP32 GPIO |
|-----------|-----------|
| MOSI      | 23        |
| MISO      | 19        |
| SCK       | 18        |
| CS/NSS    | 5         |
| IRQ       | 4         |
| RST       | 27        |
| WAKEUP    | 26 (선택) |
| VCC       | 3.3V      |
| GND       | GND       |

---

## 펌웨어 빌드 방법

### ESP32 BLE / DWM3000 (Arduino)

**요구사항:**
- Arduino IDE 2.x 또는 PlatformIO
- ESP32 Arduino Core ≥ 2.0
- DW3000 Arduino Library ([thotro/arduino-dw3000](https://github.com/thotro/arduino-dw3000))

```bash
# Arduino IDE: 보드 → "ESP32 Dev Module"
# 파티션: Default 4MB
# 해당 .ino 파일 열고 Upload
```

### DWM3001CDK (nRF5 SDK + Qorvo UWB SDK)

**요구사항:**
- nRF5 SDK 17.1.0
- Qorvo DW3000 SDK
- Segger Embedded Studio 또는 VS Code + nRF Connect Extension

---

## iOS ExperimentLogger — BLE/UWB Experiment Labeling App

iOS native SwiftUI 앱. BLE/UWB 실험 중 이벤트 타임스탬프를 기록하고 CSV로 내보낼 수 있습니다.

## 파일 목록

| 파일 | 역할 |
|------|------|
| `ExperimentLoggerApp.swift` | 앱 진입점, NavigationStack 루트 |
| `Models.swift` | `AppRoute`, `EventLog`, `ExperimentSession` 데이터 모델 |
| `ExperimentStore.swift` | `@ObservableObject` 상태 관리 + CSV 생성 |
| `SetupView.swift` | 실험 설정 화면 |
| `RecordingView.swift` | 이벤트 기록 화면 (타이머 + 버튼 + 로그) |
| `ExportView.swift` | CSV 미리보기 + ShareSheet 내보내기 |
| `ShareSheet.swift` | `UIActivityViewController` SwiftUI 래퍼 |
| `Info.plist` | 앱 메타데이터 (portrait only, light mode 고정) |

---

## Xcode 프로젝트 생성 방법 (Mac 필요)

### 1. 새 프로젝트 생성

1. Xcode → **File > New > Project**
2. **iOS > App** 선택
3. 설정:
   - Product Name: `ExperimentLogger`
   - Interface: **SwiftUI**
   - Language: **Swift**
   - Minimum Deployment: **iOS 16.0**

### 2. 소스 파일 교체

1. Xcode가 생성한 기본 파일(`ContentView.swift`, `[AppName]App.swift`) 삭제
2. 이 폴더의 `.swift` 파일 7개를 Xcode 프로젝트로 드래그 앤 드롭
   - **Copy items if needed** 체크
3. `Info.plist` 내용을 Xcode의 Info.plist에 병합하거나 교체

### 3. 빌드 및 실행

- iPhone 실기기 또는 Simulator에서 Run (⌘R)

---

## CSV 출력 형식

```
experiment_id,scenario,target,location,time_s,event,note
vehicle_occlusion_01,Vehicle Occlusion,Pedestrian,Parking Lot,0.000,START,
vehicle_occlusion_01,Vehicle Occlusion,Pedestrian,Parking Lot,2.142,CAR_OCCLUDED,
vehicle_occlusion_01,Vehicle Occlusion,Pedestrian,Parking Lot,4.831,MOVE_START,
vehicle_occlusion_01,Vehicle Occlusion,Pedestrian,Parking Lot,5.623,VISIBLE,
vehicle_occlusion_01,Vehicle Occlusion,Pedestrian,Parking Lot,8.010,END,
```

파일명 형식: `{experiment_id}_{yyyyMMdd_HHmmss}.csv`

---

## 이벤트 코드

| 버튼 | 코드 |
|------|------|
| Car Occluded | `CAR_OCCLUDED` |
| Human Occluded | `HUMAN_OCCLUDED` |
| Wall / Corner | `WALL_CORNER` |
| Move Start | `MOVE_START` |
| Visible | `VISIBLE` |
| Danger Point | `DANGER_POINT` |
| Pause | `PAUSE` |
| Resume | `RESUME` |
| End Experiment | `END` |

---

## 화면 흐름

```
SetupView
   └─▶ RecordingView (Start Experiment 누르면)
            └─▶ ExportView (End Experiment 누르면)
                     └─▶ SetupView (New Experiment 누르면, 세션 초기화)
```

- 각 버튼: 햅틱 피드백 (`UIImpactFeedbackGenerator`)
- Elapsed time: `Date().timeIntervalSince(startTime)` 기반, 0.1초 갱신
- 앱이 백그라운드로 가도 이벤트 데이터는 메모리에 유지됨
- 강제 Light Mode (`preferredColorScheme(.light)`)
