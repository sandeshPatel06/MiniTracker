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
import { localISODate, isPendingLog, FOCUS_GOOD, FOCUS_OK } from '../utils';

interface Props {
  logs: LogEntry[];
  stats: ProductivityStats | null;
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
const AXIS_TICK = { fontSize: 11, fill: 'var(--text-muted)' } as const;
const GRID_STROKE = 'var(--border-subtle)';

// Rating for one capture. The server always serializes productive_score as a
// number (0 for captures still awaiting AI analysis), so the boolean fallback
// exists only for robustness. Score averages in this page intentionally use
// analyzed captures only (see derived-data blocks) so pending rows can't drag
// ratings toward 0%.
function captureScore(log: LogEntry): number {
  return typeof log.productive_score === 'number'
    ? log.productive_score
    : log.is_productive
    ? 100
    : 0;
}

// One analysis threshold → one tone. Focus is emerald; auxiliary
// entropy trend is muted slate so it can't compete with the primary
// series or look like a second "good/bad" dimension.
const FOCUS_PRIMARY = 'var(--accent-primary)';
const SERIES_MUTED = 'var(--text-muted)';

// Custom Tooltip Component. Fixed chrome (min-width + tabular-nums) so
// swapping values never shifts the tooltip frame; null values surface
// as "Pending analysis" instead of a fake 0%.
const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) => {
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
            ? (Number.isInteger(p.value) ? `${p.value}${p.unit || ''}` : p.value.toFixed(1))
            : String(p.value);
        return (
          <div key={i} className="an-tooltip-row">
            <div className="an-tooltip-dot" style={{ background: p.color || p.fill }} />
            <span>
              {p.name}: <strong>{display}</strong>
            </span>
          </div>
        );
      })}
    </div>
  );
};

export default function Analytics({
  logs,
  stats,
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
    if (currentUser?.role !== 'admin' && currentUser?.role !== 'owner') {
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

  // Analyzed logs for focus percentage
  const analyzedLogs = useMemo(() => {
    return logs.filter(l => !isPendingLog(l));
  }, [logs]);

  // Overall Average Focus Score
  const avgFocusScore = useMemo(() => {
    if (analyzedLogs.length === 0) return 0;
    return Math.round(
      analyzedLogs.reduce((acc, l) => acc + captureScore(l), 0) / analyzedLogs.length
    );
  }, [analyzedLogs]);

  // Build hourly focus score trend chart data. Capture counts per hour cover
  // every log; the average focus rating only uses analyzed captures, because
  // the server serializes pending rows with productive_score 0. Hours with no
  // analyzed captures render as null → the bars shows a genuine gap instead
  // of a misleading 0% spike.
  const hourlyData = useMemo(() => {
    const hourCounts = Array.from({ length: 24 }, () => 0);
    const hourScores: Array<{ total: number; count: number }> = Array.from({ length: 24 }, () => ({ total: 0, count: 0 }));

    logs.forEach(l => {
      const h = new Date(l.timestamp).getHours();
      if (h < 0 || h > 23) return;
      hourCounts[h]++;
      if (!isPendingLog(l)) {
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
      if (typeof v === 'number' && (best === null || v > best.score)) {
        best = { hour: d.hour, score: v };
      }
    }
    return best;
  }, [hourlyData]);

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
      if (!isPendingLog(l)) {
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
        avgScore: d.scoreCount > 0 ? Math.round(d.scoreTotal / d.scoreCount) : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [logs]);

  // Entropy & Typing Line Chart Data. Entropy is guarded against non-numeric
  // rows (one bad row would otherwise throw inside render and blank the page):
  // missing values become null → the line shows a gap instead of diving to 0.
  // The Focus line reports null for pending captures so it only tracks
  // AI-evaluated points instead of dipping to 0 while analysis is in flight.
  const multiDay = !!(startDate && endDate && startDate !== endDate);
  const entropyData = useMemo(() => {
    return [...logs]
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .map(l => ({
        time: format(new Date(l.timestamp), multiDay ? 'MMM d HH:mm' : 'HH:mm'),
        Entropy: typeof l.entropy_score === 'number' ? parseFloat(l.entropy_score.toFixed(1)) : null,
        FocusScore: isPendingLog(l)
          ? null
          : typeof l.productive_score === 'number'
          ? Math.round(l.productive_score)
          : l.is_productive
          ? 100
          : 0,
      }));
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

  const intervalSec = config?.screenshot_interval_seconds ?? 30;
  const activeMinutes = logs.length > 0 ? (logs.length * intervalSec) / 60 : 0;

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

          <div className={`an-preset${rangePreset !== 'custom' ? ' an-preset-active' : ''}`}>
            <CustomSelect
              ariaLabel="Date range preset"
              value={rangePreset}
              onChange={applyRangePreset}
              options={[
                { value: 'today', label: 'Today', leading: <Icon name="calendar" size={14} /> },
                { value: 'yesterday', label: 'Yesterday', leading: <Icon name="calendar" size={14} /> },
                { value: 'last7', label: 'Last 7 days', leading: <Icon name="calendar" size={14} /> },
                { value: 'last30', label: 'Last 30 days', leading: <Icon name="calendar" size={14} /> },
                { value: 'custom', label: 'Custom range', leading: <Icon name="calendar" size={14} /> },
              ]}
            />
          </div>

          <div className="an-dates">
            <input
              type="date"
              className="date-input"
              aria-label="Range start date"
              value={startDate || today}
              max={endDate || localISODate()}
              onChange={(e) => {
                const s = e.target.value;
                onDateRangeChange?.(s, endDate && endDate < s ? s : endDate || s);
              }}
            />
            <span className="an-dates-sep" aria-hidden="true">to</span>
            <input
              type="date"
              className="date-input"
              aria-label="Range end date"
              value={endDate || today}
              min={startDate || undefined}
              max={localISODate()}
              onChange={(e) => {
                const ed = e.target.value;
                onDateRangeChange?.(startDate || today, ed);
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
        /* Skeleton mirrors the real layout geometry (stat row + three chart
           cards at their final heights) so swapping in data causes no CLS. */
        <div className="an-stack" aria-hidden="true">
          <div className="stats-grid">
            {[0, 1, 2].map((i) => (
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
              <div className="skeleton an-sk-chart" style={{ height: 200 }} />
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
                        <div className="skeleton" style={{ width: 16, height: 16, borderRadius: 4 }} />
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
                <div className="skeleton an-sk-chart" style={{ height: 220 }} />
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-header"><div className="skeleton an-sk-title" /></div>
            <div className="card-body">
              <div className="skeleton an-sk-note" />
              <div className="skeleton an-sk-chart" style={{ height: 180 }} />
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
            icon={<Icon name="activity" size={34} />}
            title="No analytics data recorded yet"
            description="Analytics will populate automatically as background captures are analyzed."
          />
        </div>
      ) : (
        <div className="an-stack">

          {/* Top Summary Banner */}
          <div className="stats-grid">
            <StatCard
              label="AI Focus Rating"
              value={analyzedLogs.length === 0 ? '—' : `${avgFocusScore}%`}
              valueColor={focusBandColor}
              sub={`${analyzedLogs.length} of ${logs.length} captures evaluated`}
            />

            <StatCard
              label="Active Work Duration"
              value={activeMinutes >= 60 ? `${(activeMinutes / 60).toFixed(1)} hrs` : `${Math.round(activeMinutes)} mins`}
              sub={`Based on ${logs.length} background telemetry points`}
            />

            <StatCard
              label="Avg Input Telemetry"
              value={logs.length > 0 ? `${Math.round(logs.reduce((acc, l) => acc + l.total_keys, 0) / logs.length)} keys / cap` : '0 keys / cap'}
              sub={`Average keystrokes per ${intervalSec}s capture interval`}
            />
          </div>

          {/* Hourly Focus Score Chart */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">
                <span aria-hidden="true">📊</span> Hourly AI Focus Rating
              </span>
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

              <div className="an-chart" style={{ height: 200 }} role="img" aria-label={hourlyAria}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={hourlyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }} accessibilityLayer>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
                    <XAxis dataKey="hour" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                    <Tooltip content={<CustomTooltip />} cursor={{ fill: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)' }} />
                    <Bar
                      dataKey="Focus Rating"
                      name="Focus Rating"
                      fill={FOCUS_PRIMARY}
                      radius={[4, 4, 0, 0]}
                      unit="%"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Grid: App Breakdown & Category Pie */}
          <div className="an-grid">

            {/* Top Applications Share */}
            <div className="card">
              <div className="card-header">
                <span className="card-title">
                  <span aria-hidden="true">💻</span> Desktop App Time &amp; Focus
                </span>
              </div>
              <div className="card-body">
                <div
                  title="Breakdown of time share & AI evaluation per application"
                  className="an-card-note"
                >
                  Time share &amp; AI evaluation per application
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {appData.map((app) => (
                    <div key={app.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                          <AppIcon name={app.name} size={16} />
                          <span title={app.name} style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.name}</span>
                          <span title={app.category} className="an-app-category">({app.category})</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                          <span style={{ fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: app.avgScore >= FOCUS_GOOD ? 'var(--badge-productive-text)' : app.avgScore >= FOCUS_OK ? 'var(--badge-amber-text)' : 'var(--badge-unproductive-text)' }}>
                            {app.avgScore}% Focus
                          </span>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {app.percent}%
                          </span>
                        </div>
                      </div>
                      <div style={{ width: '100%', height: 6, background: 'var(--bg-elevated)', borderRadius: 99, overflow: 'hidden' }}>
                        <div
                          style={{
                            width: `${app.percent}%`,
                            height: '100%',
                            backgroundColor: app.avgScore >= FOCUS_GOOD ? 'var(--accent-green)' : app.avgScore >= FOCUS_OK ? 'var(--accent-amber)' : 'var(--accent-red)',
                            borderRadius: 99,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Category Pie Chart */}
            <div className="card">
              <div className="card-header">
                <span className="card-title">
                  <span aria-hidden="true">🧩</span> Work Categories Breakdown
                </span>
              </div>
              <div className="card-body">
                <div
                  title="Distribution of captures across AI categories"
                  className="an-card-note"
                >
                  Distribution across AI categories
                </div>

                <div className="an-chart" style={{ height: 220 }}>
                  {categoryData.length > 0 ? (
                    <div className="an-chart" style={{ height: '100%' }} role="img" aria-label={pieAria}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart accessibilityLayer>
                          <Pie
                            data={categoryData}
                            cx="50%"
                            cy="50%"
                            outerRadius={70}
                            paddingAngle={3}
                            dataKey="value"
                            label={false}
                            labelLine={false}
                          >
                            {categoryData.map((_, i) => (
                              <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="var(--bg-card)" strokeWidth={2} />
                            ))}
                          </Pie>
                          <Tooltip content={<CustomTooltip />} />
                          <Legend
                            verticalAlign="bottom"
                            iconType="circle"
                            iconSize={9}
                            wrapperStyle={{ fontSize: 12, paddingTop: 6 }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '40px 0' }}>
                      No categories logged yet
                    </div>
                  )}
                </div>
              </div>
            </div>

          </div>

          {/* Keystroke Entropy & Focus Trend Line Chart */}
          {(
            <div className="card">
              <div className="card-header">
                <span className="card-title">
                  <span aria-hidden="true">📈</span> Keystroke Variety &amp; Focus Timeline
                </span>
              </div>
              <div className="card-body">
                <div
                  title="Keystroke entropy vs AI-evaluated focus percentage over time"
                  className="an-card-note"
                >
                  Keystroke entropy vs AI-evaluated focus percentage over time
                </div>

                <div className="an-chart" style={{ height: 180 }}>
                  {entropyData.length < 2 ? (
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '60px 0' }}>
                      Need at least 2 captures to show a trend
                    </div>
                  ) : (
                    <div className="an-chart" style={{ height: '100%' }} role="img" aria-label={lineAria}>
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={entropyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }} accessibilityLayer>
                          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
                          <XAxis dataKey="time" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                          <YAxis domain={[0, 100]} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                          <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'var(--border-medium)', strokeDasharray: '3 3' }} />
                          <Line
                            type="monotone"
                            dataKey="FocusScore"
                            name="Focus Rating (%)"
                            stroke={FOCUS_PRIMARY}
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 4, fill: FOCUS_PRIMARY }}
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
                            connectNulls={false}
                          />
                          <Legend
                            iconType="circle"
                            iconSize={9}
                            wrapperStyle={{ fontSize: 12, paddingTop: 6 }}
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
      )}
    </div>
  );
}
