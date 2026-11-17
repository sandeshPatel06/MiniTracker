import React from 'react';
import { Icon, IconName } from './Icon';
import { Page, User, Organization } from '../types';
import { isDesktopApp } from '../services/wailsBridge';
import { useToast } from '../context/ToastContext';
import logoAsset from '../assets/logo.png';

interface SidebarProps {
  page: Page;
  isMobileMenuOpen: boolean;
  setIsMobileMenuOpen: (open: boolean) => void;
  currentUser: User | null;
  currentOrg?: Organization | null;
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
  backendUnavailable?: boolean;
}

export function Sidebar({
  page,
  isMobileMenuOpen,
  setIsMobileMenuOpen,
  currentUser,
  currentOrg,
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
  backendUnavailable,
}: SidebarProps) {
  const toast = useToast();
  const isDesktop = isDesktopApp();

  const userInitials = (currentUser?.full_name || currentUser?.email || 'U')
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || '')
    .join('') || 'U';

  const isAIReady = aiKeyPresent || Boolean(aiConfigured) || Boolean(currentUser?.role === 'member');

  return (
    <>
      {/* Mobile Header Bar */}
      <header className="mobile-header">
        <div
          className="mobile-header-brand"
          onClick={() => dev.registerTap()}
          style={{ cursor: 'pointer' }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              dev.registerTap();
            }
          }}
          title="get-Hike"
        >
          <img
            src={logoAsset}
            alt="get-Hike brand logo"
            className="sidebar-brand-img"
          />
          <span className="sidebar-logo-text">get-Hike</span>
          <span className="sidebar-brand-pill">v1</span>
        </div>
        <div className="mobile-header-actions">
          {isDesktop && (
            <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 13, fontWeight: 700, color: 'var(--teal-text)', fontVariantNumeric: 'tabular-nums' }}>
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
      <aside className={`sidebar ${isMobileMenuOpen ? 'open' : ''}`} id="sidebar" aria-label="Sidebar navigation">
        {/* Brand Header */}
        <div
          className="sidebar-logo"
          onClick={() => dev.registerTap()}
          style={{ cursor: 'pointer' }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              dev.registerTap();
            }
          }}
          title="get-Hike — Click to inspect"
        >
          <div className="sidebar-logo-brand">
            <img
              src={logoAsset}
              alt="get-Hike brand logo"
              className="sidebar-brand-img"
            />
            <div>
              <div className="sidebar-logo-text">get-Hike</div>
              <div className="sidebar-logo-sub">Productivity</div>
            </div>
          </div>
          <span className="sidebar-brand-pill">v1</span>
        </div>

        {/* Workspace / Organization Switcher Info */}
        {(currentOrg || currentUser) && (
          <div
            className="sidebar-org-box"
            title={currentOrg ? `Workspace: ${currentOrg.name}` : 'Default Workspace'}
          >
            <Icon name="building" size={13} color="var(--text-muted)" />
            <div className="sidebar-org-name">
              {currentOrg?.name || 'My Workspace'}
            </div>
          </div>
        )}

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
                  background: isGuestMode ? 'color-mix(in srgb, var(--accent-purple) 15%, transparent)' : 'color-mix(in srgb, var(--accent-green) 15%, transparent)',
                  color: isGuestMode ? 'var(--accent-purple)' : 'var(--accent-primary-text)',
                  border: isGuestMode ? '1px solid color-mix(in srgb, var(--accent-purple) 30%, transparent)' : '1px solid color-mix(in srgb, var(--accent-green) 30%, transparent)',
                  whiteSpace: 'nowrap',
                }}
              >
                {isGuestMode ? 'Offline Guest' : 'Synced'}
              </span>
            </div>
            <div className="sidebar-widget-timer" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatTimer(elapsedSeconds)}
            </div>
            <button
              type="button"
              onClick={handleToggleTracking}
              className={`btn-tracker-toggle ${isTrackingActive ? 'active' : 'paused'}`}
              style={{ marginBottom: 8 }}
            >
              <Icon name={isTrackingActive ? 'pause' : 'play'} size={14} />
              <span>{isTrackingActive ? 'Pause Tracker' : 'Start Tracker'}</span>
            </button>
            {trackerError && (
              <div
                role="alert"
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
            >
              <Icon name="target" size={12} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {userTask ? `Task: ${userTask}` : 'Set Target Task Goal'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                const w = window as any;
                if (w.go?.main?.App?.TogglePrivacyMode) {
                  w.go.main.App.TogglePrivacyMode().then((active: boolean) => {
                    toast.info(active ? 'Privacy Shield enabled' : 'Privacy Shield disabled');
                  });
                }
              }}
              className="btn-task-goal"
              style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}
              title="Toggle Privacy Shield (Auto-blur credentials & vaults)"
            >
              <Icon name="shield" size={12} />
              <span>Privacy Shield</span>
            </button>
            {!isGuestMode && (
              <button
                type="button"
                onClick={handleSyncNow}
                disabled={isSyncing}
                className={`btn-sync-now ${isSyncing ? 'syncing' : ''}`}
              >
                <Icon name="refresh" size={12} className={isSyncing ? 'spin' : ''} />
                <span>{isSyncing ? 'Syncing...' : (syncMessage || 'Sync Now')}</span>
              </button>
            )}
          </div>
        )}

        <div className="sidebar-section-label">Navigation</div>
        <nav aria-label="Main Navigation">
          {navItems.map((item) => {
            const active = page === item.id;
            return (
              <button
                key={item.id}
                id={`nav-${item.id}`}
                type="button"
                className={`nav-item ${active ? 'active' : ''}`}
                onClick={() => {
                  navigateTo(item.id);
                  setIsMobileMenuOpen(false);
                }}
                aria-current={active ? 'page' : undefined}
                style={{
                  textAlign: 'left',
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  width: 'calc(100% - 16px)',
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
            <div className="sidebar-footer-user">
              <div className="sidebar-user-row">
                <div className="sidebar-user-avatar" aria-hidden="true">
                  {userInitials}
                </div>
                <div className="sidebar-user-info">
                  <div
                    className="sidebar-user-name"
                    title={currentUser.full_name || currentUser.email}
                  >
                    {currentUser.full_name || currentUser.email}
                  </div>
                  <div className="sidebar-user-meta">
                    <span style={{ textTransform: 'capitalize' }}>Role: {currentUser.role}</span>
                    <button
                      type="button"
                      className="sidebar-logout-btn"
                      onClick={() => {
                        setIsMobileMenuOpen(false);
                        handleLogout();
                      }}
                      title="Sign out of your account"
                    >
                      <span>Logout</span>
                      <Icon name="logout" size={11} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: 10 }}>
              <button
                type="button"
                onClick={() => {
                  setIsMobileMenuOpen(false);
                  setIsGuestMode(false);
                }}
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
            >
              DEV
            </button>
          )}

          {/* Status Group: Connection Status & AI Engine Indicator */}
          <div className="sidebar-status-group">
            {/* Server Connection Status */}
            <div className="status-badge" role="status">
              <div
                className={`status-dot ${backendUnavailable ? 'error' : isGuestMode ? 'inactive' : ''}`}
                title={backendUnavailable ? 'Server unreachable' : isGuestMode ? 'Offline Guest Mode' : 'Connected to Server'}
              />
              <span>
                {backendUnavailable ? 'Server Offline' : isGuestMode ? 'Offline Mode' : 'Server Online'}
              </span>
            </div>

            {/* AI Engine Status */}
            <div className="status-badge" role="status">
              <div
                className={`status-dot ${isAIReady ? '' : 'inactive'}`}
                style={{
                  background: isAIReady ? 'var(--accent-teal)' : undefined,
                  boxShadow: isAIReady ? '0 0 6px var(--accent-teal)' : undefined,
                }}
              />
              <span>
                {isAIReady ? 'AI Engine Ready' : 'AI Standby'}
              </span>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
