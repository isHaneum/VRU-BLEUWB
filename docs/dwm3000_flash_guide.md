# DWM3000 + ESP32 — 2대 보드 빌드 & 플래시 완전 가이드

> 대상: ESP32 DevKit + Qorvo DWM3000EVB × **2세트**
> (한 대는 **Initiator**, 한 대는 **Responder** 역할)
> 사용 도구: **PlatformIO** (VS Code 확장)
> 빌드 환경: 이 저장소 루트의 [platformio.ini](../platformio.ini)

이 문서대로 따라하면 처음부터 끝까지 **두 보드를 서로 다른 펌웨어로 굽고**,
시리얼 모니터에서 TWR 거리 측정 로그를 확인할 수 있다.

---

## 0. 준비 체크리스트

### 하드웨어
- [ ] ESP32 DevKit V1 × **2개**
- [ ] DWM3000EVB × **2개**
- [ ] USB Micro-B 또는 Type-C 케이블 × **2개** (데이터 전송 가능한 것; 충전 전용 X)
- [ ] 점퍼선(F-F 권장) 충분히
- [ ] 두 보드를 동시에 꽂을 수 있는 USB 허브(혹은 PC USB 포트 2개)

### 배선 (두 보드 똑같이 연결)
[docs/hardware_setup.md](hardware_setup.md)에 정의된 핀맵을 그대로 사용한다:

| DWM3000EVB | ESP32 GPIO |
|---|---|
| VCC | **3.3V** (5V 절대 금지) |
| GND | GND |
| MOSI | GPIO 23 |
| MISO | GPIO 19 |
| SCK  | GPIO 18 |
| CS / NSS | **GPIO 5** |
| IRQ | GPIO 4 |

> 펌웨어 코드는 `CHIP_SELECT_PIN=5`로 빌드된다([platformio.ini](../platformio.ini) 참고). 핀을 바꾸면 빌드 플래그도 같이 바꿔야 한다.

### 소프트웨어
- [ ] VS Code 설치
- [ ] VS Code 확장 **PlatformIO IDE** 설치
- [ ] CP210x 또는 CH340 **USB-Serial 드라이버** (보드에 따라 다름) 설치
- [ ] Windows: **장치 관리자**에서 ESP32가 `COMx`로 인식되는지 확인

---

## 1. PlatformIO에서 프로젝트 열기

1. VS Code 실행 → 좌측 사이드바의 **PlatformIO** 아이콘 클릭
2. `Open Project` → 이 저장소 루트(`VLOS-V2X/`)를 연다
3. 좌하단 상태바에 **체크/화살표/플러그/USB** 아이콘들이 나타나면 PIO 인식 성공

### 환경(env) 구조 이해
`platformio.ini`에는 4개의 env가 있다:

| env 이름 | 빌드 대상 | 사용처 |
|---|---|---|
| `ble_beacon` | `src/ble_beacon.cpp` | (이 가이드와 무관) |
| `ble_scanner` | `src/ble_scanner.cpp` | (이 가이드와 무관) |
| **`uwb_initiator`** | `src/uwb_initiator.cpp` → `firmware/UWB_DWM3000/uwb_initiator/uwb_initiator.ino` | **보드 A** |
| **`uwb_responder`** | `src/uwb_responder.cpp` → `firmware/UWB_DWM3000/uwb_responder/uwb_responder.ino` | **보드 B** |

이번 작업에서는 `uwb_initiator`와 `uwb_responder` 두 개만 쓴다.

---

## 2. 두 보드의 COM 포트 확정

같은 PC에 2개를 동시에 꽂을 때 어느 게 어느 건지 헷갈리지 않도록 **먼저 라벨링**한다.

1. ESP32 1대만 USB에 꽂는다.
2. PowerShell에서 포트 확인:
   ```powershell
   pio device list
   ```
   또는
   ```powershell
   Get-CimInstance -ClassName Win32_SerialPort | Select-Object DeviceID, Description
   ```
3. 표시되는 `COMx`를 보드 케이스에 매직펜으로 적거나 메모: 예) **"A → COM7"**
4. 첫 번째 보드를 뽑고 두 번째 보드를 꽂은 뒤 동일하게 확인: 예) **"B → COM8"**
5. 두 보드 모두 꽂는다. 이제 `COM7=Initiator`, `COM8=Responder`로 약속한다(역할은 자유, 한쪽씩만 정하면 된다).

> 매번 COM 번호가 바뀐다면 장치 관리자 → 포트 속성에서 **"Advanced → COM Port Number"** 로 고정할 수 있다.

---

## 3. Initiator 펌웨어 빌드 & 플래시 (보드 A)

### 3-1. env 선택
좌하단 상태바의 **환경 선택 버튼** 클릭 → 목록에서 `env:uwb_initiator` 선택.
또는 PowerShell에서:
```powershell
pio run -e uwb_initiator
```

### 3-2. 빌드만 먼저 (에러 없는지 확인)
```powershell
pio run -e uwb_initiator
```
첫 빌드 시 PlatformIO가 ESP32 toolchain과 espressif32 6.7.0을 자동 다운로드한다(약 200MB). 5–15분 소요.

성공하면 마지막 줄에 `SUCCESS`가 뜬다.

### 3-3. 보드 A에만 플래시
- 보드 A의 COM 포트를 명시해서 업로드한다.
- `--upload-port`를 주지 않으면 PIO가 자동 선택하는데, **두 보드를 동시에 꽂은 상태**에서는 잘못된 보드에 구워질 수 있으므로 **반드시 명시**한다.

```powershell
pio run -e uwb_initiator -t upload --upload-port COM7
```

> ESP32가 자동 부트로더 진입에 실패하면(`Failed to connect: Wrong boot mode detected`) 보드의 **BOOT 버튼을 누른 채 EN(RST) 버튼을 한 번 누르고 BOOT를 떼는** 방식으로 강제 진입한 후 다시 시도한다.

### 3-4. 보드 A 시리얼 확인
업로드 직후 시리얼 모니터를 열어 로그가 나오는지 본다:
```powershell
pio device monitor -e uwb_initiator -p COM7 -b 115200
```
초기 출력 예시:
```
timestamp_ms,node_id,seq_id,range_m,status
[UWB Initiator] Ready.
```
> Responder가 아직 안 켜져 있으면 `RX_ERROR` 또는 침묵 상태가 정상이다. 다음 단계에서 한 짝을 마저 굽는다.
> 모니터 종료: `Ctrl+C`.

---

## 4. Responder 펌웨어 빌드 & 플래시 (보드 B)

### 4-1. env 변경 후 빌드
```powershell
pio run -e uwb_responder
```

### 4-2. 보드 B에 플래시 (포트 다른 것 확인!)
```powershell
pio run -e uwb_responder -t upload --upload-port COM8
```

⚠️ **가장 흔한 실수**: `--upload-port`를 잊고 `pio run -e uwb_responder -t upload`만 치면 PIO가 첫 번째로 보이는 포트(=보드 A)에 Responder를 덮어쓴다. 그러면 두 보드 모두 Responder가 되어 측정이 안 된다.

### 4-3. 보드 B 시리얼 확인
**다른 터미널 창**을 열고:
```powershell
pio device monitor -e uwb_responder -p COM8 -b 115200
```

---

## 5. 양쪽 동시에 모니터링 (TWR 동작 확인)

이제 PowerShell 창 **2개**를 띄워서 동시에 본다:

**창 1 — Initiator (COM7)**
```powershell
pio device monitor -p COM7 -b 115200
```
**창 2 — Responder (COM8)**
```powershell
pio device monitor -p COM8 -b 115200
```

정상 동작 시 Initiator 쪽에서 약 200ms 주기로 다음과 같은 행이 출력된다:
```
timestamp_ms,node_id,seq_id,range_m,status
12345,node_A,0,1.842,OK
12555,node_A,1,1.851,OK
12765,node_A,2,1.835,OK
```
- `range_m` 값이 안정적으로 나오면 TWR이 잘 동작한다.
- 두 보드를 30cm, 1m, 2m, 5m 떨어뜨려가며 값이 따라 변하는지 확인한다.
- Responder는 동작 중에는 거의 침묵하지만 펌웨어 종류에 따라 상태 라인을 찍기도 한다.

### 흔한 증상
| 증상 | 원인 | 해결 |
|---|---|---|
| `SPI_ERROR` 무한 반복 | 배선 잘못 / CS 핀 불일치 | 핀맵 다시 확인, GND 공통인지 체크 |
| `RX_ERROR`만 계속 | Responder 미동작 / 거리가 너무 멀어 무신호 | Responder 보드 다시 플래시, 거리 줄이기 |
| 값이 들쭉날쭉 | 안테나가 금속/사람에 가려짐 | 안테나 시선 확보, 1m 이상 떨어진 곳에서 |
| `Failed to connect` | 부트 모드 진입 실패 | BOOT 누른 채 EN 누르고 떼기 |
| 두 보드 모두 같은 로그 | env를 혼동해서 양쪽 같은 펌웨어 구움 | 4-2를 정확한 `--upload-port`로 다시 |

---

## 6. 로그를 파일로 저장 (실험 데이터 수집)

PlatformIO 모니터 그대로 캡처하려면 `Tee-Object`를 쓴다:

```powershell
pio device monitor -p COM7 -b 115200 --quiet | Tee-Object -FilePath data\raw\uwb_initiator_$(Get-Date -Format yyyyMMdd_HHmmss).csv
```

또는 PlatformIO의 내장 필터 `log2file`:
```powershell
pio device monitor -p COM7 -b 115200 -f log2file
```
→ `.pio/build/uwb_initiator/monitor-COM7-*.log`에 저장된다.

저장된 CSV는 그대로 [analysis/compute_metrics.py](../analysis/compute_metrics.py)나 새로 만든 [dashboard/](../dashboard/)의 Load CSV 버튼으로 리플레이 가능하다(컬럼 매핑은 별도 변환 필요).

---

## 7. 빠른 명령 요약 (치트시트)

```powershell
# 한 번만: PIO 설치 확인
pio --version

# 포트 확인
pio device list

# 보드 A — Initiator
pio run -e uwb_initiator                          # 빌드만
pio run -e uwb_initiator -t upload --upload-port COM7
pio device monitor -p COM7 -b 115200

# 보드 B — Responder
pio run -e uwb_responder
pio run -e uwb_responder -t upload --upload-port COM8
pio device monitor -p COM8 -b 115200

# 빌드 캐시 초기화 (이상한 에러 날 때)
pio run -t clean
```

---

## 8. 다음 단계

- 같은 보드 짝을 ESP32 BLE 스캐너/비콘과 함께 묶어 cooperative trigger 시퀀스를 실험: [docs/cooperative_warning_design.md](cooperative_warning_design.md)
- 수집한 거리 로그를 risk filter로 흘려서 false-positive 검증: [docs/risk_filter_design.md](risk_filter_design.md)
- 시각화는 [dashboard/index.html](../dashboard/index.html) (Load CSV로 변환된 로그 재생)

> 만약 DWM3001CDK 또는 nRF52840 + DW3000 조합으로 가려면 ESP32+DWM3000과는 완전히 별개의 toolchain(Zephyr/NCS, J-Link)이 필요하다. 이 가이드는 **DWM3000EVB + ESP32 PlatformIO** 경로 전용이다.
