import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Organization, User, Invitation } from '../types';
import { apiFetch, getApiBaseUrl, readJsonSafe } from '../api';
import { Modal } from '../components/Modal';
import { EmptyState } from '../components/EmptyState';
import { Alert } from '../components/Alert';
import { StatCard } from '../components/StatCard';
import { Icon } from '../components/Icon';

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
    return <span className="badge badge-role-owner">Owner</span>;
  }
  if (normalized === 'admin') {
    return <span className="badge badge-role-admin">Admin</span>;
  }
  return <span className="badge badge-role-member">Member</span>;
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
      origin = 'https://minitracker-api.fly.dev';
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

  // Plan and Gemini Settings state
  const [planTier, setPlanTier] = useState<string>('free');
  const [planStatus, setPlanStatus] = useState<string>('inactive');
  const [updatingPlan, setUpdatingPlan] = useState(false);
  const [maskedOrgKey, setMaskedOrgKey] = useState<string>('');
  const [hasCustomKey, setHasCustomKey] = useState(false);
  const [inputOrgKey, setInputOrgKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);

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

  const fetchPlanData = async () => {
    try {
      const res = await apiFetch('/api/org/plan');
      if (res.ok) {
        const data = await readJsonSafe<{ plan_tier?: string; plan_status?: string }>(res);
        if (data?.plan_tier) setPlanTier(data.plan_tier);
        if (data?.plan_status) setPlanStatus(data.plan_status);
      }
    } catch {
      // Best-effort
    }
  };

  const fetchOrgSettings = async () => {
    try {
      const res = await apiFetch('/api/org/settings');
      if (res.ok) {
        const data = await readJsonSafe<{ gemini_api_key?: string; has_custom_key?: boolean }>(res);
        if (data) {
          setMaskedOrgKey(data.gemini_api_key || '');
          setHasCustomKey(Boolean(data.has_custom_key));
        }
      }
    } catch {
      // Best-effort
    }
  };

  const handleSaveOrgKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanKey = inputOrgKey.trim();
    if (!cleanKey) {
      setPageError('Please enter a Gemini API Key to save.');
      return;
    }
    setSavingKey(true);
    setPageError(null);
    try {
      const res = await apiFetch('/api/org/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gemini_api_key: cleanKey }),
      });
      if (!res.ok) {
        const err = await readJsonSafe<{ error?: string; message?: string }>(res);
        throw new Error(err?.message || err?.error || 'Failed to save Organization API Key.');
      }
      setInputOrgKey('');
      setPageSuccess('Organization Gemini API Key saved securely.');
      await fetchOrgSettings();
      setTimeout(() => setPageSuccess(null), 3000);
    } catch (err: any) {
      setPageError(err.message || 'Error saving API key.');
    } finally {
      setSavingKey(false);
    }
  };

  const handleClearOrgKey = async () => {
    if (!window.confirm('Remove custom organization API key? Team AI features will require an active Managed Cloud Plan.')) {
      return;
    }
    setSavingKey(true);
    setPageError(null);
    try {
      const res = await apiFetch('/api/org/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gemini_api_key: '' }),
      });
      if (!res.ok) {
        const err = await readJsonSafe<{ error?: string; message?: string }>(res);
        throw new Error(err?.message || err?.error || 'Failed to clear Organization API Key.');
      }
      setMaskedOrgKey('');
      setHasCustomKey(false);
      setPageSuccess('Custom organization API key removed.');
      setTimeout(() => setPageSuccess(null), 3000);
    } catch (err: any) {
      setPageError(err.message || 'Error clearing API key.');
    } finally {
      setSavingKey(false);
    }
  };

  const handleTogglePlan = async (targetTier: string, targetStatus: string) => {
    const isUpgrading = targetTier !== 'free' && targetStatus === 'active';
    const confirmMsg = isUpgrading
      ? 'Subscribe to get-Hike Managed Cloud Plan (Pro)? This will enable server-managed AI processing for your organization.'
      : 'Switch back to Free Plan? Your team will need to bring their own Gemini API key for AI features.';

    if (!window.confirm(confirmMsg)) return;

    setUpdatingPlan(true);
    setPageError(null);
    try {
      const res = await apiFetch('/api/org/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_tier: targetTier, plan_status: targetStatus }),
      });
      if (!res.ok) {
        const err = await readJsonSafe<{ error?: string; message?: string }>(res);
        throw new Error(err?.message || err?.error || 'Failed to update plan.');
      }
      setPlanTier(targetTier);
      setPlanStatus(targetStatus);
      setPageSuccess(isUpgrading ? 'Successfully upgraded to Pro Managed Cloud!' : 'Plan updated to Free.');
      setTimeout(() => setPageSuccess(null), 3000);
    } catch (err: any) {
      setPageError(err.message || 'Error updating plan.');
    } finally {
      setUpdatingPlan(false);
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
    if (!window.confirm('Reset organization API usage counters?')) {
      return;
    }
    setResettingUsage(true);
    setPageError(null);
    try {
      const res = await apiFetch('/api/org/usage/reset', { method: 'POST' });
      if (res.ok) {
        setPageSuccess('Usage counters reset.');
        await fetchUsageData();
        setTimeout(() => setPageSuccess(null), 3000);
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
      if (data.org?.plan_tier) setPlanTier(data.org.plan_tier);
      if (data.org?.plan_status) setPlanStatus(data.org.plan_status);
      setMembers(data.members || []);
      setInvitations(data.invitations || []);
      await Promise.all([fetchPlanData(), fetchOrgSettings(), fetchUsageData()]);
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
    if (!window.confirm(`Change member role to ${newRole.toUpperCase()}?`)) {
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
        throw new Error(err?.message || err?.error || 'Role change is not supported on this server.');
      }

      setMembers((prev) => prev.map((m) => (m.id === userId ? { ...m, role: newRole } : m)));
      setPageSuccess('Member role updated.');
      setTimeout(() => setPageSuccess(null), 3000);
    } catch (err: any) {
      setPageError(err.message || 'Failed to update member role.');
    } finally {
      setActionLoadingId(null);
    }
  };

  // Handle Member Removal
  const handleRemoveMember = async (userId: number, memberName: string) => {
    if (!window.confirm(`Remove ${memberName} from the organization? Workspace access will be revoked.`)) {
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
        throw new Error(err?.message || err?.error || 'Member removal is not supported on this server.');
      }

      setMembers((prev) => prev.filter((m) => m.id !== userId));
      setPageSuccess(`Removed ${memberName} from the organization.`);
      setTimeout(() => setPageSuccess(null), 3000);
    } catch (err: any) {
      setPageError(err.message || 'Failed to remove member.');
    } finally {
      setActionLoadingId(null);
    }
  };

  // Handle Invitation Revocation
  const handleRevokeInvitation = async (invId: number, email: string) => {
    if (!window.confirm(`Revoke invitation for ${email}?`)) {
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
      setModalError('Please enter a valid email address.');
      return;
    }

    const effectiveOrgId = org?.id || currentUser?.org_id;
    if (!effectiveOrgId) {
      setModalError('Organization ID is missing. Please refresh and try again.');
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
        throw new Error(data?.message || data?.error || 'Failed to create invitation.');
      }

      const generatedUrl = data.invite_url || (data.invitation?.token ? buildInvitationLink(data.invitation.token) : null);
      setInviteUrl(generatedUrl);
      await fetchTeamData();
    } catch (err: any) {
      setModalError(err.message || 'Error creating invitation.');
    } finally {
      setSending(false);
    }
  };

  // Standalone desktop offline / server unreachable
  if (isStandaloneDesktop || (loadFailed && !org && isDesktop)) {
    return (
      <EmptyState
        minHeight={380}
        icon={<Icon name="desktop" size={28} />}
        title={isStandaloneDesktop ? 'Offline Local Mode' : 'Backend Unreachable'}
        description="Team rosters and member invitations require an active server connection."
        action={
          <div className="flex gap-8">
            {!isStandaloneDesktop && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => { setLoadFailed(false); fetchTeamData(); }}
              >
                <Icon name="refresh" size={14} />
                <span>Retry</span>
              </button>
            )}
            <a href="#/settings" className="btn btn-primary btn-sm">
              <Icon name="settings" size={14} />
              <span>Server Settings</span>
            </a>
          </div>
        }
      />
    );
  }

  // Session Expired (401)
  if (authExpired && !org) {
    return (
      <EmptyState
        minHeight={380}
        icon={<Icon name="lock" size={28} />}
        title="Session Expired"
        description="Your session has expired. Sign in again to access the organization."
        action={
          <a href="#/auth" className="btn btn-primary btn-sm">
            Sign In
          </a>
        }
      />
    );
  }

  // Member Role Forbidden (403)
  if (memberForbidden && !org) {
    return (
      <EmptyState
        minHeight={380}
        icon={<Icon name="shield" size={28} />}
        title="Admin Access Required"
        description="Organization settings and member management are restricted to administrators."
        action={
          <a href="#/dashboard" className="btn btn-secondary btn-sm">
            Back to Dashboard
          </a>
        }
      />
    );
  }

  // Initial Loading Skeleton
  if (loading && !org) {
    return (
      <div className="fade-in-up org-page">
        <div className="org-header">
          <div className="org-header-left">
            <div className="skeleton" style={{ width: 180, height: 26, borderRadius: 6, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: 260, height: 14, borderRadius: 4 }} />
          </div>
          <div className="skeleton" style={{ width: 130, height: 34, borderRadius: 6 }} />
        </div>
        <div className="card">
          <div className="card-body" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="skeleton" style={{ width: '100%', height: 48, borderRadius: 6 }} />
            <div className="skeleton" style={{ width: '100%', height: 48, borderRadius: 6 }} />
            <div className="skeleton" style={{ width: '100%', height: 48, borderRadius: 6 }} />
          </div>
        </div>
      </div>
    );
  }

  // General Load Failure
  if (loadFailed && !org) {
    return (
      <EmptyState
        minHeight={380}
        icon={<Icon name="refresh" size={28} />}
        title="Failed to Load Organization"
        description="Could not load organization data. Check your network connection and retry."
        action={
          <div className="flex gap-8">
            <button type="button" className="btn btn-primary btn-sm" onClick={fetchTeamData}>
              Retry
            </button>
            <a href="#/dashboard" className="btn btn-secondary btn-sm">
              Dashboard
            </a>
          </div>
        }
      />
    );
  }

  return (
    <div className="fade-in-up org-page">
      {/* Header */}
      <div className="org-header">
        <div className="org-header-left">
          <div className="org-title-group">
            <h1
              className="page-title"
              title={org?.name || 'Organization'}
            >
              {org?.name || 'Organization'}
            </h1>
            <span className="badge badge-productive">Active</span>
            {planTier === 'pro' && planStatus === 'active' ? (
              <span className="badge badge-role-owner" title="Managed get-Hike Cloud AI subscription">
                Pro Managed Cloud
              </span>
            ) : (
              <span className="badge badge-role-member" title="Self-hosted Free Plan">
                Free Plan
              </span>
            )}
          </div>
          <p className="page-subtitle">
            Manage members, roles, and pending invitations.
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
            className="btn btn-primary btn-sm"
            aria-label="Invite member"
          >
            <Icon name="plus" size={14} />
            <span>Invite Member</span>
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

      {/* Plan & AI Provider Configuration */}
      <div className="card org-plan-card">
        <div className="card-header org-plan-header">
          <div className="org-card-title-group">
            <Icon name="sparkles" size={16} />
            <span className="card-title">AI Processing & Subscription Plan</span>
            <span className="org-card-header-badge">Admin</span>
          </div>
          <div>
            {planTier === 'pro' && planStatus === 'active' ? (
              <span className="badge badge-role-owner">
                Pro Managed Cloud Active
              </span>
            ) : (
              <span className="badge badge-role-member">
                Free Plan (BYOK)
              </span>
            )}
          </div>
        </div>

        <div className="card-body">
          <div className="org-plan-grid">
            {/* Option A: Bring Your Own Key */}
            <div className={`org-plan-option-card ${hasCustomKey ? 'active-option' : ''}`}>
              <div className="org-plan-option-header">
                <div className="org-plan-option-title">
                  <Icon name="shield" size={16} />
                  <span>Bring Your Own Key (Free)</span>
                </div>
                {hasCustomKey && (
                  <span className="badge badge-productive">Connected</span>
                )}
              </div>
              <p className="org-plan-option-desc">
                Supply an organization-wide Google Gemini API Key. Your key is envelope-encrypted with AES-256-GCM and shared across all members.
              </p>

              <form onSubmit={handleSaveOrgKey} className="org-key-form">
                <label className="form-label" htmlFor="org-gemini-key">Organization Gemini API Key</label>
                <div className="org-key-input-row">
                  <input
                    id="org-gemini-key"
                    type="password"
                    placeholder={maskedOrgKey ? `Configured: ${maskedOrgKey}` : 'AIzaSy...'}
                    value={inputOrgKey}
                    onChange={(e) => setInputOrgKey(e.target.value)}
                    disabled={savingKey}
                    className="form-input org-mono-input"
                  />
                  <button
                    type="submit"
                    disabled={savingKey || !inputOrgKey.trim()}
                    className="btn btn-primary btn-sm"
                  >
                    {savingKey ? 'Saving…' : 'Save Key'}
                  </button>
                  {hasCustomKey && (
                    <button
                      type="button"
                      onClick={handleClearOrgKey}
                      disabled={savingKey}
                      className="btn btn-danger btn-sm"
                      title="Remove key"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {maskedOrgKey && (
                  <span className="org-key-status-hint">
                    Active Key: <code style={{ fontSize: 11 }}>{maskedOrgKey}</code>
                  </span>
                )}
              </form>
            </div>

            {/* Option B: Managed Cloud Plan */}
            <div className={`org-plan-option-card ${planTier === 'pro' && planStatus === 'active' ? 'active-option' : ''}`}>
              <div className="org-plan-option-header">
                <div className="org-plan-option-title">
                  <Icon name="sparkles" size={16} />
                  <span>get-Hike Managed Plan</span>
                </div>
                {planTier === 'pro' && planStatus === 'active' ? (
                  <span className="badge badge-role-owner">Active</span>
                ) : (
                  <span className="badge badge-role-member">Pro Cloud</span>
                )}
              </div>
              <p className="org-plan-option-desc">
                Zero configuration required. All team activity telemetry is securely analyzed using get-Hike managed cloud server infrastructure.
              </p>

              <div style={{ marginTop: 'auto', paddingTop: 12 }}>
                {planTier === 'pro' && planStatus === 'active' ? (
                  <div className="flex gap-8 items-center justify-between">
                    <span className="text-muted" style={{ fontSize: 12 }}>
                      Managed Cloud Active
                    </span>
                    <button
                      type="button"
                      disabled={updatingPlan}
                      onClick={() => handleTogglePlan('free', 'inactive')}
                      className="btn btn-secondary btn-sm"
                    >
                      {updatingPlan ? 'Updating…' : 'Cancel Subscription'}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={updatingPlan}
                    onClick={() => handleTogglePlan('pro', 'active')}
                    className="btn btn-primary btn-sm"
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    <Icon name="zap" size={14} />
                    <span>{updatingPlan ? 'Activating…' : 'Subscribe to Managed Cloud Plan'}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* API Usage (Admin) */}
      {!usageForbidden && orgUsage && (
        <div className="card org-usage-card">
          <div className="card-header org-usage-header">
            <div className="org-card-title-group">
              <Icon name="zap" size={16} />
              <span className="card-title">API Usage</span>
              <span className="org-card-header-badge">Admin</span>
            </div>
            <button
              type="button"
              onClick={handleResetUsage}
              disabled={resettingUsage}
              className="btn btn-secondary btn-sm"
              title="Reset usage counters after quota renewal"
            >
              <Icon name="refresh" size={13} />
              <span>{resettingUsage ? 'Resetting…' : 'Reset Counters'}</span>
            </button>
          </div>

          <div className="card-body">
            <div className="stats-grid">
              <StatCard label="Total Requests" value={orgUsage.total_requests || 0} />
              <StatCard label="Prompt Tokens" value={(orgUsage.prompt_tokens || 0).toLocaleString()} valueClass="text-cyan" />
              <StatCard label="Candidate Tokens" value={(orgUsage.candidate_tokens || 0).toLocaleString()} valueClass="text-amber" />
              <StatCard label="Total Tokens" value={(orgUsage.total_tokens || 0).toLocaleString()} valueClass="text-green" />
            </div>

            {orgUsage.user_breakdown && orgUsage.user_breakdown.length > 0 && (
              <div className="org-usage-breakdown">
                <div className="org-usage-breakdown-title">
                  Usage by Member
                </div>
                <div className="org-usage-table-wrap">
                  <table className="org-usage-table">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Email</th>
                        <th>Role</th>
                        <th style={{ textAlign: 'right' }}>Requests</th>
                        <th style={{ textAlign: 'right' }}>Prompt Tokens</th>
                        <th style={{ textAlign: 'right' }}>Candidate Tokens</th>
                        <th style={{ textAlign: 'right' }}>Total Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orgUsage.user_breakdown.map((u: any) => (
                        <tr key={u.user_id}>
                          <td className="org-cell-name" title={u.full_name}>
                            {u.full_name || '—'}
                          </td>
                          <td className="org-cell-email" title={u.email}>
                            {u.email}
                          </td>
                          <td>
                            {renderRoleBadge(u.role)}
                          </td>
                          <td className="org-cell-num" style={{ textAlign: 'right' }}>
                            {u.total_requests || 0}
                          </td>
                          <td className="org-cell-num text-muted" style={{ textAlign: 'right' }}>
                            {(u.prompt_tokens ?? 0).toLocaleString()}
                          </td>
                          <td className="org-cell-num text-muted" style={{ textAlign: 'right' }}>
                            {(u.candidate_tokens ?? 0).toLocaleString()}
                          </td>
                          <td className="org-cell-num" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--teal-text)' }}>
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
        <div className="card-header org-card-header">
          <div className="org-card-title-group">
            <Icon name="users" size={16} />
            <span className="card-title">Members</span>
            <span className="org-card-header-badge">
              {members.length}
            </span>
          </div>
          {invitations.length > 0 && (
            <span className="text-muted" style={{ fontSize: 12 }}>
              {invitations.length} {invitations.length === 1 ? 'invitation pending' : 'invitations pending'}
            </span>
          )}
        </div>

        <div className="card-body" style={{ padding: 0 }}>
          {members.length === 0 ? (
            <div className="org-empty-list">
              No members found.
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
                          {u.full_name || u.email}
                        </span>
                        {isSelf && (
                          <span className="badge badge-cyan org-self-badge">
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

                    {/* Member Actions */}
                    {!isOwner && !isSelf && (
                      <div className="org-member-btn-group">
                        {u.role === 'member' ? (
                          <button
                            type="button"
                            disabled={isLoading}
                            onClick={() => handleUpdateRole(u.id, u.role, 'admin')}
                            className="btn btn-secondary btn-sm"
                            title="Promote to administrator"
                            aria-label={`Promote ${u.full_name} to administrator`}
                          >
                            <Icon name="shield" size={13} />
                            <span>{isLoading ? 'Updating…' : 'Make Admin'}</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={isLoading}
                            onClick={() => handleUpdateRole(u.id, u.role, 'member')}
                            className="btn btn-secondary btn-sm"
                            title="Demote to member"
                            aria-label={`Demote ${u.full_name} to member`}
                          >
                            <Icon name="user" size={13} />
                            <span>{isLoading ? 'Updating…' : 'Demote'}</span>
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
                          <Icon name="trash" size={13} />
                          <span>{isLoading ? 'Removing…' : 'Remove'}</span>
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
            <div className="card-header org-card-header" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <div className="org-card-title-group">
                <Icon name="mail" size={16} />
                <span className="card-title">Pending Invitations</span>
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
                        <Icon name="mail" size={16} />
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
                      <span className="badge badge-amber">
                        Pending
                      </span>
                      {renderRoleBadge(inv.role)}

                      <div className="org-member-btn-group">
                        <button
                          type="button"
                          onClick={() => copyToClipboard(inviteLink, inv.token)}
                          className={`btn btn-secondary btn-sm btn-copy-feedback ${isCopied ? 'copied' : ''}`}
                          aria-label={isCopied ? 'Invitation link copied' : `Copy invitation link for ${inv.email}`}
                        >
                          <Icon name={isCopied ? 'check' : 'copy'} size={13} />
                          <span>{isCopied ? 'Copied' : 'Copy Link'}</span>
                        </button>
                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() => handleRevokeInvitation(inv.id, inv.email)}
                          className="btn btn-danger btn-sm"
                          title="Revoke invitation"
                          aria-label={`Revoke invitation for ${inv.email}`}
                        >
                          <Icon name="trash" size={13} />
                          <span>{isLoading ? 'Revoking…' : 'Revoke'}</span>
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
        title="Invite Member"
        description="Generate an invitation link to add a colleague to this workspace."
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
              message="Invitation created. Share the link below to let your colleague join."
            />
            <div className="form-group">
              <label className="form-label" htmlFor="direct-invite-link">Invite Link</label>
              <div className="org-link-input-row">
                <input
                  id="direct-invite-link"
                  type="text"
                  readOnly
                  value={inviteUrl}
                  className="form-input org-mono-input"
                  title="Click to select entire link"
                  onFocus={(e) => e.target.select()}
                />
                <button
                  type="button"
                  onClick={() => copyToClipboard(inviteUrl, 'modal')}
                  className={`btn btn-primary btn-sm btn-copy-feedback ${copiedToken === 'modal' ? 'copied' : ''}`}
                >
                  <Icon name={copiedToken === 'modal' ? 'check' : 'copy'} size={14} />
                  <span>{copiedToken === 'modal' ? 'Copied' : 'Copy Link'}</span>
                </button>
              </div>
              <span className="text-muted" style={{ fontSize: 11.5, marginTop: 4, display: 'block' }}>
                Single-use onboarding link.
              </span>
            </div>
            <div className="org-modal-footer-actions">
              <button
                type="button"
                onClick={() => {
                  setInviteEmail('');
                  setInviteUrl(null);
                  setModalError(null);
                }}
                className="btn btn-secondary"
              >
                Invite Another
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowInviteModal(false);
                  setInviteUrl(null);
                  setInviteEmail('');
                }}
                className="btn btn-primary"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSendInvite}>
            <div className="form-group">
              <label className="form-label" htmlFor="invite-email-input">Email Address</label>
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
              <span className="text-muted" style={{ fontSize: 11.5, marginTop: 4, display: 'block' }}>
                The recipient will sign up or sign in using this email address.
              </span>
            </div>

            <div className="form-group" style={{ marginBottom: 20 }}>
              <label className="form-label">Role</label>
              <div
                role="radiogroup"
                aria-label="Select member role"
                className="role-picker-grid"
              >
                {[
                  {
                    id: 'member' as const,
                    icon: 'user' as const,
                    title: 'Member',
                    desc: 'Record activity and view personal metrics.',
                  },
                  {
                    id: 'admin' as const,
                    icon: 'shield' as const,
                    title: 'Admin',
                    desc: 'Invite members, adjust roles, and review usage.',
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
                          <Icon name={r.icon} size={15} />
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

            <div className="org-modal-actions">
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
                  minWidth: 120,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                {sending ? 'Sending…' : (
                  <>
                    <Icon name="mail" size={14} />
                    <span>Send Invite</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
};
