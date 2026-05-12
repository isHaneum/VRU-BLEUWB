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

export const parsePhoneCsv = (text: string): PhoneEvent[] => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  return lines.slice(1).flatMap((line) => {
    const [experimentId, scenario, target, location, timeS, event, note = ''] = csvSplit(line);
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
      note
    }];
  });
};

export const parseBleScannerLine = (line: string): BleScan | null => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('timestamp_ms')) {
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