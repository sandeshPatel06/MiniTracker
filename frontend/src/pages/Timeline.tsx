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
import { localISODate, isPendingLog, FOCUS_OK } from '../utils';

interface Props {
  logs: LogEntry[];
  loading: boolean;
  today: string;
  onDateChange: (date: string) => void;
  loadError?: string | null;
  onRetry?: () => void;
}

const SKELETON_ROWS = [1, 2, 3, 4, 5];

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

// Interval filter definitions
type TimeInterval = 'ALL' | 'morning' | 'afternoon' | 'evening' | 'night';
type FocusFilter = 'ALL' | 'productive' | 'unproductive' | 'pending';

const TIME_INTERVAL_OPTIONS = [
  { value: 'ALL', label: 'All Day (24 hrs)', leading: <Icon name="clock" size={14} /> },
  { value: 'morning', label: 'Morning (06:00–12:00)' },
  { value: 'afternoon', label: 'Afternoon (12:00–18:00)' },
  { value: 'evening', label: 'Evening (18:00–24:00)' },
  { value: 'night', label: 'Night (00:00–06:00)' },
];

const FOCUS_FILTER_OPTIONS = [
  { value: 'ALL', label: 'All Focus Ratings', leading: <Icon name="filter" size={14} /> },
  { value: 'productive', label: 'Productive (≥50%)' },
  { value: 'unproductive', label: 'Unproductive (<50%)' },
  { value: 'pending', label: 'Pending AI Analysis' },
];

export default function Timeline({ logs = [], loading, today, onDateChange, loadError, onRetry }: Props) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedApp, setSelectedApp] = useState('ALL');
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [selectedInterval, setSelectedInterval] = useState<TimeInterval>('ALL');
  const [selectedFocus, setSelectedFocus] = useState<FocusFilter>('ALL');
  const [maskSensitive, setMaskSensitive] = useState(true);

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const deferredSearchQuery = useDeferredValue(searchQuery);

  // Scope logs strictly to the selected day (prevents bleed from Analytics multi-day fetches)
  const dayLogs = useMemo(() => {
    if (!Array.isArray(logs) || !today) return [];
    return logs.filter((log) => {
      if (!log?.timestamp) return false;
      const d = parseTimestampSafe(log.timestamp);
      return d ? localISODate(d) === today : log.timestamp.startsWith(today);
    });
  }, [logs, today]);

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
      isPending: boolean;
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
      const isPending = isPendingLog(log);
      const windowTitle = maskSensitive ? redactSensitiveTitle(log.window_title) : (log.window_title || '');

      prepared.push({
        raw: log,
        parsedTime,
        hour,
        canonicalApp,
        score,
        isPending,
        windowTitle,
      });
    }

    return prepared
      .filter((item) => {
        if (selectedApp !== 'ALL' && item.canonicalApp !== selectedApp) return false;
        if (selectedCategory !== 'ALL' && item.raw.ai_category !== selectedCategory) return false;

        // Focus status filter
        if (selectedFocus === 'pending' && !item.isPending) return false;
        if (selectedFocus === 'productive' && (item.isPending || item.score < 50)) return false;
        if (selectedFocus === 'unproductive' && (item.isPending || item.score >= 50)) return false;

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
  }, [dayLogs, selectedApp, selectedCategory, selectedInterval, selectedFocus, deferredSearchQuery, maskSensitive]);

  // Safe pagination calculations avoiding NaN, 0, or negative pages
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / safePageSize));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

  // Reset to page 1 when the selected day changes without destroying active search/filters
  useEffect(() => {
    setCurrentPage(1);
  }, [today]);

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
    selectedFocus !== 'ALL';

  const clearFilters = () => {
    setSearchQuery('');
    setSelectedApp('ALL');
    setSelectedCategory('ALL');
    setSelectedInterval('ALL');
    setSelectedFocus('ALL');
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
    setCurrentPage(1);
  };

  const updateSelectedFocus = (value: string) => {
    setSelectedFocus(value as FocusFilter);
    setCurrentPage(1);
  };

  const activeFilters = useMemo(() => {
    const chips: Array<{ key: string; label: string; value: string; onRemove: () => void }> = [];
    if (searchQuery.trim()) {
      const query = searchQuery.trim();
      chips.push({ key: 'search', label: 'Search', value: query, onRemove: () => updateSearchQuery('') });
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
    if (selectedFocus !== 'ALL') {
      const opt = FOCUS_FILTER_OPTIONS.find((o) => o.value === selectedFocus);
      chips.push({
        key: 'focus',
        label: 'Focus',
        value: opt ? opt.label : selectedFocus,
        onRemove: () => updateSelectedFocus('ALL'),
      });
    }
    return chips;
  }, [searchQuery, selectedApp, selectedCategory, selectedInterval, selectedFocus]);

  // Safe row range numbers using safeCurrentPage and safePageSize
  const pageFirstRow = filteredLogs.length === 0 ? 0 : (safeCurrentPage - 1) * safePageSize + 1;
  const pageLastRow = Math.min(safeCurrentPage * safePageSize, filteredLogs.length);

  return (
    <div aria-busy={loading} className="tl-page fade-in-up">
      <ImageModal imagePath={selectedImage} onClose={() => setSelectedImage(null)} />

      {/* Header Bar */}
      <div className="page-header tl-header" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title">Activity Timeline</h1>
          <p className="page-subtitle">Detailed minute-by-minute activity captures &amp; AI focus ratings.</p>
        </div>
      </div>

      {/* Filter toolbar */}
      <div className="card tl-filter-card" style={{ marginBottom: 16 }}>
        <div className="card-body tl-filter-body">
          <div className="tl-filter-bar">
            <DateNavigator
              className="tl-date-nav"
              currentDate={today}
              maxDate={localISODate()}
              onDateChange={onDateChange}
            />

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

            <CustomSelect
              className="tl-focus-select"
              value={selectedFocus}
              onChange={updateSelectedFocus}
              ariaLabel="Filter by focus score"
              options={FOCUS_FILTER_OPTIONS}
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
                  Clear filters
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Activity Timeline List */}
      <div className="card tl-list-card">
        <div className="card-header">
          <span className="card-title tl-card-title">
            <Icon name="calendar" size={14} color="var(--accent-primary)" />
            {today === localISODate() ? "Today's Log Feed" : safeFormatDateHeader(today)}
            {loading && dayLogs.length > 0 && (
              <span className="spinner-sm" style={{ marginLeft: 6 }} title="Refreshing activity feed..." />
            )}
          </span>
          <div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setMaskSensitive((prev) => !prev)}
              title={maskSensitive ? 'Disable sensitive window masking' : 'Mask sensitive window titles'}
              style={{ fontSize: 11, padding: '4px 8px' }}
            >
              <Icon name="lock" size={12} color={maskSensitive ? 'var(--accent-teal)' : undefined} />
              {maskSensitive ? 'Privacy Mask ON' : 'Privacy Mask OFF'}
            </button>
          </div>
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
          {loading && dayLogs.length === 0 ? (
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
          ) : loadError && dayLogs.length === 0 ? (
            <Alert
              type="error"
              message={loadError}
              onRetry={onRetry}
              className="tl-error-alert"
            />
          ) : paginatedLogs.length === 0 ? (
            <EmptyState
              icon={<Icon name="inbox" size={32} />}
              title={hasActiveFilters ? 'No matching captures found' : 'No captures on this date'}
              description={
                hasActiveFilters
                  ? 'Try adjusting or clearing your filters.'
                  : 'The tracker may not have been running, or no activity was recorded on this day.'
              }
              action={
                hasActiveFilters ? (
                  <button className="btn btn-secondary btn-sm" onClick={clearFilters}>
                    Clear filters
                  </button>
                ) : (
                  <div style={{ display: 'inline-flex', gap: 8 }}>
                    {onRetry && (
                      <button className="btn btn-primary btn-sm" onClick={onRetry}>
                        <Icon name="refresh" size={14} /> Refresh Feed
                      </button>
                    )}
                    {today !== localISODate() && (
                      <button className="btn btn-secondary btn-sm" onClick={() => onDateChange(localISODate())}>
                        Go to today
                      </button>
                    )}
                  </div>
                )
              }
            />
          ) : (
            <ul className="timeline-list tl-rows">
              {paginatedLogs.map((log, index) => {
                const isNum = typeof log.productive_score === 'number' && Number.isFinite(log.productive_score);
                const rawScore = isNum ? log.productive_score! : log.is_productive ? 100 : 0;
                const scoreVal = Math.min(100, Math.max(0, Math.round(rawScore)));
                const appName = canonicalAppName(log.app_name);
                const time = safeFormatTime(log.timestamp);
                const stateLabel = isPendingLog(log) ? 'pending' : scoreVal >= 50 ? 'productive' : 'unproductive';
                const windowTitle = maskSensitive ? redactSensitiveTitle(log.window_title) : (log.window_title || '');
                const entropySafe = typeof log.entropy_score === 'number' && Number.isFinite(log.entropy_score)
                  ? log.entropy_score.toFixed(1)
                  : '0.0';

                return (
                  <li
                    key={log.id ?? `log-${log.timestamp}-${index}`}
                    className="timeline-item tl-row"
                    aria-label={`${time} — ${appName || 'Unknown app'} — ${stateLabel}`}
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
                      {isPendingLog(log) ? (
                        <span className="badge badge-pending">Pending AI</span>
                      ) : (
                        <span className={`badge ${scoreVal >= 50 ? 'badge-productive' : 'badge-unproductive'}`}>
                          <Icon name={scoreVal >= 50 ? 'check' : 'x'} size={13} />
                          {scoreVal}% Focus
                        </span>
                      )}
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
                options={[15, 25, 50, 100].map((size) => ({
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
              >
                Next
                <Icon name="chevron-right" size={14} />
              </button>
            </div>

            <div className="tl-pagination-side tl-pagination-range">
              Rows {pageFirstRow}–{pageLastRow} of {filteredLogs.length}
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}