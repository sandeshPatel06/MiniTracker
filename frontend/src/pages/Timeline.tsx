import { useState, useMemo, useEffect, useDeferredValue } from 'react';
import { LogEntry } from '../types';
import { format } from 'date-fns';
import { CategoryBadge } from '../components/CategoryBadge';
import { ScreenshotThumb, ImageModal } from '../components/Screenshot';
import { Icon } from '../components/Icon';
import { AppIcon } from '../components/AppIcon';
import { AppFilterSelect } from '../components/AppFilterSelect';
import { CustomSelect } from '../components/CustomSelect';
import { DateNavigator } from '../components/DateNavigator';
import { EmptyState } from '../components/EmptyState';
import { Alert } from '../components/Alert';
import { canonicalAppName } from '../lib/appNames';
import { localISODate, isPendingLog, FOCUS_GOOD, FOCUS_OK } from '../utils';

interface Props {
  logs: LogEntry[];
  loading: boolean;
  today: string;
  onDateChange: (date: string) => void;
  loadError?: string | null;
  onRetry?: () => void;
}

const SKELETON_ROWS = [1, 2, 3, 4, 5, 6];
const SKELETON_GRID_CARDS = [1, 2, 3, 4, 5, 6, 7, 8];

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

/**
 * Normalizes space-separated SQLite/Go timestamps ("YYYY-MM-DD HH:mm:ss") into ISO-8601
 * so WebKitGTK (Linux desktop) and Safari do not produce Invalid Date (NaN).
 */
export function parseTimestampSafe(timestamp?: string | null): Date | null {
  if (!timestamp) return null;
  const normalized = timestamp.includes(' ') && !timestamp.includes('T')
    ? timestamp.replace(' ', 'T')
    : timestamp;
  const d = new Date(normalized);
  return !Number.isNaN(d.getTime()) ? d : null;
}

function safeFormatTime(timestamp?: string | null, formatStr = 'HH:mm:ss', fallback = '—'): string {
  const d = parseTimestampSafe(timestamp);
  return d ? format(d, formatStr) : fallback;
}

function safeFormatDateHeader(dateStr: string): string {
  if (!dateStr) return '—';
  const cleanDate = dateStr.split(/[T ]/)[0].trim();
  const d = new Date(`${cleanDate}T00:00:00`);
  return !Number.isNaN(d.getTime()) ? format(d, 'MMMM d, yyyy') : dateStr;
}

// Filter definitions
type TimeInterval = 'ALL' | 'morning' | 'afternoon' | 'evening' | 'night';
type FocusFilter = 'ALL' | 'productive' | 'neutral' | 'unproductive' | 'pending';
type ZoomPreset = '24h' | 'active' | 'morning' | 'afternoon' | 'evening' | 'night';

const TIME_INTERVAL_OPTIONS = [
  { value: 'ALL', label: 'All Day (24 hrs)', leading: <Icon name="clock" size={14} /> },
  { value: 'morning', label: 'Morning (06:00–12:00)' },
  { value: 'afternoon', label: 'Afternoon (12:00–18:00)' },
  { value: 'evening', label: 'Evening (18:00–24:00)' },
  { value: 'night', label: 'Night (00:00–06:00)' },
];

export function getLogFocusTier(log: LogEntry): 'productive' | 'neutral' | 'unproductive' | 'pending' {
  if (isPendingLog(log)) return 'pending';
  const isNum = typeof log.productive_score === 'number' && Number.isFinite(log.productive_score);
  const rawScore = isNum ? log.productive_score! : log.is_productive ? 100 : 0;
  const score = Math.min(100, Math.max(0, Math.round(rawScore)));
  if (score >= FOCUS_GOOD) return 'productive'; // >= 70
  if (score >= 40) return 'neutral';           // 40 - 69
  return 'unproductive';                       // < 40
}

interface HourlyBucket {
  hour: number;
  label: string;
  count: number;
  avgScore: number;
  productive: number;
  neutral: number;
  unproductive: number;
  pending: number;
}

export default function Timeline({ logs = [], loading, today, onDateChange, loadError, onRetry }: Props) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedApp, setSelectedApp] = useState('ALL');
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [selectedInterval, setSelectedInterval] = useState<TimeInterval>('ALL');
  const [selectedFocus, setSelectedFocus] = useState<FocusFilter>('ALL');
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [maskSensitive, setMaskSensitive] = useState(true);

  // View mode switcher: 'list' (default) or 'grid'
  const [viewMode, setViewMode] = useState<'list' | 'grid'>(() => {
    try {
      const saved = localStorage.getItem('mini_timeline_view');
      return saved === 'grid' || saved === 'list' ? saved : 'list';
    } catch {
      return 'list';
    }
  });

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(24);

  const deferredSearchQuery = useDeferredValue(searchQuery);

  const handleViewModeChange = (mode: 'list' | 'grid') => {
    setViewMode(mode);
    try {
      localStorage.setItem('mini_timeline_view', mode);
    } catch {
      // Ignore storage errors
    }
  };

  // Scope logs strictly to the selected day (prevents bleed from Analytics multi-day fetches)
  const dayLogs = useMemo(() => {
    if (!Array.isArray(logs) || !today) return [];
    return logs.filter((log) => {
      if (!log?.timestamp) return false;
      const d = parseTimestampSafe(log.timestamp);
      return d ? localISODate(d) === today : log.timestamp.startsWith(today);
    });
  }, [logs, today]);

  // Reset to page 1 and clear hour scrub when the selected day changes
  useEffect(() => {
    setCurrentPage(1);
    setSelectedHour(null);
  }, [today]);

  // Unique apps scoped to the active day
  const uniqueApps = useMemo(() => {
    const apps = new Set<string>();
    dayLogs.forEach((l) => {
      const app = canonicalAppName(l.app_name);
      if (app) apps.add(app);
    });
    return Array.from(apps).sort();
  }, [dayLogs]);

  // Unique categories scoped to the active day
  const uniqueCategories = useMemo(() => {
    const cats = new Set<string>();
    dayLogs.forEach((l) => {
      if (l.ai_category && l.ai_category !== 'Unknown') cats.add(l.ai_category);
    });
    return Array.from(cats).sort();
  }, [dayLogs]);

  // Focus counts for filter pills
  const focusCounts = useMemo(() => {
    let productive = 0;
    let neutral = 0;
    let unproductive = 0;
    let pending = 0;

    for (let i = 0; i < dayLogs.length; i++) {
      const tier = getLogFocusTier(dayLogs[i]);
      if (tier === 'productive') productive += 1;
      else if (tier === 'neutral') neutral += 1;
      else if (tier === 'unproductive') unproductive += 1;
      else if (tier === 'pending') pending += 1;
    }

    return {
      ALL: dayLogs.length,
      productive,
      neutral,
      unproductive,
      pending,
    };
  }, [dayLogs]);

  // 24-hour buckets for time-block scrubbing
  const hourlyBuckets = useMemo<HourlyBucket[]>(() => {
    const buckets: HourlyBucket[] = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      label: `${String(h).padStart(2, '0')}:00`,
      count: 0,
      avgScore: 0,
      productive: 0,
      neutral: 0,
      unproductive: 0,
      pending: 0,
    }));

    const scoreSums = new Array(24).fill(0);
    const scoreCounts = new Array(24).fill(0);

    for (let i = 0; i < dayLogs.length; i++) {
      const log = dayLogs[i];
      const d = parseTimestampSafe(log.timestamp);
      if (!d) continue;
      const h = d.getHours();
      if (h >= 0 && h < 24) {
        const b = buckets[h];
        b.count += 1;
        const tier = getLogFocusTier(log);
        if (tier === 'productive') b.productive += 1;
        else if (tier === 'neutral') b.neutral += 1;
        else if (tier === 'unproductive') b.unproductive += 1;
        else if (tier === 'pending') b.pending += 1;

        if (tier !== 'pending') {
          const isNum = typeof log.productive_score === 'number' && Number.isFinite(log.productive_score);
          const score = isNum ? log.productive_score! : log.is_productive ? 100 : 0;
          scoreSums[h] += Math.min(100, Math.max(0, Math.round(score)));
          scoreCounts[h] += 1;
        }
      }
    }

    for (let h = 0; h < 24; h++) {
      if (scoreCounts[h] > 0) {
        buckets[h].avgScore = Math.round(scoreSums[h] / scoreCounts[h]);
      }
    }

    return buckets;
  }, [dayLogs]);

  const maxHourlyCaptures = useMemo(() => {
    return Math.max(1, ...hourlyBuckets.map((b) => b.count));
  }, [hourlyBuckets]);

  // Filter & sort logs with single-pass timestamp caching and privacy-aware window search
  const filteredLogs = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase();

    // Precompute metadata to avoid repeated regex and canonicalAppName execution
    type PreparedLog = {
      raw: LogEntry;
      parsedTime: number;
      hour: number;
      canonicalApp: string;
      score: number;
      tier: 'productive' | 'neutral' | 'unproductive' | 'pending';
      windowTitle: string;
    };

    const prepared: PreparedLog[] = [];

    for (let i = 0; i < dayLogs.length; i++) {
      const log = dayLogs[i];
      const parsedDate = parseTimestampSafe(log.timestamp);
      const parsedTime = parsedDate ? parsedDate.getTime() : 0;
      const hour = parsedDate ? parsedDate.getHours() : 0;
      const canonicalApp = canonicalAppName(log.app_name);
      const isNum = typeof log.productive_score === 'number' && Number.isFinite(log.productive_score);
      const rawScore = isNum ? log.productive_score! : log.is_productive ? 100 : 0;
      const score = Math.min(100, Math.max(0, Math.round(rawScore)));
      const tier = getLogFocusTier(log);
      const windowTitle = maskSensitive ? redactSensitiveTitle(log.window_title) : (log.window_title || '');

      prepared.push({
        raw: log,
        parsedTime,
        hour,
        canonicalApp,
        score,
        tier,
        windowTitle,
      });
    }

    return prepared
      .filter((item) => {
        if (selectedApp !== 'ALL' && item.canonicalApp !== selectedApp) return false;
        if (selectedCategory !== 'ALL' && item.raw.ai_category !== selectedCategory) return false;

        // Focus tier filter
        if (selectedFocus !== 'ALL' && item.tier !== selectedFocus) return false;

        // Specific hour scrubber filter
        if (selectedHour !== null && item.hour !== selectedHour) return false;

        // Time-of-day interval filter
        if (selectedInterval === 'morning' && (item.hour < 6 || item.hour >= 12)) return false;
        if (selectedInterval === 'afternoon' && (item.hour < 12 || item.hour >= 18)) return false;
        if (selectedInterval === 'evening' && (item.hour < 18 || item.hour >= 24)) return false;
        if (selectedInterval === 'night' && (item.hour < 0 || item.hour >= 6)) return false;

        // Search filter matching against masked window titles when privacy mode is ON
        if (q) {
          const matchApp = item.raw.app_name?.toLowerCase().includes(q) ||
                           item.canonicalApp.toLowerCase().includes(q);
          const matchReason = item.raw.ai_reason?.toLowerCase().includes(q);
          const matchCat = item.raw.ai_category?.toLowerCase().includes(q);
          const matchAppCat = item.raw.app_category?.toLowerCase().includes(q);
          const matchWindow = item.windowTitle.toLowerCase().includes(q);
          return Boolean(matchApp || matchReason || matchCat || matchAppCat || matchWindow);
        }
        return true;
      })
      .sort((a, b) => {
        if (b.parsedTime !== a.parsedTime) return b.parsedTime - a.parsedTime;
        return (b.raw.id || 0) - (a.raw.id || 0);
      })
      .map((item) => item.raw);
  }, [dayLogs, selectedApp, selectedCategory, selectedInterval, selectedFocus, selectedHour, deferredSearchQuery, maskSensitive]);

  // Safe pagination calculations avoiding NaN, 0, or negative pages
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / safePageSize));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

  const paginatedLogs = useMemo(() => {
    const start = (safeCurrentPage - 1) * safePageSize;
    return filteredLogs.slice(start, start + safePageSize);
  }, [filteredLogs, safeCurrentPage, safePageSize]);

  // Day summary metrics computed on the active day's analyzed captures
  const analyzedDayLogs = useMemo(() => dayLogs.filter((l) => !isPendingLog(l)), [dayLogs]);

  const avgDayScore = useMemo(() => {
    if (analyzedDayLogs.length === 0) return 0;
    const sum = analyzedDayLogs.reduce((acc, l) => {
      const isNum = typeof l.productive_score === 'number' && Number.isFinite(l.productive_score);
      const score = isNum ? l.productive_score! : l.is_productive ? 100 : 0;
      return acc + score;
    }, 0);
    return Math.round(sum / analyzedDayLogs.length);
  }, [analyzedDayLogs]);

  const hasActiveFilters = Boolean(searchQuery.trim()) ||
    selectedApp !== 'ALL' ||
    selectedCategory !== 'ALL' ||
    selectedInterval !== 'ALL' ||
    selectedFocus !== 'ALL' ||
    selectedHour !== null;

  const clearFilters = () => {
    setSearchQuery('');
    setSelectedApp('ALL');
    setSelectedCategory('ALL');
    setSelectedInterval('ALL');
    setSelectedFocus('ALL');
    setSelectedHour(null);
    setCurrentPage(1);
  };

  const updateSearchQuery = (value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  };

  const updateSelectedApp = (value: string) => {
    setSelectedApp(value);
    setCurrentPage(1);
  };

  const updateSelectedCategory = (value: string) => {
    setSelectedCategory(value);
    setCurrentPage(1);
  };

  const updateSelectedInterval = (value: string) => {
    setSelectedInterval(value as TimeInterval);
    setSelectedHour(null);
    setCurrentPage(1);
  };

  const updateSelectedFocus = (focus: FocusFilter) => {
    setSelectedFocus(focus);
    setCurrentPage(1);
  };

  const toggleHourScrub = (hour: number) => {
    if (selectedHour === hour) {
      setSelectedHour(null);
    } else {
      setSelectedHour(hour);
    }
    setCurrentPage(1);
  };

  const handleZoomPreset = (preset: ZoomPreset) => {
    if (preset === '24h') {
      setSelectedInterval('ALL');
      setSelectedHour(null);
    } else if (preset === 'active') {
      setSelectedInterval('ALL');
      setSelectedHour(null);
    } else {
      setSelectedInterval(preset as TimeInterval);
      setSelectedHour(null);
    }
    setCurrentPage(1);
  };

  const activeFilters = useMemo(() => {
    const chips: Array<{ key: string; label: string; value: string; onRemove: () => void }> = [];
    if (searchQuery.trim()) {
      chips.push({ key: 'search', label: 'Search', value: searchQuery.trim(), onRemove: () => updateSearchQuery('') });
    }
    if (selectedFocus !== 'ALL') {
      const labels: Record<FocusFilter, string> = {
        ALL: 'All Focus',
        productive: 'Productive (≥70%)',
        neutral: 'Neutral (40–69%)',
        unproductive: 'Unproductive (<40%)',
        pending: 'Pending AI',
      };
      chips.push({
        key: 'focus',
        label: 'Focus',
        value: labels[selectedFocus] || selectedFocus,
        onRemove: () => updateSelectedFocus('ALL'),
      });
    }
    if (selectedHour !== null) {
      chips.push({
        key: 'hour',
        label: 'Hour',
        value: `${String(selectedHour).padStart(2, '0')}:00–${String(selectedHour).padStart(2, '0')}:59`,
        onRemove: () => setSelectedHour(null),
      });
    }
    if (selectedApp !== 'ALL') {
      chips.push({ key: 'app', label: 'App', value: selectedApp, onRemove: () => updateSelectedApp('ALL') });
    }
    if (selectedCategory !== 'ALL') {
      chips.push({ key: 'category', label: 'Category', value: selectedCategory, onRemove: () => updateSelectedCategory('ALL') });
    }
    if (selectedInterval !== 'ALL') {
      const opt = TIME_INTERVAL_OPTIONS.find((o) => o.value === selectedInterval);
      chips.push({
        key: 'interval',
        label: 'Interval',
        value: opt ? opt.label : selectedInterval,
        onRemove: () => updateSelectedInterval('ALL'),
      });
    }
    return chips;
  }, [searchQuery, selectedFocus, selectedHour, selectedApp, selectedCategory, selectedInterval]);

  // Safe row range numbers
  const pageFirstRow = filteredLogs.length === 0 ? 0 : (safeCurrentPage - 1) * safePageSize + 1;
  const pageLastRow = Math.min(safeCurrentPage * safePageSize, filteredLogs.length);

  // Helper for rendering 3-tier focus badges
  const renderFocusBadge = (log: LogEntry) => {
    if (isPendingLog(log)) {
      return (
        <span className="badge badge-pending">
          <Icon name="clock" size={12} />
          Pending AI
        </span>
      );
    }
    const isNum = typeof log.productive_score === 'number' && Number.isFinite(log.productive_score);
    const rawScore = isNum ? log.productive_score! : log.is_productive ? 100 : 0;
    const scoreVal = Math.min(100, Math.max(0, Math.round(rawScore)));

    if (scoreVal >= FOCUS_GOOD) {
      return (
        <span className="badge badge-productive">
          <Icon name="check" size={12} />
          {scoreVal}% Focus
        </span>
      );
    }
    if (scoreVal >= 40) {
      return (
        <span className="badge badge-neutral">
          <Icon name="minus" size={12} />
          {scoreVal}% Focus
        </span>
      );
    }
    return (
      <span className="badge badge-unproductive">
        <Icon name="x" size={12} />
        {scoreVal}% Focus
      </span>
    );
  };

  return (
    <div aria-busy={loading} className="tl-page fade-in-up">
      <ImageModal imagePath={selectedImage} onClose={() => setSelectedImage(null)} />

      {/* Header Bar with Date Navigation & View Controls */}
      <header className="page-header tl-header">
        <div className="tl-header-left">
          <div className="tl-title-row">
            <h1 className="page-title">Activity Timeline</h1>
            {dayLogs.length > 0 && (
              <span className="tl-header-badge" title="Total captures recorded today">
                <Icon name="activity" size={12} color="var(--accent-primary)" />
                {dayLogs.length} {dayLogs.length === 1 ? 'capture' : 'captures'}
              </span>
            )}
          </div>
          <p className="page-subtitle">Detailed minute-by-minute activity captures &amp; AI focus ratings.</p>
        </div>

        <div className="tl-header-actions">
          {/* Compound Date Navigator */}
          <DateNavigator
            className="tl-date-nav"
            currentDate={today}
            maxDate={localISODate()}
            onDateChange={onDateChange}
          />

          {/* Privacy Mask Toggle Button */}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setMaskSensitive((prev) => !prev)}
            title={maskSensitive ? 'Disable sensitive window masking' : 'Mask sensitive window titles'}
            style={{ height: 36, fontSize: 12, padding: '0 10px', gap: 6 }}
          >
            <Icon name="lock" size={13} color={maskSensitive ? 'var(--accent-teal)' : undefined} />
            {maskSensitive ? 'Privacy Mask ON' : 'Privacy Mask OFF'}
          </button>

          {/* Refresh Feed Button */}
          {onRetry && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onRetry}
              disabled={loading}
              title="Refresh timeline captures"
              style={{ height: 36, padding: '0 10px' }}
            >
              <Icon name="refresh" size={14} className={loading ? 'spinner-sm' : ''} />
            </button>
          )}

          {/* View Mode Switcher (List vs Grid) */}
          <div className="tl-view-toggle" role="group" aria-label="Timeline display mode">
            <button
              type="button"
              className={`tl-view-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => handleViewModeChange('list')}
              aria-pressed={viewMode === 'list'}
              title="Detailed list view"
            >
              <Icon name="activity" size={13} />
              List
            </button>
            <button
              type="button"
              className={`tl-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => handleViewModeChange('grid')}
              aria-pressed={viewMode === 'grid'}
              title="Visual screenshot gallery grid"
            >
              <Icon name="desktop" size={13} />
              Grid
            </button>
          </div>
        </div>
      </header>

      {/* Interactive Time-Block Scrubber & Zoom Controls */}
      {dayLogs.length > 0 && (
        <section className="card tl-scrubber-card" aria-label="Visual timeline scrubber">
          <div className="card-body tl-scrubber-body">
            <div className="tl-scrubber-top">
              <div className="tl-scrubber-heading">
                <Icon name="clock" size={14} color="var(--accent-primary)" />
                <span>24-Hour Activity Scrubber</span>
                {selectedHour !== null && (
                  <span className="tl-scrubber-status">
                    Filtered: {String(selectedHour).padStart(2, '0')}:00–{String(selectedHour).padStart(2, '0')}:59
                    <button
                      type="button"
                      className="tl-scrubber-clear-btn"
                      onClick={() => setSelectedHour(null)}
                      title="Clear hour filter"
                      aria-label="Clear hour filter"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                )}
              </div>

              {/* Zoom & Range Presets */}
              <div className="tl-scrubber-zoom-group" role="group" aria-label="Timeline zoom intervals">
                <button
                  type="button"
                  className={`tl-scrubber-preset ${selectedInterval === 'ALL' && selectedHour === null ? 'active' : ''}`}
                  onClick={() => handleZoomPreset('24h')}
                  title="Show all 24 hours"
                >
                  24h (All)
                </button>
                <button
                  type="button"
                  className={`tl-scrubber-preset ${selectedInterval === 'morning' ? 'active' : ''}`}
                  onClick={() => handleZoomPreset('morning')}
                  title="Focus on morning captures (06:00-12:00)"
                >
                  Morning (06–12)
                </button>
                <button
                  type="button"
                  className={`tl-scrubber-preset ${selectedInterval === 'afternoon' ? 'active' : ''}`}
                  onClick={() => handleZoomPreset('afternoon')}
                  title="Focus on afternoon captures (12:00-18:00)"
                >
                  Afternoon (12–18)
                </button>
                <button
                  type="button"
                  className={`tl-scrubber-preset ${selectedInterval === 'evening' ? 'active' : ''}`}
                  onClick={() => handleZoomPreset('evening')}
                  title="Focus on evening captures (18:00-24:00)"
                >
                  Evening (18–24)
                </button>
              </div>
            </div>

            {/* 24-hour visual heat-density scrub track */}
            <div className="tl-scrubber-track-scroll">
              <div className="tl-scrubber-track" role="group" aria-label="Hourly timeline scrub track">
                {hourlyBuckets.map((bucket) => {
                  const isSelected = selectedHour === bucket.hour;
                  const heightPercent = bucket.count === 0
                    ? 0
                    : Math.max(18, Math.round((bucket.count / maxHourlyCaptures) * 100));

                  let barColor = 'var(--border-subtle)';
                  if (bucket.count > 0) {
                    if (bucket.pending === bucket.count) {
                      barColor = 'var(--text-muted)';
                    } else if (bucket.avgScore >= FOCUS_GOOD) {
                      barColor = 'var(--accent-green)';
                    } else if (bucket.avgScore >= 40) {
                      barColor = 'var(--accent-amber)';
                    } else {
                      barColor = 'var(--accent-red)';
                    }
                  }

                  const hourTooltip = bucket.count > 0
                    ? `${bucket.label}–${String(bucket.hour).padStart(2, '0')}:59: ${bucket.count} captures · ${bucket.avgScore}% Focus`
                    : `${bucket.label}: No captures`;

                  return (
                    <button
                      key={bucket.hour}
                      type="button"
                      className={`tl-scrubber-hour ${isSelected ? 'active' : ''}`}
                      onClick={() => toggleHourScrub(bucket.hour)}
                      title={hourTooltip}
                      aria-label={hourTooltip}
                      aria-pressed={isSelected}
                    >
                      <div className="tl-scrubber-bar-wrap">
                        {bucket.count > 0 ? (
                          <div
                            className="tl-scrubber-bar"
                            style={{
                              height: `${heightPercent}%`,
                              backgroundColor: barColor,
                            }}
                          />
                        ) : (
                          <div className="tl-scrubber-tick" />
                        )}
                      </div>
                      <span className="tl-scrubber-label">
                        {String(bucket.hour).padStart(2, '0')}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Filter Toolbar: Filter Pills + Search + Dropdowns */}
      <section className="card tl-filter-card" style={{ marginBottom: 16 }}>
        <div className="card-body tl-filter-body">
          {/* Row 1: Focus Filter Pills */}
          <div className="tl-filter-bar" style={{ marginBottom: 12 }}>
            <div className="tl-filter-pills" role="tablist" aria-label="Filter captures by focus rating">
              <button
                type="button"
                className={`tl-filter-pill ${selectedFocus === 'ALL' ? 'active' : ''}`}
                data-variant="all"
                onClick={() => updateSelectedFocus('ALL')}
                aria-pressed={selectedFocus === 'ALL'}
              >
                <Icon name="filter" size={13} />
                <span>All Focus</span>
                <span className="tl-pill-count">{focusCounts.ALL}</span>
              </button>

              <button
                type="button"
                className={`tl-filter-pill ${selectedFocus === 'productive' ? 'active' : ''}`}
                data-variant="productive"
                onClick={() => updateSelectedFocus('productive')}
                aria-pressed={selectedFocus === 'productive'}
              >
                <Icon name="check" size={13} color="var(--accent-green)" />
                <span>Productive</span>
                <span className="tl-pill-count">{focusCounts.productive}</span>
              </button>

              <button
                type="button"
                className={`tl-filter-pill ${selectedFocus === 'neutral' ? 'active' : ''}`}
                data-variant="neutral"
                onClick={() => updateSelectedFocus('neutral')}
                aria-pressed={selectedFocus === 'neutral'}
              >
                <Icon name="minus" size={13} color="var(--accent-amber)" />
                <span>Neutral</span>
                <span className="tl-pill-count">{focusCounts.neutral}</span>
              </button>

              <button
                type="button"
                className={`tl-filter-pill ${selectedFocus === 'unproductive' ? 'active' : ''}`}
                data-variant="unproductive"
                onClick={() => updateSelectedFocus('unproductive')}
                aria-pressed={selectedFocus === 'unproductive'}
              >
                <Icon name="x" size={13} color="var(--accent-red)" />
                <span>Unproductive</span>
                <span className="tl-pill-count">{focusCounts.unproductive}</span>
              </button>

              {focusCounts.pending > 0 && (
                <button
                  type="button"
                  className={`tl-filter-pill ${selectedFocus === 'pending' ? 'active' : ''}`}
                  data-variant="pending"
                  onClick={() => updateSelectedFocus('pending')}
                  aria-pressed={selectedFocus === 'pending'}
                >
                  <Icon name="clock" size={13} color="var(--text-muted)" />
                  <span>Pending AI</span>
                  <span className="tl-pill-count">{focusCounts.pending}</span>
                </button>
              )}
            </div>
          </div>

          {/* Row 2: Search Input + App Filter + Category Filter + Interval Select */}
          <div className="tl-filter-bar">
            <div className="tl-search-wrap">
              <input
                type="text"
                placeholder="Search apps, windows, reason..."
                className="form-input tl-search"
                aria-label="Search captures"
                value={searchQuery}
                onChange={(e) => updateSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && searchQuery) {
                    e.stopPropagation();
                    updateSearchQuery('');
                  }
                }}
              />
              <span className="tl-search-icon" aria-hidden="true">
                <Icon name="search" size={14} />
              </span>
              {searchQuery && (
                <button
                  type="button"
                  className="tl-search-clear"
                  onClick={() => updateSearchQuery('')}
                  aria-label="Clear search input"
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>

            <AppFilterSelect
              apps={uniqueApps}
              value={selectedApp}
              onChange={updateSelectedApp}
            />

            <CustomSelect
              className="tl-category-select"
              value={selectedCategory}
              onChange={updateSelectedCategory}
              ariaLabel="Filter by category"
              options={[
                {
                  value: 'ALL',
                  label: 'All Categories',
                  leading: <Icon name="filter" size={14} />,
                },
                ...uniqueCategories.map((cat) => ({ value: cat, label: cat })),
              ]}
            />

            <CustomSelect
              className="tl-interval-select"
              value={selectedInterval}
              onChange={updateSelectedInterval}
              ariaLabel="Filter by time interval"
              options={TIME_INTERVAL_OPTIONS}
            />
          </div>

          {/* Meta summary + active filter chips */}
          <div className="tl-meta-bar">
            <div className="tl-meta">
              <div className="tl-stat">
                <span className="tl-stat-label">Showing</span>
                <span className="tl-stat-value">
                  {paginatedLogs.length} of {filteredLogs.length}
                </span>
              </div>
              <div className="tl-stat">
                <span className="tl-stat-label">Avg Day Focus</span>
                {analyzedDayLogs.length === 0 ? (
                  <span className="tl-stat-value">—</span>
                ) : (
                  <span
                    className="tl-stat-value"
                    data-ok={avgDayScore >= FOCUS_OK ? 'true' : 'false'}
                  >
                    {avgDayScore}%
                  </span>
                )}
              </div>
            </div>

            {hasActiveFilters && (
              <div className="tl-chips" aria-label="Active filters">
                {activeFilters.map((chip) => (
                  <span key={chip.key} className="tl-chip" title={chip.value}>
                    <span className="tl-chip-label">{chip.value}</span>
                    <button
                      type="button"
                      className="tl-chip-x"
                      aria-label={`Remove ${chip.label} filter`}
                      onClick={chip.onRemove}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                ))}
                <button type="button" className="tl-chip-clear" onClick={clearFilters}>
                  <Icon name="x" size={12} />
                  Clear all filters
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Main Activity Timeline (List or Grid View) */}
      <section className="card tl-list-card">
        <div className="card-header">
          <span className="card-title tl-card-title">
            <Icon name="calendar" size={14} color="var(--accent-primary)" />
            {today === localISODate() ? "Today's Activity Feed" : safeFormatDateHeader(today)}
            {loading && dayLogs.length > 0 && (
              <span className="spinner-sm" style={{ marginLeft: 6 }} title="Refreshing activity feed..." />
            )}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {viewMode === 'list' ? 'List View' : 'Grid View'} ({filteredLogs.length} matching)
          </span>
        </div>

        <div className="card-body tl-list-body">
          {loadError && dayLogs.length > 0 && (
            <Alert
              type="error"
              message={loadError}
              onRetry={onRetry}
              className="tl-error-alert"
            />
          )}

          {/* Loading Skeleton States */}
          {loading && dayLogs.length === 0 ? (
            viewMode === 'grid' ? (
              <ul className="tl-grid" aria-label="Loading captures in grid">
                {SKELETON_GRID_CARDS.map((i) => (
                  <li key={i} className="tl-grid-card tl-sk-grid-card">
                    <span className="skeleton tl-sk-grid-media" />
                    <div className="tl-sk-grid-tags">
                      <span className="skeleton" style={{ width: 80, height: 20, borderRadius: 4 }} />
                      <span className="skeleton" style={{ width: 70, height: 20, borderRadius: 4 }} />
                    </div>
                    <span className="skeleton tl-sk-grid-title" />
                    <span className="skeleton tl-sk-grid-desc" />
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'auto' }}>
                      <span className="skeleton" style={{ width: 85, height: 20, borderRadius: 99 }} />
                      <span className="skeleton" style={{ width: 60, height: 14 }} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="timeline-list tl-rows" aria-label="Loading captures">
                {SKELETON_ROWS.map((i) => (
                  <li key={i} className="timeline-item tl-row tl-skeleton-row">
                    <span className="skeleton tl-sk-time" />
                    <span className="skeleton tl-sk-thumb" />
                    <div className="tl-sk-info">
                      <div className="tl-sk-chips">
                        <span className="skeleton tl-sk-chip tl-sk-chip-a" />
                        <span className="skeleton tl-sk-chip tl-sk-chip-b" />
                      </div>
                      <span className="skeleton tl-sk-line" />
                      <span className="skeleton tl-sk-line2" />
                      <span className="skeleton tl-sk-keys" />
                    </div>
                    <div className="tl-sk-score">
                      <span className="skeleton tl-sk-badge" />
                      <span className="skeleton tl-sk-conf" />
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : loadError && dayLogs.length === 0 ? (
            <Alert
              type="error"
              message={loadError}
              onRetry={onRetry}
              className="tl-error-alert"
            />
          ) : paginatedLogs.length === 0 ? (
            <EmptyState
              icon={
                hasActiveFilters ? (
                  <Icon name="search" size={36} color="var(--text-muted)" />
                ) : (
                  <Icon name="calendar" size={36} color="var(--accent-primary)" />
                )
              }
              title={hasActiveFilters ? 'No matching captures found' : 'No activity recorded for this day'}
              description={
                hasActiveFilters
                  ? 'No captures match your current search, focus rating, or hour filter. Try resetting them.'
                  : `MiniTracker was either paused, not running, or no keystroke/window activity was logged on ${safeFormatDateHeader(today)}.`
              }
              action={
                hasActiveFilters ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={clearFilters}>
                    <Icon name="x" size={13} />
                    Clear all filters
                  </button>
                ) : (
                  <div className="tl-empty-actions">
                    {today !== localISODate() && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => onDateChange(localISODate())}
                      >
                        <Icon name="chevron-right" size={14} />
                        Go to Today's Feed
                      </button>
                    )}
                    {onRetry && (
                      <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
                        <Icon name="refresh" size={14} /> Refresh Feed
                      </button>
                    )}
                  </div>
                )
              }
            />
          ) : viewMode === 'grid' ? (
            /* --- Capture Grid View --- */
            <ul className="tl-grid" role="list" aria-label="Activity captures gallery">
              {paginatedLogs.map((log, index) => {
                const appName = canonicalAppName(log.app_name);
                const time = safeFormatTime(log.timestamp);
                const windowTitle = maskSensitive ? redactSensitiveTitle(log.window_title) : (log.window_title || '');
                const entropySafe = typeof log.entropy_score === 'number' && Number.isFinite(log.entropy_score)
                  ? log.entropy_score.toFixed(1)
                  : '0.0';

                return (
                  <li
                    key={log.id ?? `grid-log-${log.timestamp}-${index}`}
                    className="tl-grid-card"
                  >
                    {/* 16:9 Media container with inspect overlay */}
                    <div className="tl-grid-media">
                      <ScreenshotThumb
                        imagePath={log.image_path}
                        onClick={log.image_path ? () => setSelectedImage(log.image_path) : undefined}
                      />
                      <div className="tl-grid-media-badge">
                        <span className="tl-grid-time">{time}</span>
                      </div>
                      {log.image_path && (
                        <div className="tl-grid-overlay" aria-hidden="true">
                          <Icon name="search" size={14} />
                          <span>Inspect Screenshot</span>
                        </div>
                      )}
                    </div>

                    {/* Card Body */}
                    <div className="tl-grid-body">
                      <div className="tl-grid-header">
                        {appName && (
                          <span className="tl-app-chip" title={appName}>
                            <AppIcon name={appName} size={14} />
                            <span className="tl-app-chip-label">{appName}</span>
                          </span>
                        )}
                        <CategoryBadge category={log.ai_category} />
                      </div>

                      {windowTitle && (
                        <h3 className="tl-grid-title" title={windowTitle}>
                          {windowTitle}
                        </h3>
                      )}

                      <p className="tl-grid-reason" title={log.ai_reason || undefined}>
                        {log.ai_reason || 'No analysis details recorded.'}
                      </p>

                      <div className="tl-grid-keys">
                        <span title="Keys pressed">
                          <Icon name="keyboard" size={12} />
                          {(log.total_keys ?? 0).toLocaleString()}
                        </span>
                        {(log.total_clicks ?? 0) > 0 && (
                          <span title="Mouse clicks">
                            <Icon name="target" size={12} />
                            {log.total_clicks}
                          </span>
                        )}
                        <span title="Typing entropy score">
                          Entropy: {entropySafe}
                        </span>
                      </div>
                    </div>

                    {/* Card Footer: 3-tier Focus Badge + AI Confidence */}
                    <div className="tl-grid-footer">
                      {renderFocusBadge(log)}
                      {(log.ai_confidence ?? 0) > 0 && (
                        <span className="tl-confidence">
                          {((log.ai_confidence ?? 0) * 100).toFixed(0)}% AI confidence
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            /* --- Capture List View --- */
            <ul className="timeline-list tl-rows" role="list" aria-label="Activity captures list">
              {paginatedLogs.map((log, index) => {
                const appName = canonicalAppName(log.app_name);
                const time = safeFormatTime(log.timestamp);
                const windowTitle = maskSensitive ? redactSensitiveTitle(log.window_title) : (log.window_title || '');
                const entropySafe = typeof log.entropy_score === 'number' && Number.isFinite(log.entropy_score)
                  ? log.entropy_score.toFixed(1)
                  : '0.0';

                return (
                  <li
                    key={log.id ?? `list-log-${log.timestamp}-${index}`}
                    className="timeline-item tl-row"
                    aria-label={`${time} — ${appName || 'Unknown app'}`}
                  >
                    <span className="timeline-time tl-time">{time}</span>

                    <ScreenshotThumb
                      imagePath={log.image_path}
                      onClick={log.image_path ? () => setSelectedImage(log.image_path) : undefined}
                    />

                    <div className="timeline-info">
                      <div className="tl-tags">
                        <CategoryBadge category={log.ai_category} />
                        {appName && (
                          <span className="tl-app-chip" title={appName}>
                            <AppIcon name={appName} size={14} />
                            <span className="tl-app-chip-label">{appName}</span>
                          </span>
                        )}
                        {log.app_category && (
                          <span className="tl-app-category" title={log.app_category}>
                            ({log.app_category})
                          </span>
                        )}
                      </div>

                      {windowTitle && (
                        <div className="tl-window-title" title={windowTitle}>
                          {windowTitle}
                        </div>
                      )}

                      <div className="timeline-reason" title={log.ai_reason || undefined}>
                        {log.ai_reason || '—'}
                      </div>

                      <div className="tl-keys">
                        <span className="tl-keys-icon" aria-hidden="true">
                          <Icon name="keyboard" size={12} />
                        </span>
                        <span>{(log.total_keys ?? 0).toLocaleString()} keys · {(log.unique_keys ?? 0).toLocaleString()} unique</span>
                        {(log.total_clicks ?? 0) > 0 && (
                          <>
                            <span className="tl-dot" aria-hidden="true">•</span>
                            <span>{log.total_clicks} clicks</span>
                          </>
                        )}
                        <span className="tl-dot" aria-hidden="true">•</span>
                        <span>Entropy: {entropySafe}</span>
                      </div>
                    </div>

                    <div className="tl-score-col">
                      {renderFocusBadge(log)}
                      {(log.ai_confidence ?? 0) > 0 && (
                        <span className="tl-confidence">
                          {((log.ai_confidence ?? 0) * 100).toFixed(0)}% AI confidence
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Pagination Footer */}
        {filteredLogs.length > 0 && (
          <footer className="tl-pagination">
            <div className="tl-pagination-side tl-pagination-left">
              <label htmlFor="timeline-page-size" className="tl-pagination-label">Per page</label>
              <CustomSelect
                id="timeline-page-size"
                ariaLabel="Rows per page"
                compact
                value={String(safePageSize)}
                onChange={(value) => {
                  const parsed = Number(value);
                  if (parsed > 0) {
                    setPageSize(parsed);
                    setCurrentPage(1);
                  }
                }}
                options={[12, 24, 48, 96].map((size) => ({
                  value: String(size),
                  label: String(size),
                }))}
              />
            </div>

            <div className="tl-pagination-nav">
              <button
                type="button"
                disabled={safeCurrentPage <= 1}
                onClick={() => setCurrentPage(safeCurrentPage - 1)}
                className="btn btn-secondary btn-sm tl-page-btn"
                aria-label="Previous page"
              >
                <Icon name="chevron-left" size={14} />
                Previous
              </button>
              <span className="tl-page-info">
                {safeCurrentPage} / {totalPages}
              </span>
              <button
                type="button"
                disabled={safeCurrentPage >= totalPages}
                onClick={() => setCurrentPage(safeCurrentPage + 1)}
                className="btn btn-secondary btn-sm tl-page-btn"
                aria-label="Next page"
              >
                Next
                <Icon name="chevron-right" size={14} />
              </button>
            </div>

            <div className="tl-pagination-side tl-pagination-range">
              Showing {pageFirstRow}–{pageLastRow} of {filteredLogs.length}
            </div>
          </footer>
        )}
      </section>
    </div>
  );
}
