import { useState, useMemo, useEffect } from 'react';
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

export default function Timeline({ logs, loading, today, onDateChange, loadError, onRetry }: Props) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedApp, setSelectedApp] = useState('ALL');
  const [selectedCategory, setSelectedCategory] = useState('ALL');

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Extract unique app names & categories for dropdown filters
  const uniqueApps = useMemo(() => {
    const apps = new Set<string>();
    logs.forEach((l) => {
      const app = canonicalAppName(l.app_name);
      if (app) apps.add(app);
    });
    return Array.from(apps).sort();
  }, [logs]);

  const uniqueCategories = useMemo(() => {
    const cats = new Set<string>();
    logs.forEach((l) => {
      if (l.ai_category && l.ai_category !== 'Unknown') cats.add(l.ai_category);
    });
    return Array.from(cats).sort();
  }, [logs]);

  // Filter logs based on search query, app, and category
  const filteredLogs = useMemo(() => {
    return logs
      .filter((log) => {
        if (selectedApp !== 'ALL' && canonicalAppName(log.app_name) !== selectedApp) return false;
        if (selectedCategory !== 'ALL' && log.ai_category !== selectedCategory) return false;
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const matchApp = log.app_name?.toLowerCase().includes(q);
          const matchReason = log.ai_reason?.toLowerCase().includes(q);
          const matchCat = log.ai_category?.toLowerCase().includes(q);
          const matchWindow = log.window_title?.toLowerCase().includes(q);
          return matchApp || matchReason || matchCat || matchWindow;
        }
        return true;
      })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [logs, selectedApp, selectedCategory, searchQuery]);

  const totalPages = Math.ceil(filteredLogs.length / pageSize) || 1;

  // Reset to page 1 and clear filters when the selected day changes
  useEffect(() => {
    setCurrentPage(1);
    setSearchQuery('');
    setSelectedApp('ALL');
    setSelectedCategory('ALL');
  }, [today]);

  // Never leave the paginator on a page that no longer exists
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const paginatedLogs = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredLogs.slice(start, start + pageSize);
  }, [filteredLogs, currentPage, pageSize]);

  // Calculate day summary metrics from analyzed captures only
  const analyzedLogs = useMemo(() => logs.filter((l) => !isPendingLog(l)), [logs]);

  const avgDayScore = analyzedLogs.length > 0
    ? Math.round(
        analyzedLogs.reduce((acc, l) => acc + (typeof l.productive_score === 'number' ? l.productive_score : l.is_productive ? 100 : 0), 0) / analyzedLogs.length
      )
    : 0;

  const hasActiveFilters = Boolean(searchQuery.trim()) || selectedApp !== 'ALL' || selectedCategory !== 'ALL';

  const clearFilters = () => {
    setSearchQuery('');
    setSelectedApp('ALL');
    setSelectedCategory('ALL');
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
    return chips;
  }, [searchQuery, selectedApp, selectedCategory]);

  const pageFirstRow = filteredLogs.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const pageLastRow = Math.min(currentPage * pageSize, filteredLogs.length);

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

      {/* Compact filter toolbar */}
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
              />
              <span className="tl-search-icon" aria-hidden="true">
                <Icon name="search" size={14} />
              </span>
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
                {analyzedLogs.length === 0 ? (
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
            {today === localISODate() ? 'Today\'s Log Feed' : format(new Date(today + 'T00:00:00'), 'MMMM d, yyyy')}
          </span>
        </div>

        <div className="card-body tl-list-body">
          {loadError && logs.length > 0 && (
            <Alert
              type="error"
              message={loadError}
              onRetry={onRetry}
              className="tl-error-alert"
            />
          )}
          {loading && logs.length === 0 ? (
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
          ) : loadError && logs.length === 0 ? (
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
                  : 'The tracker may not have been running, or the backend is unreachable.'
              }
              action={
                hasActiveFilters ? (
                  <button className="btn btn-secondary btn-sm" onClick={clearFilters}>
                    Clear filters
                  </button>
                ) : today !== localISODate() ? (
                  <button className="btn btn-secondary btn-sm" onClick={() => onDateChange(localISODate())}>Go to today</button>
                ) : undefined
              }
            />
          ) : (
            <ul className="timeline-list tl-rows">
              {paginatedLogs.map((log) => {
                const scoreVal = typeof log.productive_score === 'number'
                  ? Math.round(log.productive_score)
                  : log.is_productive ? 100 : 0;
                const appName = canonicalAppName(log.app_name);
                const time = format(new Date(log.timestamp), 'HH:mm:ss');
                const stateLabel = isPendingLog(log) ? 'pending' : scoreVal >= 50 ? 'productive' : 'unproductive';

                return (
                  <li
                    key={log.id}
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

                      {log.window_title && (
                        <div className="tl-window-title" title={log.window_title}>
                          {log.window_title}
                        </div>
                      )}

                      <div className="timeline-reason" title={log.ai_reason || undefined}>
                        {log.ai_reason || '—'}
                      </div>

                      <div className="tl-keys">
                        <span className="tl-keys-icon" aria-hidden="true">
                          <Icon name="keyboard" size={12} />
                        </span>
                        <span>{log.total_keys} keys · {log.unique_keys} unique</span>
                        <span className="tl-dot" aria-hidden="true">•</span>
                        <span>Entropy: {log.entropy_score.toFixed(1)}</span>
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
                      {log.ai_confidence > 0 && (
                        <span className="tl-confidence">
                          {(log.ai_confidence * 100).toFixed(0)}% AI confidence
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
                value={String(pageSize)}
                onChange={(value) => {
                  setPageSize(Number(value));
                  setCurrentPage(1);
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
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="btn btn-secondary btn-sm tl-page-btn"
              >
                <Icon name="chevron-left" size={14} />
                Previous
              </button>
              <span className="tl-page-info">
                {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
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
