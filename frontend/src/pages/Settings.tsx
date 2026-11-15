import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { apiFetch, readJsonSafe } from '../api';
import { isDesktopApp, callGo } from '../services/wailsBridge';
import { getTodayUsageCount, bumpUsageCount, resetUsageCount } from '../utils';
import { CustomSelect } from '../components/CustomSelect';
import type { SelectOption } from '../components/CustomSelect';
import { Icon } from '../components/Icon';
import { StatCard } from '../components/StatCard';
import { Alert } from '../components/Alert';

interface AIModel {
  name: string;
  displayName: string;
  description: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
}

// Normalize model name so stored selection and comparisons stay consistent
const normalizeModelName = (raw: string) => (raw.startsWith('models/') ? raw : `models/${raw}`);

interface SettingsPageProps {
  theme?: 'dark' | 'light' | 'auto';
  onThemeChange?: (theme: 'dark' | 'light' | 'auto') => void;
  syncIntervalSeconds?: number;
}

const DEFAULT_INTERVAL_OPTIONS: SelectOption[] = [
  { value: '15', label: '15s — High frequency', leading: <Icon name="clock" size={14} /> },
  { value: '30', label: '30s — Active tracking', leading: <Icon name="clock" size={14} /> },
  { value: '60', label: '60s — Standard (default)', leading: <Icon name="clock" size={14} /> },
  { value: '120', label: '2m — Low resource', leading: <Icon name="clock" size={14} /> },
  { value: '300', label: '5m — Minimal', leading: <Icon name="clock" size={14} /> },
];

export function SettingsPage({ theme = 'auto', onThemeChange, syncIntervalSeconds = 30 }: SettingsPageProps) {
  const isDesktop = isDesktopApp();

  const [apiKey, setApiKey] = useState(() => localStorage.getItem('mini_gemini_api_key') || '');
  const [model, setModel] = useState(() => normalizeModelName(localStorage.getItem('mini_ai_model') || 'gemini-3.5-flash-lite'));
  const [availableModels, setAvailableModels] = useState<AIModel[]>([]);
  const [fetchingModels, setFetchingModels] = useState<boolean>(false);
  const [usageSummary, setUsageSummary] = useState<{ total_requests: number; prompt_tokens: number; candidate_tokens: number; total_tokens: number } | null>(null);
  const [usageCount, setUsageCount] = useState<number>(() => getTodayUsageCount());
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [backendConfiguredKey, setBackendConfiguredKey] = useState<boolean>(false);
  const [maskedKeyHint, setMaskedKeyHint] = useState<string>('');

  // Persisted baseline state for dirty tracking
  const [savedBaseline, setSavedBaseline] = useState({
    apiKey: localStorage.getItem('mini_gemini_api_key') || '',
    model: normalizeModelName(localStorage.getItem('mini_ai_model') || 'gemini-3.5-flash-lite'),
    screenshotInterval: parseInt(localStorage.getItem('mini_screenshot_interval') || '60', 10) || 60,
  });

  const [screenshotInterval, setScreenshotInterval] = useState<number>(() => {
    const parsed = parseInt(localStorage.getItem('mini_screenshot_interval') || '60', 10);
    if (!Number.isFinite(parsed)) return 60;
    return Math.min(Math.max(parsed, 5), 3600);
  });

  // Track unsaved modifications
  const isDirty = useMemo(() => {
    return (
      apiKey !== savedBaseline.apiKey ||
      model !== savedBaseline.model ||
      screenshotInterval !== savedBaseline.screenshotInterval
    );
  }, [apiKey, model, screenshotInterval, savedBaseline]);

  // Central status helper with timer cleanup
  const statusTimerRef = useRef<number | null>(null);
  const showStatus = useCallback((msg: string | null, ttlMs?: number) => {
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
    setStatusMessage(msg);
    if (ttlMs) {
      statusTimerRef.current = window.setTimeout(() => setStatusMessage(null), ttlMs);
    }
  }, []);

  useEffect(() => () => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
  }, []);

  // Sync screenshot interval prop if unset
  useEffect(() => {
    if (syncIntervalSeconds && !localStorage.getItem('mini_screenshot_interval')) {
      const clamped = Math.min(Math.max(syncIntervalSeconds, 5), 3600);
      setScreenshotInterval(clamped);
      setSavedBaseline((prev) => ({ ...prev, screenshotInterval: clamped }));
    }
  }, [syncIntervalSeconds]);

  // Initial runtime diagnostics & active config loading
  useEffect(() => {
    let mounted = true;
    if (isDesktop) {
      const goApp = (window as any).go?.main?.App;
      if (goApp?.GetDevDiagnostics) {
        callGo(() => goApp.GetDevDiagnostics()).then((diag: any) => {
          if (!mounted || !diag) return;
          if (typeof diag.version === 'string' && diag.version) setAppVersion(diag.version);
          if (diag.ai_configured) setBackendConfiguredKey(true);
          if (typeof diag.ai_key_masked === 'string' && diag.ai_key_masked !== 'not set') {
            setMaskedKeyHint(diag.ai_key_masked);
          }
          if (typeof diag.ai_model === 'string' && diag.ai_model && !localStorage.getItem('mini_ai_model')) {
            const normalized = normalizeModelName(diag.ai_model);
            setModel(normalized);
            setSavedBaseline((prev) => ({ ...prev, model: normalized }));
          }
        });
      }
    } else {
      // In web mode, fetch backend config
      apiFetch('/api/config')
        .then((r) => (r.ok ? readJsonSafe<any>(r) : null))
        .then((cfg) => {
          if (!mounted || !cfg) return;
          if (cfg.ai_configured) setBackendConfiguredKey(true);
          if (cfg.screenshot_interval_seconds && !localStorage.getItem('mini_screenshot_interval')) {
            const interval = Math.min(Math.max(Math.round(cfg.screenshot_interval_seconds), 5), 3600);
            setScreenshotInterval(interval);
            setSavedBaseline((prev) => ({ ...prev, screenshotInterval: interval }));
          }
        })
        .catch(() => {});
    }
    return () => {
      mounted = false;
    };
  }, [isDesktop]);

  const fetchUsageSummary = useCallback(async () => {
    if (isDesktop) {
      const goApp = (window as any).go?.main?.App;
      if (goApp?.GetAIUsageSummary) {
        const data = await callGo(() => goApp.GetAIUsageSummary()) as any;
        setUsageSummary(data);
        return;
      }
    }
    try {
      const res = await apiFetch('/api/user/usage');
      if (res.ok) {
        const data = await readJsonSafe<any>(res);
        if (data) setUsageSummary(data);
      }
    } catch {}
  }, [isDesktop]);

  // Periodic usage refresh + cross-tab/local event sync
  useEffect(() => {
    const syncUsage = () => {
      setUsageCount(getTodayUsageCount());
      fetchUsageSummary();
    };
    syncUsage();

    const handleCustomUsageEvent = (e: Event) => {
      const customEv = e as CustomEvent;
      if (typeof customEv.detail === 'number') {
        setUsageCount(customEv.detail);
      } else {
        syncUsage();
      }
    };

    window.addEventListener('ai_usage_updated', handleCustomUsageEvent);
    window.addEventListener('storage', syncUsage);
    const usageTimer = setInterval(syncUsage, 20000);

    return () => {
      clearInterval(usageTimer);
      window.removeEventListener('ai_usage_updated', handleCustomUsageEvent);
      window.removeEventListener('storage', syncUsage);
    };
  }, [fetchUsageSummary]);

  // Dynamic model fetcher
  const fetchAvailableModels = useCallback(async (key: string, showSuccessBanner = false) => {
    setFetchingModels(true);
    const trimmedKey = key.trim();
    try {
      if (isDesktop) {
        const goApp = (window as any).go?.main?.App;
        // If key is provided, query Google API directly with key header
        if (trimmedKey) {
          const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
            headers: { 'x-goog-api-key': trimmedKey },
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData?.error?.message || `Google returned status ${res.status}`);
          }
          const data = await res.json();
          if (data.models && Array.isArray(data.models)) {
            const generateModels = data.models
              .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
              .map((m: any) => ({
                name: m.name,
                displayName: m.displayName || m.name.replace('models/', ''),
                description: m.description || '',
                inputTokenLimit: m.inputTokenLimit || 0,
                outputTokenLimit: m.outputTokenLimit || 0,
              }));
            setAvailableModels(generateModels);
            if (showSuccessBanner) showStatus('✓ Loaded models from Google Gemini API', 3000);
          }
        } else if (goApp?.ListAvailableModels) {
          // No key typed: read models using desktop backend's configured key
          const models: string[] | null = await callGo(() => goApp.ListAvailableModels());
          if (models && Array.isArray(models) && models.length > 0) {
            setAvailableModels(
              models.map((m: string) => {
                const name = normalizeModelName(m);
                return {
                  name,
                  displayName: name.replace('models/', ''),
                  description: '',
                  inputTokenLimit: 0,
                  outputTokenLimit: 0,
                };
              })
            );
            if (showSuccessBanner) showStatus('✓ Loaded models from desktop backend', 3000);
          }
        }
      } else {
        // Web mode: proxy through backend
        const res = await apiFetch('/api/ai/models');
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData?.error || `Server returned ${res.status}`);
        }
        const data = await res.json();
        if (data.models && Array.isArray(data.models)) {
          setAvailableModels(
            data.models.map((m: any) => {
              const name = normalizeModelName(m.name);
              return {
                name,
                displayName: m.displayName || name.replace('models/', ''),
                description: '',
                inputTokenLimit: 0,
                outputTokenLimit: 0,
              };
            })
          );
          if (showSuccessBanner) showStatus('✓ Loaded models from server', 3000);
        }
      }
    } catch (err: any) {
      if (showSuccessBanner) {
        showStatus(`✕ Failed to load models: ${err?.message || 'Network error'}`, 5000);
      }
    } finally {
      setFetchingModels(false);
    }
  }, [isDesktop, showStatus]);

  useEffect(() => {
    fetchAvailableModels(apiKey, false);
  }, [fetchAvailableModels]);

  const handleSave = async () => {
    setSaving(true);
    let backendError: string | null = null;
    const cleanModel = model.replace(/^models\//, '').trim();
    const trimmedKey = apiKey.trim();

    try {
      if (isDesktop) {
        const goApp = (window as any).go?.main?.App;
        if (goApp) {
          if (trimmedKey && goApp.UpdateGeminiAPIKey) {
            await callGo(() => goApp.UpdateGeminiAPIKey(trimmedKey));
            setBackendConfiguredKey(true);
          }
          if (goApp.UpdateAIModel) {
            await callGo(() => goApp.UpdateAIModel(cleanModel));
          }
          if (goApp.UpdateScreenshotInterval) {
            await callGo(() => goApp.UpdateScreenshotInterval(screenshotInterval));
          }
        }
      } else {
        const payload: Record<string, any> = {
          ai_model: model,
          screenshot_interval_seconds: screenshotInterval,
        };
        if (trimmedKey) {
          payload.gemini_api_key = trimmedKey;
        }
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData?.error || `Server returned ${res.status}`);
        }
        if (trimmedKey) setBackendConfiguredKey(true);
      }
    } catch (err: any) {
      backendError = err?.message || 'Unknown error';
    }

    if (backendError) {
      showStatus(`✕ Update failed: ${backendError}`, 5000);
    } else {
      if (trimmedKey) {
        localStorage.setItem('mini_gemini_api_key', trimmedKey);
      }
      localStorage.setItem('mini_ai_model', model);
      localStorage.setItem('mini_screenshot_interval', screenshotInterval.toString());

      setSavedBaseline({
        apiKey: trimmedKey,
        model,
        screenshotInterval,
      });

      showStatus('✓ Settings saved successfully!', 4000);
      window.dispatchEvent(new CustomEvent('mini_settings_updated'));
    }
    setSaving(false);
  };

  const handleClearApiKey = async () => {
    if (!window.confirm('Clear stored Gemini API Key?')) return;
    setApiKey('');
    localStorage.removeItem('mini_gemini_api_key');
    if (isDesktop) {
      const goApp = (window as any).go?.main?.App;
      if (goApp?.UpdateGeminiAPIKey) {
        await callGo(() => goApp.UpdateGeminiAPIKey(''));
      }
    }
    setBackendConfiguredKey(false);
    setMaskedKeyHint('');
    setSavedBaseline((prev) => ({ ...prev, apiKey: '' }));
    showStatus('✓ API key cleared', 3000);
  };

  const handleTestAPI = async () => {
    if (testing) return;
    setTesting(true);
    showStatus('Testing AI connection…');

    try {
      const trimmedKey = apiKey.trim();
      if (isDesktop) {
        if (!trimmedKey && !backendConfiguredKey) {
          showStatus('Please enter an API Key to test.', 4000);
          setTesting(false);
          return;
        }
        const activeKey = trimmedKey;
        const cleanModel = encodeURIComponent(model.replace(/^models\//, '').trim());
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': activeKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Hello, respond with OK if working.' }] }],
          }),
        });

        if (res.ok) {
          bumpUsageCount(1);
          setUsageCount(getTodayUsageCount());
          fetchUsageSummary();
          showStatus(`✓ Connected successfully to ${cleanModel}!`, 4000);
        } else {
          const err = await res.json().catch(() => ({}));
          const msg = err.error?.message ? String(err.error.message).slice(0, 100) : `Status ${res.status}`;
          showStatus(`✕ API Error: ${msg}`, 5000);
        }
      } else {
        const res = await apiFetch('/api/ai/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: trimmedKey,
            model,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.models && Array.isArray(data.models)) {
            setAvailableModels(
              data.models.map((m: any) => {
                const name = normalizeModelName(m.name);
                return {
                  name,
                  displayName: m.displayName || name.replace('models/', ''),
                  description: '',
                  inputTokenLimit: 0,
                  outputTokenLimit: 0,
                };
              })
            );
          }
          fetchUsageSummary();
          showStatus('✓ Server verified Gemini connection successfully!', 4000);
        } else {
          const err = await res.json().catch(() => ({}));
          showStatus(`✕ API Error: ${err.error || 'Server failed to verify Gemini key.'}`, 5000);
        }
      }
    } catch {
      showStatus('✕ Connection failed. Check network or API key.', 5000);
    } finally {
      setTesting(false);
    }
  };

  const handleClearData = async () => {
    if (!isDesktop) {
      showStatus('✕ Clearing stored data is only available in the desktop app.', 4000);
      return;
    }
    if (!window.confirm('Are you sure you want to delete all stored screenshots, logs, and activity records? This action cannot be undone.')) {
      return;
    }
    try {
      const goApp = (window as any).go?.main?.App;
      if (goApp?.ClearAllLocalData) {
        await callGo(() => goApp.ClearAllLocalData());
      }
      resetUsageCount();
      setUsageCount(0);
      showStatus('✓ Deleted local screenshots and reset database!', 2000);
      setTimeout(() => window.location.reload(), 1500);
    } catch {
      showStatus('✕ Failed to clear local data.', 5000);
    }
  };

  const fmtTokens = (n: number) => (n ? n.toLocaleString() : 'N/A');
  const selectedModelInfo = availableModels.find((m) => m.name === model || m.name === `models/${model}`);

  const modelOptions: SelectOption[] = useMemo(() => {
    if (availableModels.length > 0) {
      return availableModels.map((m) => ({
        value: m.name,
        label: m.displayName,
        meta: m.inputTokenLimit ? `${fmtTokens(m.inputTokenLimit)} in` : undefined,
        leading: <Icon name="sparkles" size={14} />,
      }));
    }
    return [
      {
        value: 'models/gemini-3.5-flash-lite',
        label: 'Gemini 3.5 Flash Lite',
        triggerLabel: 'Gemini 3.5 Flash Lite (Fast & Recommended)',
        meta: 'Fast & Recommended',
        leading: <Icon name="sparkles" size={14} />,
      },
      {
        value: 'models/gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        triggerLabel: 'Gemini 3.8 Flash (Balanced)',
        meta: 'Balanced',
        leading: <Icon name="sparkles" size={14} />,
      },
      {
        value: 'models/gemini-2.5-pro',
        label: 'Gemini 2.5 Pro',
        triggerLabel: 'Gemini 2.5 Pro (Deep Reasoning)',
        meta: 'Deep Reasoning',
        leading: <Icon name="sparkles" size={14} />,
      },
      {
        value: 'models/gemma-4-31b-it',
        label: 'Gemma 4 31B IT',
        triggerLabel: 'Gemma 4 31B IT (Schema-free Fallback)',
        meta: 'Schema-free',
        leading: <Icon name="sparkles" size={14} />,
      },
    ];
  }, [availableModels]);

  // Ensure non-standard screenshot interval is visible in CustomSelect options
  const intervalOptions: SelectOption[] = useMemo(() => {
    const stringVal = String(screenshotInterval);
    const hasMatch = DEFAULT_INTERVAL_OPTIONS.some((opt) => opt.value === stringVal);
    if (!hasMatch) {
      return [
        { value: stringVal, label: `${screenshotInterval}s — Custom interval`, leading: <Icon name="clock" size={14} /> },
        ...DEFAULT_INTERVAL_OPTIONS,
      ];
    }
    return DEFAULT_INTERVAL_OPTIONS;
  }, [screenshotInterval]);

  const modelFamily = (() => {
    const lower = model.toLowerCase();
    if (lower.includes('gemma')) return 'Gemma family';
    if (lower.includes('pro')) return 'Gemini Pro family';
    return 'Gemini Flash family';
  })();

  return (
    <div className="fade-in-up">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
      >
        <div className="page-header" style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h1 className="page-title" style={{ margin: 0 }}>AI Engine & Model Settings</h1>
              {isDirty && (
                <span className="badge badge-warning" style={{ fontSize: 11, padding: '2px 8px' }}>
                  Unsaved changes
                </span>
              )}
            </div>
            <p className="page-subtitle">API key, model, capture preferences, and live usage.</p>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={handleTestAPI}
              disabled={testing}
              className="btn btn-secondary"
              style={{ padding: '10px 18px', fontSize: 14, fontWeight: 600, opacity: testing ? 0.6 : undefined, cursor: testing ? 'not-allowed' : undefined }}
            >
              {testing ? 'Testing…' : '⚡ Test'}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="btn btn-primary"
              style={{
                padding: '10px 22px',
                fontSize: 14,
                fontWeight: 700,
                opacity: saving ? 0.6 : undefined,
                cursor: saving ? 'not-allowed' : undefined,
                boxShadow: isDirty ? '0 0 0 2px var(--primary-accent)' : undefined,
              }}
            >
              {saving ? 'Saving…' : '💾 Save Settings'}
            </button>
          </div>
        </div>

        {statusMessage && (
          <Alert
            type={statusMessage.startsWith('✓') ? 'success' : statusMessage.startsWith('✕') ? 'error' : 'info'}
            message={statusMessage}
            style={{ marginBottom: 16 }}
          />
        )}

        {/* API Key & Model Card */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="card-title">🔑 API Key & Model</span>
            {backendConfiguredKey && (
              <span className="badge badge-productive" style={{ fontSize: 11 }}>
                ✓ {isDesktop ? 'Active in Desktop Config' : 'Active on Server'}
                {maskedKeyHint ? ` (${maskedKeyHint})` : ''}
              </span>
            )}
          </div>
          <div className="card-body">
            <div className="form-group">
              <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Google Gemini API Key</span>
                {apiKey && (
                  <button
                    type="button"
                    onClick={handleClearApiKey}
                    style={{ background: 'none', border: 'none', color: 'var(--danger-text)', fontSize: 12, cursor: 'pointer', padding: 0 }}
                  >
                    Clear key
                  </button>
                )}
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="password"
                  placeholder={backendConfiguredKey ? '●●●●●●●● (Configured - enter new key to replace)' : 'AIzaSy...'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="form-input"
                  style={{ fontFamily: 'monospace', flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => fetchAvailableModels(apiKey, true)}
                  disabled={fetchingModels || (isDesktop && !apiKey.trim() && !backendConfiguredKey)}
                  className="btn btn-secondary"
                  title="Refresh model list from Google Gemini API"
                  style={{
                    padding: '8px 12px',
                    minWidth: 42,
                    opacity: fetchingModels || (isDesktop && !apiKey.trim() && !backendConfiguredKey) ? 0.6 : undefined,
                    cursor: fetchingModels || (isDesktop && !apiKey.trim() && !backendConfiguredKey) ? 'not-allowed' : undefined,
                  }}
                >
                  {fetchingModels ? '…' : '↻'}
                </button>
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: selectedModelInfo ? 8 : undefined }}>
              <label className="form-label">
                Model {availableModels.length > 0 && `(${availableModels.length} fetched)`}
              </label>
              <CustomSelect
                fullWidth
                ariaLabel="Model"
                value={model}
                onChange={setModel}
                options={modelOptions}
                triggerStyle={{ height: 38 }}
              />
            </div>

            {selectedModelInfo && (
              <div
                title={selectedModelInfo.description}
                style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                Context {fmtTokens(selectedModelInfo.inputTokenLimit)} · Output {fmtTokens(selectedModelInfo.outputTokenLimit)}
                {selectedModelInfo.description ? ` · ${selectedModelInfo.description}` : ''}
              </div>
            )}
          </div>
        </div>

        {/* Capture & Appearance Card */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">🎨 Capture & Appearance</span>
          </div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Theme</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[
                    { id: 'dark', label: '🌙 Dark', desc: 'Dark contrast for low light' },
                    { id: 'light', label: '☀️ Light', desc: 'Bright palette for daytime' },
                    { id: 'auto', label: '💻 Auto', desc: 'Match OS system preference' },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      title={t.desc}
                      onClick={() => onThemeChange?.(t.id as any)}
                      className={theme === t.id ? 'btn btn-primary' : 'btn btn-secondary'}
                      style={{ flex: 1, padding: '8px 10px', fontSize: 13, fontWeight: theme === t.id ? 700 : 500 }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Capture Interval</label>
                <CustomSelect
                  fullWidth
                  ariaLabel="Capture Interval"
                  value={String(screenshotInterval)}
                  onChange={(value) => {
                    const parsed = parseInt(value, 10);
                    setScreenshotInterval(Number.isFinite(parsed) ? Math.min(Math.max(parsed, 5), 3600) : 60);
                  }}
                  options={intervalOptions}
                  triggerStyle={{ height: 38 }}
                />
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
              {isDesktop
                ? `Captures every ${screenshotInterval}s (backend: ${syncIntervalSeconds}s). Pending captures are batched to keep AI usage low.`
                : `Organization capture interval: every ${screenshotInterval}s. This policy is synced to all connected desktop trackers.`}
            </div>
          </div>
        </div>
      </form>

      {/* Live AI Usage */}
      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="card-title">📊 AI Usage</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
            <span
              style={{ fontWeight: 700, color: 'var(--teal-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}
              title={selectedModelInfo?.displayName || model.replace('models/', '')}
            >
              {selectedModelInfo?.displayName || model.replace('models/', '')}
            </span>
            <span className="badge badge-productive" style={{ flexShrink: 0 }}>
              {modelFamily}
            </span>
          </span>
        </div>
        <div className="card-body">
          <div className="stats-grid" style={{ marginBottom: 14 }}>
            <StatCard
              label="AI Requests Today"
              value={usageSummary?.total_requests ?? usageCount}
              valueClass="text-purple"
              sub="Tracked API requests (resets daily)"
            />
            <StatCard
              label="Prompt Tokens"
              value={(usageSummary?.prompt_tokens ?? 0).toLocaleString()}
              valueClass="text-cyan"
              sub="Input prompt tokens"
            />
            <StatCard
              label="Output Tokens"
              value={(usageSummary?.candidate_tokens ?? 0).toLocaleString()}
              valueClass="text-amber"
              sub="AI output tokens"
            />
            <StatCard
              label="Total Tokens"
              value={(usageSummary?.total_tokens ?? 0).toLocaleString()}
              valueClass="text-green"
              sub="Combined API tokens"
            />
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Free-tier RPM/RPD/TPM limits are enforced by Google per model (check <strong>Google AI Studio → Rate limits</strong>); the numbers above are live app usage. Each completed 5-minute window is analyzed as one session bundle with automatic retry and model fallback.
          </div>
        </div>
      </div>

      {/* Danger Zone - Desktop Only */}
      {isDesktop && (
        <div className="card" style={{ marginTop: 16, border: '1px solid color-mix(in srgb, var(--accent-red) 30%, transparent)' }}>
          <div className="card-header" style={{ borderBottom: '1px solid color-mix(in srgb, var(--accent-red) 20%, transparent)' }}>
            <span className="card-title" style={{ color: 'var(--danger-text)' }}>⚠️ Danger Zone</span>
          </div>
          <div className="card-body" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, flex: 1, minWidth: 220 }}>
              Permanently purge local screenshot caches and reset the activity database. Settings and API keys are preserved.
            </p>
            <button
              type="button"
              onClick={handleClearData}
              className="btn"
              style={{
                background: 'color-mix(in srgb, var(--accent-red) 15%, transparent)',
                border: '1px solid var(--accent-red)',
                color: 'var(--danger-text)',
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              🗑️ Clear All Data & Reset
            </button>
          </div>
        </div>
      )}

      {isDesktop && appVersion && (
        <div style={{ marginTop: 14, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          get-Hike desktop · version {appVersion}
        </div>
      )}
    </div>
  );
}