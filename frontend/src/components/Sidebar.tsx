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
  isSidebarCollapsed?: boolean;
  onToggleSidebarCollapse?: () => void;
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
  isSidebarCollapsed = false,
  onToggleSidebarCollapse,
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
        {/* Brand Header & Collapse Toggle */}
        <div className="sidebar-logo">
          <div
            className="sidebar-logo-brand"
            onClick={() => dev.registerTap()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                dev.registerTap();
              }
            }}
            title="get-Hike Productivity"
          >
            <img
              src={logoAsset}
              alt="get-Hike brand logo"
              className="sidebar-brand-img"
            />
            <div className="sidebar-brand-title-wrap">
              <span className="sidebar-logo-text">get-Hike</span>
            </div>
          </div>

          {onToggleSidebarCollapse && (
            <button
              type="button"
              className="sidebar-collapse-btn"
              onClick={onToggleSidebarCollapse}
              aria-label={isSidebarCollapsed ? 'Expand sidebar menu' : 'Collapse sidebar menu'}
              title={isSidebarCollapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
            >
              <Icon name={isSidebarCollapsed ? 'chevron-right' : 'chevron-left'} size={14} />
            </button>
          )}
        </div>

        {/* Work Clock & Tracking Control Widget - Desktop Only */}
        {isDesktop && (
          <div className="sidebar-widget">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span className="sidebar-widget-label">Session</span>
              <span
                style={{
                  fontSize: 10,
                  padding: '1px 5px',
                  borderRadius: 4,
                  fontWeight: 600,
                  background: isGuestMode ? 'rgba(139, 92, 246, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                  color: isGuestMode ? 'var(--accent-purple)' : 'var(--accent-primary)',
                  border: isGuestMode ? '1px solid rgba(139, 92, 246, 0.3)' : '1px solid rgba(16, 185, 129, 0.3)',
                  whiteSpace: 'nowrap',
                }}
              >
                {isGuestMode ? 'Guest' : 'Active'}
              </span>
            </div>
            <div className="sidebar-widget-timer" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatTimer(elapsedSeconds)}
            </div>
            <button
              type="button"
              onClick={handleToggleTracking}
              className={`btn-tracker-toggle ${isTrackingActive ? 'active' : 'paused'}`}
              style={{ marginBottom: 6 }}
            >
              <Icon name={isTrackingActive ? 'pause' : 'play'} size={13} />
              <span>{isTrackingActive ? 'Pause Tracker' : 'Start Tracker'}</span>
            </button>
            {trackerError && (
              <div
                role="alert"
                style={{
                  fontSize: 11,
                  padding: '4px 6px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.35)',
                  color: 'var(--danger-text)',
                  marginBottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Icon name="x" size={11} />
                <span style={{ flex: 1 }}>{trackerError}</span>
              </div>
            )}
            <button
              type="button"
              onClick={onOpenTaskModal}
              className={`btn-task-goal ${userTask ? 'active' : ''}`}
              title={userTask || 'Set target task goal'}
            >
              <Icon name="target" size={12} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {userTask ? `Task: ${userTask}` : 'Set Target Goal'}
              </span>
            </button>
          </div>
        )}

        <div className="sidebar-section-label">Menu</div>
        <nav aria-label="Main Navigation" className="sidebar-nav">
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
                title={isSidebarCollapsed ? item.label : undefined}
                style={{
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
                    <span className="sidebar-user-role">{currentUser.role}</span>
                    <button
                      type="button"
                      className="sidebar-logout-btn"
                      onClick={() => {
                        setIsMobileMenuOpen(false);
                        handleLogout();
                      }}
                      title="Sign out of your account"
                    >
                      <span>Sign Out</span>
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

          {/* Discreet Connection & Engine Status */}
          <div className="sidebar-status-group" title={backendUnavailable ? 'Server unreachable' : isAIReady ? 'Connected • AI Online' : 'Connected • AI Standby'}>
            <div className="status-badge" role="status">
              <div
                className={`status-dot ${backendUnavailable ? 'error' : isGuestMode ? 'inactive' : ''}`}
              />
              <span>
                {backendUnavailable ? 'Offline' : isGuestMode ? 'Guest Mode' : 'Connected'}
              </span>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
