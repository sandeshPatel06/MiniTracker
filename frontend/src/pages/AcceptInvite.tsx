import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { apiFetch, readJsonSafe } from '../api';
import { User, Organization } from '../types';
import { Alert } from '../components/Alert';

export interface AcceptInviteResult {
  user?: User | null;
  org?: Organization | null;
  token?: string;
}

interface AcceptInviteProps {
  token?: string;
  onSuccess: (result: AcceptInviteResult) => void;
  onNavigateSignIn?: () => void;
}

interface InvitationData {
  valid: boolean;
  email: string;
  org_name: string;
  role: string;
  status: string;
  expires_at?: string;
}

/**
 * Robustly resolve the invitation token from props, search params, hash query, or path.
 */
function resolveInvitationToken(propToken?: string): string {
  if (propToken && propToken.trim()) {
    return propToken.trim();
  }
  if (typeof window === 'undefined') return '';

  // 1. Check window.location.search (?token=... or ?invite=...)
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const qToken = searchParams.get('token') || searchParams.get('invite');
    if (qToken && qToken.trim()) {
      return decodeURIComponent(qToken).trim();
    }
  } catch {}

  // 2. Check window.location.hash (#/accept-invite?token=... or #accept-invite?invite=...)
  const hash = window.location.hash || '';
  if (hash.includes('token=') || hash.includes('invite=')) {
    const hashMatch = hash.match(/[?&](?:token|invite)=([^&]+)/);
    if (hashMatch && hashMatch[1]) {
      return decodeURIComponent(hashMatch[1]).trim();
    }
  }

  // 3. Check path segments: #/accept-invite/:token or /accept-invite/:token
  const pathMatch = hash.match(/#\/?accept-invite\/([^/?&]+)/) ||
                    window.location.pathname.match(/\/accept-invite\/([^/?&]+)/);
  if (pathMatch && pathMatch[1]) {
    return decodeURIComponent(pathMatch[1]).trim();
  }

  return '';
}

/**
 * Remove sensitive tokens from the URL without triggering a full page refresh.
 */
function scrubTokenFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    let modified = false;

    if (url.searchParams.has('token') || url.searchParams.has('invite')) {
      url.searchParams.delete('token');
      url.searchParams.delete('invite');
      modified = true;
    }

    if (url.hash.includes('token=') || url.hash.includes('invite=')) {
      url.hash = '#/accept-invite';
      modified = true;
    }

    if (modified) {
      window.history.replaceState(null, document.title, url.toString());
    }
  } catch {}
}

const friendlyError = (msg: string): string => {
  const m = (msg || '').toLowerCase();
  if (m.includes('expired')) {
    return 'This invitation has expired — ask an admin to resend it.';
  }
  if (m.includes('used') || m.includes('accepted')) {
    return 'This invitation has already been accepted.';
  }
  if (m.includes('not found') || m.includes('invalid') || m.includes('missing')) {
    return 'Invalid invitation link or token.';
  }
  if (m.includes('unique constraint') || m.includes('duplicate key') || m.includes('already exists') || m.includes('already a member')) {
    return 'An account with this email address already exists. Please sign in to accept the invitation.';
  }
  if (m.includes('failed to fetch') || m.includes('network') || m.includes('load failed')) {
    return 'Unable to reach the server. Please check your network connection and try again.';
  }
  return msg;
};

export const AcceptInvitePage: React.FC<AcceptInviteProps> = ({ token: propToken, onSuccess, onNavigateSignIn }) => {
  const effectiveToken = useMemo(() => resolveInvitationToken(propToken), [propToken]);

  const [invitation, setInvitation] = useState<InvitationData | null>(null);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAccountExisting, setIsAccountExisting] = useState(false);

  // Check if a local session is active
  const loggedInUserEmail = useMemo(() => {
    try {
      const stored = localStorage.getItem('mini_auth_user');
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed?.email || null;
      }
    } catch {}
    return null;
  }, []);

  const navigateToAuth = useCallback(() => {
    if (onNavigateSignIn) {
      onNavigateSignIn();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    url.searchParams.delete('invite');
    url.hash = '';
    window.history.replaceState({}, document.title, url.pathname);
    window.location.hash = '#dashboard';
  }, [onNavigateSignIn]);

  useEffect(() => {
    let isCancelled = false;

    const checkToken = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/org/invite-info?token=${encodeURIComponent(effectiveToken)}`);
        const data = await readJsonSafe<any>(res);

        if (isCancelled) return;

        if (!res.ok || !data || data.valid === false) {
          if (data?.status === 'expired' || data?.status === 'revoked') {
            throw new Error('This invitation has expired or been revoked — ask an admin to resend it.');
          }
          if (data?.status && data.status !== 'pending') {
            throw new Error('This invitation has already been accepted.');
          }
          throw new Error(data?.error || data?.message || 'Invalid or expired invitation link');
        }

        setInvitation(data);
        // Scrub the token from address bar to prevent history exposure
        scrubTokenFromUrl();
      } catch (err: any) {
        if (!isCancelled) {
          setError(friendlyError(err.message || 'Invitation verification failed'));
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    if (effectiveToken) {
      checkToken();
    } else {
      setError('No invitation token found in link. Please click the full invitation link received in your email.');
      setLoading(false);
    }

    return () => {
      isCancelled = true;
    };
  }, [effectiveToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    const trimmedName = fullName.trim();
    if (!trimmedName) {
      setError('Please enter your full name.');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match. Please verify and try again.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await apiFetch('/api/org/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: effectiveToken,
          full_name: trimmedName,
          password,
        }),
      });

      const data = await readJsonSafe<any>(res);
      if (!res.ok || !data) {
        const errDetail = data?.message || data?.error || 'Failed to accept invitation';
        if (errDetail.toLowerCase().includes('unique') || errDetail.toLowerCase().includes('already exists')) {
          setIsAccountExisting(true);
        }
        throw new Error(errDetail);
      }

      onSuccess({
        user: data.user,
        org: data.org,
        token: data.token,
      });
    } catch (err: any) {
      setError(friendlyError(err.message || 'Error completing account setup'));
    } finally {
      setSubmitting(false);
    }
  };

  // 1. Loading Skeleton Screen (mirrors actual card geometry to prevent CLS)
  if (loading) {
    return (
      <div className="fade-in-up" style={{ width: '100%', maxWidth: 420, margin: '40px auto', padding: '0 16px' }}>
        <div className="card" style={{ padding: '24px' }}>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div className="skeleton" style={{ width: 44, height: 44, borderRadius: '50%', margin: '0 auto 12px' }} />
            <div className="skeleton" style={{ width: 180, height: 18, margin: '0 auto 8px' }} />
            <div className="skeleton" style={{ width: 140, height: 12, margin: '0 auto' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="skeleton" style={{ width: '100%', height: 38, borderRadius: 6 }} />
            <div className="skeleton" style={{ width: '100%', height: 38, borderRadius: 6 }} />
            <div className="skeleton" style={{ width: '100%', height: 38, borderRadius: 6 }} />
          </div>
        </div>
      </div>
    );
  }

  // 2. Error Screen (Token Invalid, Expired or Missing)
  if (error && !invitation) {
    return (
      <div className="fade-in-up" style={{ width: '100%', maxWidth: 420, margin: '40px auto', padding: '0 16px' }}>
        <div className="card">
          <div className="card-header" style={{ justifyContent: 'center' }}>
            <span className="card-title">⚠️ Invalid Invitation</span>
          </div>
          <div className="card-body">
            <Alert type="error" message={error} style={{ marginBottom: 16 }} />
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', marginBottom: 16, lineHeight: 1.5 }}>
              If you believe this is an error, please ask your organization administrator to resend the invite.
            </p>
            <button
              type="button"
              onClick={navigateToAuth}
              className="btn btn-primary w-full"
            >
              Return to Sign In
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in-up" style={{ width: '100%', maxWidth: 420, margin: '40px auto', padding: '0 16px' }}>
      <div className="card">
        <div className="card-header" style={{ justifyContent: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }} role="img" aria-label="Mail icon">✉️</span>
          <span className="card-title">Team Invitation</span>
        </div>
        <div className="card-body">
          {/* Header & Org Detail */}
          <div style={{ textAlign: 'center', marginBottom: 18 }}>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: 'var(--text-primary)',
                wordBreak: 'break-word',
                lineHeight: 1.3,
              }}
              title={invitation?.org_name}
            >
              Join {invitation?.org_name}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>
              You've been invited to collaborate as{' '}
              <span style={{ fontWeight: 600, color: 'var(--accent-purple)' }}>{invitation?.role}</span>.
            </div>
          </div>

          {/* Active session mismatch notice */}
          {loggedInUserEmail && loggedInUserEmail.toLowerCase() !== invitation?.email.toLowerCase() && (
            <div
              className="alert alert-warning"
              style={{ fontSize: 12, marginBottom: 14, lineHeight: 1.45 }}
              role="status"
            >
              You are currently signed in as <strong>{loggedInUserEmail}</strong>. Completing this registration will sign you into <strong>{invitation?.email}</strong>.
            </div>
          )}

          {error && (
            <Alert type="error" message={error} style={{ marginBottom: 14 }} />
          )}

          {/* Existing User Notification Branch */}
          {isAccountExisting ? (
            <div style={{ textAlign: 'center', padding: '12px 0' }}>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
                An account already exists for <strong>{invitation?.email}</strong>. Please sign in to accept and link your organization membership.
              </p>
              <button
                type="button"
                onClick={navigateToAuth}
                className="btn btn-primary w-full"
              >
                Sign In to Existing Account
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate>
              <div className="form-group">
                <label className="form-label" htmlFor="invite-email">Email Address</label>
                <input
                  id="invite-email"
                  type="email"
                  disabled
                  value={invitation?.email || ''}
                  className="form-input"
                  title={invitation?.email || ''}
                  style={{ opacity: 0.75, cursor: 'not-allowed' }}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="invite-fullname">Full Name</label>
                <input
                  id="invite-fullname"
                  type="text"
                  required
                  disabled={submitting}
                  autoComplete="name"
                  placeholder="Jane Doe"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="form-input"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="invite-password">Create Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    id="invite-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    disabled={submitting}
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="form-input"
                    style={{ paddingRight: 40 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                    style={{
                      position: 'absolute',
                      right: 10,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 14,
                      opacity: 0.7,
                    }}
                    title={showPassword ? 'Hide password' : 'Show password'}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? '🙈' : '👁️'}
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="invite-confirm-password">Confirm Password</label>
                <input
                  id="invite-confirm-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  disabled={submitting}
                  autoComplete="new-password"
                  placeholder="Repeat your password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="form-input"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="btn btn-primary w-full"
                style={{
                  padding: '11px 16px',
                  fontWeight: 700,
                  opacity: submitting ? 0.7 : undefined,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                {submitting && <span className="spinner-sm" aria-hidden="true" />}
                {submitting ? 'Creating Account…' : 'Create Account & Join Team'}
              </button>

              <div style={{ textAlign: 'center', marginTop: 14 }}>
                <button
                  type="button"
                  onClick={navigateToAuth}
                  className="btn-link-guest"
                  style={{ fontSize: 12 }}
                >
                  Already have an account? Sign In
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
