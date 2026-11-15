import React from 'react';
import { Icon, IconName } from './Icon';
import { Page, User } from '../types';
import { isDesktopApp } from '../services/wailsBridge';
import logoAsset from '../assets/logo.png';

interface SidebarProps {
  page: Page;
  isMobileMenuOpen: boolean;
  setIsMobileMenuOpen: (open: boolean) => void;
  currentUser: User | null;
  isGuestMode: boolean;
  setIsGuestMode: (isGuest: boolean) => void;
  elapsedSeconds: number;
  formatTimer: (seconds: number) => string;
  isTrackingActive: boolean;
  handleToggleTracking: () => void;
  trackerError: string | null;
  userTask: string;
  onOpenTaskModal: () => void;
  isSyncing: boolean;
  syncMessage: string | null;
  handleSyncNow: () => void;
  navItems: { id: Page; iconName: IconName; label: string }[];
  navigateTo: (page: Page) => void;
  handleLogout: () => void;
  dev: {
    enabled: boolean;
    registerTap: () => void;
    setOpen: (open: boolean) => void;
  };
  aiKeyPresent: boolean;
  aiConfigured?: boolean;
}

export function Sidebar({
  page,
  isMobileMenuOpen,
  setIsMobileMenuOpen,
  currentUser,
  isGuestMode,
  setIsGuestMode,
  elapsedSeconds,
  formatTimer,
  isTrackingActive,
  handleToggleTracking,
  trackerError,
  userTask,
  onOpenTaskModal,
  isSyncing,
  syncMessage,
  handleSyncNow,
  navItems,
  navigateTo,
  handleLogout,
  dev,
  aiKeyPresent,
  aiConfigured,
}: SidebarProps) {
  const isDesktop = isDesktopApp();
  // AI is ready only when a local key is present or the server backend has AI configured
  const isAIReady = Boolean(aiKeyPresent || aiConfigured);

  const handleNavClick = (id: Page) => {
    navigateTo(id);
    setIsMobileMenuOpen(false);
  };

  const handleLogoutClick = () => {
    setIsMobileMenuOpen(false);
    handleLogout();
  };

  const handleExitGuestMode = () => {
    try {
      localStorage.removeItem('mini_guest_mode');
    } catch {}
    setIsMobileMenuOpen(false);
    setIsGuestMode(false);
  };

  return (
    <>
      {/* Mobile Header Bar */}
      <header className="mobile-header">
        <div
          className="mobile-header-brand"
          onClick={() => dev.registerTap()}
          style={{ cursor: 'default' }}
          title="get-Hike Productivity"
        >
          <img src={logoAsset} alt="get-Hike Logo" className="app-brand-logo-img" style={{ width: 34, height: 34 }} />
          <span className="sidebar-logo-text" style={{ fontSize: 14 }}>get-Hike</span>
        </div>
        <div className="mobile-header-actions">
          {isDesktop && (
            <div
              role="timer"
              aria-label={`Work session timer: ${formatTimer(elapsedSeconds)}`}
              style={{
                fontFamily: 'monospace',
                fontSize: 13,
                fontWeight: 700,
                color: 'var(--teal-text)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatTimer(elapsedSeconds)}
            </div>
          )}
          <button
            type="button"
            className="mobile-menu-toggle"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            aria-label={isMobileMenuOpen ? 'Close Navigation Menu' : 'Open Navigation Menu'}
            aria-expanded={isMobileMenuOpen}
            aria-controls="sidebar"
          >
            {isMobileMenuOpen ? '✕' : '☰'}
          </button>
        </div>
      </header>

      {/* Sidebar Backdrop Overlay for Mobile */}
      {isMobileMenuOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setIsMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar Drawer */}
      <aside
        className={`sidebar ${isMobileMenuOpen ? 'open' : ''}`}
        id="sidebar"
        aria-label="Main Navigation"
      >
        <div
          className="sidebar-logo"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div
            onClick={() => dev.registerTap()}
            style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'default', flex: 1 }}
          >
            <img src={logoAsset} alt="get-Hike Logo" className="app-brand-logo-img" style={{ width: 32, height: 32 }} />
            <div>
              <div className="sidebar-logo-text">get-Hike</div>
              <div className="sidebar-logo-sub">Productivity</div>
            </div>
          </div>
          {/* Mobile drawer quick-close button */}
          {isMobileMenuOpen && (
            <button
              type="button"
              onClick={() => setIsMobileMenuOpen(false)}
              aria-label="Close navigation drawer"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '4px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="x" size={16} />
            </button>
          )}
        </div>

        {/* Work Clock & Tracking Control Widget - Desktop Only */}
        {isDesktop && (
          <div className="sidebar-widget">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span className="sidebar-widget-label">Work Session</span>
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 6px',
                  borderRadius: 4,
                  fontWeight: 600,
                  background: isGuestMode
                    ? 'color-mix(in srgb, var(--accent-purple) 15%, transparent)'
                    : 'color-mix(in srgb, var(--accent-green) 15%, transparent)',
                  color: isGuestMode ? 'var(--accent-purple)' : 'var(--accent-primary-text)',
                  border: isGuestMode
                    ? '1px solid color-mix(in srgb, var(--accent-purple) 30%, transparent)'
                    : '1px solid color-mix(in srgb, var(--accent-green) 30%, transparent)',
                  whiteSpace: 'nowrap',
                }}
              >
                {isGuestMode ? 'Offline Guest' : 'Synced'}
              </span>
            </div>
            <div
              className="sidebar-widget-timer"
              role="timer"
              aria-label={`Elapsed time: ${formatTimer(elapsedSeconds)}`}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {formatTimer(elapsedSeconds)}
            </div>
            <button
              type="button"
              onClick={handleToggleTracking}
              className={`btn-tracker-toggle ${isTrackingActive ? 'active' : 'paused'}`}
              style={{ marginBottom: 8 }}
              aria-label={isTrackingActive ? 'Pause work tracking' : 'Start work tracking'}
              aria-pressed={isTrackingActive}
            >
              <Icon name={isTrackingActive ? 'pause' : 'play'} size={14} />
              <span>{isTrackingActive ? 'Pause Tracker' : 'Start Tracker'}</span>
            </button>
            {trackerError && (
              <div
                role="alert"
                aria-live="assertive"
                style={{
                  fontSize: 11,
                  padding: '6px 8px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'color-mix(in srgb, var(--accent-red) 15%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--accent-red) 35%, transparent)',
                  color: 'var(--danger-text)',
                  marginBottom: 8,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Icon name="x" size={12} />
                <span style={{ flex: 1 }}>{trackerError}</span>
              </div>
            )}
            <button
              type="button"
              onClick={onOpenTaskModal}
              className={`btn-task-goal ${userTask ? 'active' : ''}`}
              title={userTask || 'Set target task goal (max 20 words)'}
              aria-label={userTask ? `Active task: ${userTask}. Click to edit.` : 'Set target task goal'}
            >
              <Icon name="target" size={12} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {userTask ? `Task: ${userTask}` : 'Set Target Task Goal'}
              </span>
            </button>
            {!isGuestMode && (
              <button
                type="button"
                onClick={handleSyncNow}
                disabled={isSyncing}
                className={`btn-sync-now ${isSyncing ? 'syncing' : ''}`}
                aria-label={isSyncing ? 'Sync in progress' : (syncMessage || 'Sync with server now')}
              >
                <Icon name="refresh" size={12} className={isSyncing ? 'spin' : ''} />
                <span>{isSyncing ? 'Syncing...' : (syncMessage || 'Sync Now')}</span>
              </button>
            )}
          </div>
        )}

        <nav aria-label="Main Navigation" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="sidebar-section-label">Navigation</div>
          {navItems.map((item) => {
            const active = page === item.id;
            return (
              <button
                key={item.id}
                id={`nav-${item.id}`}
                type="button"
                className={`nav-item ${active ? 'active' : ''}`}
                onClick={() => handleNavClick(item.id)}
                aria-current={active ? 'page' : undefined}
                style={{
                  borderTop: 'none',
                  borderRight: 'none',
                  borderBottom: 'none',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <Icon name={item.iconName} size={16} className="nav-icon" />
                <span className="nav-text">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          {currentUser ? (
            <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="user" size={14} color="var(--text-secondary)" />
                <span
                  style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={currentUser.full_name || currentUser.email}
                >
                  {currentUser.full_name || currentUser.email}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                <span style={{ textTransform: 'capitalize' }}>Role: {currentUser.role || 'Member'}</span>
                <button
                  type="button"
                  onClick={handleLogoutClick}
                  title="Sign out of get-Hike"
                  aria-label="Sign out of account"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--danger-text)',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 6px',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <span>Logout</span>
                  <Icon name="logout" size={12} />
                </button>
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: 10 }}>
              {isGuestMode && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: 'var(--accent-purple)',
                      display: 'inline-block',
                    }}
                    aria-hidden="true"
                  />
                  <span>Offline Guest Mode</span>
                </div>
              )}
              <button
                type="button"
                onClick={handleExitGuestMode}
                className="btn btn-secondary btn-sm w-full"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  fontSize: 12,
                  marginBottom: 8,
                }}
              >
                <Icon name="lock" size={13} />
                <span>Sign In / Sign Up</span>
              </button>
            </div>
          )}

          {dev.enabled && isDesktop && (
            <button
              type="button"
              className="dev-badge dev-badge-btn"
              onClick={() => dev.setOpen(true)}
              title="Open Developer Menu (Ctrl+Shift+D)"
              aria-label="Open Developer Menu (Ctrl+Shift+D)"
              aria-haspopup="dialog"
            >
              DEV
            </button>
          )}

          <div
            className="status-badge"
            role="status"
            aria-label={`AI Status: ${isAIReady ? 'Engine Ready' : 'Standby'}`}
          >
            <div
              className={`status-dot ${isAIReady ? '' : 'inactive'}`}
              style={{
                background: isAIReady ? 'var(--accent-teal)' : undefined,
                boxShadow: isAIReady ? '0 0 8px var(--accent-teal)' : undefined,
              }}
              aria-hidden="true"
            />
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              {isAIReady ? 'AI Engine Ready' : 'AI Standby'}
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}
