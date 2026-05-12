import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { formatAgo, parseBleScannerLine, parseUwbLine } from './parsers';
import type { BleScan, UwbRange } from './types';
import { useSerialSource } from './useSerialSource';

const CONDITIONS = [
  'Visible / No Obstacle',
  'Wall / Corner',
  'Vehicle Occlusion',
  'Human Occlusion'
] as const;

type ConditionOption = typeof CONDITIONS[number];
type DashboardEventType = 'CONDITION_CHANGED' | 'RECORDING_STARTED' | 'RECORDING_STOPPED';

type DashboardEvent = {
  id: string;
  type: DashboardEventType;
  condition: ConditionOption;
  detail: string;
  receivedAt: number;
  elapsedMs: number;
};

type LiveBleScan = BleScan & {
  condition: ConditionOption;
  elapsedMs: number;
  receivedIso: string;
};

type LiveUwbRange = UwbRange & {
  condition: ConditionOption;
  elapsedMs: number;
  receivedIso: string;
};

type ChartMarker = {
  elapsedMs: number;
  label: string;
  color: string;
};

type NumericPoint = {
  elapsedMs: number;
  value: number;
};

type ConnectionSummary = {
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
};

const CONDITION_COLORS: Record<ConditionOption, string> = {
  'Visible / No Obstacle': '#2a9d8f',
  'Wall / Corner': '#e9c46a',
  'Vehicle Occlusion': '#e76f51',
  'Human Occlusion': '#3a86ff'
};

const STATUS_COLORS: Record<string, string> = {
  OK: '#2a9d8f',
  TIMEOUT: '#b8572f',
  INVALID_MSG: '#8c5cff',
  INVALID_RANGE: '#e9c46a',
  LOG: '#94a3b8',
  UNKNOWN: '#64748b'
};

const CHART_WIDTH = 760;
const CHART_HEIGHT = 220;
const CHART_PADDING = { top: 20, right: 18, bottom: 28, left: 18 };

const toIso = (timestamp: number) => new Date(timestamp).toISOString();

const formatDuration = (ms: number) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
};

const formatRate = (count: number, windowMs: number) => `${(count / (windowMs / 1000)).toFixed(2)}/s`;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const escapeCsv = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);
  if (!/[",\n]/.test(stringValue)) {
    return stringValue;
  }

  return `"${stringValue.replace(/"/g, '""')}"`;
};

const downloadCsv = (fileName: string, headers: string[], rows: Array<Array<string | number | null | undefined>>) => {
  const csv = [headers.join(','), ...rows.map((row) => row.map(escapeCsv).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

const getConnectionSummary = (
  connectionState: string,
  isSupported: boolean,
  error: string,
  lastValueAt: number | null,
  now: number
): ConnectionSummary => {
  if (!isSupported) {
    return { label: 'Unsupported', tone: 'bad' };
  }

  if (error || connectionState === 'error') {
    return { label: 'Error', tone: 'bad' };
  }

  if (connectionState === 'connecting') {
    return { label: 'Connecting', tone: 'warn' };
  }

  if (connectionState === 'idle') {
    return { label: 'Disconnected', tone: 'neutral' };
  }

  if (lastValueAt === null) {
    return { label: 'Connected / Waiting', tone: 'warn' };
  }

  if (now - lastValueAt <= 2500) {
    return { label: 'Receiving', tone: 'good' };
  }

  return { label: 'Connected / Stale', tone: 'warn' };
};

const buildLinePath = (points: NumericPoint[]) => {
  if (points.length === 0) {
    return { path: '', minValue: 0, maxValue: 1, minX: 0, maxX: 1 };
  }

  const values = points.map((point) => point.value);
  const minValueBase = Math.min(...values);
  const maxValueBase = Math.max(...values);
  const yPad = minValueBase === maxValueBase ? Math.max(Math.abs(minValueBase) * 0.1, 1) : (maxValueBase - minValueBase) * 0.12;
  const minValue = minValueBase - yPad;
  const maxValue = maxValueBase + yPad;
  const minX = points[0].elapsedMs;
  const maxX = points[points.length - 1].elapsedMs === minX ? minX + 1000 : points[points.length - 1].elapsedMs;

  const innerWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const innerHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const mapX = (elapsedMs: number) => CHART_PADDING.left + ((elapsedMs - minX) / (maxX - minX)) * innerWidth;
  const mapY = (value: number) => CHART_PADDING.top + (1 - (value - minValue) / (maxValue - minValue)) * innerHeight;

  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${mapX(point.elapsedMs).toFixed(2)} ${mapY(point.value).toFixed(2)}`)
    .join(' ');

  return { path, minValue, maxValue, minX, maxX };
};

function LineChart({
  title,
  points,
  markers,
  accent,
  unit,
  emptyLabel
}: {
  title: string;
  points: NumericPoint[];
  markers: ChartMarker[];
  accent: string;
  unit: string;
  emptyLabel: string;
}) {
  const recentPoints = points.slice(-80);
  const { path, minValue, maxValue, minX, maxX } = buildLinePath(recentPoints);
  const innerWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const innerHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const domain = Math.max(1, maxX - minX);

  return (
    <div className="chart-card">
      <div className="chart-head">
        <span className="chart-title">{title}</span>
        {recentPoints.length > 0 ? (
          <span className="chart-range">
            {minValue.toFixed(1)} to {maxValue.toFixed(1)} {unit}
          </span>
        ) : null}
      </div>
      {recentPoints.length === 0 ? (
        <div className="chart-empty">{emptyLabel}</div>
      ) : (
        <svg className="chart-svg" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={title}>
          <line x1={CHART_PADDING.left} y1={CHART_HEIGHT - CHART_PADDING.bottom} x2={CHART_WIDTH - CHART_PADDING.right} y2={CHART_HEIGHT - CHART_PADDING.bottom} className="chart-axis" />
          <line x1={CHART_PADDING.left} y1={CHART_PADDING.top} x2={CHART_PADDING.left} y2={CHART_HEIGHT - CHART_PADDING.bottom} className="chart-axis" />
          {markers
            .filter((marker) => marker.elapsedMs >= minX && marker.elapsedMs <= maxX)
            .map((marker) => {
              const x = CHART_PADDING.left + ((marker.elapsedMs - minX) / domain) * innerWidth;
              return (
                <g key={`${marker.label}-${marker.elapsedMs}`}>
                  <line x1={x} y1={CHART_PADDING.top} x2={x} y2={CHART_HEIGHT - CHART_PADDING.bottom} className="chart-marker" style={{ stroke: marker.color }} />
                  <text x={x + 4} y={CHART_PADDING.top + 12} className="chart-marker-label" style={{ fill: marker.color }}>
                    {marker.label}
                  </text>
                </g>
              );
            })}
          <path d={path} fill="none" stroke={accent} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
          {recentPoints.map((point) => {
            const x = CHART_PADDING.left + ((point.elapsedMs - minX) / domain) * innerWidth;
            const y = CHART_PADDING.top + (1 - (point.value - minValue) / Math.max(1, maxValue - minValue)) * innerHeight;
            return <circle key={`${point.elapsedMs}-${point.value}`} cx={x} cy={y} r="2.5" fill={accent} />;
          })}
          <text x={CHART_PADDING.left} y={16} className="chart-axis-label">{maxValue.toFixed(1)} {unit}</text>
          <text x={CHART_PADDING.left} y={CHART_HEIGHT - 8} className="chart-axis-label">{minValue.toFixed(1)} {unit}</text>
          <text x={CHART_WIDTH - CHART_PADDING.right} y={CHART_HEIGHT - 8} textAnchor="end" className="chart-axis-label">{formatDuration(maxX)}</text>
        </svg>
      )}
    </div>
  );
}

function StatusTimeline({ samples, markers }: { samples: LiveUwbRange[]; markers: ChartMarker[] }) {
  const recentSamples = samples.slice(-60);

  if (recentSamples.length === 0) {
    return (
      <div className="chart-card">
        <div className="chart-head">
          <span className="chart-title">UWB Status Timeline</span>
        </div>
        <div className="chart-empty">No UWB status history yet.</div>
      </div>
    );
  }

  const minX = recentSamples[0].elapsedMs;
  const maxX = recentSamples[recentSamples.length - 1].elapsedMs === minX ? minX + 1000 : recentSamples[recentSamples.length - 1].elapsedMs;
  const domain = maxX - minX;
  const barWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;

  return (
    <div className="chart-card">
      <div className="chart-head">
        <span className="chart-title">UWB Status Timeline</span>
        <span className="chart-range">Recent {recentSamples.length} frames</span>
      </div>
      <svg className="chart-svg timeline-svg" viewBox={`0 0 ${CHART_WIDTH} 110`} preserveAspectRatio="none" role="img" aria-label="UWB status timeline">
        <rect x={CHART_PADDING.left} y="28" width={barWidth} height="34" rx="10" className="timeline-base" />
        {markers
          .filter((marker) => marker.elapsedMs >= minX && marker.elapsedMs <= maxX)
          .map((marker) => {
            const x = CHART_PADDING.left + ((marker.elapsedMs - minX) / Math.max(1, domain)) * barWidth;
            return (
              <g key={`${marker.label}-${marker.elapsedMs}`}>
                <line x1={x} y1="12" x2={x} y2="92" className="chart-marker" style={{ stroke: marker.color }} />
                <text x={x + 4} y="18" className="chart-marker-label" style={{ fill: marker.color }}>
                  {marker.label}
                </text>
              </g>
            );
          })}
        {recentSamples.map((sample, index) => {
          const currentX = CHART_PADDING.left + ((sample.elapsedMs - minX) / Math.max(1, domain)) * barWidth;
          const nextElapsed = recentSamples[index + 1]?.elapsedMs ?? maxX;
          const nextX = CHART_PADDING.left + ((nextElapsed - minX) / Math.max(1, domain)) * barWidth;
          const width = Math.max(6, nextX - currentX);
          const fill = STATUS_COLORS[sample.status] ?? STATUS_COLORS.UNKNOWN;

          return <rect key={`${sample.elapsedMs}-${sample.seqId ?? index}`} x={currentX} y="28" width={width} height="34" rx="6" fill={fill} opacity="0.92" />;
        })}
        <text x={CHART_PADDING.left} y="102" className="chart-axis-label">{formatDuration(minX)}</text>
        <text x={CHART_WIDTH - CHART_PADDING.right} y="102" textAnchor="end" className="chart-axis-label">{formatDuration(maxX)}</text>
      </svg>
      <div className="status-legend">
        {Object.entries(STATUS_COLORS)
          .filter(([key]) => recentSamples.some((sample) => sample.status === key))
          .map(([key, value]) => (
            <span key={key} className="legend-pill">
              <span className="legend-dot" style={{ backgroundColor: value }} />
              {key}
            </span>
          ))}
      </div>
    </div>
  );
}

function App() {
  const [experimentId, setExperimentId] = useState(`occlusion-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
  const [currentCondition, setCurrentCondition] = useState<ConditionOption>('Visible / No Obstacle');
  const [recording, setRecording] = useState(false);
  const [sessionAnchorAt, setSessionAnchorAt] = useState<number | null>(null);
  const [bleScans, setBleScans] = useState<LiveBleScan[]>([]);
  const [uwbRanges, setUwbRanges] = useState<LiveUwbRange[]>([]);
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const sessionAnchorRef = useRef<number | null>(null);
  const conditionRef = useRef<ConditionOption>(currentCondition);

  const bleSerial = useSerialSource(parseBleScannerLine);
  const uwbSerial = useSerialSource(parseUwbLine);

  useEffect(() => {
    conditionRef.current = currentCondition;
  }, [currentCondition]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const ensureSessionAnchor = (timestamp: number) => {
    if (sessionAnchorRef.current !== null) {
      return sessionAnchorRef.current;
    }

    sessionAnchorRef.current = timestamp;
    setSessionAnchorAt(timestamp);
    return timestamp;
  };

  const appendEvent = (type: DashboardEventType, condition: ConditionOption, detail: string, receivedAt = Date.now()) => {
    const anchor = ensureSessionAnchor(receivedAt);
    const nextEvent: DashboardEvent = {
      id: `${type}-${receivedAt}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      condition,
      detail,
      receivedAt,
      elapsedMs: receivedAt - anchor
    };

    startTransition(() => {
      setEvents((items) => [...items, nextEvent]);
    });
  };

  const handleBleValue = (value: BleScan) => {
    const anchor = ensureSessionAnchor(value.receivedAt);
    const nextValue: LiveBleScan = {
      ...value,
      condition: conditionRef.current,
      elapsedMs: value.receivedAt - anchor,
      receivedIso: toIso(value.receivedAt)
    };

    startTransition(() => {
      setBleScans((items) => [...items, nextValue]);
    });
  };

  const handleUwbValue = (value: UwbRange) => {
    const anchor = ensureSessionAnchor(value.receivedAt);
    const nextValue: LiveUwbRange = {
      ...value,
      condition: conditionRef.current,
      elapsedMs: value.receivedAt - anchor,
      receivedIso: toIso(value.receivedAt)
    };

    startTransition(() => {
      setUwbRanges((items) => [...items, nextValue]);
    });
  };

  const handleRecordingToggle = () => {
    const nextRecording = !recording;
    setRecording(nextRecording);
    appendEvent(nextRecording ? 'RECORDING_STARTED' : 'RECORDING_STOPPED', currentCondition, nextRecording ? 'Operator started recording.' : 'Operator stopped recording.');
  };

  const handleConditionChange = (condition: ConditionOption) => {
    if (condition === currentCondition) {
      return;
    }

    conditionRef.current = condition;
    setCurrentCondition(condition);
    appendEvent('CONDITION_CHANGED', condition, condition);
  };

  const elapsedMs = sessionAnchorAt === null ? 0 : now - sessionAnchorAt;
  const latestBle = bleScans[bleScans.length - 1] ?? null;
  const latestUwb = uwbRanges[uwbRanges.length - 1] ?? null;
  const conditionMarkers = useMemo<ChartMarker[]>(() => {
    return events
      .filter((event) => event.type === 'CONDITION_CHANGED')
      .map((event) => ({
        elapsedMs: event.elapsedMs,
        label: event.condition,
        color: CONDITION_COLORS[event.condition]
      }));
  }, [events]);

  const bleRecentWindow = useMemo(() => bleScans.filter((scan) => now - scan.receivedAt <= 10000), [bleScans, now]);
  const uwbRecentWindow = useMemo(() => uwbRanges.filter((range) => now - range.receivedAt <= 10000), [uwbRanges, now]);
  const bleChartPoints = useMemo<NumericPoint[]>(() => bleScans.slice(-120).map((scan) => ({ elapsedMs: scan.elapsedMs, value: scan.rssi })), [bleScans]);
  const uwbChartPoints = useMemo<NumericPoint[]>(() => uwbRanges.filter((range) => range.rangeM !== null).slice(-120).map((range) => ({ elapsedMs: range.elapsedMs, value: range.rangeM ?? 0 })), [uwbRanges]);

  const blePacketRate = formatRate(bleRecentWindow.length, 10000);
  const uwbValidRate = formatRate(uwbRecentWindow.filter((range) => range.status === 'OK' && range.rangeM !== null).length, 10000);
  const uwbTimeoutRate = formatRate(uwbRecentWindow.filter((range) => range.status === 'TIMEOUT').length, 10000);

  const bleConnection = getConnectionSummary(bleSerial.connectionState, bleSerial.isSupported, bleSerial.error, bleSerial.lastValueAt, now);
  const uwbConnection = getConnectionSummary(uwbSerial.connectionState, uwbSerial.isSupported, uwbSerial.error, uwbSerial.lastValueAt, now);

  const exportBleCsv = () => {
    downloadCsv(
      `${experimentId}-ble.csv`,
      ['received_at_iso', 'elapsed_ms', 'condition', 'timestamp_ms', 'node_id', 'seq_id', 'device_name', 'mac', 'rssi', 'manufacturer_data_hex'],
      bleScans.map((scan) => [
        scan.receivedIso,
        scan.elapsedMs,
        scan.condition,
        scan.timestampMs,
        scan.nodeId,
        scan.seqId,
        scan.deviceName,
        scan.mac,
        scan.rssi,
        scan.manufacturerDataHex
      ])
    );
  };

  const exportUwbCsv = () => {
    downloadCsv(
      `${experimentId}-uwb.csv`,
      ['received_at_iso', 'elapsed_ms', 'condition', 'timestamp_ms', 'node_id', 'seq_id', 'range_m', 'status', 'raw'],
      uwbRanges.map((range) => [
        range.receivedIso,
        range.elapsedMs,
        range.condition,
        range.timestampMs,
        range.nodeId,
        range.seqId,
        range.rangeM,
        range.status,
        range.raw
      ])
    );
  };

  const exportEventCsv = () => {
    downloadCsv(
      `${experimentId}-events.csv`,
      ['received_at_iso', 'elapsed_ms', 'event_type', 'condition', 'detail'],
      events.map((event) => [toIso(event.receivedAt), event.elapsedMs, event.type, event.condition, event.detail])
    );
  };

  const exportMergedCsv = () => {
    const mergedRows = [
      ...bleScans.map((scan) => ({
        kind: 'BLE',
        receivedAt: scan.receivedAt,
        values: [scan.receivedIso, scan.elapsedMs, scan.condition, scan.timestampMs, scan.nodeId, scan.seqId, scan.deviceName, scan.mac, scan.rssi, scan.manufacturerDataHex, '', '', '']
      })),
      ...uwbRanges.map((range) => ({
        kind: 'UWB',
        receivedAt: range.receivedAt,
        values: [range.receivedIso, range.elapsedMs, range.condition, range.timestampMs, range.nodeId, range.seqId, '', '', '', '', range.rangeM, range.status, range.raw]
      })),
      ...events.map((event) => ({
        kind: 'EVENT',
        receivedAt: event.receivedAt,
        values: [toIso(event.receivedAt), event.elapsedMs, event.condition, '', '', '', '', '', '', '', '', event.type, event.detail]
      }))
    ].sort((left, right) => left.receivedAt - right.receivedAt);

    downloadCsv(
      `${experimentId}-dashboard-merged.csv`,
      ['kind', 'received_at_iso', 'elapsed_ms', 'condition', 'timestamp_ms', 'node_id', 'seq_id', 'device_name', 'mac', 'rssi', 'manufacturer_data_hex', 'range_m', 'status_or_event_type', 'detail_or_raw'],
      mergedRows.map((row) => [row.kind, ...row.values])
    );
  };

  const recentEvents = events.slice(-8).reverse();

  return (
    <main className="app-shell">
      <section className="top-status-grid">
        <article className="status-card status-card-input">
          <span className="status-label">Experiment ID</span>
          <input value={experimentId} onChange={(event) => setExperimentId(event.target.value)} aria-label="Experiment ID" />
        </article>
        <article className="status-card">
          <span className="status-label">Elapsed Time</span>
          <strong className="status-value">{formatDuration(elapsedMs)}</strong>
        </article>
        <article className="status-card">
          <span className="status-label">Current Condition</span>
          <strong className="status-value status-value-wrap">{currentCondition}</strong>
        </article>
        <article className="status-card">
          <span className="status-label">BLE Connection</span>
          <strong className={`status-badge ${bleConnection.tone}`}>{bleConnection.label}</strong>
        </article>
        <article className="status-card">
          <span className="status-label">UWB Connection</span>
          <strong className={`status-badge ${uwbConnection.tone}`}>{uwbConnection.label}</strong>
        </article>
        <article className="status-card status-card-recording">
          <span className="status-label">Recording Status</span>
          <div className="status-card-row">
            <strong className={`status-badge ${recording ? 'good' : 'neutral'}`}>{recording ? 'Recording' : 'Standby'}</strong>
            <button type="button" className={recording ? 'ghost-button danger' : 'primary-button'} onClick={handleRecordingToggle}>
              {recording ? 'Stop Recording' : 'Start Recording'}
            </button>
          </div>
        </article>
      </section>

      <section className="toolbar-card">
        <div className="toolbar-block">
          <span className="section-kicker">Serial Input</span>
          <div className="toolbar-actions">
            <button type="button" className="primary-button" onClick={() => void bleSerial.connect(handleBleValue)}>
              Connect BLE Serial
            </button>
            <button type="button" className="primary-button" onClick={() => void uwbSerial.connect(handleUwbValue)}>
              Connect UWB Serial
            </button>
            <button type="button" className="ghost-button" onClick={() => void bleSerial.disconnect()}>
              Disconnect BLE
            </button>
            <button type="button" className="ghost-button" onClick={() => void uwbSerial.disconnect()}>
              Disconnect UWB
            </button>
          </div>
        </div>
        <div className="toolbar-block">
          <span className="section-kicker">Export</span>
          <div className="toolbar-actions">
            <button type="button" className="ghost-button" onClick={exportBleCsv} disabled={bleScans.length === 0}>
              BLE CSV
            </button>
            <button type="button" className="ghost-button" onClick={exportUwbCsv} disabled={uwbRanges.length === 0}>
              UWB CSV
            </button>
            <button type="button" className="ghost-button" onClick={exportEventCsv} disabled={events.length === 0}>
              Event CSV
            </button>
            <button type="button" className="ghost-button" onClick={exportMergedCsv} disabled={bleScans.length + uwbRanges.length + events.length === 0}>
              Merged Dashboard CSV
            </button>
          </div>
        </div>
      </section>

      <section className="condition-card">
        <div className="condition-card-head">
          <div>
            <span className="section-kicker">Condition Selector</span>
            <h1>Early Occlusion Validation Monitor</h1>
          </div>
          <p>Select one of the four occlusion conditions. Each change is logged as a CONDITION_CHANGED event and marked on both charts.</p>
        </div>
        <div className="condition-grid">
          {CONDITIONS.map((condition) => {
            const active = condition === currentCondition;
            return (
              <button
                key={condition}
                type="button"
                className={`condition-button ${active ? 'active' : ''}`}
                style={{ '--condition-accent': CONDITION_COLORS[condition] } as CSSProperties}
                onClick={() => handleConditionChange(condition)}
              >
                <span className="condition-swatch" />
                <span>{condition}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="monitor-grid">
        <article className="monitor-panel ble-panel">
          <div className="panel-head-row">
            <div>
              <span className="section-kicker">Left Panel</span>
              <h2>BLE Monitor</h2>
            </div>
            <strong className={`status-badge ${bleConnection.tone}`}>{bleConnection.label}</strong>
          </div>

          <div className="primary-readout">
            <span className="primary-label">Latest RSSI</span>
            <strong>{latestBle ? `${latestBle.rssi} dBm` : 'No data'}</strong>
          </div>

          <div className="metric-grid">
            <div className="metric-card">
              <span className="metric-label">Device Name</span>
              <strong>{latestBle?.deviceName ?? 'Waiting for BLE packets'}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Node ID</span>
              <strong>{latestBle?.nodeId ?? 'N/A'}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Packet Rate</span>
              <strong>{blePacketRate}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Last Update Age</span>
              <strong>{formatAgo(latestBle?.receivedAt ?? bleSerial.lastValueAt)}</strong>
            </div>
          </div>

          <LineChart title="RSSI Time-Series" points={bleChartPoints} markers={conditionMarkers} accent="#3a86ff" unit="dBm" emptyLabel="BLE RSSI will appear here once packets arrive." />

          <div className="diagnostic-grid">
            <div className="diagnostic-card">
              <span className="metric-label">Parsed Samples</span>
              <strong>{bleSerial.parsedValueCount}</strong>
            </div>
            <div className="diagnostic-card">
              <span className="metric-label">Parse Errors</span>
              <strong>{bleSerial.parseErrorCount}</strong>
            </div>
            <div className="diagnostic-card diagnostic-card-wide">
              <span className="metric-label">Serial Status</span>
              <strong>{bleSerial.error || bleSerial.lastLine || 'Ready for BLE serial input.'}</strong>
            </div>
          </div>
        </article>

        <article className="monitor-panel uwb-panel">
          <div className="panel-head-row">
            <div>
              <span className="section-kicker">Right Panel</span>
              <h2>UWB Monitor</h2>
            </div>
            <strong className={`status-badge ${uwbConnection.tone}`}>{uwbConnection.label}</strong>
          </div>

          <div className="primary-readout">
            <span className="primary-label">Latest Range</span>
            <strong>{latestUwb?.rangeM === null || latestUwb?.rangeM === undefined ? 'No data' : `${latestUwb.rangeM.toFixed(3)} m`}</strong>
          </div>

          <div className="metric-grid">
            <div className="metric-card">
              <span className="metric-label">Latest Status</span>
              <strong>{latestUwb?.status ?? 'Waiting for UWB frames'}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Valid Range Rate</span>
              <strong>{uwbValidRate}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Timeout Rate</span>
              <strong>{uwbTimeoutRate}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Last Update Age</span>
              <strong>{formatAgo(latestUwb?.receivedAt ?? uwbSerial.lastValueAt)}</strong>
            </div>
          </div>

          <LineChart title="UWB Range Time-Series" points={uwbChartPoints} markers={conditionMarkers} accent="#2a9d8f" unit="m" emptyLabel="UWB range will appear here once the initiator streams measurements." />
          <StatusTimeline samples={uwbRanges} markers={conditionMarkers} />

          <div className="diagnostic-grid">
            <div className="diagnostic-card">
              <span className="metric-label">Parsed Frames</span>
              <strong>{uwbSerial.parsedValueCount}</strong>
            </div>
            <div className="diagnostic-card">
              <span className="metric-label">Parse Errors</span>
              <strong>{uwbSerial.parseErrorCount}</strong>
            </div>
            <div className="diagnostic-card diagnostic-card-wide">
              <span className="metric-label">Serial Status</span>
              <strong>{uwbSerial.error || uwbSerial.lastLine || 'Ready for UWB serial input.'}</strong>
            </div>
          </div>
        </article>
      </section>

      <section className="bottom-grid">
        <article className="bottom-panel">
          <div className="panel-head-row compact">
            <div>
              <span className="section-kicker">Condition Events</span>
              <h2>Recent Event Log</h2>
            </div>
          </div>
          <div className="event-list">
            {recentEvents.length === 0 ? <div className="event-empty">No dashboard events yet.</div> : null}
            {recentEvents.map((event) => (
              <div key={event.id} className="event-item">
                <span className="event-time">{formatDuration(event.elapsedMs)}</span>
                <div>
                  <strong>{event.type}</strong>
                  <p>{event.detail}</p>
                </div>
                <span className="event-condition" style={{ color: CONDITION_COLORS[event.condition] }}>
                  {event.condition}
                </span>
              </div>
            ))}
          </div>
        </article>

        <article className="bottom-panel">
          <div className="panel-head-row compact">
            <div>
              <span className="section-kicker">At A Glance</span>
              <h2>Live Validation Summary</h2>
            </div>
          </div>
          <ul className="summary-list">
            <li>BLE is measurable when the BLE card shows a live RSSI value and packet rate above 0.</li>
            <li>UWB is ranging when the UWB card shows a live range value and a valid range rate above 0.</li>
            <li>Timeout behavior is visible immediately through the latest UWB status and the status timeline.</li>
            <li>Condition changes are stamped into the event log and drawn as vertical markers across both charts.</li>
          </ul>
        </article>
      </section>
    </main>
  );
}

export default App;