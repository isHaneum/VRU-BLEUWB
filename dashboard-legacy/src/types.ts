export type PhoneEvent = {
  experimentId: string;
  scenario: string;
  target: string;
  location: string;
  timeS: number;
  event: string;
  note: string;
  roadType: string;
  laneCount: string;
  egoLane: string;
  targetZone: string;
  targetMotion: string;
  occlusionState: string;
  carryPosition: string;
  riskLabel: string;
  nodeId: string;
};

export type BleScan = {
  timestampMs: number;
  nodeId: string;
  seqId: number | null;
  deviceName: string;
  mac: string;
  rssi: number;
  manufacturerDataHex: string;
  receivedAt: number;
};

export type UwbRange = {
  timestampMs: number;
  nodeId: string;
  seqId: number | null;
  rangeM: number | null;
  status: string;
  receivedAt: number;
  raw: string;
};

export type SerialConnectionState = 'idle' | 'connecting' | 'streaming' | 'error';

export type TimelineEntry = {
  source: 'phone' | 'esp32' | 'dwm3000';
  label: string;
  detail: string;
  timeLabel: string;
  sortKey: number;
};