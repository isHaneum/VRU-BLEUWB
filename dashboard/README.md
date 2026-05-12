# VLOS-V2X Dashboard

별도 로컬 웹앱입니다. 기존 iOS 앱과 펌웨어를 건드리지 않고 다음 세 가지 입력을 한 화면에 모읍니다.

- iPhone ExperimentLogger CSV 업로드
- ESP32 BLE Scanner 시리얼 스트림 연결
- DWM3000 Initiator 시리얼 스트림 연결

## 실행

```bash
cd dashboard
npm install
npm run dev
```

브라우저는 Chrome 또는 Edge를 권장합니다. Web Serial API가 필요하기 때문입니다.

## 데이터 소스

### 1. Phone

ExperimentLogger가 내보낸 CSV를 그대로 업로드합니다.

```csv
experiment_id,scenario,target,location,time_s,event,note
vehicle_occlusion_01,Vehicle Occlusion,Pedestrian,Parking Lot,0.000,START,
```

### 2. ESP32 BLE Scanner

현재 레포의 BLE scanner 출력 형식을 그대로 사용합니다.

```text
timestamp_ms,device_name,mac,rssi,manufacturer_data_hex
3812,VRU_BLE_01,aa:bb:cc:dd:ee:ff,-64,FF040100
```

### 3. DWM3000 UWB

현재 레포의 initiator 출력 형식을 그대로 사용합니다.

```text
timestamp_ms,range_m,status
4201,3.284,OK
```

## 제한 사항

- DWM3000 한 세트만으로는 절대 좌표 맵을 계산할 수 없습니다.
- 현재 Scene View는 운영 상태와 상대 거리 시각화용입니다.
- 실제 좌표 맵은 고정 앵커 추가 후 확장해야 합니다.