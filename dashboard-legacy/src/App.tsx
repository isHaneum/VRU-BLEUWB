import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { formatAgo, parseBleScannerLine, parsePhoneCsv, parseUwbLine } from './parsers';
import type { BleScan, PhoneEvent, UwbRange } from './types';
import { useSerialSource } from './useSerialSource';

const CONDITIONS = [
  'Visible / No Obstacle',
  'Wall / Corner',
  'Metal / Vehicle Occlusion',
  'Human Occlusion'
] as const;

type ConditionOption = typeof CONDITIONS[number];
type DashboardEventType = 'CONDITION_CHANGED' | 'RECORDING_STARTED' | 'RECORDING_STOPPED';
type UwbSourceSlot = 'uwbA' | 'uwbB';

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
  sourceSlot: UwbSourceSlot;
};

type AnalyzedUwbRange = LiveUwbRange & {
  effectiveCondition: ConditionOption;
};

type SyncedPhoneEvent = PhoneEvent & {
  adjustedElapsedMs: number;
  mappedCondition: ConditionOption | null;
};

type PhoneConditionEvent = {
  id: string;
  elapsedMs: number;
  condition: ConditionOption;
  event: string;
  note: string;
  nodeId: string;
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

type UnifiedTimelineEvent = {
  id: string;
  elapsedMs: number;
  sourceLabel: string;
  title: string;
  detail: string;
  condition: ConditionOption | null;
};

type UwbNodeSummary = {
  sourceSlot: UwbSourceSlot;
  nodeId: string;
  latestStatus: string;
  latestRangeM: number | null;
  lastUpdateAt: number;
  effectiveCondition: ConditionOption;
};

type ConditionStat = {
  condition: ConditionOption;
  sampleCount: number;
  validCount: number;
  mean: number | null;
  min: number | null;
  max: number | null;
};

const CONDITION_COLORS: Record<ConditionOption, string> = {
  'Visible / No Obstacle': '#2a9d8f',
  'Wall / Corner': '#e9c46a',
  'Metal / Vehicle Occlusion': '#e76f51',
  'Human Occlusion': '#3a86ff'
};

const STATUS_COLORS: Record<string, string> = {
  OK: '#2a9d8f',
  TIMEOUT: '#b8572f',
  INVALID_MSG: '#8c5cff',
  INVALID_RANGE: '#e9c46a',
  DRIVER_STUB: '#64748b',
  RESPONDER_IDLE: '#94a3b8',
  WAITING: '#94a3b8',
  INIT_ERROR: '#c75b3f',
  RESPONDER_ERROR: '#c75b3f',
  ROLE_INITIATOR: '#2f6690',
  ROLE_RESPONDER: '#9a6d38',
  LOG: '#94a3b8',
  UNKNOWN: '#64748b'
};

const CHART_WIDTH = 760;
const CHART_HEIGHT = 220;
const CHART_PADDING = { top: 20, right: 18, bottom: 28, left: 18 };
const SUMMARY_WINDOW_MS = 10000;

const toIso = (timestamp: number) => new Date(timestamp).toISOString();

const slotLabel = (sourceSlot: UwbSourceSlot) => (sourceSlot === 'uwbA' ? 'UWB-A' : 'UWB-B');

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

const normalizeLookupText = (value: string) => value.trim().toUpperCase().replace(/[_-]+/g, ' ');

const matchConditionFromText = (value: string) => {
  const normalized = normalizeLookupText(value);

  if (!normalized) {
    return null;
  }

  if (normalized.includes('VISIBLE') || normalized.includes('NO OBSTACLE')) {
    return 'Visible / No Obstacle';
  }

  if (normalized.includes('WALL') || normalized.includes('CORNER')) {
    return 'Wall / Corner';
  }

  if (normalized.includes('HUMAN')) {
    return 'Human Occlusion';
  }

  if (normalized.includes('METAL') || normalized.includes('VEHICLE') || normalized.includes('CAR OCCLUDED')) {
    return 'Metal / Vehicle Occlusion';
  }

  return null;
};

const shortConditionLabel = (condition: ConditionOption) => {
  switch (condition) {
    case 'Visible / No Obstacle':
      return 'Visible';
    case 'Wall / Corner':
      return 'Wall';
    case 'Metal / Vehicle Occlusion':
      return 'Metal';
    case 'Human Occlusion':
      return 'Human';
    default:
      return condition;
  }
};

const getPhoneCondition = (event: PhoneEvent) => {
  return matchConditionFromText(event.occlusionState) ?? matchConditionFromText(event.event);
};

const getConditionForElapsed = (elapsedMs: number, timeline: PhoneConditionEvent[], fallback: ConditionOption) => {
  let activeCondition = fallback;

  for (const marker of timeline) {
    if (marker.elapsedMs > elapsedMs) {
      break;
    }

    activeCondition = marker.condition;
  }

  return activeCondition;
};

const buildPhoneEventDetail = (event: PhoneEvent) => {
  const parts = [
    event.note,
    event.occlusionState,
    event.targetMotion,
    event.carryPosition,
    event.riskLabel,
    event.nodeId
  ].filter(Boolean);

  return parts.join(' · ') || 'Imported from phone CSV.';
};

const findLastValidRange = (ranges: AnalyzedUwbRange[]) => {
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const sample = ranges[index];
    if (sample.status === 'OK' && sample.rangeM !== null) {
      return sample;
    }
  }

  return null;
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
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const visiblePoints = points;
  const { path, minValue, maxValue, minX, maxX } = buildLinePath(visiblePoints);
  const innerWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const innerHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const domain = Math.max(1, maxX - minX);
  const inspectedPoint = scrubIndex === null ? null : visiblePoints[scrubIndex] ?? null;

  const updateScrubFromClientX = (clientX: number) => {
    if (!svgRef.current || visiblePoints.length === 0) {
      return;
    }

    const bounds = svgRef.current.getBoundingClientRect();
    const relativeX = clamp(((clientX - bounds.left) / Math.max(1, bounds.width)) * CHART_WIDTH, CHART_PADDING.left, CHART_WIDTH - CHART_PADDING.right);
    const nextIndex = Math.round(((relativeX - CHART_PADDING.left) / Math.max(1, innerWidth)) * (visiblePoints.length - 1));
    setScrubIndex(clamp(nextIndex, 0, visiblePoints.length - 1));
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    setIsScrubbing(true);
    updateScrubFromClientX(event.clientX);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!isScrubbing && event.buttons === 0) {
      return;
    }

    updateScrubFromClientX(event.clientX);
  };

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    setIsScrubbing(false);
    updateScrubFromClientX(event.clientX);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handlePointerLeave = () => {
    if (!isScrubbing) {
      setScrubIndex(null);
    }
  };

  const inspectedMarker = inspectedPoint
    ? markers.filter((marker) => Math.abs(marker.elapsedMs - inspectedPoint.elapsedMs) <= 1200).at(-1) ?? null
    : null;
  const inspectedX = inspectedPoint ? CHART_PADDING.left + ((inspectedPoint.elapsedMs - minX) / domain) * innerWidth : null;
  const inspectedY = inspectedPoint
    ? CHART_PADDING.top + (1 - (inspectedPoint.value - minValue) / Math.max(1, maxValue - minValue)) * innerHeight
    : null;

  return (
    <div className="chart-card">
      <div className="chart-head">
        <span className="chart-title">{title}</span>
        {visiblePoints.length > 0 ? (
          <span className="chart-range">
            {minValue.toFixed(1)} to {maxValue.toFixed(1)} {unit}
          </span>
        ) : null}
      </div>
      {visiblePoints.length > 0 ? (
        <div className="chart-inspector">
          <span>{inspectedPoint ? `Time ${formatDuration(inspectedPoint.elapsedMs)}` : 'Drag or hover on the chart to inspect a point.'}</span>
          <strong>
            {inspectedPoint ? `${inspectedPoint.value.toFixed(1)} ${unit}` : `Total ${visiblePoints.length} samples`}
          </strong>
          <span>{inspectedMarker ? `Condition marker: ${inspectedMarker.label}` : 'Condition markers combine dashboard tags and imported phone labels.'}</span>
        </div>
      ) : null}
      {visiblePoints.length === 0 ? (
        <div className="chart-empty">{emptyLabel}</div>
      ) : (
        <svg
          ref={svgRef}
          className="chart-svg chart-svg-interactive"
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={title}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
        >
          <line x1={CHART_PADDING.left} y1={CHART_HEIGHT - CHART_PADDING.bottom} x2={CHART_WIDTH - CHART_PADDING.right} y2={CHART_HEIGHT - CHART_PADDING.bottom} className="chart-axis" />
          <line x1={CHART_PADDING.left} y1={CHART_PADDING.top} x2={CHART_PADDING.left} y2={CHART_HEIGHT - CHART_PADDING.bottom} className="chart-axis" />
          <rect x={CHART_PADDING.left} y={CHART_PADDING.top} width={innerWidth} height={innerHeight} fill="transparent" />
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
          {visiblePoints.map((point) => {
            const x = CHART_PADDING.left + ((point.elapsedMs - minX) / domain) * innerWidth;
            const y = CHART_PADDING.top + (1 - (point.value - minValue) / Math.max(1, maxValue - minValue)) * innerHeight;
            return <circle key={`${point.elapsedMs}-${point.value}`} cx={x} cy={y} r="2.5" fill={accent} />;
          })}
          {inspectedPoint !== null && inspectedX !== null && inspectedY !== null ? (
            <g>
              <line x1={inspectedX} y1={CHART_PADDING.top} x2={inspectedX} y2={CHART_HEIGHT - CHART_PADDING.bottom} className="chart-scrub-line" />
              <circle cx={inspectedX} cy={inspectedY} r="6" className="chart-scrub-dot" style={{ fill: accent }} />
            </g>
          ) : null}
          <text x={CHART_PADDING.left} y={16} className="chart-axis-label">{maxValue.toFixed(1)} {unit}</text>
          <text x={CHART_PADDING.left} y={CHART_HEIGHT - CHART_PADDING.bottom - 6} className="chart-axis-label">{minValue.toFixed(1)} {unit}</text>
          <text x={CHART_PADDING.left} y={CHART_HEIGHT - 8} className="chart-axis-label chart-axis-label-bottom">00:00:00</text>
          <text x={CHART_WIDTH - CHART_PADDING.right} y={CHART_HEIGHT - 8} textAnchor="end" className="chart-axis-label chart-axis-label-bottom">{formatDuration(maxX)}</text>
        </svg>
      )}
    </div>
  );
}

function StatusTimeline({ samples, markers }: { samples: AnalyzedUwbRange[]; markers: ChartMarker[] }) {
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

          return <rect key={`${sample.elapsedMs}-${sample.sourceSlot}-${sample.seqId ?? index}`} x={currentX} y="28" width={width} height="34" rx="6" fill={fill} opacity="0.92" />;
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
  const [phoneEvents, setPhoneEvents] = useState<PhoneEvent[]>([]);
  const [phoneImportName, setPhoneImportName] = useState('');
  const [phoneTimeOffsetMs, setPhoneTimeOffsetMs] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const sessionAnchorRef = useRef<number | null>(null);
  const conditionRef = useRef<ConditionOption>(currentCondition);
  const phoneFileInputRef = useRef<HTMLInputElement | null>(null);

  const bleSerial = useSerialSource(parseBleScannerLine);
  const uwbSerialA = useSerialSource(parseUwbLine);
  const uwbSerialB = useSerialSource(parseUwbLine);

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

  const handleUwbValue = (sourceSlot: UwbSourceSlot) => (value: UwbRange) => {
    const anchor = ensureSessionAnchor(value.receivedAt);
    const nextValue: LiveUwbRange = {
      ...value,
      condition: conditionRef.current,
      elapsedMs: value.receivedAt - anchor,
      receivedIso: toIso(value.receivedAt),
      sourceSlot
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

  const handlePhoneCsvImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    const parsed = parsePhoneCsv(await file.text()).sort((left, right) => left.timeS - right.timeS);
    setPhoneImportName(file.name);
    startTransition(() => {
      setPhoneEvents(parsed);
    });

    if (parsed[0]?.experimentId && experimentId.startsWith('occlusion-')) {
      setExperimentId(parsed[0].experimentId);
    }
  };

  const clearPhoneImport = () => {
    setPhoneEvents([]);
    setPhoneImportName('');
    setPhoneTimeOffsetMs(0);
  };

  const elapsedMs = sessionAnchorAt === null ? 0 : now - sessionAnchorAt;
  const latestBle = bleScans[bleScans.length - 1] ?? null;

  const syncedPhoneEvents = useMemo<SyncedPhoneEvent[]>(() => {
    return phoneEvents.map((phoneEvent) => ({
      ...phoneEvent,
      adjustedElapsedMs: Math.max(0, Math.round(phoneEvent.timeS * 1000 + phoneTimeOffsetMs)),
      mappedCondition: getPhoneCondition(phoneEvent)
    }));
  }, [phoneEvents, phoneTimeOffsetMs]);

  const phoneConditionTimeline = useMemo<PhoneConditionEvent[]>(() => {
    return syncedPhoneEvents.flatMap((phoneEvent, index) => {
      if (phoneEvent.mappedCondition === null) {
        return [];
      }

      return [{
        id: `${phoneEvent.event}-${phoneEvent.adjustedElapsedMs}-${index}`,
        elapsedMs: phoneEvent.adjustedElapsedMs,
        condition: phoneEvent.mappedCondition,
        event: phoneEvent.event,
        note: phoneEvent.note,
        nodeId: phoneEvent.nodeId
      }];
    });
  }, [syncedPhoneEvents]);

  const analyzedUwbRanges = useMemo<AnalyzedUwbRange[]>(() => {
    return uwbRanges.map((range) => ({
      ...range,
      effectiveCondition: getConditionForElapsed(range.elapsedMs, phoneConditionTimeline, range.condition)
    }));
  }, [uwbRanges, phoneConditionTimeline]);

  const latestUwbFrame = analyzedUwbRanges[analyzedUwbRanges.length - 1] ?? null;
  const latestValidUwb = useMemo(() => findLastValidRange(analyzedUwbRanges), [analyzedUwbRanges]);

  const dashboardConditionMarkers = useMemo<ChartMarker[]>(() => {
    return events
      .filter((dashboardEvent) => dashboardEvent.type === 'CONDITION_CHANGED')
      .map((dashboardEvent) => ({
        elapsedMs: dashboardEvent.elapsedMs,
        label: shortConditionLabel(dashboardEvent.condition),
        color: CONDITION_COLORS[dashboardEvent.condition]
      }));
  }, [events]);

  const phoneConditionMarkers = useMemo<ChartMarker[]>(() => {
    return phoneConditionTimeline.map((phoneEvent) => ({
      elapsedMs: phoneEvent.elapsedMs,
      label: `Phone ${shortConditionLabel(phoneEvent.condition)}`,
      color: CONDITION_COLORS[phoneEvent.condition]
    }));
  }, [phoneConditionTimeline]);

  const conditionMarkers = useMemo<ChartMarker[]>(() => {
    return [...dashboardConditionMarkers, ...phoneConditionMarkers].sort((left, right) => left.elapsedMs - right.elapsedMs);
  }, [dashboardConditionMarkers, phoneConditionMarkers]);

  const bleRecentWindow = useMemo(() => bleScans.filter((scan) => now - scan.receivedAt <= SUMMARY_WINDOW_MS), [bleScans, now]);
  const uwbRecentWindow = useMemo(() => analyzedUwbRanges.filter((range) => now - range.receivedAt <= SUMMARY_WINDOW_MS), [analyzedUwbRanges, now]);
  const bleChartPoints = useMemo<NumericPoint[]>(() => bleScans.map((scan) => ({ elapsedMs: scan.elapsedMs, value: scan.rssi })), [bleScans]);
  const uwbChartPoints = useMemo<NumericPoint[]>(() => {
    return analyzedUwbRanges
      .filter((range) => range.status === 'OK' && range.rangeM !== null)
      .map((range) => ({ elapsedMs: range.elapsedMs, value: range.rangeM ?? 0 }));
  }, [analyzedUwbRanges]);

  const blePacketRate = formatRate(bleRecentWindow.length, SUMMARY_WINDOW_MS);
  const uwbValidRate = formatRate(uwbRecentWindow.filter((range) => range.status === 'OK' && range.rangeM !== null).length, SUMMARY_WINDOW_MS);
  const uwbTimeoutRate = formatRate(uwbRecentWindow.filter((range) => range.status === 'TIMEOUT').length, SUMMARY_WINDOW_MS);

  const bleConnection = getConnectionSummary(bleSerial.connectionState, bleSerial.isSupported, bleSerial.error, bleSerial.lastValueAt, now);
  const uwbConnectionA = getConnectionSummary(uwbSerialA.connectionState, uwbSerialA.isSupported, uwbSerialA.error, uwbSerialA.lastValueAt, now);
  const uwbConnectionB = getConnectionSummary(uwbSerialB.connectionState, uwbSerialB.isSupported, uwbSerialB.error, uwbSerialB.lastValueAt, now);

  const uwbLastUpdateAt = Math.max(uwbSerialA.lastValueAt ?? 0, uwbSerialB.lastValueAt ?? 0) || null;

  const uwbNodeSummaries = useMemo<UwbNodeSummary[]>(() => {
    const latestBySlot = new Map<UwbSourceSlot, AnalyzedUwbRange>();

    for (const sample of analyzedUwbRanges) {
      latestBySlot.set(sample.sourceSlot, sample);
    }

    return Array.from(latestBySlot.values())
      .map((sample) => ({
        sourceSlot: sample.sourceSlot,
        nodeId: sample.nodeId,
        latestStatus: sample.status,
        latestRangeM: sample.status === 'OK' ? sample.rangeM : null,
        lastUpdateAt: sample.receivedAt,
        effectiveCondition: sample.effectiveCondition
      }))
      .sort((left, right) => left.sourceSlot.localeCompare(right.sourceSlot));
  }, [analyzedUwbRanges]);

  const conditionStats = useMemo<ConditionStat[]>(() => {
    return CONDITIONS.map((condition) => {
      const samples = analyzedUwbRanges.filter((range) => range.effectiveCondition === condition);
      const validValues = samples
        .filter((range) => range.status === 'OK' && range.rangeM !== null)
        .map((range) => range.rangeM ?? 0);

      if (validValues.length === 0) {
        return {
          condition,
          sampleCount: samples.length,
          validCount: 0,
          mean: null,
          min: null,
          max: null
        };
      }

      const total = validValues.reduce((sum, value) => sum + value, 0);
      return {
        condition,
        sampleCount: samples.length,
        validCount: validValues.length,
        mean: total / validValues.length,
        min: Math.min(...validValues),
        max: Math.max(...validValues)
      };
    });
  }, [analyzedUwbRanges]);

  const recentEvents = useMemo<UnifiedTimelineEvent[]>(() => {
    const dashboardEvents = events.map((dashboardEvent) => ({
      id: dashboardEvent.id,
      elapsedMs: dashboardEvent.elapsedMs,
      sourceLabel: 'Dashboard',
      title: dashboardEvent.type,
      detail: dashboardEvent.detail,
      condition: dashboardEvent.condition
    }));

    const importedPhoneEvents = syncedPhoneEvents.map((phoneEvent, index) => ({
      id: `phone-${phoneEvent.event}-${phoneEvent.adjustedElapsedMs}-${index}`,
      elapsedMs: phoneEvent.adjustedElapsedMs,
      sourceLabel: 'Phone CSV',
      title: phoneEvent.event,
      detail: buildPhoneEventDetail(phoneEvent),
      condition: phoneEvent.mappedCondition
    }));

    return [...dashboardEvents, ...importedPhoneEvents]
      .sort((left, right) => right.elapsedMs - left.elapsedMs)
      .slice(0, 10);
  }, [events, syncedPhoneEvents]);

  const exportBleCsv = () => {
    downloadCsv(
      `${experimentId}-ble.csv`,
      ['received_at_iso', 'elapsed_ms', 'dashboard_condition', 'timestamp_ms', 'node_id', 'seq_id', 'device_name', 'mac', 'rssi', 'manufacturer_data_hex'],
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
      ['received_at_iso', 'elapsed_ms', 'source_slot', 'dashboard_condition', 'analysis_condition', 'timestamp_ms', 'node_id', 'seq_id', 'range_m', 'status', 'raw'],
      analyzedUwbRanges.map((range) => [
        range.receivedIso,
        range.elapsedMs,
        slotLabel(range.sourceSlot),
        range.condition,
        range.effectiveCondition,
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
      ['source', 'elapsed_ms', 'received_at_iso', 'event_type', 'condition', 'detail'],
      [
        ...events.map((dashboardEvent) => [
          'dashboard',
          dashboardEvent.elapsedMs,
          toIso(dashboardEvent.receivedAt),
          dashboardEvent.type,
          dashboardEvent.condition,
          dashboardEvent.detail
        ]),
        ...syncedPhoneEvents.map((phoneEvent) => [
          'phone_csv',
          phoneEvent.adjustedElapsedMs,
          '',
          phoneEvent.event,
          phoneEvent.mappedCondition,
          buildPhoneEventDetail(phoneEvent)
        ])
      ]
    );
  };

  const exportMergedCsv = () => {
    const mergedRows = [
      ...bleScans.map((scan) => ({
        kind: 'BLE',
        sortKey: scan.receivedAt,
        values: [scan.receivedIso, scan.elapsedMs, '', scan.condition, scan.condition, scan.timestampMs, scan.nodeId, scan.seqId, scan.deviceName, scan.mac, scan.rssi, scan.manufacturerDataHex, '', '', '', '', '', '', '', '']
      })),
      ...analyzedUwbRanges.map((range) => ({
        kind: 'UWB',
        sortKey: range.receivedAt,
        values: [range.receivedIso, range.elapsedMs, slotLabel(range.sourceSlot), range.condition, range.effectiveCondition, range.timestampMs, range.nodeId, range.seqId, '', '', '', '', range.rangeM, range.status, range.raw, '', '', '', '', '']
      })),
      ...events.map((dashboardEvent) => ({
        kind: 'EVENT',
        sortKey: dashboardEvent.receivedAt,
        values: [toIso(dashboardEvent.receivedAt), dashboardEvent.elapsedMs, 'Dashboard', dashboardEvent.condition, dashboardEvent.condition, '', '', '', '', '', '', '', '', dashboardEvent.type, dashboardEvent.detail, '', '', '', '', '']
      })),
      ...syncedPhoneEvents.map((phoneEvent) => ({
        kind: 'PHONE',
        sortKey: phoneEvent.adjustedElapsedMs,
        values: ['', phoneEvent.adjustedElapsedMs, 'Phone CSV', '', phoneEvent.mappedCondition, '', phoneEvent.nodeId, '', '', '', '', '', '', phoneEvent.event, buildPhoneEventDetail(phoneEvent), phoneEvent.note, phoneEvent.occlusionState, phoneEvent.carryPosition, phoneEvent.riskLabel, phoneEvent.targetMotion]
      }))
    ].sort((left, right) => left.sortKey - right.sortKey);

    downloadCsv(
      `${experimentId}-dashboard-merged.csv`,
      ['kind', 'received_at_iso', 'elapsed_ms', 'source_slot', 'dashboard_condition', 'analysis_condition', 'timestamp_ms', 'node_id', 'seq_id', 'device_name', 'mac', 'rssi', 'manufacturer_data_hex', 'range_m', 'status_or_event_type', 'detail_or_raw', 'phone_note', 'phone_occlusion_state', 'phone_carry_position', 'phone_risk_label', 'phone_target_motion'],
      mergedRows.map((row) => [row.kind, ...row.values])
    );
  };

  return (
    <main className="app-shell">
      <input ref={phoneFileInputRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => void handlePhoneCsvImport(event)} />

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
          <span className="status-label">Dashboard Condition</span>
          <strong className="status-value status-value-wrap">{currentCondition}</strong>
        </article>
        <article className="status-card">
          <span className="status-label">BLE Connection</span>
          <strong className={`status-badge ${bleConnection.tone}`}>{bleConnection.label}</strong>
        </article>
        <article className="status-card">
          <span className="status-label">UWB-A Connection</span>
          <strong className={`status-badge ${uwbConnectionA.tone}`}>{uwbConnectionA.label}</strong>
        </article>
        <article className="status-card">
          <span className="status-label">UWB-B Connection</span>
          <strong className={`status-badge ${uwbConnectionB.tone}`}>{uwbConnectionB.label}</strong>
        </article>
        <article className="status-card">
          <span className="status-label">Phone CSV</span>
          <div className="status-card-row">
            <strong className={`status-badge ${phoneEvents.length > 0 ? 'good' : 'neutral'}`}>{phoneEvents.length > 0 ? `${phoneEvents.length} Events` : 'Not Loaded'}</strong>
            <button type="button" className="ghost-button" onClick={() => phoneFileInputRef.current?.click()}>
              Load CSV
            </button>
          </div>
          <span className="chart-range">{phoneImportName ? `${phoneImportName} · Offset ${phoneTimeOffsetMs} ms` : 'Import the iPhone CSV to align occlusion labels with UWB.'}</span>
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
        <div className="toolbar-block toolbar-block-wide">
          <span className="section-kicker">Serial Input</span>
          <div className="toolbar-actions">
            <button type="button" className="primary-button" onClick={() => void bleSerial.connect(handleBleValue)}>
              Connect BLE Serial
            </button>
            <button type="button" className="primary-button" onClick={() => void uwbSerialA.connect(handleUwbValue('uwbA'))}>
              Connect UWB-A
            </button>
            <button type="button" className="primary-button" onClick={() => void uwbSerialB.connect(handleUwbValue('uwbB'))}>
              Connect UWB-B
            </button>
            <button type="button" className="ghost-button" onClick={() => void bleSerial.disconnect()}>
              Disconnect BLE
            </button>
            <button type="button" className="ghost-button" onClick={() => void uwbSerialA.disconnect()}>
              Disconnect UWB-A
            </button>
            <button type="button" className="ghost-button" onClick={() => void uwbSerialB.disconnect()}>
              Disconnect UWB-B
            </button>
          </div>
        </div>
        <div className="toolbar-block toolbar-block-wide">
          <span className="section-kicker">Phone Sync</span>
          <div className="toolbar-actions">
            <button type="button" className="primary-button" onClick={() => phoneFileInputRef.current?.click()}>
              Import Phone CSV
            </button>
            <button type="button" className="ghost-button" onClick={clearPhoneImport} disabled={phoneEvents.length === 0}>
              Clear Phone CSV
            </button>
            <input
              className="toolbar-input"
              type="number"
              step="100"
              value={phoneTimeOffsetMs}
              onChange={(event) => setPhoneTimeOffsetMs(Number.parseInt(event.target.value, 10) || 0)}
              aria-label="Phone time offset in milliseconds"
            />
          </div>
          <span className="chart-range">Use a positive offset when the phone log lags behind the UWB serial timestamps.</span>
        </div>
        <div className="toolbar-block toolbar-block-wide">
          <span className="section-kicker">Export</span>
          <div className="toolbar-actions">
            <button type="button" className="ghost-button" onClick={exportBleCsv} disabled={bleScans.length === 0}>
              BLE CSV
            </button>
            <button type="button" className="ghost-button" onClick={exportUwbCsv} disabled={analyzedUwbRanges.length === 0}>
              UWB CSV
            </button>
            <button type="button" className="ghost-button" onClick={exportEventCsv} disabled={events.length + syncedPhoneEvents.length === 0}>
              Event CSV
            </button>
            <button type="button" className="ghost-button" onClick={exportMergedCsv} disabled={bleScans.length + analyzedUwbRanges.length + events.length + syncedPhoneEvents.length === 0}>
              Merged Dashboard CSV
            </button>
          </div>
        </div>
      </section>

      <section className="condition-card">
        <div className="condition-card-head">
          <div>
            <span className="section-kicker">Condition Selector</span>
            <h1>Two-Node UWB + Phone Sync Monitor</h1>
          </div>
          <p>Dashboard condition changes and imported phone labels are both stamped as chart markers. Imported phone occlusion labels override the analysis condition used in the UWB summary cards.</p>
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
            <div className="diagnostic-card">
              <span className="metric-label">Serial Status</span>
              <strong>{bleSerial.error || bleSerial.lastLine || 'Ready for BLE serial input.'}</strong>
            </div>
          </div>
        </article>

        <article className="monitor-panel uwb-panel">
          <div className="panel-head-row compact">
            <div>
              <span className="section-kicker">Right Panel</span>
              <h2>Two-Node UWB Monitor</h2>
            </div>
            <div className="toolbar-actions">
              <strong className={`status-badge ${uwbConnectionA.tone}`}>{slotLabel('uwbA')} {uwbConnectionA.label}</strong>
              <strong className={`status-badge ${uwbConnectionB.tone}`}>{slotLabel('uwbB')} {uwbConnectionB.label}</strong>
            </div>
          </div>

          <div className="primary-readout">
            <span className="primary-label">Latest Valid Range</span>
            <strong>{latestValidUwb ? `${latestValidUwb.rangeM!.toFixed(3)} m` : 'No valid range'}</strong>
            <span className="chart-range">
              {latestValidUwb ? `${slotLabel(latestValidUwb.sourceSlot)} · ${latestValidUwb.nodeId} · ${latestValidUwb.effectiveCondition}` : 'Both UWB ports can stream status immediately. A real range appears when a node reports status OK with range_m.'}
            </span>
          </div>

          <div className="metric-grid">
            <div className="metric-card">
              <span className="metric-label">Latest Status Frame</span>
              <strong>{latestUwbFrame?.status ?? 'Waiting for UWB frames'}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Last Range Node</span>
              <strong>{latestValidUwb ? `${slotLabel(latestValidUwb.sourceSlot)} / ${latestValidUwb.nodeId}` : 'No ranging yet'}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Valid Range Rate</span>
              <strong>{uwbValidRate}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Last Update Age</span>
              <strong>{formatAgo(uwbLastUpdateAt)}</strong>
            </div>
          </div>

          <div>
            <div className="chart-head">
              <span className="chart-title">Per-Node UWB Status</span>
              <span className="chart-range">Latest frame from each connected serial port</span>
            </div>
            <div className="metric-grid">
              {uwbNodeSummaries.length === 0 ? (
                <div className="metric-card">
                  <span className="metric-label">No UWB nodes yet</span>
                  <strong>Connect UWB-A and UWB-B to display both boards separately.</strong>
                </div>
              ) : null}
              {uwbNodeSummaries.map((summary) => (
                <div key={`${summary.sourceSlot}-${summary.nodeId}`} className="metric-card">
                  <span className="metric-label">{slotLabel(summary.sourceSlot)}</span>
                  <strong>{summary.nodeId}</strong>
                  <span className="chart-range">{summary.latestStatus} · {summary.latestRangeM === null ? 'Range unavailable' : `${summary.latestRangeM.toFixed(3)} m`} · {summary.effectiveCondition}</span>
                </div>
              ))}
            </div>
          </div>

          <LineChart title="UWB Range Time-Series" points={uwbChartPoints} markers={conditionMarkers} accent="#2a9d8f" unit="m" emptyLabel="UWB range will appear here once a node streams status OK with range_m." />
          <StatusTimeline samples={analyzedUwbRanges} markers={conditionMarkers} />

          <div className="diagnostic-grid">
            <div className="diagnostic-card">
              <span className="metric-label">UWB-A Parsed Frames</span>
              <strong>{uwbSerialA.parsedValueCount}</strong>
            </div>
            <div className="diagnostic-card">
              <span className="metric-label">UWB-B Parsed Frames</span>
              <strong>{uwbSerialB.parsedValueCount}</strong>
            </div>
            <div className="diagnostic-card">
              <span className="metric-label">Total Parse Errors</span>
              <strong>{uwbSerialA.parseErrorCount + uwbSerialB.parseErrorCount}</strong>
            </div>
            <div className="diagnostic-card">
              <span className="metric-label">UWB-A Serial</span>
              <strong>{uwbSerialA.error || uwbSerialA.lastLine || 'Ready for UWB-A serial input.'}</strong>
            </div>
            <div className="diagnostic-card">
              <span className="metric-label">UWB-B Serial</span>
              <strong>{uwbSerialB.error || uwbSerialB.lastLine || 'Ready for UWB-B serial input.'}</strong>
            </div>
          </div>
        </article>
      </section>

      <section className="bottom-grid">
        <article className="bottom-panel">
          <div className="panel-head-row compact">
            <div>
              <span className="section-kicker">Condition Events</span>
              <h2>Recent Synced Event Log</h2>
            </div>
          </div>
          <div className="event-list">
            {recentEvents.length === 0 ? <div className="event-empty">No dashboard or phone events yet.</div> : null}
            {recentEvents.map((event) => (
              <div key={event.id} className="event-item">
                <span className="event-time">{formatDuration(event.elapsedMs)}</span>
                <div>
                  <strong>{event.sourceLabel} · {event.title}</strong>
                  <p>{event.detail}</p>
                </div>
                <span className="event-condition" style={{ color: event.condition ? CONDITION_COLORS[event.condition] : '#8f8a78' }}>
                  {event.condition ?? 'Context only'}
                </span>
              </div>
            ))}
          </div>
        </article>

        <article className="bottom-panel">
          <div className="panel-head-row compact">
            <div>
              <span className="section-kicker">Analysis</span>
              <h2>Condition Range Summary</h2>
            </div>
          </div>
          <div className="metric-grid">
            {conditionStats.map((stat) => (
              <div key={stat.condition} className="metric-card">
                <span className="metric-label">{stat.condition}</span>
                <strong>{stat.mean === null ? 'No valid ranges' : `${stat.mean.toFixed(2)} m avg`}</strong>
                <span className="chart-range">
                  {stat.validCount}/{stat.sampleCount} valid
                  {stat.min !== null && stat.max !== null ? ` · ${stat.min.toFixed(2)} to ${stat.max.toFixed(2)} m` : ''}
                </span>
              </div>
            ))}
          </div>
        </article>

        <article className="bottom-panel">
          <div className="panel-head-row compact">
            <div>
              <span className="section-kicker">Workflow</span>
              <h2>Dashboard Guide</h2>
            </div>
          </div>
          <ul className="summary-list">
            <li>Connect BLE once, then connect both UWB serial ports separately as UWB-A and UWB-B so each board appears as its own node.</li>
            <li>Import the phone CSV and adjust the offset until its condition markers line up with the UWB status timeline.</li>
            <li>Range analysis cards use the imported phone occlusion labels when available, otherwise they fall back to manual dashboard condition changes.</li>
            <li>The merged dashboard CSV exports BLE, both UWB streams, dashboard events, and imported phone events on one shared timeline.</li>
          </ul>
        </article>
      </section>
    </main>
  );
}

export default App;
