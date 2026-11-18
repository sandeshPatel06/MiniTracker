import { useState, useEffect, useMemo, useRef } from 'react';
import { LogEntry, ProductivityStats, User, AppConfig } from '../types';
import { apiFetch } from '../api';
import { format } from 'date-fns';
import { AppIcon } from '../components/AppIcon';
import { canonicalAppName } from '../lib/appNames';
import { CustomSelect } from '../components/CustomSelect';
import { EmptyState } from '../components/EmptyState';
import { Alert } from '../components/Alert';
import { StatCard } from '../components/StatCard';
import { Icon } from '../components/Icon';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { localISODate, isPendingLog, isIdleLog, FOCUS_GOOD, FOCUS_OK } from '../utils';
import { isDesktopApp } from '../services/wailsBridge';

interface Props {
  logs: LogEntry[];
  stats?: ProductivityStats | null;
  loading: boolean;
  today: string;
  onDateChange: (date: string) => void;
  currentUser?: User | null;
  selectedUserId?: number | null;
  startDate?: string;
  endDate?: string;
  onUserChange?: (userId: number | null) => void;
  onDateRangeChange?: (start: string, end: string) => void;
  loadError?: string | null;
  onRetry?: () => void;
  config?: AppConfig | null;
}

// Shared chart chrome: 11px readable ticks, subtle grid, consistent
// hover states. Colors come from the brand palette (emerald primary,
// muted slate for secondary series) rather than per-chart hues.

function safeFormatDate(dateStr?: string | null, formatStr = 'MMMM d, yyyy', fallback = '—'): string {
  if (!dateStr) return fallback;
  try {
    const clean = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    const d = new Date(`${clean}T00:00:00`);
    return !Number.isNaN(d.getTime()) ? format(d, formatStr) : fallback;
  } catch {
    return fallback;
  }
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return '< 1m';
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(minutes)}m`;
}

const AXIS_TICK = { fontSize: 11, fill: 'var(--text-muted)' } as const;
const GRID_STROKE = 'var(--border-subtle)';

// Rating for one capture. The server always serializes productive_score as a
// number (0 for captures still awaiting AI analysis), so the boolean fallback
// exists only for robustness. Score averages in this page intentionally use
// analyzed captures only (see derived-data blocks) so pending rows can't drag
// ratings toward 0%.
function captureScore(log: LogEntry): number {
  if (typeof log.productive_score === 'number' && Number.isFinite(log.productive_score)) {
    return Math.max(0, Math.min(100, Math.round(log.productive_score)));
  }
  return log.is_productive ? 100 : 0;
}

// One analysis threshold → one tone. Focus is emerald; auxiliary
// entropy trend is muted slate so it can't compete with the primary
// series or look like a second "good/bad" dimension.
const FOCUS_PRIMARY = 'var(--accent-primary)';
const SERIES_MUTED = 'var(--text-muted)';

// Circular progress ring for productivity score
function ScoreRing({
  score,
  size = 62,
  strokeWidth = 6,
}: {
  score: number;
  size?: number;
  strokeWidth?: number;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedScore = Math.max(0, Math.min(100, score));
  const offset = circumference - (clampedScore / 100) * circumference;

  const color =
    clampedScore >= FOCUS_GOOD
      ? 'var(--accent-green)'
      : clampedScore >= FOCUS_OK
      ? 'var(--accent-amber)'
      : 'var(--accent-red)';

  return (
    <div
      className="an-score-ring"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="var(--border-subtle)"
          strokeWidth={strokeWidth}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          fill="none"
          style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.4, 0, 0.2, 1)' }}
        />
      </svg>
      <div className="an-score-ring-label">
        <span className="an-score-ring-val" style={{ color }}>
          {clampedScore}%
        </span>
      </div>
    </div>
  );
}

// Custom Tooltip Component. Fixed chrome (min-width + tabular-nums) so
// swapping values never shifts the tooltip frame; null values surface
// as "Pending analysis" instead of a fake 0%.
const CustomTooltip = ({
  active,
  payload,
  label,
  isDonut = false,
}: {
  active?: boolean;
  payload?: any[];
  label?: string;
  isDonut?: boolean;
}) => {
  if (!active || !payload?.length) return null;
  const header = label != null && label !== '' ? label : null;

  return (
    <div className="an-tooltip">
      {header && <div className="an-tooltip-label">{header}</div>}
      {payload.map((p, i) => {
        const noData = p.value == null;
        const display = noData
          ? (p.payload?.Captures === 0 ? 'No captures' : 'Pending analysis')
          : typeof p.value === 'number'
            ? Number.isNaN(p.value)
              ? '—'
              : `${Number.isInteger(p.value) ? p.value : p.value.toFixed(1)}${p.unit || ''}`
            : String(p.value);

        const dotColor =
          typeof (p.color || p.fill) === 'string' && (p.color || p.fill).startsWith('url(')
            ? 'var(--accent-primary)'
            : (p.color || p.fill);

        return (
          <div key={i} className="an-tooltip-row">
            <div className="an-tooltip-key">
              <div
                className="an-tooltip-dot"
                style={{ background: dotColor }}
              />
              <span>{p.name || p.dataKey}</span>
            </div>
            <span className="an-tooltip-val">
              {display}
              {isDonut && p.payload?.value != null ? ' captures' : ''}
            </span>
          </div>
        );
      })}
      {payload[0]?.payload?.Captures != null && !isDonut && (
        <div
          className="an-tooltip-row"
          style={{
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: 4,
            marginTop: 4,
          }}
        >
          <span style={{ color: 'var(--text-muted)' }}>Captures in hour:</span>
          <span className="an-tooltip-val">{payload[0].payload.Captures}</span>
        </div>
      )}
    </div>
  );
};

export default function Analytics({
  logs,
  stats: _stats,
  loading,
  today,
  onDateChange,
  currentUser,
  selectedUserId,
  startDate,
  endDate,
  onUserChange,
  onDateRangeChange,
  loadError,
  onRetry,
  config,
}: Props) {
  const [members, setMembers] = useState<{ id: number; full_name: string; email: string; role: string }[]>([]);

  useEffect(() => {
    if (isDesktopApp() || (currentUser?.role !== 'admin' && currentUser?.role !== 'owner')) {
      setMembers([]);
      return;
    }

    // Abort keeps a slow roster response from landing after quick navigation
    // or an auth change replaces this page's user.
    const controller = new AbortController();
    apiFetch('/api/org/members', { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!controller.signal.aborted && data?.members) {
          setMembers(data.members);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [currentUser]);

  // App only refetches data when `today` changes or when this page's filters
  // are edited, so after visiting Dashboard/Timeline (which load a different
  // day) Analytics would render that stale day's logs under its own range
  // filters. Refetching the active range on mount keeps the page consistent
  // with its filter state without reaching into App-owned logic.
  const mountRefetchedRef = useRef(false);
  useEffect(() => {
    if (mountRefetchedRef.current) return;
    mountRefetchedRef.current = true;
    onRetry?.();
    // Intentionally runs once per mount; onRetry is a plain App function, not
    // a stable callback, so it must not enter the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Analyzed active work logs for focus percentage (ignoring pure idle away captures)
  const analyzedLogs = useMemo(() => {
    return logs.filter(l => !isPendingLog(l) && !isIdleLog(l));
  }, [logs]);

  // Overall Average Focus Score
  const avgFocusScore = useMemo(() => {
    if (analyzedLogs.length === 0) return 0;
    return Math.round(
      analyzedLogs.reduce((acc, l) => acc + captureScore(l), 0) / analyzedLogs.length
    );
  }, [analyzedLogs]);

  // Build hourly focus score trend chart data. Capture counts per hour cover
  // every log; the average focus rating only uses analyzed active captures, because
  // unanalyzed and pure idle rows skew the working productivity towards 0%.
  const hourlyData = useMemo(() => {
    const hourCounts = Array.from({ length: 24 }, () => 0);
    const hourScores: Array<{ total: number; count: number }> = Array.from({ length: 24 }, () => ({ total: 0, count: 0 }));

    logs.forEach(l => {
      if (!l.timestamp) return;
      const d = new Date(l.timestamp);
      const h = d.getHours();
      if (Number.isNaN(h) || h < 0 || h > 23) return;
      hourCounts[h]++;
      if (!isPendingLog(l) && !isIdleLog(l)) {
        hourScores[h].total += captureScore(l);
        hourScores[h].count++;
      }
    });

    return hourScores.map((s, h) => ({
      hour: `${String(h).padStart(2, '0')}:00`,
      'Focus Rating': s.count > 0 ? Math.round(s.total / s.count) : null,
      Captures: hourCounts[h],
    }));
  }, [logs]);

  const peakHour = useMemo(() => {
    let best: { hour: string; score: number } | null = null;
    for (const d of hourlyData) {
      const v = d['Focus Rating'];
      if (typeof v === 'number' && Number.isFinite(v) && (best === null || v > best.score)) {
        best = { hour: d.hour, score: v };
      }
    }
    return best;
  }, [hourlyData]);

  const intervalSec = config?.screenshot_interval_seconds ?? 30;

  // App usage breakdown: time-share counts span every capture, focus-rating
  // averages only analyzed ones (pending rows serialize with score 0).
  const appData = useMemo(() => {
    const appMap: Record<string, { count: number; category: string; scoreTotal: number; scoreCount: number }> = {};
    logs.forEach(l => {
      const app = canonicalAppName(l.app_name) || 'Other';
      if (!appMap[app]) {
        appMap[app] = { count: 0, category: l.app_category || 'Application', scoreTotal: 0, scoreCount: 0 };
      }
      appMap[app].count++;
      if (!isPendingLog(l) && !isIdleLog(l)) {
        appMap[app].scoreTotal += captureScore(l);
        appMap[app].scoreCount++;
      }
    });

    const total = logs.length || 1;
    return Object.entries(appMap)
      .map(([name, d]) => ({
        name,
        category: d.category,
        count: d.count,
        percent: Math.round((d.count / total) * 100),
        durationMinutes: (d.count * intervalSec) / 60,
        avgScore: d.scoreCount > 0 ? Math.round(d.scoreTotal / d.scoreCount) : null,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [logs, intervalSec]);

  // Entropy & Typing Line Chart Data. Entropy is guarded against non-numeric
  // rows (one bad row would otherwise throw inside render and blank the page):
  // missing values become null → the line shows a gap instead of diving to 0.
  // The Focus line reports null for pending captures so it only tracks
  // AI-evaluated points instead of dipping to 0 while analysis is in flight.
  const multiDay = !!(startDate && endDate && startDate !== endDate);
  const entropyData = useMemo(() => {
    if (logs.length === 0) return [];
    const sorted = [...logs]
      .filter(l => l.timestamp && !Number.isNaN(new Date(l.timestamp).getTime()))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Downsample if dataset exceeds 150 points to prevent Recharts SVG performance collapse on 30-day views
    const maxPoints = 150;
    const step = Math.max(1, Math.ceil(sorted.length / maxPoints));
    const sampled = sorted.filter((_, idx) => idx % step === 0 || idx === sorted.length - 1);

    return sampled.map(l => {
      let timeStr = '—';
      try {
        timeStr = format(new Date(l.timestamp), multiDay ? 'MMM d HH:mm' : 'HH:mm');
      } catch {
        // Safe fallback
      }
      return {
        time: timeStr,
        Entropy: typeof l.entropy_score === 'number' && Number.isFinite(l.entropy_score)
          ? parseFloat(Math.max(0, Math.min(100, l.entropy_score)).toFixed(1))
          : null,
        FocusScore: (isPendingLog(l) || isIdleLog(l))
          ? null
          : captureScore(l),
      };
    });
  }, [logs, multiDay]);

  // Category breakdown for pie chart
  const categoryData = useMemo(() => {
    const catMap = new Map<string, number>();
    logs.filter(l => l.ai_category && l.ai_category !== 'Unknown').forEach(l => {
      catMap.set(l.ai_category, (catMap.get(l.ai_category) ?? 0) + 1);
    });
    return Array.from(catMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name, value }));
  }, [logs]);

  const PIE_COLORS = [
    'var(--accent-green)',
    'var(--accent-indigo)',
    'var(--accent-teal)',
    'var(--accent-amber)',
    'var(--accent-purple)',
    'var(--accent-cyan)',
    'var(--accent-red)',
  ];

  // For a single-day range the label must come from startDate — previously it
  // fell back to the App-global `today`, so picking "Yesterday" or any past
  // day via the date inputs still showed Today — or today's date — in the
  // header while the charts rendered the selected day's data.
  const dateLabel = startDate && endDate && startDate !== endDate
    ? `${format(new Date(startDate + 'T00:00:00'), 'MMM d, yyyy')} - ${format(new Date(endDate + 'T00:00:00'), 'MMM d, yyyy')}`
    : (startDate || today) === localISODate()
    ? 'Today'
    : format(new Date((startDate || today) + 'T00:00:00'), 'MMMM d, yyyy');

  const activeWorkingLogs = useMemo(() => {
    return logs.filter(l => !isIdleLog(l));
  }, [logs]);

  const activeMinutes = activeWorkingLogs.length > 0 ? (activeWorkingLogs.length * intervalSec) / 60 : 0;

  // Quick date-range presets. The selected preset is derived from the active
  // range so manually picking dates naturally switches the dropdown to Custom.
  const isoDaysAgo = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return localISODate(d);
  };
  const nowISO = localISODate();
  const yesterdayISO = isoDaysAgo(1);
  const last7StartISO = isoDaysAgo(6);
  const last30StartISO = isoDaysAgo(29);

  const rangePreset = (() => {
    const s = startDate || today;
    const e = endDate || today;
    if (s === e) {
      if (s === nowISO) return 'today';
      if (s === yesterdayISO) return 'yesterday';
    }
    if (s === last7StartISO && e === nowISO) return 'last7';
    if (s === last30StartISO && e === nowISO) return 'last30';
    return 'custom';
  })();

  const applyRangePreset = (preset: string) => {
    switch (preset) {
      case 'today':
        onDateRangeChange?.(nowISO, nowISO);
        break;
      case 'yesterday':
        onDateRangeChange?.(yesterdayISO, yesterdayISO);
        break;
      case 'last7':
        onDateRangeChange?.(last7StartISO, nowISO);
        break;
      case 'last30':
        onDateRangeChange?.(last30StartISO, nowISO);
        break;
      default:
        break;
    }
  };

  // Accessible chart summaries (role="img" + aria-label on each chart
  // wrapper): the charts themselves are invisible SVG soup to screen
  // readers, so every graph gets a one-line data sentence instead.
  const hourlyAria = logs.length === 0
    ? undefined
    : `Hourly AI focus rating chart, ${
        analyzedLogs.length > 0
          ? `average ${avgFocusScore}%`
          : 'no analyzed captures yet'
      }${peakHour ? `, peak ${peakHour.score}% in the ${peakHour.hour} hour` : ''}${
        analyzedLogs.length < logs.length
          ? `; ${logs.length - analyzedLogs.length} captures pending analysis`
          : ''
      }`;

  const categoryTotal = categoryData.reduce((acc, c) => acc + c.value, 0);
  const categoryTop = categoryData[0];
  const pieAria = logs.length === 0 || !categoryTop
    ? undefined
    : `Work categories breakdown, ${categoryData.length} categories across ${categoryTotal} captures, largest is ${categoryTop.name} at ${Math.round((categoryTop.value / categoryTotal) * 100)}%`;

  const lineAria = logs.length === 0
    ? undefined
    : `Focus rating and keystroke entropy trend over ${entropyData.length} captures in the selected range${
        analyzedLogs.length > 0 ? `, average focus ${avgFocusScore}%` : ', no analyzed captures yet'
      }`;

  // Focus-band tone for chart header copy, matching the StatCard semantics.
  const focusBandColor = analyzedLogs.length === 0
    ? 'var(--text-muted)'
    : avgFocusScore >= FOCUS_GOOD
    ? 'var(--badge-productive-text)'
    : avgFocusScore >= FOCUS_OK
    ? 'var(--badge-amber-text)'
    : 'var(--badge-unproductive-text)';

  return (
    <div className="an-page" aria-busy={loading}>
      <div className="page-header" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <div>
          <h1 className="page-title">Productivity Analytics &amp; Deep Dive</h1>
          <p className="page-subtitle">
            {dateLabel} · {selectedUserId ? 'Single User Deep Dive' : 'Team / Organization Overview'}
          </p>
        </div>

        <div className="an-toolbar">
          {(currentUser?.role === 'admin' || currentUser?.role === 'owner') && members.length > 0 && (
            <CustomSelect
              ariaLabel="Filter by team member"
              value={selectedUserId ? String(selectedUserId) : ''}
              onChange={(value) => onUserChange?.(value ? Number(value) : null)}
              className="an-member-select"
              triggerStyle={{ maxWidth: 280 }}
              options={[
                {
                  value: '',
                  label: 'All Organization Users',
                  leading: <Icon name="users" size={14} />,
                },
                ...members.map((member) => {
                  const name = member.full_name || member.email;
                  return {
                    value: String(member.id),
                    label: name,
                    triggerLabel: `${name} (${member.role})`,
                    meta: member.role,
                    leading: <Icon name="user" size={14} />,
                  };
                }),
              ]}
            />
          )}

          {/* Mobile / Narrow Screen Presets Dropdown using CustomSelect */}
          <div className="an-period-select-wrap">
            <CustomSelect
              ariaLabel="Select date range preset"
              className={`an-period-select${rangePreset !== 'custom' ? ' an-preset-active' : ''}`}
              value={rangePreset}
              onChange={(value) => {
                if (value === 'custom') {
                  const startEl = document.getElementById('an-start-date');
                  startEl?.focus();
                } else {
                  applyRangePreset(value);
                }
              }}
              options={[
                { value: 'today', label: 'Today', leading: <Icon name="calendar" size={14} /> },
                { value: 'yesterday', label: 'Yesterday', leading: <Icon name="calendar" size={14} /> },
                { value: 'last7', label: 'Last 7 Days', leading: <Icon name="calendar" size={14} /> },
                { value: 'last30', label: 'Last 30 Days', leading: <Icon name="calendar" size={14} /> },
                { value: 'custom', label: 'Custom Range', leading: <Icon name="calendar" size={14} /> },
              ]}
            />
          </div>

          <div className="an-period-group" role="group" aria-label="Time period selector">
            <button
              type="button"
              className={`an-period-btn${rangePreset === 'today' ? ' active' : ''}`}
              onClick={() => applyRangePreset('today')}
              aria-pressed={rangePreset === 'today'}
            >
              <Icon name="calendar" size={13} />
              <span>Today</span>
            </button>
            <button
              type="button"
              className={`an-period-btn${rangePreset === 'last7' ? ' active' : ''}`}
              onClick={() => applyRangePreset('last7')}
              aria-pressed={rangePreset === 'last7'}
            >
              <span>7 Days</span>
            </button>
            <button
              type="button"
              className={`an-period-btn${rangePreset === 'last30' ? ' active' : ''}`}
              onClick={() => applyRangePreset('last30')}
              aria-pressed={rangePreset === 'last30'}
            >
              <span>30 Days</span>
            </button>
            <button
              type="button"
              className={`an-period-btn${rangePreset === 'custom' ? ' active' : ''}`}
              onClick={() => {
                const startEl = document.getElementById('an-start-date');
                startEl?.focus();
              }}
              aria-pressed={rangePreset === 'custom'}
            >
              <span>Custom</span>
            </button>
          </div>

          <div className={`an-dates-wrapper${rangePreset === 'custom' ? ' active' : ''}`}>
            <Icon
              name="calendar"
              size={13}
              color={rangePreset === 'custom' ? 'var(--accent-primary)' : 'var(--text-muted)'}
            />
            <input
              id="an-start-date"
              type="date"
              className="date-input an-range-input"
              aria-label="Range start date"
              value={startDate || today}
              max={endDate || localISODate()}
              onChange={(e) => {
                const s = e.target.value;
                if (!s) return;
                const currentEnd = endDate || today || localISODate();
                const nextEnd = currentEnd < s ? s : currentEnd;
                onDateRangeChange?.(s, nextEnd);
              }}
            />
            <span className="an-dates-sep" aria-hidden="true">to</span>
            <input
              id="an-end-date"
              type="date"
              className="date-input an-range-input"
              aria-label="Range end date"
              value={endDate || today}
              min={startDate || undefined}
              max={localISODate()}
              onChange={(e) => {
                const ed = e.target.value;
                if (!ed) return;
                const currentStart = startDate || today || localISODate();
                const nextStart = currentStart > ed ? ed : currentStart;
                onDateRangeChange?.(nextStart, ed);
              }}
            />
          </div>
        </div>
      </div>

      {loadError && logs.length > 0 && (
        <Alert
          type="error"
          message={loadError}
          onRetry={onRetry}
          style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
        />
      )}
      {loading && logs.length === 0 ? (
        /* Skeleton mirrors the real layout geometry (4-stat row + chart
           cards at their final heights) so swapping in data causes no CLS. */
        <div className="an-stack" aria-hidden="true">
          <div className="stats-grid">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="stat-card">
                <div className="skeleton an-sk-label" />
                <div className="skeleton an-sk-value" />
                <div className="skeleton an-sk-sub" />
              </div>
            ))}
          </div>
          <div className="card">
            <div className="card-header"><div className="skeleton an-sk-title" /></div>
            <div className="card-body">
              <div className="skeleton an-sk-note" />
              <div className="skeleton an-sk-chart" style={{ height: 220 }} />
            </div>
          </div>
          <div className="an-grid">
            <div className="card">
              <div className="card-header"><div className="skeleton an-sk-title" /></div>
              <div className="card-body">
                <div className="skeleton an-sk-note" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="an-sk-approw">
                      <div className="an-sk-appsize">
                        <div className="skeleton" style={{ width: 28, height: 28, borderRadius: 6 }} />
                        <div className="skeleton an-sk-appname" />
                        <div className="skeleton an-sk-appnum" />
                      </div>
                      <div className="skeleton an-sk-track" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="card">
              <div className="card-header"><div className="skeleton an-sk-title" /></div>
              <div className="card-body">
                <div className="skeleton an-sk-note" />
                <div className="skeleton an-sk-chart" style={{ height: 200 }} />
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-header"><div className="skeleton an-sk-title" /></div>
            <div className="card-body">
              <div className="skeleton an-sk-note" />
              <div className="skeleton an-sk-chart" style={{ height: 210 }} />
            </div>
          </div>
        </div>
      ) : loadError && logs.length === 0 ? (
        <div className="card">
          <Alert
            type="error"
            message={loadError}
            onRetry={onRetry}
            style={{ margin: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
          />
        </div>
      ) : logs.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Icon name="activity" size={38} color="var(--accent-primary)" />}
            title={
              rangePreset !== 'today'
                ? `No activity recorded for ${dateLabel}`
                : 'No analytics telemetry for today'
            }
            description={
              rangePreset !== 'today'
                ? 'No background telemetry points were captured during this timeframe. Try switching back to Today or selecting a wider date range.'
                : 'MiniTracker tracks your active applications and focus in the background. Once captures begin, your focus score, hourly productivity, and app breakdown will populate automatically.'
            }
            action={
              rangePreset !== 'today' ? (
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => applyRangePreset('today')}
                  >
                    <Icon name="calendar" size={14} />
                    <span>Switch to Today</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => applyRangePreset('last7')}
                  >
                    <Icon name="clock" size={14} />
                    <span>View Last 7 Days</span>
                  </button>
                </div>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="an-stack">

          {/* Top Summary Banner: Hero Score Ring & Companion Metric Cards */}
          <div className="stats-grid">
            <div className="stat-card an-hero-card">
              <div className="an-hero-body">
                <div className="an-score-info">
                  <span className="stat-label">AI Productivity Score</span>
                  <div className="an-score-row">
                    <span className="an-score-num" style={{ color: focusBandColor }}>
                      {analyzedLogs.length === 0 ? '—' : `${avgFocusScore}%`}
                    </span>
                    {analyzedLogs.length > 0 ? (
                      <span
                        className={`an-score-badge ${
                          avgFocusScore >= FOCUS_GOOD
                            ? 'good'
                            : avgFocusScore >= FOCUS_OK
                            ? 'ok'
                            : 'poor'
                        }`}
                      >
                        {avgFocusScore >= FOCUS_GOOD
                          ? 'Productive'
                          : avgFocusScore >= FOCUS_OK
                          ? 'Balanced'
                          : 'Distracted'}
                      </span>
                    ) : (
                      <span className="an-score-badge neutral">Awaiting AI</span>
                    )}
                  </div>
                  <div className="stat-sub">
                    {analyzedLogs.length} of {logs.length} captures evaluated
                  </div>
                </div>
                {analyzedLogs.length > 0 ? (
                  <ScoreRing score={avgFocusScore} size={62} strokeWidth={6} />
                ) : (
                  <div className="an-score-ring-placeholder">
                    <Icon name="target" size={24} color="var(--text-muted)" />
                  </div>
                )}
              </div>
            </div>

            <StatCard
              label="Active Work Duration"
              value={activeMinutes >= 60 ? `${(activeMinutes / 60).toFixed(1)} hrs` : `${Math.round(activeMinutes)} mins`}
              leading={<Icon name="clock" size={16} color="var(--accent-teal)" />}
              sub={`Across ${activeWorkingLogs.length.toLocaleString()} active captures (${logs.length - activeWorkingLogs.length} idle/away)`}
            />

            <StatCard
              label="Avg Keystroke Activity"
              value={
                activeWorkingLogs.length > 0
                  ? `${Math.round(
                      activeWorkingLogs.reduce((acc, l) => acc + (l.total_keys || 0), 0) / activeWorkingLogs.length
                    ).toLocaleString()} keys / cap`
                  : '0 keys / cap'
              }
              leading={<Icon name="keyboard" size={16} color="var(--accent-indigo)" />}
              sub={`Keystrokes per active ${intervalSec}s interval`}
            />

            <StatCard
              label="Peak Focus Window"
              value={peakHour ? peakHour.hour : '—'}
              leading={<Icon name="award" size={16} color="var(--accent-amber)" />}
              sub={
                peakHour
                  ? `Peak rating ${peakHour.score}% productivity`
                  : 'Requires active analyzed captures'
              }
            />
          </div>

          {/* Hourly Focus Score Chart */}
          <div className="card">
            <div className="card-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="activity" size={16} color="var(--accent-primary)" />
                <span className="card-title">Hourly AI Focus Rating</span>
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: focusBandColor, fontVariantNumeric: 'tabular-nums' }}>
                Overall Focus: {analyzedLogs.length === 0 ? '—' : `${avgFocusScore}%`}
              </span>
            </div>
            <div className="card-body">
              <div
                title="Average AI productivity percentage score for each active hour"
                className="an-card-note"
              >
                Average AI productivity percentage score (0–100%) for each active hour
              </div>

              <div className="an-chart" style={{ height: 220 }} role="img" aria-label={hourlyAria}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={hourlyData}
                    margin={{ top: 12, right: 12, left: -4, bottom: 4 }}
                    accessibilityLayer
                  >
                    <defs>
                      <linearGradient id="anBarGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--accent-primary)" stopOpacity={1} />
                        <stop offset="100%" stopColor="var(--accent-primary)" stopOpacity={0.65} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
                    <XAxis
                      dataKey="hour"
                      tick={AXIS_TICK}
                      axisLine={{ stroke: 'var(--border-subtle)' }}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={[0, 100]}
                      ticks={[0, 25, 50, 75, 100]}
                      tickFormatter={(v) => `${v}%`}
                      tick={AXIS_TICK}
                      axisLine={false}
                      tickLine={false}
                      width={38}
                    />
                    <Tooltip
                      content={<CustomTooltip />}
                      cursor={{ fill: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)' }}
                    />
                    <Bar
                      dataKey="Focus Rating"
                      name="Focus Rating"
                      fill="url(#anBarGradient)"
                      radius={[4, 4, 0, 0]}
                      unit="%"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Grid: App Breakdown & Category Donut Chart */}
          <div className="an-grid">

            {/* Top Applications Share */}
            <div className="card">
              <div className="card-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="desktop" size={16} color="var(--accent-teal)" />
                  <span className="card-title">Desktop App Time &amp; Focus</span>
                </div>
              </div>
              <div className="card-body">
                <div
                  title="Breakdown of time share & AI evaluation per application"
                  className="an-card-note"
                >
                  Time share &amp; AI evaluation per application
                </div>

                {appData.length === 0 ? (
                  <div className="an-panel-empty">
                    <div className="an-panel-empty-icon">
                      <Icon name="desktop" size={20} />
                    </div>
                    <div className="an-panel-empty-title">No applications logged</div>
                    <div className="an-panel-empty-desc">
                      Application usage will appear here once background window activity is tracked.
                    </div>
                  </div>
                ) : (
                  <div className="an-app-list">
                    {appData.map((app) => (
                      <div key={app.name} className="an-app-item">
                        <div className="an-app-row-top">
                          <div className="an-app-identity">
                            <div className="an-app-icon-box">
                              <AppIcon name={app.name} size={16} />
                            </div>
                            <div className="an-app-meta">
                              <span className="an-app-title" title={app.name}>
                                {app.name}
                              </span>
                              <span className="an-app-pill" title={app.category}>
                                {app.category}
                              </span>
                            </div>
                          </div>

                          <div className="an-app-metrics">
                            <span className="an-app-duration" title="Estimated active duration">
                              {formatDuration(app.durationMinutes)}
                            </span>
                            <span
                              className={`an-app-score-tag ${
                                app.avgScore == null
                                  ? 'pending'
                                  : app.avgScore >= FOCUS_GOOD
                                  ? 'good'
                                  : app.avgScore >= FOCUS_OK
                                  ? 'ok'
                                  : 'poor'
                              }`}
                            >
                              {app.avgScore == null ? 'Pending AI' : `${app.avgScore}% Focus`}
                            </span>
                            <span className="an-app-pct">{app.percent}%</span>
                          </div>
                        </div>

                        <div className="an-progress-track">
                          <div
                            className="an-progress-fill"
                            style={{
                              width: `${Math.max(app.percent, 3)}%`,
                              backgroundColor:
                                app.avgScore == null
                                  ? 'var(--border-medium)'
                                  : app.avgScore >= FOCUS_GOOD
                                  ? 'var(--accent-green)'
                                  : app.avgScore >= FOCUS_OK
                                  ? 'var(--accent-amber)'
                                  : 'var(--accent-red)',
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Category Donut Chart */}
            <div className="card">
              <div className="card-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="sparkles" size={16} color="var(--accent-purple)" />
                  <span className="card-title">Work Categories Breakdown</span>
                </div>
              </div>
              <div className="card-body">
                <div
                  title="Distribution of captures across AI categories"
                  className="an-card-note"
                >
                  Distribution across AI categories
                </div>

                {categoryData.length > 0 ? (
                  <>
                    <div className="an-donut-wrap" role="img" aria-label={pieAria}>
                      <ResponsiveContainer width="100%" height={200}>
                        <PieChart accessibilityLayer>
                          <Pie
                            data={categoryData}
                            cx="50%"
                            cy="50%"
                            innerRadius={54}
                            outerRadius={76}
                            paddingAngle={3}
                            dataKey="value"
                            cornerRadius={3}
                            stroke="var(--bg-card)"
                            strokeWidth={2}
                          >
                            {categoryData.map((_, i) => (
                              <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip content={<CustomTooltip isDonut />} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="an-donut-center" aria-hidden="true">
                        <span className="an-donut-total">{categoryTotal}</span>
                        <span className="an-donut-sub">Captures</span>
                      </div>
                    </div>

                    <div className="an-category-legend">
                      {categoryData.map((c, i) => (
                        <div key={c.name} className="an-category-legend-item">
                          <span
                            className="an-category-dot"
                            style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                          />
                          <span className="an-category-name">{c.name}</span>
                          <span className="an-category-val">
                            {Math.round((c.value / (categoryTotal || 1)) * 100)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="an-panel-empty">
                    <div className="an-panel-empty-icon">
                      <Icon name="sparkles" size={20} />
                    </div>
                    <div className="an-panel-empty-title">No categories classified yet</div>
                    <div className="an-panel-empty-desc">
                      AI classification will populate as background captures are analyzed.
                    </div>
                  </div>
                )}
              </div>
            </div>

          </div>

          {/* Keystroke Variety & Focus Trend Line Chart */}
          <div className="card">
            <div className="card-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="keyboard" size={16} color="var(--accent-indigo)" />
                <span className="card-title">Keystroke Variety &amp; Focus Timeline</span>
              </div>
            </div>
            <div className="card-body">
              <div
                title="Keystroke entropy vs AI-evaluated focus percentage over time"
                className="an-card-note"
              >
                Keystroke entropy vs AI-evaluated focus percentage over time
              </div>

              {entropyData.length < 2 ? (
                <div className="an-panel-empty">
                  <div className="an-panel-empty-icon">
                    <Icon name="activity" size={20} />
                  </div>
                  <div className="an-panel-empty-title">Insufficient trend data</div>
                  <div className="an-panel-empty-desc">
                    Need at least 2 capture points in the selected range to display a timeline trend.
                  </div>
                </div>
              ) : (
                <div className="an-chart" style={{ height: 210 }} role="img" aria-label={lineAria}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={entropyData}
                      margin={{ top: 12, right: 12, left: -4, bottom: 4 }}
                      accessibilityLayer
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
                      <XAxis
                        dataKey="time"
                        tick={AXIS_TICK}
                        axisLine={{ stroke: 'var(--border-subtle)' }}
                        tickLine={false}
                        minTickGap={30}
                      />
                      <YAxis
                        domain={[0, 100]}
                        ticks={[0, 25, 50, 75, 100]}
                        tickFormatter={(v) => `${v}%`}
                        tick={AXIS_TICK}
                        axisLine={false}
                        tickLine={false}
                        width={38}
                      />
                      <Tooltip
                        content={<CustomTooltip />}
                        cursor={{ stroke: 'var(--border-medium)', strokeDasharray: '3 3' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="FocusScore"
                        name="Focus Rating (%)"
                        stroke={FOCUS_PRIMARY}
                        strokeWidth={2.5}
                        dot={false}
                        activeDot={{ r: 5, fill: FOCUS_PRIMARY, stroke: 'var(--bg-card)', strokeWidth: 2 }}
                        connectNulls={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="Entropy"
                        name="Keystroke Entropy"
                        stroke={SERIES_MUTED}
                        strokeWidth={1.5}
                        strokeDasharray="4 4"
                        dot={false}
                        activeDot={{ r: 4, fill: SERIES_MUTED }}
                        connectNulls={false}
                      />
                      <Legend
                        iconType="circle"
                        iconSize={8}
                        wrapperStyle={{ fontSize: 12, paddingTop: 10 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
