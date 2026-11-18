import { useState, useEffect, useMemo } from 'react';
import { LogEntry, ProductivityStats, AppConfig, WorkSession, CalendarEvent } from '../types';
import { apiFetch, readJsonSafe } from '../api';
import { format } from 'date-fns';
import { CategoryBadge } from '../components/CategoryBadge';
import { ScreenshotThumb, ImageModal } from '../components/Screenshot';
import { Icon } from '../components/Icon';
import { AppIcon } from '../components/AppIcon';
import { StatCard } from '../components/StatCard';
import { EmptyState } from '../components/EmptyState';
import { Alert } from '../components/Alert';
import { canonicalAppName } from '../lib/appNames';
import { DateNavigator } from '../components/DateNavigator';
import { CustomSelect } from '../components/CustomSelect';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { localISODate, isPendingLog, isIdleLog, buildLocalWorkSessions, FOCUS_GOOD, FOCUS_OK } from '../utils';
import { isDesktopApp, callGo } from '../services/wailsBridge';

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const SENSITIVE_PATTERNS = [
  /\b(password|vault|bitwarden|1password|keepass|lastpass)\b/i,
  /\b(bank|banking|chase|paypal|fidelity|schwab|stripe)\b/i,
  /\b(incognito|private browsing|inprivate)\b/i,
  /\b(token=|bearer |auth=|session_id=)/i,
];

function redactSensitiveTitle(title?: string | null): string {
  if (!title) return '';
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(title)) {
      return '🔒 [Protected Window]';
    }
  }
  return title;
}

function safeFormatTime(timestamp?: string | null, formatStr = 'HH:mm'): string {
  if (!timestamp) return '--:--';
  const clean = timestamp.includes(' ') && !timestamp.includes('T') ? timestamp.replace(' ', 'T') : timestamp;
  const d = new Date(clean);
  return !Number.isNaN(d.getTime()) ? format(d, formatStr) : '--:--';
}

function focusColor(score: number): string {
  return score >= FOCUS_GOOD
    ? 'var(--badge-productive-text)'
    : score >= FOCUS_OK
    ? 'var(--badge-amber-text)'
    : 'var(--badge-unproductive-text)';
}

function focusBarColor(score: number): string {
  return score >= FOCUS_GOOD
    ? 'var(--accent-green)'
    : score >= FOCUS_OK
    ? 'var(--accent-indigo)'
    : 'var(--accent-amber)';
}

function formatHoursAndMinutes(mins: number): string {
  if (!mins || mins <= 0) return '0m';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function captureScore(log: LogEntry): number {
  return typeof log.productive_score === 'number'
    ? log.productive_score
    : log.is_productive
    ? 100
    : 0;
}

interface Props {
  logs: LogEntry[];
  stats: ProductivityStats | null;
  config: AppConfig | null;
  loading: boolean;
  today: string;
  onRefresh?: () => void;
  onDateChange?: (date: string) => void;
  onOpenSettings?: () => void;
  loadError?: string | null;
  onRetry?: () => void;
  userTask?: string;
  onOpenTaskModal?: () => void;
  aiKeyPresent?: boolean;
  onConfigureApiKey?: () => void;
}

export default function Dashboard({
  logs,
  stats,
  config,
  loading,
  today,
  onRefresh,
  onDateChange,
  onOpenSettings: _onOpenSettings,
  loadError,
  onRetry,
  userTask,
  onOpenTaskModal,
  aiKeyPresent,
  onConfigureApiKey,
}: Props) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [processingPending, setProcessingPending] = useState(false);
  const [workSessions, setWorkSessions] = useState<WorkSession[]>([]);
  const [breakdownView, setBreakdownView] = useState<'apps' | 'categories'>('apps');
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);

  // Timezone-safe day scoping: Never fall back to prior days when today has 0 captures
  const activeLogs = useMemo(() => {
    if (!today || !Array.isArray(logs)) return [];
    return logs.filter((l: LogEntry) => {
      if (!l || !l.timestamp) return false;
      try {
        const clean = l.timestamp.includes(' ') && !l.timestamp.includes('T') ? l.timestamp.replace(' ', 'T') : l.timestamp;
        return localISODate(new Date(clean)) === today;
      } catch {
        return typeof l.timestamp === 'string' && l.timestamp.startsWith(today);
      }
    });
  }, [logs, today]);

  // Derive Work Sessions scoped strictly to activeLogs
  useEffect(() => {
    if (!today) return;

    if (isDesktopApp()) {
      setWorkSessions(buildLocalWorkSessions(activeLogs));
      return;
    }

    const controller = new AbortController();
    let requestValid = true;

    apiFetch(`/api/work-sessions?date=${today}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`work sessions status ${res.status}`);
        return readJsonSafe<WorkSession[]>(res);
      })
      .then((data) => {
        if (!requestValid) return;
        if (Array.isArray(data) && data.length > 0) {
          setWorkSessions(data);
        } else {
          setWorkSessions(buildLocalWorkSessions(activeLogs));
        }
      })
      .catch(() => {
        if (requestValid) setWorkSessions(buildLocalWorkSessions(activeLogs));
      });

    return () => {
      requestValid = false;
      controller.abort();
    };
  }, [today, activeLogs]);

  // Fetch Connected Calendar Events for today if available
  useEffect(() => {
    if (!today) return;
    let isSubscribed = true;

    const fromDate = `${today}T00:00:00Z`;
    const toDate = `${today}T23:59:59Z`;

    const fetchEvents = async () => {
      try {
        if (isDesktopApp()) {
          const w = window as any;
          if (w.go?.main?.App?.GetCalendarEvents) {
            const events = await callGo(() => w.go.main.App.GetCalendarEvents(fromDate, toDate));
            if (isSubscribed && Array.isArray(events)) {
              setCalendarEvents(events);
            }
          }
        } else {
          const res = await apiFetch(`/api/calendar/events?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`);
          if (res.ok) {
            const data = await readJsonSafe<CalendarEvent[]>(res);
            if (isSubscribed && Array.isArray(data)) {
              setCalendarEvents(data);
            }
          }
        }
      } catch {
        // Calendar events integration is optional
      }
    };

    fetchEvents();
    return () => {
      isSubscribed = false;
    };
  }, [today]);

  const pendingCount = useMemo(() => activeLogs.filter(isPendingLog).length, [activeLogs]);
  const analyzedLogs = useMemo(() => activeLogs.filter((l: LogEntry) => !isPendingLog(l) && !isIdleLog(l)), [activeLogs]);

  const avgProductivityScore = useMemo(() => {
    return analyzedLogs.length > 0
      ? Math.round(analyzedLogs.reduce((acc, l) => acc + captureScore(l), 0) / analyzedLogs.length)
      : 0;
  }, [analyzedLogs]);

  const totalKeys = useMemo(() => {
    return activeLogs.reduce((acc, l) => acc + (typeof l.total_keys === 'number' ? l.total_keys : 0), 0);
  }, [activeLogs]);

  const avgEntropy = useMemo(() => {
    return activeLogs.length
      ? activeLogs.reduce((acc, l) => acc + (typeof l.entropy_score === 'number' ? l.entropy_score : 0), 0) / activeLogs.length
      : 0;
  }, [activeLogs]);

  const intervalSec = config?.screenshot_interval_seconds || 30;

  const productiveCaptures = useMemo(() => {
    return activeLogs.filter((l: LogEntry) => {
      // Pending/unanalyzed captures must not be penalized or assumed distracted
      if (isPendingLog(l)) {
        return false;
      }
      if (typeof l.productive_score === 'number') {
        return l.productive_score >= FOCUS_OK;
      }
      return l.is_productive;
    }).length;
  }, [activeLogs]);

  const focusMinutes = useMemo(() => {
    if (analyzedLogs.length === 0) {
      return null;
    }
    return Math.round((productiveCaptures * intervalSec) / 60);
  }, [productiveCaptures, intervalSec, analyzedLogs.length]);

  const totalTrackedMinutes = useMemo(() => {
    return Math.round((activeLogs.length * intervalSec) / 60);
  }, [activeLogs.length, intervalSec]);

  // Memoized App Usage Breakdown
  const topApps = useMemo(() => {
    const appCounts = new Map<string, { count: number; category: string; scoreTotal: number; scoreCount: number }>();
    activeLogs.forEach((l: LogEntry) => {
      const app = canonicalAppName(l.app_name) || 'Other';
      let entry = appCounts.get(app);
      if (!entry) {
        entry = { count: 0, category: l.app_category || 'Application', scoreTotal: 0, scoreCount: 0 };
        appCounts.set(app, entry);
      }
      if (!isPendingLog(l)) {
        entry.scoreTotal += captureScore(l);
        entry.scoreCount++;
      }
      entry.count++;
    });

    const totalLogCount = activeLogs.length || 1;
    return Array.from(appCounts.entries())
      .map(([appName, data]) => ({
        appName,
        category: data.category,
        count: data.count,
        percent: Math.round((data.count / totalLogCount) * 100),
        avgScore: data.scoreCount > 0 ? Math.round(data.scoreTotal / data.scoreCount) : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [activeLogs]);

  // Memoized Activity Category Breakdown
  const categoryBreakdown = useMemo(() => {
    const catMap = new Map<string, { count: number; scoreTotal: number; scoreCount: number }>();
    activeLogs.forEach((l: LogEntry) => {
      const cat = l.ai_category && l.ai_category !== 'Unknown' ? l.ai_category : 'Uncategorized';
      let entry = catMap.get(cat);
      if (!entry) {
        entry = { count: 0, scoreTotal: 0, scoreCount: 0 };
        catMap.set(cat, entry);
      }
      entry.count++;
      if (!isPendingLog(l)) {
        entry.scoreTotal += captureScore(l);
        entry.scoreCount++;
      }
    });

    const totalLogCount = activeLogs.length || 1;
    return Array.from(catMap.entries())
      .map(([category, data]) => ({
        category,
        count: data.count,
        percent: Math.round((data.count / totalLogCount) * 100),
        avgScore: data.scoreCount > 0 ? Math.round(data.scoreTotal / data.scoreCount) : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [activeLogs]);

  // Hourly Productivity Trend (dynamic span covering activity if present)
  const hourlyChartData = useMemo(() => {
    let minHour = 8;
    let maxHour = 20;

    activeLogs.forEach((l) => {
      try {
        const clean = l.timestamp.includes(' ') && !l.timestamp.includes('T') ? l.timestamp.replace(' ', 'T') : l.timestamp;
        const d = new Date(clean);
        if (!Number.isNaN(d.getTime())) {
          const h = d.getHours();
          if (h < minHour) minHour = Math.max(0, h);
          if (h > maxHour) maxHour = Math.min(23, h);
        }
      } catch {}
    });

    const hourKeys: string[] = [];
    const hourlyCounts: Record<string, number> = {};
    const hourlyScores: Record<string, { total: number; count: number }> = {};

    for (let i = minHour; i <= maxHour; i++) {
      const key = `${i.toString().padStart(2, '0')}:00`;
      hourKeys.push(key);
      hourlyCounts[key] = 0;
    }

    activeLogs.forEach((l: LogEntry) => {
      try {
        const clean = l.timestamp.includes(' ') && !l.timestamp.includes('T') ? l.timestamp.replace(' ', 'T') : l.timestamp;
        const date = new Date(clean);
        if (!Number.isNaN(date.getTime())) {
          const h = date.getHours();
          const key = `${h.toString().padStart(2, '0')}:00`;
          if (hourlyCounts[key] !== undefined) {
            hourlyCounts[key]++;
            if (!isPendingLog(l)) {
              if (!hourlyScores[key]) hourlyScores[key] = { total: 0, count: 0 };
              hourlyScores[key].total += captureScore(l);
              hourlyScores[key].count++;
            }
          }
        }
      } catch {}
    });

    return hourKeys.map((key) => {
      const scoreData = hourlyScores[key];
      const hasAnalyzed = scoreData && scoreData.count > 0;
      return {
        hour: key,
        score: hasAnalyzed ? Math.round(scoreData.total / scoreData.count) : 0,
        count: hourlyCounts[key] || 0,
        hasAnalyzed: !!hasAnalyzed,
      };
    });
  }, [activeLogs]);

  type DashFilterTier = 'ALL' | 'productive' | 'neutral' | 'unproductive' | 'pending';
  const [activityTier, setActivityTier] = useState<DashFilterTier>('ALL');
  const [activityApp, setActivityApp] = useState<string>('ALL');

  const availableApps = useMemo(() => {
    const apps = new Set<string>();
    activeLogs.forEach((l) => {
      const name = canonicalAppName(l.app_name);
      if (name) apps.add(name);
    });
    return Array.from(apps).sort();
  }, [activeLogs]);

  const tierCounts = useMemo(() => {
    let prod = 0, neut = 0, unprod = 0, pend = 0;
    activeLogs.forEach((l) => {
      if (isPendingLog(l)) {
        pend++;
      } else {
        const score = typeof l.productive_score === 'number' ? l.productive_score : (l.is_productive ? 100 : 0);
        if (score >= FOCUS_GOOD) prod++;
        else if (score >= FOCUS_OK) neut++;
        else unprod++;
      }
    });
    return { all: activeLogs.length, prod, neut, unprod, pend };
  }, [activeLogs]);

  const filteredRecent = useMemo(() => {
    let result = activeLogs;
    if (activityTier !== 'ALL') {
      result = result.filter((l) => {
        if (activityTier === 'pending') return isPendingLog(l);
        if (isPendingLog(l)) return false;
        const score = typeof l.productive_score === 'number' ? l.productive_score : (l.is_productive ? 100 : 0);
        if (activityTier === 'productive') return score >= FOCUS_GOOD;
        if (activityTier === 'neutral') return score >= FOCUS_OK && score < FOCUS_GOOD;
        if (activityTier === 'unproductive') return score < FOCUS_OK;
        return true;
      });
    }
    if (activityApp !== 'ALL') {
      result = result.filter((l) => canonicalAppName(l.app_name) === activityApp);
    }
    return result.slice(-30).reverse();
  }, [activeLogs, activityTier, activityApp]);

  let dateLabel = today === localISODate() ? 'Today' : today;
  try {
    const cleanDate = today.includes('T') ? today.split('T')[0] : today;
    dateLabel = today === localISODate() ? 'Today' : format(new Date(`${cleanDate}T00:00:00`), 'MMMM d, yyyy');
  } catch {}

  const headerMeta = `${dateLabel} · ${activeLogs.length} capture${activeLogs.length === 1 ? '' : 's'}${config ? ` · every ${config.screenshot_interval_seconds}s` : ''}`;

  const handleProcessPending = async () => {
    if (!aiKeyPresent) {
      if (onConfigureApiKey) onConfigureApiKey();
      return;
    }
    setProcessingPending(true);
    try {
      if (isDesktopApp()) {
        const w = window as any;
        if (w.go?.main?.App?.ProcessPendingLogs) {
          await callGo(() => w.go.main.App.ProcessPendingLogs());
        }
      } else {
        const res = await apiFetch('/api/process-pending', { method: 'POST' });
        if (!res.ok) {
          throw new Error(`Failed to queue analysis (${res.status})`);
        }
        await new Promise((r) => setTimeout(r, 600));
      }
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('Failed to process pending logs:', err);
    } finally {
      setProcessingPending(false);
    }
  };

  if (loading && logs.length === 0) {
    return (
      <main className="dash-page" aria-busy="true">
        <header className="page-header dash-header" style={{ marginBottom: 20 }}>
          <div>
            <div className="skeleton" style={{ width: 180, height: 28, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: 240, height: 16 }} />
          </div>
        </header>
        <section className="stats-grid dash-stats" aria-label="Loading summary metrics" style={{ marginBottom: 16 }}>
          {[1, 2, 3, 4].map((i) => (
            <article key={i} className="stat-card">
              <div className="skeleton" style={{ width: '50%', height: 14, marginBottom: 12 }} />
              <div className="skeleton" style={{ width: '65%', height: 32, marginBottom: 8 }} />
              <div className="skeleton" style={{ width: '40%', height: 12 }} />
            </article>
          ))}
        </section>
        <section className="dash-charts" aria-label="Loading charts" style={{ marginBottom: 16 }}>
          <article className="card" style={{ height: 280 }}>
            <div className="card-header">
              <div className="skeleton" style={{ width: 120, height: 16 }} />
            </div>
            <div className="card-body">
              <div className="skeleton" style={{ width: '100%', height: 200, borderRadius: 8 }} />
            </div>
          </article>
          <article className="card" style={{ height: 280 }}>
            <div className="card-header">
              <div className="skeleton" style={{ width: 140, height: 16 }} />
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[1, 2, 3, 4].map((j) => (
                <div key={j}>
                  <div className="skeleton" style={{ width: '80%', height: 14, marginBottom: 6 }} />
                  <div className="skeleton" style={{ width: '100%', height: 6, borderRadius: 99 }} />
                </div>
              ))}
            </div>
          </article>
        </section>
      </main>
    );
  }

  return (
    <main className="dash-page" aria-busy={loading}>
      <ImageModal imagePath={selectedImage} onClose={() => setSelectedImage(null)} />

      {loadError && (
        <Alert
          type="error"
          message={loadError}
          onRetry={onRetry}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Header Bar */}
      <header className="page-header dash-header" style={{ marginBottom: 20 }}>
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title">Productivity Intelligence</h1>
          <p
            className="page-subtitle"
            title={headerMeta}
            style={{ fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {headerMeta}
          </p>
        </div>

        <nav className="dash-header-actions" aria-label="Dashboard actions">
          {onDateChange && (
            <DateNavigator
              currentDate={today}
              onDateChange={onDateChange}
              maxDate={localISODate()}
            />
          )}

          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="btn btn-secondary dash-btn"
              title="Refresh dashboard data"
              aria-label="Refresh dashboard data"
              aria-busy={loading}
            >
              <Icon name="refresh" size={14} className={loading ? 'spin' : ''} />
              <span>{loading ? 'Refreshing…' : 'Refresh'}</span>
            </button>
          )}

          {pendingCount > 0 && (
            aiKeyPresent ? (
              <button
                type="button"
                onClick={handleProcessPending}
                disabled={processingPending}
                className="btn btn-primary dash-btn dash-btn-analyze"
                title={`Process ${pendingCount} pending capture${pendingCount === 1 ? '' : 's'}`}
                aria-label={`Process ${pendingCount} pending captures`}
                aria-busy={processingPending}
              >
                <Icon name="sparkles" size={14} />
                <span>{processingPending ? 'Processing…' : `Process ${pendingCount} Pending`}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={onConfigureApiKey}
                className="btn btn-secondary dash-btn"
                title="Configure Gemini API Key in Settings to score captures"
                aria-label="Configure API Key in Settings"
                style={{ border: '1px dashed var(--accent-amber)', color: 'var(--accent-amber)' }}
              >
                <Icon name="sparkles" size={14} />
                <span>Configure API Key ({pendingCount} Pending)</span>
              </button>
            )
          )}
        </nav>
      </header>

      {/* Target Task Banner & Distraction Shield Status */}
      <section className={`dash-task-banner ${userTask ? 'has-goal' : 'no-goal'}`} role="region" aria-label="Active focus goal">
        <div className="dash-task-banner-left">
          <div className="dash-task-icon-wrap" aria-hidden="true">
            <Icon name="target" size={16} />
          </div>
          <div className="dash-task-content">
            <span className="dash-task-label">Focus Objective</span>
            <span className="dash-task-text" title={userTask || 'No specific objective set'}>
              {userTask ? userTask : 'No objective defined for current session'}
            </span>
          </div>
        </div>
        <div className="dash-task-banner-actions">
          {userTask ? (
            <span className="dash-goal-badge active" title="Current session target active">
              <span className="status-dot" aria-hidden="true" />
              <span>Active Target</span>
            </span>
          ) : (
            <span className="dash-goal-badge pending" title="No active goal set for session">
              <span className="status-dot inactive" aria-hidden="true" />
              <span>No Goal Set</span>
            </span>
          )}

          {onOpenTaskModal && (
            <button
              type="button"
              className={`btn btn-sm dash-task-edit-btn ${userTask ? 'btn-secondary' : 'btn-primary'}`}
              onClick={onOpenTaskModal}
              title={userTask ? 'Update active focus objective' : 'Set target focus objective'}
              aria-label={userTask ? 'Change active focus goal' : 'Set active focus goal'}
            >
              <Icon name={userTask ? 'edit' : 'target'} size={13} />
              <span>{userTask ? 'Change Goal' : 'Set Focus Goal'}</span>
            </button>
          )}
        </div>
      </section>

      {/* Metric Cards Grid: Clear Hierarchy (Score, Focus Time, Top App, Activity) */}
      <section className="stats-grid dash-stats" aria-label="Summary productivity statistics" style={{ marginBottom: 16 }}>
        <StatCard
          label="Focus Rating"
          value={
            analyzedLogs.length === 0
              ? aiKeyPresent
                ? '—'
                : '—'
              : `${avgProductivityScore}%`
          }
          sub={
            analyzedLogs.length === 0
              ? !aiKeyPresent
                ? 'API key required in Settings'
                : 'Awaiting analysis'
              : avgProductivityScore >= FOCUS_GOOD
              ? 'High focus'
              : avgProductivityScore >= FOCUS_OK
              ? 'Moderate focus'
              : 'Low focus'
          }
          valueColor={analyzedLogs.length === 0 ? 'var(--text-secondary)' : focusColor(avgProductivityScore)}
        />
        <StatCard
          label="Focus Time"
          value={focusMinutes === null ? '—' : formatHoursAndMinutes(focusMinutes)}
          sub={
            activeLogs.length === 0
              ? 'No activity tracked today'
              : focusMinutes === null
              ? !aiKeyPresent
                ? 'Requires API key to evaluate'
                : 'Awaiting pending review'
              : `${formatHoursAndMinutes(totalTrackedMinutes)} total active time`
          }
          valueClass={focusMinutes === null ? 'text-secondary' : 'text-green'}
        />
        <StatCard
          label="Top Application"
          value={topApps[0]?.appName || stats?.top_category || '—'}
          valueTitle={topApps[0]?.appName || stats?.top_category || undefined}
          sub={
            topApps[0]
              ? `${topApps[0].percent}% of captures · ${topApps[0].category}`
              : `${activeLogs.length} snapshot${activeLogs.length === 1 ? '' : 's'} recorded`
          }
          valueClass="text-teal"
          leading={topApps[0] ? <AppIcon name={topApps[0].appName} size={20} /> : undefined}
        />
        <StatCard
          label="Active Keystrokes"
          value={totalKeys.toLocaleString()}
          sub={
            avgEntropy > 0
              ? `${avgEntropy.toFixed(1)} variety score · active typing`
              : 'Recorded keyboard input'
          }
          valueClass="text-cyan"
        />
      </section>

      {/* Hourly Trend & Activity Distribution Grid */}
      <section className="dash-charts" aria-label="Hourly trend and breakdown charts">

        {/* Hourly Focus Score Chart */}
        <article className="card">
          <header className="card-header">
            <span className="card-title">
              <Icon name="activity" size={14} />
              Hourly Focus
            </span>
            <span className="dash-chart-avg-badge">
              Avg {analyzedLogs.length === 0 ? '—' : `${avgProductivityScore}%`}
            </span>
          </header>
          <div className="card-body">
            {activeLogs.length === 0 ? (
              <EmptyState
                icon={<Icon name="clock" size={24} />}
                title="No Activity Logged Today"
                description="Hourly focus ratings will render once desktop snapshots are recorded."
              />
            ) : (
              <div className="dash-chart-wrapper">
                <div style={{ width: '100%', height: 210 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={hourlyChartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                      <XAxis dataKey="hour" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                      <YAxis domain={[0, 100]} width={32} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                      <Tooltip
                        cursor={{ fill: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)' }}
                        contentStyle={{
                          backgroundColor: 'var(--bg-elevated)',
                          borderColor: 'var(--border-medium)',
                          borderRadius: 8,
                          boxShadow: 'var(--shadow-card)',
                          fontSize: 12,
                          color: 'var(--text-primary)',
                          padding: '8px 12px',
                        }}
                        labelStyle={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 4 }}
                        itemStyle={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}
                        formatter={(val: any, _name: any, item: any) => {
                          const captures = item?.payload?.count ?? 0;
                          const hasAnalyzed = item?.payload?.hasAnalyzed ?? false;
                          if (captures === 0) {
                            return ['No captures recorded', 'Status'];
                          }
                          const label = hasAnalyzed ? `${val}% Focus Rating` : 'Awaiting review';
                          return [label, `${captures} capture${captures === 1 ? '' : 's'}`];
                        }}
                      />
                      <Bar dataKey="score" radius={[4, 4, 0, 0]} isAnimationActive={!prefersReducedMotion}>
                        {hourlyChartData.map((entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={
                              entry.hasAnalyzed
                                ? entry.score >= FOCUS_GOOD
                                  ? 'var(--accent-green)'
                                  : entry.score >= FOCUS_OK
                                  ? 'var(--accent-indigo)'
                                  : 'var(--accent-amber)'
                                : entry.count > 0
                                ? 'var(--text-muted)'
                                : 'transparent'
                            }
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="dash-chart-legend" aria-hidden="true">
                  <span className="dash-legend-item">
                    <span className="dash-legend-dot" style={{ background: 'var(--accent-green)' }} />
                    <span>High (≥70%)</span>
                  </span>
                  <span className="dash-legend-item">
                    <span className="dash-legend-dot" style={{ background: 'var(--accent-indigo)' }} />
                    <span>Moderate (50-69%)</span>
                  </span>
                  <span className="dash-legend-item">
                    <span className="dash-legend-dot" style={{ background: 'var(--accent-amber)' }} />
                    <span>Low (&lt;50%)</span>
                  </span>
                  <span className="dash-legend-item">
                    <span className="dash-legend-dot" style={{ background: 'var(--text-muted)' }} />
                    <span>Pending AI</span>
                  </span>
                </div>
              </div>
            )}
          </div>
        </article>

        {/* Activity Distribution: Top Apps & Category Toggle */}
        <article className="card dash-topapps">
          <header className="card-header">
            <span className="card-title">
              <Icon name="award" size={14} />
              {breakdownView === 'apps' ? 'Top Applications' : 'Category Share'}
            </span>
            <div className="dash-view-toggle" role="tablist" aria-label="Breakdown view selector">
              <button
                type="button"
                role="tab"
                aria-selected={breakdownView === 'apps'}
                className={`dash-view-toggle-btn${breakdownView === 'apps' ? ' is-active' : ''}`}
                onClick={() => setBreakdownView('apps')}
              >
                Apps
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={breakdownView === 'categories'}
                className={`dash-view-toggle-btn${breakdownView === 'categories' ? ' is-active' : ''}`}
                onClick={() => setBreakdownView('categories')}
              >
                Categories
              </button>
            </div>
          </header>
          <div className="card-body">
            <div className="dash-breakdown-list">
              {breakdownView === 'apps' ? (
                topApps.length === 0 ? (
                  <EmptyState
                    icon={<Icon name="globe" size={24} />}
                    title="No App Data Yet"
                    description="Application usage appears here once the tracker records captures."
                  />
                ) : (
                  topApps.map((app) => (
                    <div key={app.appName} className="dash-breakdown-row">
                      <div className="dash-breakdown-header">
                        <div className="dash-breakdown-info">
                          <div className="dash-app-icon-wrap" aria-hidden="true">
                            <AppIcon name={app.appName} size={20} />
                          </div>
                          <span title={app.appName} className="dash-breakdown-name">{app.appName}</span>
                          <span title={app.category} className="dash-breakdown-sub">({app.category})</span>
                        </div>
                        <div className="dash-breakdown-stats">
                          <span
                            className="dash-focus-tag"
                            style={{ color: app.avgScore >= FOCUS_OK ? 'var(--badge-productive-text)' : 'var(--badge-unproductive-text)' }}
                          >
                            {app.avgScore}% Focus
                          </span>
                          <span className="dash-percent-tag">
                            {app.percent}%
                          </span>
                        </div>
                      </div>
                      <div
                        className="dash-progress-track"
                        role="progressbar"
                        aria-valuenow={app.percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${app.appName} share of captures`}
                      >
                        <div
                          className="dash-progress-fill"
                          style={{
                            width: `${app.percent}%`,
                            backgroundColor: focusBarColor(app.avgScore),
                          }}
                        />
                      </div>
                    </div>
                  ))
                )
              ) : (
                categoryBreakdown.length === 0 ? (
                  <EmptyState
                    icon={<Icon name="activity" size={24} />}
                    title="No Category Data Yet"
                    description="Category classifications will appear once snapshots are analyzed."
                  />
                ) : (
                  categoryBreakdown.map((cat) => (
                    <div key={cat.category} className="dash-breakdown-row">
                      <div className="dash-breakdown-header">
                        <div className="dash-breakdown-info">
                          <CategoryBadge category={cat.category} />
                          <span className="dash-breakdown-sub">{cat.count} capture{cat.count === 1 ? '' : 's'}</span>
                        </div>
                        <div className="dash-breakdown-stats">
                          <span
                            className="dash-focus-tag"
                            style={{ color: cat.avgScore >= FOCUS_OK ? 'var(--badge-productive-text)' : 'var(--badge-unproductive-text)' }}
                          >
                            {cat.avgScore}% Focus
                          </span>
                          <span className="dash-percent-tag">
                            {cat.percent}%
                          </span>
                        </div>
                      </div>
                      <div
                        className="dash-progress-track"
                        role="progressbar"
                        aria-valuenow={cat.percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${cat.category} share of captures`}
                      >
                        <div
                          className="dash-progress-fill"
                          style={{
                            width: `${cat.percent}%`,
                            backgroundColor: focusBarColor(cat.avgScore),
                          }}
                        />
                      </div>
                    </div>
                  ))
                )
              )}
            </div>
          </div>
        </article>

      </section>

      {/* Work Sessions Timeline Block */}
      {workSessions.length > 0 && (
        <article className="card" style={{ marginBottom: 16 }}>
          <header className="card-header">
            <span className="card-title">
              <Icon name="clock" size={14} />
              Work Sessions
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {workSessions.length} session{workSessions.length === 1 ? '' : 's'}
            </span>
          </header>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {workSessions.map((session) => (
              <div
                key={session.id}
                className="dash-session-row"
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    {canonicalAppName(session.top_app_name) && (
                      <div className="dash-app-icon-wrap" aria-hidden="true" style={{ width: 22, height: 22 }}>
                        <AppIcon name={canonicalAppName(session.top_app_name)} size={16} />
                      </div>
                    )}
                    <span title={session.title} style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {session.title}
                    </span>
                    {session.start_time && session.end_time && (
                      <span className="dash-session-times">
                        {safeFormatTime(session.start_time)} – {safeFormatTime(session.end_time)}
                      </span>
                    )}
                  </div>
                  <div title={session.summary} style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {session.summary}
                  </div>
                </div>

                <div className="dash-session-meta">
                  <span
                    className={`badge ${session.productive_pct >= FOCUS_OK ? 'badge-productive' : 'badge-unproductive'}`}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {Math.round(session.productive_pct)}% Focus
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                    {session.log_count} captures
                  </span>
                </div>
              </div>
            ))}
          </div>
        </article>
      )}

      {/* Connected Calendar Schedule Block */}
      {calendarEvents.length > 0 && (
        <article className="card dash-calendar-card" style={{ marginBottom: 16 }}>
          <header className="card-header">
            <span className="card-title">
              <Icon name="calendar" size={14} />
              Connected Calendar Events
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {calendarEvents.length} event{calendarEvents.length === 1 ? '' : 's'} today
            </span>
          </header>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {calendarEvents.map((event) => {
              const now = new Date();
              const isHappeningNow =
                !event.all_day &&
                Boolean(event.start_time) &&
                Boolean(event.end_time) &&
                new Date(event.start_time) <= now &&
                new Date(event.end_time) >= now;

              return (
                <div key={event.id || `${event.title}-${event.start_time}`} className="dash-calendar-row">
                  <div className="dash-calendar-info">
                    <span className="dash-calendar-time">
                      {event.all_day
                        ? 'All Day'
                        : `${safeFormatTime(event.start_time)} – ${safeFormatTime(event.end_time)}`}
                    </span>
                    <span className="dash-calendar-title" title={event.title}>
                      {event.title}
                    </span>
                  </div>
                  <div className="dash-calendar-actions">
                    {event.meeting_url && (
                      <a
                        href={event.meeting_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-secondary btn-sm dash-calendar-join-btn"
                        title="Join online meeting"
                        aria-label={`Join meeting for ${event.title}`}
                      >
                        <Icon name="globe" size={12} />
                        <span>Join</span>
                      </a>
                    )}
                    {event.is_matched ? (
                      <span className="dash-calendar-badge matched" title="Matched to tracked activity">
                        <Icon name="check" size={12} />
                        <span>Matched</span>
                      </span>
                    ) : isHappeningNow ? (
                      <span className="dash-calendar-badge live" title="Meeting happening right now">
                        <span className="status-dot" aria-hidden="true" />
                        <span>Happening Now</span>
                      </span>
                    ) : (
                      <span className="dash-calendar-badge scheduled" title="Upcoming scheduled calendar event">
                        Scheduled
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </article>
      )}

      {/* Activity Stream Feed */}
      <article className="card dash-activity">
        <header className="card-header" style={{ flexWrap: 'wrap', gap: 10, justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="card-title">
              <Icon name="desktop" size={14} />
              Activity Stream
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              Showing {filteredRecent.length} of {activeLogs.length}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div className="dash-view-toggle" role="tablist" aria-label="Activity focus filter">
              <button
                type="button"
                className={`dash-view-toggle-btn ${activityTier === 'ALL' ? 'is-active' : ''}`}
                onClick={() => setActivityTier('ALL')}
                style={{ padding: '3px 8px', fontSize: 11 }}
              >
                All ({tierCounts.all})
              </button>
              <button
                type="button"
                className={`dash-view-toggle-btn ${activityTier === 'productive' ? 'is-active' : ''}`}
                onClick={() => setActivityTier('productive')}
                style={{ padding: '3px 8px', fontSize: 11 }}
              >
                Focus ({tierCounts.prod})
              </button>
              <button
                type="button"
                className={`dash-view-toggle-btn ${activityTier === 'neutral' ? 'is-active' : ''}`}
                onClick={() => setActivityTier('neutral')}
                style={{ padding: '3px 8px', fontSize: 11 }}
              >
                Neutral ({tierCounts.neut})
              </button>
              <button
                type="button"
                className={`dash-view-toggle-btn ${activityTier === 'unproductive' ? 'is-active' : ''}`}
                onClick={() => setActivityTier('unproductive')}
                style={{ padding: '3px 8px', fontSize: 11 }}
              >
                Distracted ({tierCounts.unprod})
              </button>
              {tierCounts.pend > 0 && (
                <button
                  type="button"
                  className={`dash-view-toggle-btn ${activityTier === 'pending' ? 'is-active' : ''}`}
                  onClick={() => setActivityTier('pending')}
                  style={{ padding: '3px 8px', fontSize: 11 }}
                >
                  Pending ({tierCounts.pend})
                </button>
              )}
            </div>

            {availableApps.length > 1 && (
              <CustomSelect
                value={activityApp}
                options={[
                  { value: 'ALL', label: 'All Apps' },
                  ...availableApps.map((a) => ({ value: a, label: a })),
                ]}
                onChange={setActivityApp}
                ariaLabel="Filter activity by application"
                compact
              />
            )}

            {pendingCount > 0 && (
              <span
                className={`badge badge-pending dash-pending-pill${processingPending ? ' is-processing' : ''}`}
                title={
                  processingPending
                    ? 'Processing pending captures'
                    : `${pendingCount} capture${pendingCount === 1 ? '' : 's'} awaiting analysis`
                }
              >
                {processingPending && <span className="dash-mini-spinner" aria-hidden="true" />}
                {processingPending ? 'Processing…' : `${pendingCount} pending review`}
              </span>
            )}
          </div>
        </header>

        <div className="card-body" style={{ padding: '12px 14px' }}>
          {filteredRecent.length === 0 ? (
            <EmptyState
              icon={<Icon name="inbox" size={32} />}
              title="No Activity Found"
              description={
                activeLogs.length === 0
                  ? (isDesktopApp()
                    ? "The tracking daemon will automatically log desktop screenshots and keystroke activity."
                    : "No activity recorded yet for this date.")
                  : "No captures match your selected focus or application filter."
              }
              action={
                activityTier !== 'ALL' || activityApp !== 'ALL' ? (
                  <button
                    type="button"
                    className="btn btn-secondary dash-btn"
                    onClick={() => {
                      setActivityTier('ALL');
                      setActivityApp('ALL');
                    }}
                  >
                    Reset filters
                  </button>
                ) : onRefresh ? (
                  <button
                    type="button"
                    className="btn btn-secondary dash-btn"
                    onClick={onRefresh}
                    aria-label="Refresh dashboard activity"
                  >
                    Refresh now
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="timeline-list" role="feed" aria-label="Recent activity captures feed">
              {filteredRecent.map((log) => {
                const scoreVal = Math.round(captureScore(log));
                const isPending = isPendingLog(log);
                const safeTitle = redactSensitiveTitle(log.window_title);
                const isProtected = safeTitle.includes('[Protected Window]');
                return (
                  <article
                    key={`${log.id}-${log.timestamp}-${log.image_path}`}
                    className="timeline-item dash-log-row"
                    aria-label={`Capture at ${safeFormatTime(log.timestamp)}`}
                  >
                    <div className="dash-time-col">
                      <time className="timeline-time" dateTime={log.timestamp}>
                        {safeFormatTime(log.timestamp)}
                      </time>
                    </div>

                    <div className="dash-thumb-col">
                      <ScreenshotThumb
                        imagePath={log.image_path}
                        onClick={log.image_path ? () => setSelectedImage(log.image_path) : undefined}
                      />
                    </div>

                    <div className="timeline-info dash-info-col">
                      <div className="dash-chip-row">
                        <CategoryBadge category={log.ai_category} />
                        {canonicalAppName(log.app_name) && (
                          <span
                            title={`Application: ${canonicalAppName(log.app_name)}`}
                            className="dash-app-chip"
                          >
                            <AppIcon name={canonicalAppName(log.app_name)} size={14} />
                            <span className="dash-app-chip-label">
                              {canonicalAppName(log.app_name)}
                            </span>
                          </span>
                        )}
                        {log.app_category && (
                          <span title={`Category: ${log.app_category}`} className="dash-app-category">
                            ({log.app_category})
                          </span>
                        )}
                        {log.is_blurred && (
                          <span
                            className="badge badge-amber"
                            style={{ fontSize: 10, padding: '1px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            title={log.blur_reason || 'Sensitive content protected by Privacy Shield'}
                          >
                            <Icon name="shield" size={10} />
                            Privacy Shielded
                          </span>
                        )}
                        {log.is_retroactive && (
                          <span
                            className="badge badge-purple"
                            style={{ fontSize: 10, padding: '1px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            title="Retroactively allocated offline interval"
                          >
                            <Icon name="clock" size={10} />
                            Offline Interval
                          </span>
                        )}
                      </div>

                      {safeTitle && (
                        <div title={safeTitle} className="dash-window-title">
                          {isProtected ? (
                            <span className="dash-protected-badge">
                              <Icon name="lock" size={12} color="var(--warning-text)" />
                              <span>Protected Window</span>
                            </span>
                          ) : (
                            <span className="dash-window-title-text">
                              <Icon name="desktop" size={12} color="var(--text-muted)" />
                              <span className="dash-window-title-string">{safeTitle}</span>
                            </span>
                          )}
                        </div>
                      )}

                      {isPending ? (
                        <div
                          className="dash-reason-skeleton"
                          title="Analysis is running for this capture"
                          aria-busy="true"
                        >
                          <div className="skeleton dash-shimmer-line" style={{ width: '58%' }} />
                          <div className="skeleton dash-shimmer-line" style={{ width: '34%' }} />
                        </div>
                      ) : (
                        <div
                          className="dash-reason"
                          title={log.ai_reason || 'No AI summary was generated for this capture'}
                        >
                          {log.ai_reason || 'No AI summary for this capture'}
                        </div>
                      )}
                    </div>

                    <div className={isPending ? 'dash-score-col is-pending' : 'dash-score-col'}>
                      {isPending ? (
                        <span
                          className="badge badge-pending dash-pending-chip"
                          title="Pending review | add an API key in Settings to score captures"
                        >
                          <span className="dash-mini-spinner" aria-hidden="true" />
                          <span>Pending AI</span>
                        </span>
                      ) : (
                        <>
                          <span
                            title={`AI focus rating: ${scoreVal}%`}
                            className={`badge ${
                              scoreVal >= FOCUS_GOOD
                                ? 'badge-productive'
                                : scoreVal >= FOCUS_OK
                                ? 'badge-amber'
                                : 'badge-unproductive'
                            }`}
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            <Icon
                              name={
                                scoreVal >= FOCUS_GOOD
                                  ? 'check'
                                  : scoreVal >= FOCUS_OK
                                  ? 'activity'
                                  : 'x'
                              }
                              size={13}
                            />
                            {scoreVal}% Focus
                          </span>
                          <div
                            className="dash-score-bar"
                            role="meter"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={scoreVal}
                            aria-label="AI focus rating"
                          >
                            <div
                              className="dash-score-bar-fill"
                              style={{ width: `${scoreVal}%`, background: focusBarColor(scoreVal) }}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </article>
    </main>
  );
}
