import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Organization, User, Invitation } from '../types';
import { apiFetch, getApiBaseUrl, readJsonSafe } from '../api';
import { Modal } from '../components/Modal';
import { EmptyState } from '../components/EmptyState';
import { Alert } from '../components/Alert';
import { StatCard } from '../components/StatCard';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const getInitials = (name?: string, email?: string): string => {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0].slice(0, 2).toUpperCase();
  }
  if (email && email.trim()) {
    return email.trim().slice(0, 2).toUpperCase();
  }
  return '??';
};

const renderRoleBadge = (role: string = 'member') => {
  const normalized = role.toLowerCase();
  if (normalized === 'owner') {
    return (
      <span className="badge badge-role-owner" title="Organization Owner">
        👑 OWNER
      </span>
    );
  }
  if (normalized === 'admin') {
    return (
      <span className="badge badge-role-admin" title="Organization Administrator">
        🛡️ ADMIN
      </span>
    );
  }
  return (
    <span className="badge badge-role-member" title="Standard Workspace Member">
      MEMBER
    </span>
  );
};

const fmtDateOrDash = (ts: string | undefined, mode: 'date' | 'datetime' = 'date') => {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : mode === 'date' ? d.toLocaleDateString() : d.toLocaleString();
};

/**
 * Builds an invitation URL safe for distribution across both desktop and web clients.
 * In desktop Wails webviews (where window.location.origin is wails:// or localhost with wails),
 * fall back to the configured backend base URL or default port so recipients can reach it.
 */
const buildInvitationLink = (token: string) => {
  const base = getApiBaseUrl().replace(/\/$/, '');
  let origin = base;
  if (!origin) {
    if (typeof window !== 'undefined' && window.location.protocol.startsWith('http') && !window.location.hostname.includes('wails')) {
      origin = window.location.origin;
    } else {
      origin = 'http://localhost:8080';
    }
  }
  return `${origin}/#/accept-invite?token=${encodeURIComponent(token)}`;
};

export const OrganizationPage: React.FC = () => {
  const [org, setOrg] = useState<Organization | null>(null);
  const [members, setMembers] = useState<User[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const [memberForbidden, setMemberForbidden] = useState(false);

  // Read current user from localStorage for permission and self-protection checks
  const currentUser: User | null = useMemo(() => {
    try {
      const stored = localStorage.getItem('mini_auth_user');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  }, []);

  // Dynamic environment detection (avoids stale frozen state)
  const isDesktop = typeof window !== 'undefined' && Boolean((window as any).go?.main?.App);
  const hasBackend = Boolean(getApiBaseUrl());
  const isStandaloneDesktop = isDesktop && !hasBackend;

  // Modal & form states
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [sending, setSending] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  // Page-level alerts & action loading indicators
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageSuccess, setPageSuccess] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<number | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  // Admin usage tracking state
  const [orgUsage, setOrgUsage] = useState<any>(null);
  const [usageForbidden, setUsageForbidden] = useState(false);
  const [resettingUsage, setResettingUsage] = useState(false);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const copyToClipboard = async (text: string, token: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-HTTPS or webviews without Clipboard API permissions
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (!success) throw new Error('Copy command failed');
      }
      setCopiedToken(token);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedToken(null), 2500);
    } catch {
      setPageError('Copy failed — please select the link and copy it manually.');
    }
  };

  const fetchUsageData = async () => {
    try {
      const res = await apiFetch('/api/org/usage');
      if (res.status === 403) {
        setUsageForbidden(true);
        return;
      }
      if (res.ok) {
        const data = await readJsonSafe(res);
        if (data) setOrgUsage(data);
      }
    } catch {
      // Usage stats are best-effort for admin view
    }
  };

  const handleResetUsage = async () => {
    if (!window.confirm('Reset organization API usage counters? This is recommended after Google resets your API key quota.')) {
      return;
    }
    setResettingUsage(true);
    setPageError(null);
    try {
      const res = await apiFetch('/api/org/usage/reset', { method: 'POST' });
      if (res.ok) {
        setPageSuccess('Usage counters successfully reset.');
        await fetchUsageData();
        setTimeout(() => setPageSuccess(null), 4000);
      } else {
        const errData = await readJsonSafe<{ error?: string; message?: string }>(res);
        setPageError(errData?.message || errData?.error || 'Failed to reset usage counters.');
      }
    } catch {
      setPageError('Network failure while attempting to reset usage counters.');
    } finally {
      setResettingUsage(false);
    }
  };

  const fetchTeamData = async () => {
    setLoading(true);
    setLoadFailed(false);
    setAuthExpired(false);
    setMemberForbidden(false);

    try {
      let orgParam = '';
      if (currentUser?.org_id) {
        orgParam = `?org_id=${encodeURIComponent(currentUser.org_id)}`;
      }

      const res = await apiFetch(`/api/org/members${orgParam}`);
      if (res.status === 401) {
        setAuthExpired(true);
        return;
      }
      if (res.status === 403) {
        setMemberForbidden(true);
        return;
      }
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }

      const data = await readJsonSafe<any>(res);
      if (!data) {
        setLoadFailed(true);
        return;
      }

      setOrg(data.org || null);
      setMembers(data.members || []);
      setInvitations(data.invitations || []);
      await fetchUsageData();
    } catch (err) {
      console.error('Failed to fetch team data:', err);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isStandaloneDesktop) {
      setLoading(false);
      return;
    }
    fetchTeamData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStandaloneDesktop]);

  // Handle Role Change
  const handleUpdateRole = async (userId: number, currentRole: string, newRole: 'admin' | 'member') => {
    if (currentRole === newRole) return;
    if (!window.confirm(`Are you sure you want to change this member's role to ${newRole.toUpperCase()}?`)) {
      return;
    }

    setActionLoadingId(userId);
    setPageError(null);
    try {
      const res = await apiFetch(`/api/org/members/${userId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });

      if (!res.ok) {
        const err = await readJsonSafe<{ error?: string; message?: string }>(res);
        throw new Error(err?.message || err?.error || 'Role change is not yet supported on this backend.');
      }

      setMembers((prev) => prev.map((m) => (m.id === userId ? { ...m, role: newRole } : m)));
      setPageSuccess('Member role updated successfully.');
      setTimeout(() => setPageSuccess(null), 3000);
    } catch (err: any) {
      setPageError(err.message || 'Failed to update member role.');
    } finally {
      setActionLoadingId(null);
    }
  };

  // Handle Member Removal
  const handleRemoveMember = async (userId: number, memberName: string) => {
    if (!window.confirm(`Are you sure you want to remove ${memberName} from the organization? This will revoke their workspace access.`)) {
      return;
    }

    setActionLoadingId(userId);
    setPageError(null);
    try {
      const res = await apiFetch(`/api/org/members/${userId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const err = await readJsonSafe<{ error?: string; message?: string }>(res);
        throw new Error(err?.message || err?.error || 'Member removal is not supported on this backend.');
      }

      setMembers((prev) => prev.filter((m) => m.id !== userId));
      setPageSuccess(`Removed ${memberName} from the organization.`);
      setTimeout(() => setPageSuccess(null), 3000);
    } catch (err: any) {
      setPageError(err.message || 'Failed to remove team member.');
    } finally {
      setActionLoadingId(null);
    }
  };

  // Handle Invitation Revocation
  const handleRevokeInvitation = async (invId: number, email: string) => {
    if (!window.confirm(`Revoke pending invitation for ${email}?`)) {
      return;
    }

    setActionLoadingId(invId);
    setPageError(null);
    try {
      const res = await apiFetch(`/api/org/invitations/${invId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const err = await readJsonSafe<{ error?: string; message?: string }>(res);
        throw new Error(err?.message || err?.error || 'Failed to revoke invitation.');
      }

      setInvitations((prev) => prev.filter((inv) => inv.id !== invId));
      setPageSuccess(`Revoked invitation for ${email}.`);
      setTimeout(() => setPageSuccess(null), 3000);
    } catch (err: any) {
      setPageError(err.message || 'Failed to revoke invitation.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = inviteEmail.trim().toLowerCase();

    if (!cleanEmail) {
      setModalError('Please enter an email address.');
      return;
    }
    if (!EMAIL_REGEX.test(cleanEmail)) {
      setModalError('Please enter a valid email address (e.g., name@company.com).');
      return;
    }

    const effectiveOrgId = org?.id || currentUser?.org_id;
    if (!effectiveOrgId) {
      setModalError('Organization ID is missing. Please refresh the page and try again.');
      return;
    }

    setSending(true);
    setModalError(null);
    setInviteUrl(null);

    try {
      const res = await apiFetch('/api/org/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: effectiveOrgId,
          email: cleanEmail,
          role: inviteRole,
        }),
      });

      const data = await readJsonSafe<any>(res);
      if (!res.ok || !data) {
        throw new Error(data?.message || data?.error || 'Failed to send invitation.');
      }

      const generatedUrl = data.invite_url || (data.invitation?.token ? buildInvitationLink(data.invitation.token) : null);
      setInviteUrl(generatedUrl);
      await fetchTeamData();
    } catch (err: any) {
      setModalError(err.message || 'Error sending invitation.');
    } finally {
      setSending(false);
    }
  };

  // Standalone desktop offline warning
  if (isStandaloneDesktop || (loadFailed && !org && isDesktop)) {
    return (
      <div className="fade-in-up">
        <div className="page-header" style={{ marginBottom: 16 }}>
          <div>
            <h1 className="page-title">Team &amp; Organization</h1>
            <p className="page-subtitle">Manage members, permissions and invitations.</p>
          </div>
        </div>
        <div
          className="card"
          role="status"
          style={{ border: '1px solid color-mix(in srgb, var(--accent-purple) 35%, transparent)', marginBottom: 16 }}
        >
          <div className="card-body" style={{ padding: '28px 22px', textAlign: 'center' }}>
            <div style={{ fontSize: 34, marginBottom: 10 }}>🔌</div>
            <div className="empty-state-title" style={{ fontSize: 17 }}>
              {isStandaloneDesktop
                ? 'Local Mode — Team features require the Get-Hike server'
                : 'Server Unreachable — Team features offline'}
            </div>
            <div className="empty-state-desc" style={{ maxWidth: 540, margin: '10px auto 0', lineHeight: 1.5 }}>
              Your desktop application is currently running in offline local mode. Local tracking,
              screenshots, and analytics are saved to your local database, but organization management,
              team member rosters, and invitations require an active server connection.
            </div>
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                Please check that your backend server is running and reachable, or configure the server URL in Settings.
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                {!isStandaloneDesktop && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => { setLoadFailed(false); fetchTeamData(); }}
                  >
                    🔄 Retry Connection
                  </button>
                )}
                <a href="#/settings" className="btn btn-primary btn-sm">
                  ⚙️ Configure Settings
                </a>
              </div>
              <span className="badge badge-pending" style={{ fontSize: 11 }}>
                Requires active server connection
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Session Expired (401)
  if (authExpired && !org) {
    return (
      <EmptyState
        minHeight={400}
        title="Session Expired"
        description="Your login session has expired or is invalid. Please sign in again to access your organization."
        action={
          <a href="#/auth" className="btn btn-primary">
            Sign In Again
          </a>
        }
      />
    );
  }

  // Member Role Forbidden (403)
  if (memberForbidden && !org) {
    return (
      <div className="fade-in-up">
        <div className="page-header" style={{ marginBottom: 16 }}>
          <div>
            <h1 className="page-title">Team &amp; Organization</h1>
            <p className="page-subtitle">Manage members, permissions and invitations.</p>
          </div>
        </div>
        <div className="card">
          <div className="card-body" style={{ padding: '28px 22px', textAlign: 'center' }}>
            <div style={{ fontSize: 34, marginBottom: 10 }}>🔒</div>
            <div className="empty-state-title" style={{ fontSize: 17 }}>
              Admin Access Required
            </div>
            <div className="empty-state-desc" style={{ maxWidth: 520, margin: '10px auto 0' }}>
              Your account has the <strong>member</strong> role. Team rosters, permissions, and organization
              settings are accessible to owners and administrators only. Your personal activity and analytics
              remain fully accessible.
            </div>
            <div style={{ marginTop: 20, display: 'flex', justifyContent: 'center', gap: 12 }}>
              <a href="#/dashboard" className="btn btn-primary btn-sm">
                Return to Dashboard
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Initial Loading Skeleton
  if (loading && !org) {
    return (
      <div className="fade-in-up org-page">
        <div className="org-header">
          <div className="org-header-left">
            <div className="skeleton" style={{ width: 220, height: 28, borderRadius: 6, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: 340, height: 14, borderRadius: 4 }} />
          </div>
          <div className="skeleton" style={{ width: 170, height: 38, borderRadius: 8 }} />
        </div>
        <div className="card" style={{ padding: '24px 20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="skeleton" style={{ width: 150, height: 20, borderRadius: 4 }} />
              <div className="skeleton" style={{ width: 80, height: 16, borderRadius: 4 }} />
            </div>
            <div className="skeleton" style={{ width: '100%', height: 56, borderRadius: 8 }} />
            <div className="skeleton" style={{ width: '100%', height: 56, borderRadius: 8 }} />
            <div className="skeleton" style={{ width: '100%', height: 56, borderRadius: 8 }} />
          </div>
        </div>
      </div>
    );
  }

  // General Load Failure
  if (loadFailed && !org) {
    return (
      <EmptyState
        minHeight={400}
        title="Couldn't load your team"
        description="Check your network connection or sign in again, then retry."
        action={
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" className="btn btn-primary" onClick={fetchTeamData}>
              Retry
            </button>
            <a href="#/dashboard" className="btn btn-secondary">
              Back to Dashboard
            </a>
          </div>
        }
      />
    );
  }

  const cellPad: React.CSSProperties = { padding: '8px 12px' };

  return (
    <div className="fade-in-up org-page">
      {/* Header */}
      <div className="org-header">
        <div className="org-header-left">
          <div className="org-title-group">
            <h1
              className="page-title"
              style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={org?.name || 'Company Organization'}
            >
              {org?.name || 'Company Workspace'}
            </h1>
            <span className="badge badge-productive" style={{ flexShrink: 0 }}>
              Active Workspace
            </span>
          </div>
          <p className="page-subtitle" style={{ marginTop: 4 }}>
            Manage team members, access roles, and onboarding invitations for your organization.
          </p>
        </div>

        <div className="org-header-actions">
          <button
            type="button"
            onClick={() => {
              setShowInviteModal(true);
              setInviteEmail('');
              setInviteUrl(null);
              setModalError(null);
            }}
            className="btn btn-primary"
            style={{ padding: '9px 18px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 8 }}
            aria-label="Invite new team member"
          >
            <span style={{ fontSize: 16, lineHeight: 1 }} aria-hidden="true">+</span>
            <span>Invite Team Member</span>
          </button>
        </div>
      </div>

      {pageError && (
        <Alert
          type="error"
          message={pageError}
          style={{ marginBottom: 14 }}
        />
      )}

      {pageSuccess && (
        <Alert
          type="success"
          message={pageSuccess}
          style={{ marginBottom: 14 }}
        />
      )}

      {/* Admin Usage Tracking */}
      {!usageForbidden && orgUsage && (
        <div className="card" style={{ border: '1px solid color-mix(in srgb, var(--accent-purple) 30%, transparent)' }}>
          <div className="card-header">
            <span className="card-title" style={{ color: 'var(--text-secondary)' }}>
              ⚡ Organization API Usage <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>(Admin View)</span>
            </span>
            <button
              type="button"
              onClick={handleResetUsage}
              disabled={resettingUsage}
              className="btn btn-secondary btn-sm"
              title="Recommended after Google resets your API key quota"
              style={{ opacity: resettingUsage ? 0.6 : undefined, cursor: resettingUsage ? 'not-allowed' : undefined, flexShrink: 0 }}
            >
              {resettingUsage ? 'Resetting…' : '🔄 Reset Usage'}
            </button>
          </div>

          <div className="card-body">
            <div className="stats-grid" style={{ marginBottom: orgUsage.user_breakdown && orgUsage.user_breakdown.length > 0 ? 16 : 0 }}>
              <StatCard label="Total Requests" value={orgUsage.total_requests || 0} />
              <StatCard label="Prompt Tokens" value={(orgUsage.prompt_tokens || 0).toLocaleString()} valueClass="text-cyan" />
              <StatCard label="Candidate Tokens" value={(orgUsage.candidate_tokens || 0).toLocaleString()} valueClass="text-amber" />
              <StatCard label="Total Tokens" value={(orgUsage.total_tokens || 0).toLocaleString()} valueClass="text-green" />
            </div>

            {orgUsage.user_breakdown && orgUsage.user_breakdown.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: 8 }}>
                  Member API Usage Breakdown
                </div>
                <div className="table-container" style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                  <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={cellPad}>Member</th>
                        <th style={cellPad}>Email</th>
                        <th style={cellPad}>Role</th>
                        <th style={cellPad}>API Requests</th>
                        <th style={cellPad}>Prompt Tokens</th>
                        <th style={cellPad}>Output Tokens</th>
                        <th style={cellPad}>Total Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orgUsage.user_breakdown.map((u: any) => (
                        <tr key={u.user_id}>
                          <td style={{ ...cellPad, fontWeight: 600, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.full_name}>
                            {u.full_name}
                          </td>
                          <td className="text-muted" style={{ ...cellPad, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.email}>
                            {u.email}
                          </td>
                          <td style={cellPad}>
                            {renderRoleBadge(u.role)}
                          </td>
                          <td style={cellPad}>{u.total_requests || 0}</td>
                          <td className="text-muted" style={cellPad}>{(u.prompt_tokens ?? 0).toLocaleString()}</td>
                          <td className="text-muted" style={cellPad}>{(u.candidate_tokens ?? 0).toLocaleString()}</td>
                          <td style={{ ...cellPad, fontWeight: 700, color: 'var(--teal-text)' }}>
                            {(u.total_tokens ?? 0).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Team Members List */}
      <div className="card">
        <div className="card-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="card-title">👥 Team Members</span>
            <span className="org-card-header-badge">
              {members.length} {members.length === 1 ? 'member' : 'members'}
            </span>
          </div>
          {invitations.length > 0 && (
            <span
              style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, flexShrink: 0 }}
            >
              {invitations.length} {invitations.length === 1 ? 'invite pending' : 'invites pending'}
            </span>
          )}
        </div>

        <div className="card-body" style={{ padding: 0 }}>
          {members.length === 0 ? (
            <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No team members found. Invite your colleagues to get started.
            </div>
          ) : (
            members.map((u) => {
              const isSelf = currentUser?.id === u.id;
              const isOwner = u.role === 'owner';
              const isLoading = actionLoadingId === u.id;
              const initials = getInitials(u.full_name, u.email);

              return (
                <div key={u.id} className="org-member-row">
                  <div className="org-member-primary">
                    <div
                      className={`org-avatar ${u.role === 'owner' ? 'owner' : u.role === 'admin' ? 'admin' : 'member'}`}
                      aria-hidden="true"
                    >
                      {initials}
                    </div>
                    <div className="org-member-details">
                      <div className="org-member-name-row">
                        <span className="org-member-name" title={u.full_name}>
                          {u.full_name}
                        </span>
                        {isSelf && (
                          <span className="badge badge-cyan" style={{ fontSize: 10, padding: '2px 6px' }}>
                            You
                          </span>
                        )}
                      </div>
                      <div className="org-member-email" title={u.email}>
                        {u.email}
                      </div>
                    </div>
                  </div>

                  <div className="org-member-meta-actions">
                    {renderRoleBadge(u.role)}

                    <span className="org-member-joined">
                      Joined {fmtDateOrDash(u.created_at)}
                    </span>

                    {/* Member Actions (Promote / Demote / Remove) */}
                    {!isOwner && !isSelf && (
                      <div className="org-member-btn-group">
                        {u.role === 'member' ? (
                          <button
                            type="button"
                            disabled={isLoading}
                            onClick={() => handleUpdateRole(u.id, u.role, 'admin')}
                            className="btn btn-secondary btn-sm"
                            title="Promote to organization administrator"
                            aria-label={`Promote ${u.full_name} to administrator`}
                          >
                            {isLoading ? 'Updating…' : '🛡️ Make Admin'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={isLoading}
                            onClick={() => handleUpdateRole(u.id, u.role, 'member')}
                            className="btn btn-secondary btn-sm"
                            title="Demote to regular member"
                            aria-label={`Demote ${u.full_name} to member`}
                          >
                            {isLoading ? 'Updating…' : '👤 Demote'}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() => handleRemoveMember(u.id, u.full_name || u.email)}
                          className="btn btn-danger btn-sm"
                          title="Remove user from organization"
                          aria-label={`Remove ${u.full_name} from organization`}
                        >
                          {isLoading ? 'Removing…' : '✕ Remove'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Pending Invitations Section */}
        {invitations.length > 0 && (
          <>
            <div className="card-header" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="card-title">📨 Pending Invitations</span>
                <span className="org-card-header-badge">
                  {invitations.length}
                </span>
              </div>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {invitations.map((inv) => {
                const inviteLink = buildInvitationLink(inv.token);
                const isLoading = actionLoadingId === inv.id;
                const isCopied = copiedToken === inv.token;

                return (
                  <div key={inv.id} className="org-member-row">
                    <div className="org-member-primary">
                      <div className="org-avatar invite" aria-hidden="true">
                        ✉️
                      </div>
                      <div className="org-member-details">
                        <span className="org-member-name" title={inv.email}>
                          {inv.email}
                        </span>
                        <span className="org-member-email">
                          Expires {fmtDateOrDash(inv.expires_at, 'datetime')}
                        </span>
                      </div>
                    </div>

                    <div className="org-member-meta-actions">
                      <span className="badge badge-amber" style={{ flexShrink: 0 }}>
                        PENDING
                      </span>
                      {inv.role === 'admin' ? (
                        <span className="badge badge-role-admin" style={{ flexShrink: 0 }}>
                          🛡️ ADMIN
                        </span>
                      ) : (
                        <span className="badge badge-role-member" style={{ flexShrink: 0 }}>
                          MEMBER
                        </span>
                      )}
                      <div className="org-member-btn-group">
                        <button
                          type="button"
                          onClick={() => copyToClipboard(inviteLink, inv.token)}
                          className={`btn btn-secondary btn-sm btn-copy-feedback ${isCopied ? 'copied' : ''}`}
                          style={{ flexShrink: 0 }}
                          aria-label={isCopied ? 'Invitation link copied' : `Copy invitation link for ${inv.email}`}
                        >
                          {isCopied ? '✓ Copied!' : '📋 Copy Link'}
                        </button>
                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() => handleRevokeInvitation(inv.id, inv.email)}
                          className="btn btn-danger btn-sm"
                          style={{ flexShrink: 0 }}
                          title="Cancel this pending invitation"
                          aria-label={`Revoke invitation for ${inv.email}`}
                        >
                          {isLoading ? 'Revoking…' : 'Revoke'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Invite Modal */}
      <Modal
        isOpen={showInviteModal}
        onClose={() => {
          if (!sending) {
            setShowInviteModal(false);
            setModalError(null);
          }
        }}
        title="Invite Team Member"
        description="Send an onboarding invitation link to add a colleague to your workspace."
      >
        {modalError && (
          <Alert
            type="error"
            message={modalError}
            style={{ marginBottom: 16 }}
          />
        )}

        {inviteUrl ? (
          <div className="flex flex-col gap-16">
            <Alert
              type="success"
              message="Invitation created successfully! Share the direct onboarding link below with your team member."
            />
            <div className="form-group">
              <label className="form-label" htmlFor="direct-invite-link">Direct Onboarding Link</label>
              <div className="flex gap-8">
                <input
                  id="direct-invite-link"
                  type="text"
                  readOnly
                  value={inviteUrl}
                  className="form-input"
                  title="Click to select entire link"
                  onFocus={(e) => e.target.select()}
                  style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, minWidth: 0 }}
                />
                <button
                  type="button"
                  onClick={() => copyToClipboard(inviteUrl, 'modal')}
                  className={`btn btn-primary btn-sm btn-copy-feedback ${copiedToken === 'modal' ? 'copied' : ''}`}
                  style={{ whiteSpace: 'nowrap', minWidth: 95 }}
                >
                  {copiedToken === 'modal' ? '✓ Copied!' : 'Copy Link'}
                </button>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                This single-use onboarding link allows your colleague to set up their account and join.
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button
                type="button"
                onClick={() => {
                  setInviteEmail('');
                  setInviteUrl(null);
                  setModalError(null);
                }}
                className="btn btn-secondary"
                style={{ flex: 1 }}
              >
                Invite Another Member
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowInviteModal(false);
                  setInviteUrl(null);
                  setInviteEmail('');
                }}
                className="btn btn-primary"
                style={{ flex: 1 }}
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSendInvite}>
            <div className="form-group">
              <label className="form-label" htmlFor="invite-email-input">Work Email Address</label>
              <input
                id="invite-email-input"
                type="email"
                required
                autoFocus
                disabled={sending}
                placeholder="colleague@company.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="form-input"
              />
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                The recipient must use this email address when accepting the invitation.
              </span>
            </div>

            <div className="form-group" style={{ marginBottom: 20 }}>
              <label className="form-label">Role &amp; Permissions</label>
              <div
                role="radiogroup"
                aria-label="Select member role"
                className="role-picker-grid"
              >
                {[
                  {
                    id: 'member' as const,
                    icon: '👤',
                    title: 'Member',
                    desc: 'Standard workspace access to track activity and view personal metrics.',
                  },
                  {
                    id: 'admin' as const,
                    icon: '🛡️',
                    title: 'Admin',
                    desc: 'Full workspace management: invite team members, adjust roles, and review usage.',
                  },
                ].map((r) => {
                  const isSelected = inviteRole === r.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      disabled={sending}
                      onClick={() => setInviteRole(r.id)}
                      className={`role-picker-card ${isSelected ? 'active' : ''}`}
                    >
                      <div className="role-picker-header">
                        <span className="role-picker-title">
                          <span>{r.icon}</span>
                          <span>{r.title}</span>
                        </span>
                        <span className="role-picker-radio" aria-hidden="true" />
                      </div>
                      <p className="role-picker-desc">{r.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
              <button
                type="button"
                disabled={sending}
                onClick={() => setShowInviteModal(false)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={sending}
                className="btn btn-primary"
                style={{
                  opacity: sending ? 0.7 : undefined,
                  cursor: sending ? 'not-allowed' : undefined,
                  minWidth: 130,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                {sending ? 'Sending…' : 'Send Invitation'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
};
