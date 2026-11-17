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
  const [successMsg, setSuccessMsg] = useState('');
  const [retryingConnection, setRetryingConnection] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const [pollCount, setPollCount] = useState(0);

  // OTP Verification state for two-step registration
  const [isOtpStep, setIsOtpStep] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);

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

  // Countdown timer for OTP resend button
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

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
    setSuccessMsg('');

    const trimmedEmail = email.trim();
    const trimmedPassword = password;
    const trimmedFullName = fullName.trim();
    const trimmedOrgName = orgName.trim();
    const trimmedOtp = otpCode.trim();

    // 1. If currently on OTP verification step during registration
    if (!isLogin && isOtpStep) {
      if (!trimmedOtp || trimmedOtp.length < 6) {
        setError('Please enter the 6-digit verification code sent to your email.');
        return;
      }

      setLoading(true);
      try {
        const res = await apiFetch('/api/auth/verify-registration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: trimmedEmail, otp: trimmedOtp }),
        });

        const raw = await res.text();
        let data: any = {};
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw ? { error: raw.trim() } : {};
        }

        if (res.ok && data.success) {
          onAuthSuccess(data.user, data.org || null, data.token);
        } else {
          setError(data.error || data.message || 'Invalid or expired verification code.');
        }
      } catch {
        setError('Network error. Unable to reach authentication server.');
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
      return;
    }

    // 2. Validation checks
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

    // If login, call /api/auth/login directly. If register, initiate OTP verification flow via /api/auth/register-intent
    if (isLogin) {
      try {
        const res = await apiFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: trimmedEmail, password: trimmedPassword }),
        });

        const raw = await res.text();
        let data: any = {};
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw ? { error: raw.trim() } : {};
        }

        if (res.ok && data.success) {
          onAuthSuccess(data.user, data.org || null, data.token);
        } else {
          setError(data.error || data.message || 'Invalid email or password.');
        }
      } catch {
        setError('Network error. Unable to reach authentication server.');
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    } else {
      // Registration: Call /api/auth/register-intent
      try {
        const res = await apiFetch('/api/auth/register-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            org_name: trimmedOrgName || 'My Workspace',
            email: trimmedEmail,
            password: trimmedPassword,
            name: trimmedFullName,
          }),
        });

        const raw = await res.text();
        let data: any = {};
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw ? { error: raw.trim() } : {};
        }

        if (res.ok && data.success) {
          setIsOtpStep(true);
          setResendCooldown(60);
          setSuccessMsg(`Verification code sent to ${trimmedEmail}. Please check your inbox.`);
        } else {
          setError(data.error || data.message || 'Failed to start registration.');
        }
      } catch {
        setError('Network error. Unable to reach authentication server.');
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    }
  };

  const handleResendOtp = async () => {
    if (resendCooldown > 0 || loading) return;
    setError('');
    setSuccessMsg('');
    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/register-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_name: orgName.trim() || 'My Workspace',
          email: email.trim(),
          password: password,
          name: fullName.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setResendCooldown(60);
        setSuccessMsg(`New code sent to ${email.trim()}.`);
      } else {
        setError(data.error || 'Failed to resend code.');
      }
    } catch {
      setError('Network error.');
    } finally {
      if (isMountedRef.current) setLoading(false);
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
      const base = getApiBaseUrl() || (typeof window !== 'undefined' && window.location.origin.startsWith('http') ? window.location.origin : 'https://minitracker-api.fly.dev');
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
      <main className="auth-container" role="main">
        <article
          className="auth-card"
          aria-label="Server unavailable notice"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-medium)',
            boxShadow: 'var(--shadow-card)',
          }}
        >
          <header className="auth-header">
            <div
              className="auth-logo-badge"
              style={{
                width: 48,
                height: 48,
                margin: '0 auto 12px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-medium)',
                borderRadius: 'var(--radius-md)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <img
                src={logoAsset}
                alt="get-Hike Logo"
                style={{
                  width: 36,
                  height: 36,
                  display: 'block',
                  objectFit: 'contain',
                }}
              />
            </div>
            <h1 className="auth-title" style={{ fontSize: 18, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
              get-Hike
            </h1>
          </header>

          <div style={{ textAlign: 'center', marginTop: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, color: 'var(--text-primary)' }}>
              Server unavailable
            </div>
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
                style={{ marginTop: 12, fontSize: 12, textAlign: 'left' }}
              />
            )}

            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.5 }}>
              Sign-in, team sync, and shared analytics will be available once the server is reachable.
            </p>
          </div>
        </article>
      </main>
    );
  }

  const isFormDisabled = loading || oauthLoading !== null;

  return (
    <main className="auth-container" role="main">
      <article
        className="auth-card"
        aria-label="Authentication portal"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-medium)',
          boxShadow: 'var(--shadow-card)',
        }}
      >
        {/* Brand Header */}
        <header className="auth-header">
          <div
            className="auth-logo-badge"
            style={{
              width: 48,
              height: 48,
              margin: '0 auto 10px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-medium)',
              borderRadius: 'var(--radius-md)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <img
              src={logoAsset}
              alt="get-Hike Logo"
              style={{
                width: 36,
                height: 36,
                display: 'block',
                objectFit: 'contain',
              }}
            />
          </div>
          <h1 className="auth-title" style={{ fontSize: 18, fontWeight: 700, margin: '0 0 2px 0', color: 'var(--text-primary)' }}>
            get-Hike
          </h1>
          <p
            className="auth-subtitle"
            title="Privacy-First Productivity Platform & AI Analyzer"
            style={{
              fontSize: 12,
              color: 'var(--text-muted)',
              margin: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            Privacy-first productivity & AI analyzer
          </p>
        </header>

        <div>
          {/* Segmented Sign in / Register Selector */}
          <nav role="tablist" aria-label="Authentication Options" className="auth-tabs">
            <button
              id="tab-signin"
              type="button"
              role="tab"
              aria-selected={isLogin}
              aria-controls="auth-form-panel"
              disabled={isFormDisabled}
              className={`auth-tab ${isLogin ? 'active' : ''}`}
              onClick={() => { setIsLogin(true); setIsOtpStep(false); setError(''); setSuccessMsg(''); }}
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
              className={`auth-tab ${!isLogin ? 'active' : ''}`}
              onClick={() => { setIsLogin(false); setIsOtpStep(false); setError(''); setSuccessMsg(''); }}
            >
              Register
            </button>
          </nav>

          {/* Success / Error Alerts */}
          {error && <Alert type="error" message={error} style={{ marginBottom: 14, textAlign: 'left' }} />}
          {successMsg && <Alert type="success" message={successMsg} style={{ marginBottom: 14, textAlign: 'left' }} />}

          {/* Social SSO OAuth Buttons */}
          <section aria-label="Single Sign-On Options">
            <div className="oauth-button-group">
              <button
                type="button"
                className="btn-oauth btn-google"
                onClick={() => handleOAuth('google')}
                disabled={isFormDisabled}
                title={`${isLogin ? 'Sign in' : 'Sign up'} with Google`}
                style={{ opacity: isFormDisabled ? 0.6 : undefined, cursor: isFormDisabled ? 'not-allowed' : undefined }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" className="oauth-icon" aria-hidden="true">
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
                <svg width="18" height="18" viewBox="0 0 23 23" className="oauth-icon" aria-hidden="true">
                  <path fill="#f35325" d="M1 1h10v10H1z" />
                  <path fill="#81bc06" d="M12 1h10v10H12z" />
                  <path fill="#05a6f0" d="M1 12h10v10H1z" />
                  <path fill="#ffba08" d="M12 12h10v10H12z" />
                </svg>
                <span>{oauthLoading === 'azure' ? 'Connecting...' : 'Azure AD'}</span>
              </button>
            </div>
          </section>

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

          {/* Email & Password / OTP Form */}
          <form id="auth-form-panel" onSubmit={handleSubmit} noValidate>
            {!isLogin && isOtpStep ? (
              <section aria-label="Verification Code Step">
                <div style={{ textAlign: 'center', marginBottom: 16 }}>
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 6px 0' }}>
                    Enter the 6-digit verification code sent to:
                  </p>
                  <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent-primary)', wordBreak: 'break-all', margin: 0 }}>
                    {email}
                  </p>
                </div>

                <div className="form-group" style={{ marginBottom: 16 }}>
                  <label className="form-label" htmlFor="auth-otp" style={{ textAlign: 'center', display: 'block', marginBottom: 8 }}>
                    Verification Code (OTP)
                  </label>
                  <input
                    id="auth-otp"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    className="form-input"
                    placeholder="123456"
                    value={otpCode}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '');
                      setOtpCode(val);
                      if (error) setError('');
                    }}
                    disabled={isFormDisabled}
                    autoFocus
                    required
                    style={{
                      fontSize: 22,
                      letterSpacing: '0.3em',
                      textAlign: 'center',
                      fontWeight: 700,
                      padding: '10px 14px',
                      fontVariantNumeric: 'tabular-nums',
                      boxSizing: 'border-box',
                      width: '100%',
                    }}
                  />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', marginTop: 6 }}>
                    Code expires in 10 minutes.
                  </div>
                </div>

                <button
                  type="submit"
                  className="btn btn-primary w-full"
                  disabled={isFormDisabled || otpCode.length < 6}
                  style={{ padding: '10px 16px', fontWeight: 700, marginBottom: 10 }}
                >
                  {loading ? (
                    <>
                      <span className="spinner-sm" /> Verifying…
                    </>
                  ) : (
                    'Verify & Create Account'
                  )}
                </button>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => { setIsOtpStep(false); setOtpCode(''); setError(''); setSuccessMsg(''); }}
                    disabled={isFormDisabled}
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                  >
                    ← Edit details
                  </button>

                  <button
                    type="button"
                    className="btn-link"
                    onClick={handleResendOtp}
                    disabled={isFormDisabled || resendCooldown > 0}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: resendCooldown > 0 ? 'var(--text-muted)' : 'var(--accent-primary)',
                      cursor: resendCooldown > 0 ? 'not-allowed' : 'pointer',
                      padding: 0,
                      fontWeight: 600,
                    }}
                  >
                    {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
                  </button>
                </div>
              </section>
            ) : (
              <>
                {!isLogin && (
                  <>
                    <div className="form-group" style={{ marginBottom: 12 }}>
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

                    <div className="form-group" style={{ marginBottom: 12 }}>
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

                <div className="form-group" style={{ marginBottom: 12 }}>
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

                <div className="form-group" style={{ marginBottom: 16 }}>
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
                      style={{ paddingRight: 44, width: '100%', boxSizing: 'border-box' }}
                    />
                    <button
                      type="button"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                      disabled={isFormDisabled}
                      onClick={() => setShowPassword((v) => !v)}
                      style={{
                        position: 'absolute',
                        right: 8,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: isFormDisabled ? 'not-allowed' : 'pointer',
                        padding: '4px 6px',
                        fontSize: 12,
                        lineHeight: 1,
                      }}
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>

                  {!isLogin && password && (
                    <div style={{ marginTop: 8, fontSize: 11, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div
                        role="progressbar"
                        aria-valuenow={passwordStrength.score}
                        aria-valuemin={0}
                        aria-valuemax={3}
                        aria-label="Password strength"
                        style={{ flex: '0 0 56px', height: 4, background: 'var(--border-subtle)', borderRadius: 2, overflow: 'hidden' }}
                      >
                        <div style={{ width: `${(passwordStrength.score / 3) * 100}%`, height: '100%', background: passwordStrength.color, transition: 'all 0.2s ease' }} />
                      </div>
                      <span style={{ color: passwordStrength.color, fontWeight: 500, lineHeight: 1.3 }}>
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
                      <span className="spinner-sm" /> {isLogin ? 'Signing in…' : 'Sending code…'}
                    </>
                  ) : (
                    isLogin ? 'Sign In' : 'Continue with Email'
                  )}
                </button>
              </>
            )}
          </form>
        </div>

        {/* Guest Local Desktop Mode Fallback - Desktop only */}
        {onSkip && isDesktopApp() && (
          <footer style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-subtle)', textAlign: 'center' }}>
            <button
              type="button"
              className="btn-link-guest"
              onClick={onSkip}
              disabled={isFormDisabled}
              title="Continue as Guest (Local Offline Desktop Mode)"
              style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <span aria-hidden="true">💻</span> Continue as Guest (Local Mode)
            </button>
          </footer>
        )}
      </article>
    </main>
  );
}