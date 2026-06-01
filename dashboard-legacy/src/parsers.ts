import type { BleScan, PhoneEvent, UwbRange } from './types';

const csvSplit = (line: string) => {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current);
  return fields;
};

const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, '_');

const readField = (row: Record<string, string>, ...keys: string[]) => {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined) {
      return value;
    }
  }

  return '';
};

const parseCommentLine = (line: string): UwbRange => {
  const payload = line.replace(/^#\s*/, '');
  const segments = payload.split(',').map((segment) => segment.trim()).filter(Boolean);
  const pairs = new Map<string, string>();

  for (const segment of segments) {
    const [rawKey, ...rest] = segment.split('=');
    if (!rawKey || rest.length === 0) {
      continue;
    }

    pairs.set(rawKey.trim(), rest.join('=').trim());
  }

  const role = pairs.get('role');
  const nodeId = pairs.get('node_id') ?? 'node_unknown';
  const status = pairs.get('status') ?? (role ? `ROLE_${role.toUpperCase()}` : 'LOG');

  return {
    timestampMs: Date.now(),
    nodeId,
    seqId: null,
    rangeM: null,
    status,
    receivedAt: Date.now(),
    raw: line.trim()
  };
};

export const parsePhoneCsv = (text: string): PhoneEvent[] => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = csvSplit(lines[0]).map(normalizeHeader);

  return lines.slice(1).flatMap((line) => {
    const fields = csvSplit(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? '']));
    const experimentId = readField(row, 'experiment_id');
    const scenario = readField(row, 'scenario');
    const target = readField(row, 'target');
    const location = readField(row, 'location');
    const timeS = readField(row, 'time_s', 'time');
    const event = readField(row, 'event');
    const note = readField(row, 'note');
    const parsedTime = Number(timeS);

    if (!experimentId || Number.isNaN(parsedTime) || !event) {
      return [];
    }

    return [{
      experimentId,
      scenario,
      target,
      location,
      timeS: parsedTime,
      event,
      note,
      roadType: readField(row, 'road_type'),
      laneCount: readField(row, 'lane_count'),
      egoLane: readField(row, 'ego_lane'),
      targetZone: readField(row, 'target_zone'),
      targetMotion: readField(row, 'target_motion'),
      occlusionState: readField(row, 'occlusion_state'),
      carryPosition: readField(row, 'carry_position'),
      riskLabel: readField(row, 'risk_label'),
      nodeId: readField(row, 'node_id')
    }];
  });
};

export const parseBleScannerLine = (line: string): BleScan | null => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('timestamp_ms') || trimmed.startsWith('#')) {
    return null;
  }

  const fields = trimmed.split(',');
  const parsedTimestamp = Number(fields[0]);
  if (Number.isNaN(parsedTimestamp)) {
    return null;
  }

  if (fields.length >= 7) {
    const parsedSeq = Number(fields[2]);
    const parsedRssi = Number(fields[5]);
    if (Number.isNaN(parsedRssi)) {
      return null;
    }

    return {
      timestampMs: parsedTimestamp,
      nodeId: fields[1] || 'node_unknown',
      seqId: Number.isNaN(parsedSeq) ? null : parsedSeq,
      deviceName: fields[3] || 'UNKNOWN',
      mac: fields[4] || 'UNKNOWN',
      rssi: parsedRssi,
      manufacturerDataHex: fields[6] || '',
      receivedAt: Date.now()
    };
  }

  const parsedRssi = Number(fields[3]);
  if (Number.isNaN(parsedRssi) || !fields[2]) {
    return null;
  }

  return {
    timestampMs: parsedTimestamp,
    nodeId: 'node_unknown',
    seqId: null,
    deviceName: fields[1] || 'UNKNOWN',
    mac: fields[2],
    rssi: parsedRssi,
    manufacturerDataHex: fields[4] || '',
    receivedAt: Date.now()
  };
};

export const parseUwbLine = (line: string): UwbRange | null => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('timestamp_ms')) {
    return null;
  }

  if (trimmed.startsWith('#')) {
    return parseCommentLine(trimmed);
  }

  const fields = trimmed.split(',');
  if (fields.length >= 5) {
    const parsedTimestamp = Number(fields[0]);
    const parsedSeq = Number(fields[2]);
    const parsedRange = Number(fields[3]);
    if (Number.isNaN(parsedTimestamp)) {
      return null;
    }

    return {
      timestampMs: parsedTimestamp,
      nodeId: fields[1] || 'node_unknown',
      seqId: Number.isNaN(parsedSeq) ? null : parsedSeq,
      rangeM: Number.isNaN(parsedRange) ? null : parsedRange,
      status: fields[4] || 'UNKNOWN',
      receivedAt: Date.now(),
      raw: trimmed
    };
  }

  if (fields.length !== 3) {
    return {
      timestampMs: Date.now(),
      nodeId: 'node_unknown',
      seqId: null,
      rangeM: null,
      status: 'LOG',
      receivedAt: Date.now(),
      raw: trimmed
    };
  }

  const parsedTimestamp = Number(fields[0]);
  const parsedRange = Number(fields[1]);
  if (Number.isNaN(parsedTimestamp)) {
    return null;
  }

  return {
    timestampMs: parsedTimestamp,
    nodeId: 'node_unknown',
    seqId: null,
    rangeM: Number.isNaN(parsedRange) ? null : parsedRange,
    status: fields[2] || 'UNKNOWN',
    receivedAt: Date.now(),
    raw: trimmed
  };
};

export const formatAgo = (timestamp: number | null) => {
  if (!timestamp) {
    return 'No data';
  }

  const diffMs = Math.max(0, Date.now() - timestamp);
  if (diffMs < 1000) {
    return 'Just now';
  }

  return `${(diffMs / 1000).toFixed(1)}s ago`;
};

export const estimateBleDistance = (rssi: number | null) => {
  if (rssi === null) {
    return null;
  }

  const txPower = -59;
  const pathLoss = 2.0;
  return Number((10 ** ((txPower - rssi) / (10 * pathLoss))).toFixed(2));
};