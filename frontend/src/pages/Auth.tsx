import React, { useState, useEffect, useRef } from 'react';
import { User, Organization } from '../types';
import { apiFetch, buildApiUrl, getApiBaseUrl } from '../api';
import { Alert } from '../components/Alert';
import { isDesktopApp } from '../services/wailsBridge';
import logoAsset from '../assets/logo.png';

interface AuthProps {
  onAuthSuccess: (user: User, org: Organization | null, token?: string) => void;
  onSkip?: () => void;
  backendUnavailable?: boolean;
  onRetryConnection?: () => Promise<boolean>;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD_LENGTH = 72; // Bcrypt limit

export function AuthPage({ onAuthSuccess, onSkip, backendUnavailable = false, onRetryConnection }: AuthProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fullName, setFullName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<'google' | 'azure' | null>(null);
  const [error, setError] = useState('');
  const [retryingConnection, setRetryingConnection] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const [pollCount, setPollCount] = useState(0);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const oauthTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  // Parse error params from both URL search query and hash
  useEffect(() => {
    isMountedRef.current = true;
    const searchParams = new URLSearchParams(window.location.search);
    let authErr = searchParams.get('error');

    if (!authErr && window.location.hash.includes('?')) {
      const hashParams = new URLSearchParams(window.location.hash.split('?')[1]);
      authErr = hashParams.get('error');
    }

    if (authErr) {
      try {
        setError(decodeURIComponent(authErr));
      } catch {
        setError(authErr);
      }
      // Clean query parameter from browser address bar
      if (window.history && window.history.replaceState) {
        const cleanUrl = window.location.pathname + window.location.hash.split('?')[0];
        window.history.replaceState({}, document.title, cleanUrl);
      }
    }

    return () => {
      isMountedRef.current = false;
      stopAuthPolling();
    };
  }, []);

  const stopAuthPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (oauthTimeoutRef.current) {
      clearTimeout(oauthTimeoutRef.current);
      oauthTimeoutRef.current = null;
    }
  };

  const startAuthPolling = () => {
    stopAuthPolling();
    setPollCount(0);
    let count = 0;

    pollTimerRef.current = setInterval(async () => {
      count += 1;
      if (!isMountedRef.current) return;
      setPollCount(count);

      if (count > 40) {
        stopAuthPolling();
        setOauthLoading(null);
        setError('Sign-in was cancelled or timed out. Please try again.');
        return;
      }

      try {
        const res = await apiFetch('/api/auth/me');
        if (res.ok) {
          const data = await res.json();
          if (data.authenticated && data.user && isMountedRef.current) {
            stopAuthPolling();
            setOauthLoading(null);
            onAuthSuccess(data.user, data.org || null, data.token);
          }
        }
      } catch {
        // Silently continue polling until auth completes or times out
      }
    }, 1500);
  };

  const cancelOAuth = () => {
    stopAuthPolling();
    setOauthLoading(null);
    setPollCount(0);
    setError('');
  };

  const getPasswordStrength = (pwd: string) => {
    if (!pwd) return { score: 0, text: '', color: 'transparent' };
    let score = 0;
    if (pwd.length >= 8) score++;
    if (pwd.length >= 12) score++;
    if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) score++;
    if (/[0-9]/.test(pwd)) score++;
    if (/[^A-Za-z0-9]/.test(pwd)) score++;

    if (score <= 2) return { score: 1, text: 'Weak (minimum 8 characters, mix letters & numbers)', color: 'var(--accent-red)' };
    if (score <= 3) return { score: 2, text: 'Medium', color: 'var(--accent-amber)' };
    return { score: 3, text: 'Strong', color: 'var(--accent-green)' };
  };

  const passwordStrength = getPasswordStrength(password);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || oauthLoading !== null) return;
    setError('');

    const trimmedEmail = email.trim();
    const trimmedPassword = password;
    const trimmedFullName = fullName.trim();
    const trimmedOrgName = orgName.trim();

    // 1. Validation checks
    if (!trimmedEmail) {
      setError('Email address is required.');
      return;
    }
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      setError('Please enter a valid work email address (e.g., name@company.com).');
      return;
    }
    if (!trimmedPassword) {
      setError('Password is required.');
      return;
    }
    if (trimmedPassword.length > MAX_PASSWORD_LENGTH) {
      setError(`Password cannot exceed ${MAX_PASSWORD_LENGTH} characters.`);
      return;
    }

    if (!isLogin) {
      if (!trimmedFullName) {
        setError('Full name is required.');
        return;
      }
      if (!trimmedOrgName) {
        setError('Organization or workspace name is required.');
        return;
      }
      if (trimmedPassword.length < 8) {
        setError('Password must be at least 8 characters long.');
        return;
      }
      if (passwordStrength.score < 2) {
        setError('Password is too weak. Please use at least 8 characters with a mix of letters and numbers.');
        return;
      }
    }

    setLoading(true);

    const endpoint = isLogin ? '/api/auth/login' : '/api/org/register';
    const payload = isLogin
      ? { email: trimmedEmail, password: trimmedPassword }
      : { name: trimmedOrgName || 'My Workspace', email: trimmedEmail, password: trimmedPassword, full_name: trimmedFullName };

    try {
      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const raw = await res.text();
      let data: any = {};
      try {
        data = JSON.parse(raw);
      } catch {
        // Guard against HTML error pages leaking into error text
        if (raw.includes('<html') || raw.includes('<!DOCTYPE')) {
          data = { error: `Server error (${res.status}). Please try again later.` };
        } else {
          data = raw ? { error: raw.trim() } : {};
        }
      }

      if (res.ok && data.success) {
        onAuthSuccess(data.user, data.org || null, data.token);
      } else {
        const errorMsg = data.error || data.message || (res.status === 401 ? 'Invalid email or password.' : 'Authentication failed.');
        setError(errorMsg);
      }
    } catch {
      setError('Network error. Unable to reach authentication server.');
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  };

  const handleOAuth = (provider: 'google' | 'azure') => {
    setError('');
    setOauthLoading(provider);

    // Determine absolute URL for desktop external browser compatibility
    const redirectTarget = isDesktopApp()
      ? encodeURIComponent('/auth-success')
      : encodeURIComponent('/');
    let targetUrl = buildApiUrl(`/api/auth/oauth/${provider}?redirect=${redirectTarget}`);

    // If relative in desktop mode, build absolute URL against configured host or localhost
    if (isDesktopApp() && targetUrl.startsWith('/')) {
      const base = getApiBaseUrl() || (typeof window !== 'undefined' && window.location.origin.startsWith('http') ? window.location.origin : 'http://localhost:8080');
      targetUrl = `${base.replace(/\/$/, '')}${targetUrl}`;
    }

    startAuthPolling();

    // Trigger external system browser
    try {
      if ((window as any).runtime?.BrowserOpenURL) {
        (window as any).runtime.BrowserOpenURL(targetUrl);
      } else {
        const opened = window.open(targetUrl, '_blank');
        if (!opened) {
          window.location.href = targetUrl;
        }
      }
    } catch (err) {
      stopAuthPolling();
      setOauthLoading(null);
      setError('Unable to open authentication browser window.');
    }
  };

  const handleRetryConnection = async () => {
    if (!onRetryConnection) return;
    setRetryingConnection(true);
    setRetryFailed(false);
    const reachable = await onRetryConnection();
    if (isMountedRef.current) {
      setRetryingConnection(false);
      if (!reachable) setRetryFailed(true);
    }
  };

  // Backend unavailable fallback screen
  if (backendUnavailable) {
    return (
      <div className="auth-container">
        <div className="card fade-in-up" style={{ width: '100%', maxWidth: 400, margin: 'auto', flexShrink: 0 }}>
          <div className="card-header" style={{ justifyContent: 'center', gap: 10 }}>
            <img
              src={logoAsset}
              alt="get-Hike Logo"
              style={{ width: 26, height: 26, display: 'block', filter: 'drop-shadow(0 4px 8px color-mix(in srgb, var(--accent-indigo) 40%, transparent))' }}
            />
            <span className="card-title" style={{ fontSize: 14, textTransform: 'none', letterSpacing: 0, color: 'var(--text-primary)' }}>
              get-Hike
            </span>
          </div>

          <div className="card-body" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Server unavailable</div>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 16 }}>
              {isDesktopApp() ? (
                <>
                  We couldn't connect to the get-Hike server. You can continue in <strong>Guest Mode</strong> — tracking and
                  AI analysis run locally on this device and your data stays private.
                </>
              ) : (
                <>
                  We couldn't connect to the get-Hike server. Please verify your internet connection or check back shortly.
                </>
              )}
            </p>

            {/* Guest mode button strictly isolated to desktop app */}
            {onSkip && isDesktopApp() && (
              <button
                type="button"
                className="btn btn-primary w-full"
                onClick={onSkip}
                disabled={retryingConnection}
                style={{ padding: '10px 16px', fontWeight: 700 }}
              >
                Continue in Guest Mode
              </button>
            )}

            {onRetryConnection && (
              <button
                type="button"
                className="btn btn-secondary w-full"
                onClick={handleRetryConnection}
                disabled={retryingConnection}
                style={{ marginTop: 8, opacity: retryingConnection ? 0.6 : undefined, cursor: retryingConnection ? 'wait' : undefined }}
              >
                {retryingConnection ? 'Checking connection…' : 'Retry connection'}
              </button>
            )}

            {retryFailed && (
              <Alert
                type="error"
                message="Still can't reach the server. Check your network or server address and try again."
                style={{ marginTop: 12, fontSize: 12 }}
              />
            )}

            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.5 }}>
              Sign-in, team sync, and shared analytics will be available once the server is reachable.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const isFormDisabled = loading || oauthLoading !== null;

  return (
    <div className="auth-container">
      <div className="card fade-in-up" style={{ width: '100%', maxWidth: 400, margin: 'auto', flexShrink: 0 }}>
        {/* Header */}
        <div className="card-header" style={{ justifyContent: 'center', gap: 10 }}>
          <img
            src={logoAsset}
            alt="get-Hike Logo"
            style={{ width: 26, height: 26, display: 'block', filter: 'drop-shadow(0 4px 8px color-mix(in srgb, var(--accent-indigo) 40%, transparent))' }}
          />
          <span className="card-title" style={{ fontSize: 14, textTransform: 'none', letterSpacing: 0, color: 'var(--text-primary)' }}>
            get-Hike
          </span>
        </div>

        <div className="card-body">
          <div
            title="Privacy-First Linux Productivity Platform & AI Analyzer"
            style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginBottom: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            Privacy-first productivity & AI analyzer
          </div>

          {/* Segmented Sign in / Register Selector */}
          <div role="tablist" aria-label="Authentication Options" style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <button
              id="tab-signin"
              type="button"
              role="tab"
              aria-selected={isLogin}
              aria-controls="auth-form-panel"
              disabled={isFormDisabled}
              className={isLogin ? 'btn btn-primary' : 'btn btn-secondary'}
              style={{ flex: 1, padding: '8px 10px', fontSize: 13, fontWeight: isLogin ? 700 : 500 }}
              onClick={() => { setIsLogin(true); setError(''); }}
            >
              Sign in
            </button>
            <button
              id="tab-register"
              type="button"
              role="tab"
              aria-selected={!isLogin}
              aria-controls="auth-form-panel"
              disabled={isFormDisabled}
              className={!isLogin ? 'btn btn-primary' : 'btn btn-secondary'}
              style={{ flex: 1, padding: '8px 10px', fontSize: 13, fontWeight: !isLogin ? 700 : 500 }}
              onClick={() => { setIsLogin(false); setError(''); }}
            >
              Register
            </button>
          </div>

          {/* Error Alert */}
          {error && <Alert type="error" message={error} style={{ marginBottom: 14 }} />}

          {/* Social SSO OAuth Buttons */}
          <div className="oauth-button-group">
            <button
              type="button"
              className="btn-oauth btn-google"
              onClick={() => handleOAuth('google')}
              disabled={isFormDisabled}
              title={`${isLogin ? 'Sign in' : 'Sign up'} with Google`}
              style={{ opacity: isFormDisabled ? 0.6 : undefined, cursor: isFormDisabled ? 'not-allowed' : undefined }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" className="oauth-icon">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
              </svg>
              <span>{oauthLoading === 'google' ? 'Connecting...' : 'Google'}</span>
            </button>

            <button
              type="button"
              className="btn-oauth btn-azure"
              onClick={() => handleOAuth('azure')}
              disabled={isFormDisabled}
              title={`${isLogin ? 'Sign in' : 'Sign up'} with Azure AD`}
              style={{ opacity: isFormDisabled ? 0.6 : undefined, cursor: isFormDisabled ? 'not-allowed' : undefined }}
            >
              <svg width="18" height="18" viewBox="0 0 23 23" className="oauth-icon">
                <path fill="#f35325" d="M1 1h10v10H1z" />
                <path fill="#81bc06" d="M12 1h10v10H12z" />
                <path fill="#05a6f0" d="M1 12h10v10H1z" />
                <path fill="#ffba08" d="M12 12h10v10H12z" />
              </svg>
              <span>{oauthLoading === 'azure' ? 'Connecting...' : 'Azure AD'}</span>
            </button>
          </div>

          {/* OAuth In-Progress Polling State */}
          {oauthLoading && (
            <div style={{ textAlign: 'center', marginTop: 12, padding: '10px 14px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', marginBottom: 6 }}>
                <span className="spinner-sm" />
                <span>Waiting for {oauthLoading === 'google' ? 'Google' : 'Azure'} sign-in...</span>
              </div>
              <div
                role="progressbar"
                aria-valuenow={pollCount}
                aria-valuemin={0}
                aria-valuemax={40}
                aria-label="OAuth sign-in progress"
                style={{ width: '100%', height: 4, background: 'var(--border-subtle)', borderRadius: 2, overflow: 'hidden', marginBottom: 6 }}
              >
                <div style={{ width: `${Math.min(100, Math.round((pollCount / 40) * 100))}%`, height: '100%', background: 'var(--accent-primary)', transition: 'width 0.3s ease' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
                <span>Checking session ({pollCount}/40)</span>
                <button type="button" className="btn-link" onClick={cancelOAuth} style={{ fontSize: 11, color: 'var(--accent-primary)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                  Cancel sign-in
                </button>
              </div>
            </div>
          )}

          <div className="auth-divider">
            <span>Or with email</span>
          </div>

          {/* Email & Password Form */}
          <form id="auth-form-panel" onSubmit={handleSubmit} noValidate>
            {!isLogin && (
              <>
                <div className="form-group">
                  <label className="form-label" htmlFor="auth-fullname">Full Name</label>
                  <input
                    id="auth-fullname"
                    type="text"
                    className="form-input"
                    placeholder="John Doe"
                    autoComplete="name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    disabled={isFormDisabled}
                    required={!isLogin}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="auth-orgname">Organization / Workspace Name</label>
                  <input
                    id="auth-orgname"
                    type="text"
                    className="form-input"
                    placeholder="Acme Corp"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    disabled={isFormDisabled}
                    required={!isLogin}
                  />
                </div>
              </>
            )}

            <div className="form-group">
              <label className="form-label" htmlFor="auth-email">Work Email</label>
              <input
                id="auth-email"
                type="email"
                className="form-input"
                placeholder="you@company.com"
                autoComplete="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); if (error) setError(''); }}
                disabled={isFormDisabled}
                required
              />
            </div>

            <div className="form-group" style={{ marginBottom: 14 }}>
              <label className="form-label" htmlFor="auth-password">Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  className="form-input"
                  placeholder="••••••••••••"
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); if (error) setError(''); }}
                  disabled={isFormDisabled}
                  maxLength={MAX_PASSWORD_LENGTH}
                  required
                  style={{ paddingRight: 44, width: '100%' }}
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  disabled={isFormDisabled}
                  onClick={() => setShowPassword((v) => !v)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: isFormDisabled ? 'not-allowed' : 'pointer', padding: 4, fontSize: 12 }}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>

              {!isLogin && password && (
                <div style={{ marginTop: 6, fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div
                    role="progressbar"
                    aria-valuenow={passwordStrength.score}
                    aria-valuemin={0}
                    aria-valuemax={3}
                    aria-label="Password strength"
                    style={{ flex: '0 0 48px', height: 4, background: 'var(--border-subtle)', borderRadius: 2, overflow: 'hidden' }}
                  >
                    <div style={{ width: `${(passwordStrength.score / 3) * 100}%`, height: '100%', background: passwordStrength.color, transition: 'all 0.2s ease' }} />
                  </div>
                  <span style={{ color: passwordStrength.color, fontWeight: 500 }}>
                    {passwordStrength.text}
                  </span>
                </div>
              )}
            </div>

            <button
              type="submit"
              className="btn btn-primary w-full"
              disabled={isFormDisabled}
              style={{ padding: '10px 16px', fontWeight: 700, opacity: isFormDisabled ? 0.6 : undefined, cursor: isFormDisabled ? 'not-allowed' : undefined }}
            >
              {loading ? (
                <>
                  <span className="spinner-sm" /> {isLogin ? 'Signing in…' : 'Creating account…'}
                </>
              ) : (
                isLogin ? 'Sign In' : 'Create Account'
              )}
            </button>
          </form>
        </div>

        {/* Guest Local Desktop Mode Fallback - Desktop only */}
        {onSkip && isDesktopApp() && (
          <div style={{ padding: '0 18px 16px', textAlign: 'center' }}>
            <button
              type="button"
              className="btn-link-guest"
              onClick={onSkip}
              disabled={isFormDisabled}
              title="Continue as Guest (Local Offline Desktop Mode)"
              style={{ fontSize: 12 }}
            >
              💻 Continue as Guest (Local Mode)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}