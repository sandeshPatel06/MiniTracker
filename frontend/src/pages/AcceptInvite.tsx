import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { apiFetch, readJsonSafe } from '../api';
import { User, Organization } from '../types';
import { Alert } from '../components/Alert';
import { Icon } from '../components/Icon';

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

const getPasswordStrength = (pwd: string) => {
  if (!pwd) return { score: 0, text: '', color: 'transparent', width: '0%' };
  let score = 0;
  if (pwd.length >= 8) score++;
  if (pwd.length >= 12) score++;
  if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;

  if (score <= 2) {
    return { score: 1, text: 'Weak (min 8 chars, mix letters & numbers)', color: 'var(--accent-red)', width: '33%' };
  }
  if (score <= 3) {
    return { score: 2, text: 'Medium strength', color: 'var(--accent-amber)', width: '66%' };
  }
  return { score: 3, text: 'Strong password', color: 'var(--accent-green)', width: '100%' };
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

  const passwordStrength = useMemo(() => getPasswordStrength(password), [password]);
  const passwordsMatch = !confirmPassword || password === confirmPassword;

  // 1. Loading Skeleton Screen (mirrors actual card geometry to prevent CLS)
  if (loading) {
    return (
      <main className="accept-invite-page" role="main">
        <article className="accept-invite-card" aria-label="Loading invitation">
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div className="skeleton" style={{ width: 52, height: 52, borderRadius: 14, margin: '0 auto 14px' }} />
            <div className="skeleton" style={{ width: 200, height: 22, margin: '0 auto 8px', borderRadius: 4 }} />
            <div className="skeleton" style={{ width: 160, height: 14, margin: '0 auto', borderRadius: 4 }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="skeleton" style={{ width: '100%', height: 42, borderRadius: 6 }} />
            <div className="skeleton" style={{ width: '100%', height: 42, borderRadius: 6 }} />
            <div className="skeleton" style={{ width: '100%', height: 42, borderRadius: 6 }} />
            <div className="skeleton" style={{ width: '100%', height: 44, borderRadius: 8, marginTop: 6 }} />
          </div>
        </article>
      </main>
    );
  }

  // 2. Error Screen (Token Invalid, Expired or Missing)
  if (error && !invitation) {
    return (
      <main className="accept-invite-page" role="main">
        <article className="accept-invite-card" style={{ textAlign: 'center' }}>
          <div className="accept-invite-badge-icon error" aria-hidden="true">
            <Icon name="x" size={24} />
          </div>
          <h2 style={{ fontSize: 19, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10 }}>
            Invalid or Expired Invitation
          </h2>
          <Alert type="error" message={error} style={{ marginBottom: 16, textAlign: 'left' }} />
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 22, lineHeight: 1.55 }}>
            This invitation link may have expired, been revoked, or already accepted. Please request a new invitation link from your workspace administrator.
          </p>
          <button
            type="button"
            onClick={navigateToAuth}
            className="btn btn-primary w-full"
            style={{ padding: '11px 16px', fontWeight: 600, minHeight: 44 }}
          >
            Return to Sign In
          </button>
        </article>
      </main>
    );
  }

  return (
    <main className="accept-invite-page" role="main">
      <article className="accept-invite-card">
        {/* Header & Org Detail */}
        <header style={{ textAlign: 'center', marginBottom: 22 }}>
          <div className="accept-invite-badge-icon" aria-hidden="true">
            <Icon name="mail" size={24} />
          </div>
          <h1
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: 'var(--text-primary)',
              wordBreak: 'break-word',
              lineHeight: 1.3,
              letterSpacing: '-0.3px',
              margin: '0 0 6px 0',
            }}
            title={invitation?.org_name}
          >
            Join {invitation?.org_name || 'Organization'}
          </h1>
          <div
            style={{
              fontSize: 13,
              color: 'var(--text-muted)',
              lineHeight: 1.45,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            <span>You've been invited to collaborate as</span>
            {invitation?.role === 'admin' ? (
              <span className="badge badge-role-admin">
                <Icon name="shield" size={12} />
                <span>Admin</span>
              </span>
            ) : (
              <span className="badge badge-role-member">
                <Icon name="user" size={12} />
                <span>Member</span>
              </span>
            )}
          </div>
        </header>

        {/* Active session mismatch notice */}
        {loggedInUserEmail && loggedInUserEmail.toLowerCase() !== invitation?.email.toLowerCase() && (
          <Alert
            type="warning"
            message={
              <span>
                You are currently signed in as <strong>{loggedInUserEmail}</strong>. Completing this registration will switch your active session to <strong>{invitation?.email}</strong>.
              </span>
            }
            style={{ marginBottom: 16 }}
          />
        )}

        {error && (
          <Alert type="error" message={error} style={{ marginBottom: 16 }} />
        )}

        {/* Existing User Notification Branch */}
        {isAccountExisting ? (
          <section style={{ textAlign: 'center', padding: '12px 0' }} aria-label="Existing Account Sign In">
            <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.55 }}>
              An account already exists for <strong>{invitation?.email}</strong>. Please sign in to link your account to this workspace.
            </p>
            <button
              type="button"
              onClick={navigateToAuth}
              className="btn btn-primary w-full"
              style={{ padding: '11px 16px', fontWeight: 600, minHeight: 44 }}
            >
              Sign In to Existing Account
            </button>
          </section>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <div className="form-group" style={{ marginBottom: 16 }}>
              <label className="form-label" htmlFor="invite-email">Work Email</label>
              <input
                id="invite-email"
                type="email"
                disabled
                value={invitation?.email || ''}
                className="form-input"
                title={invitation?.email || ''}
                style={{ opacity: 0.8, cursor: 'not-allowed', backgroundColor: 'var(--bg-elevated)' }}
              />
            </div>

            <div className="form-group" style={{ marginBottom: 16 }}>
              <label className="form-label" htmlFor="invite-fullname">Full Name</label>
              <input
                id="invite-fullname"
                type="text"
                required
                autoFocus
                disabled={submitting}
                autoComplete="name"
                placeholder="Jane Doe"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="form-input"
              />
            </div>

            <div className="form-group" style={{ marginBottom: 16 }}>
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
                  style={{ paddingRight: 44 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute',
                    right: 4,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    width: 38,
                    height: 38,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 16,
                    color: 'var(--text-muted)',
                    borderRadius: 'var(--radius-sm)',
                  }}
                  title={showPassword ? 'Hide password' : 'Show password'}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  <Icon name={showPassword ? 'x' : 'info'} size={15} />
                </button>
              </div>

              {password && (
                <div className="password-strength-container">
                  <div className="password-strength-meter">
                    <div
                      className="password-strength-fill"
                      style={{
                        width: passwordStrength.width,
                        backgroundColor: passwordStrength.color,
                      }}
                    />
                  </div>
                  <div className="password-strength-caption" style={{ color: passwordStrength.color }}>
                    {passwordStrength.text}
                  </div>
                </div>
              )}
            </div>

            <div className="form-group" style={{ marginBottom: 22 }}>
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
              {confirmPassword && !passwordsMatch && (
                <span style={{ fontSize: 11.5, color: 'var(--accent-red)', marginTop: 4, display: 'block' }}>
                  Passwords do not match
                </span>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting || (!passwordsMatch && Boolean(confirmPassword))}
              className="btn btn-primary w-full"
              style={{
                padding: '12px 18px',
                fontWeight: 700,
                minHeight: 44,
                opacity: submitting ? 0.7 : undefined,
                cursor: submitting ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              {submitting ? 'Setting Up Account…' : 'Create Account & Join Team'}
            </button>

            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button
                type="button"
                onClick={navigateToAuth}
                className="btn-link-guest"
                style={{ fontSize: 13, textDecoration: 'none' }}
              >
                Already have an account? <span style={{ textDecoration: 'underline' }}>Sign In</span>
              </button>
            </div>
          </form>
        )}
      </article>
    </main>
  );
};
