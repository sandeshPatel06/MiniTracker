import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { apiFetch, readJsonSafe } from '../api';
import { isDesktopApp, callGo } from '../services/wailsBridge';
import { getTodayUsageCount, bumpUsageCount, resetUsageCount } from '../utils';
import { CustomSelect } from '../components/CustomSelect';
import type { SelectOption } from '../components/CustomSelect';
import { Icon } from '../components/Icon';
import { StatCard } from '../components/StatCard';
import { Alert } from '../components/Alert';
import type { PrivacyRule, CalendarIntegration } from '../types';

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
  { value: '15', label: '15s | High frequency', leading: <Icon name="clock" size={14} /> },
  { value: '30', label: '30s | Active tracking', leading: <Icon name="clock" size={14} /> },
  { value: '60', label: '60s | Standard (default)', leading: <Icon name="clock" size={14} /> },
  { value: '120', label: '2m | Low resource', leading: <Icon name="clock" size={14} /> },
  { value: '300', label: '5m | Minimal', leading: <Icon name="clock" size={14} /> },
];

const RULE_TYPE_OPTIONS: SelectOption[] = [
  { value: 'app', label: 'App name', leading: <Icon name="desktop" size={13} /> },
  { value: 'title_regex', label: 'Title regex', leading: <Icon name="code" size={13} /> },
];

const RULE_ACTION_OPTIONS: SelectOption[] = [
  { value: 'blur', label: 'Blur', leading: <Icon name="palette" size={13} /> },
  { value: 'shield', label: 'Shield', leading: <Icon name="shield" size={13} /> },
  { value: 'skip_screenshot', label: 'Skip', leading: <Icon name="lock" size={13} /> },
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

  // Features 5, 8, 9 & 10 State
  const [privacyEnabled, setPrivacyEnabled] = useState(true);
  const [privacyBlurStyle, setPrivacyBlurStyle] = useState('blur');
  const [privacyRules, setPrivacyRules] = useState<PrivacyRule[]>([]);
  const [newRulePattern, setNewRulePattern] = useState('');
  const [newRuleAction, setNewRuleAction] = useState<'blur' | 'shield' | 'skip_screenshot'>('blur');
  const [newRuleType, setNewRuleType] = useState<'app' | 'title_regex'>('app');
  const [addingRule, setAddingRule] = useState(false);

  const [distractionEnabled, setDistractionEnabled] = useState(true);
  const [distractionThresholdMins, setDistractionThresholdMins] = useState(15);
  const [distractionFocusSuppression, setDistractionFocusSuppression] = useState(false);
  const [distractionSound, setDistractionSound] = useState(true);
  const [distractionNativeNotify, setDistractionNativeNotify] = useState(true);
  const [distractionInAppToast, setDistractionInAppToast] = useState(true);

  const [calendarIntegrations, setCalendarIntegrations] = useState<CalendarIntegration[]>([]);

  const loadPrivacyRules = useCallback(() => {
    const w = window as any;
    if (w.go?.main?.App?.GetPrivacyRules) {
      callGo(() => w.go.main.App.GetPrivacyRules()).then((rules: any) => {
        if (Array.isArray(rules)) setPrivacyRules(rules);
      }).catch(() => {});
    }
  }, []);

  const loadCalendarIntegrations = useCallback(() => {
    const w = window as any;
    if (w.go?.main?.App?.GetCalendarIntegrations) {
      callGo(() => w.go.main.App.GetCalendarIntegrations()).then((integrations: any) => {
        if (Array.isArray(integrations)) setCalendarIntegrations(integrations);
      }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const w = window as any;
    if (w.go?.main?.App?.GetPrivacySettings) {
      callGo(() => w.go.main.App.GetPrivacySettings()).then((s: any) => {
        if (s) {
          setPrivacyEnabled(!!s.enabled);
          setPrivacyBlurStyle(s.blur_style || 'blur');
        }
      }).catch(() => {});
    }
    loadPrivacyRules();
    loadCalendarIntegrations();
    if (w.go?.main?.App?.GetDistractionConfig) {
      callGo(() => w.go.main.App.GetDistractionConfig()).then((c: any) => {
        if (c) {
          setDistractionEnabled(!!c.enabled);
          setDistractionThresholdMins(c.threshold_minutes || 15);
          setDistractionFocusSuppression(!!c.disable_during_focus);
          if (typeof c.sound_enabled === 'boolean') setDistractionSound(c.sound_enabled);
          if (typeof c.native_notify_enabled === 'boolean') setDistractionNativeNotify(c.native_notify_enabled);
          if (typeof c.in_app_toast_enabled === 'boolean') setDistractionInAppToast(c.in_app_toast_enabled);
        }
      }).catch(() => {});
    }
  }, [loadPrivacyRules, loadCalendarIntegrations]);

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

  const handleAddPrivacyRule = async (e: React.FormEvent) => {
    e.preventDefault();
    const pattern = newRulePattern.trim();
    if (!pattern) return;
    setAddingRule(true);
    try {
      const w = window as any;
      if (w.go?.main?.App?.AddPrivacyRule) {
        await callGo(() =>
          w.go.main.App.AddPrivacyRule(
            newRuleType,
            pattern,
            newRuleAction,
            `Custom ${newRuleType} rule: ${pattern}`
          )
        );
        setNewRulePattern('');
        loadPrivacyRules();
        showStatus('✓ Privacy rule added', 3000);
      }
    } catch (err: any) {
      showStatus(`✕ Failed to add rule: ${err?.message || 'Error'}`, 4000);
    } finally {
      setAddingRule(false);
    }
  };

  const handleDeletePrivacyRule = async (ruleId: number) => {
    try {
      const w = window as any;
      if (w.go?.main?.App?.DeletePrivacyRule) {
        await callGo(() => w.go.main.App.DeletePrivacyRule(ruleId));
        setPrivacyRules((prev) => prev.filter((r) => r.id !== ruleId));
        showStatus('✓ Privacy rule removed', 2500);
      }
    } catch (err: any) {
      showStatus(`✕ Failed to delete rule: ${err?.message || 'Error'}`, 4000);
    }
  };

  const handleTogglePrivacyRule = async (ruleId: number, currentActive: boolean) => {
    try {
      const w = window as any;
      if (w.go?.main?.App?.TogglePrivacyRule) {
        await callGo(() => w.go.main.App.TogglePrivacyRule(ruleId, !currentActive));
        setPrivacyRules((prev) =>
          prev.map((r) => (r.id === ruleId ? { ...r, is_active: !currentActive } : r))
        );
      }
    } catch {}
  };

  const updateDistractionSettings = (updates: {
    enabled?: boolean;
    threshold?: number;
    focusSuppression?: boolean;
    sound?: boolean;
    nativeNotify?: boolean;
    inAppToast?: boolean;
  }) => {
    const newEnabled = updates.enabled !== undefined ? updates.enabled : distractionEnabled;
    const newThreshold = updates.threshold !== undefined ? updates.threshold : distractionThresholdMins;
    const newFocus = updates.focusSuppression !== undefined ? updates.focusSuppression : distractionFocusSuppression;
    const newSound = updates.sound !== undefined ? updates.sound : distractionSound;
    const newNative = updates.nativeNotify !== undefined ? updates.nativeNotify : distractionNativeNotify;
    const newToast = updates.inAppToast !== undefined ? updates.inAppToast : distractionInAppToast;

    if (updates.enabled !== undefined) setDistractionEnabled(newEnabled);
    if (updates.threshold !== undefined) setDistractionThresholdMins(newThreshold);
    if (updates.focusSuppression !== undefined) setDistractionFocusSuppression(newFocus);
    if (updates.sound !== undefined) setDistractionSound(newSound);
    if (updates.nativeNotify !== undefined) setDistractionNativeNotify(newNative);
    if (updates.inAppToast !== undefined) setDistractionInAppToast(newToast);

    const w = window as any;
    if (w.go?.main?.App?.UpdateDistractionConfig) {
      callGo(() =>
        w.go.main.App.UpdateDistractionConfig(
          newEnabled,
          newThreshold,
          newFocus,
          newNative,
          newToast,
          newSound,
          15
        )
      ).catch(() => {});
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
        { value: stringVal, label: `${screenshotInterval}s | Custom`, leading: <Icon name="clock" size={14} /> },
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
              {testing ? 'Testing…' : 'Test'}
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
                boxShadow: isDirty ? '0 0 0 2px var(--accent-primary)' : undefined,
              }}
            >
              {saving ? 'Saving…' : 'Save Settings'}
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
          <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span className="card-title">
              <Icon name="sparkles" size={16} className="card-title-icon" />
              <span className="card-title-text">API Key & Model</span>
            </span>
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
            <span className="card-title">
              <Icon name="desktop" size={16} className="card-title-icon" />
              <span className="card-title-text">Capture & Appearance</span>
            </span>
          </div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Theme</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[
                    { id: 'dark', label: 'Dark', desc: 'Dark contrast for low light' },
                    { id: 'light', label: 'Light', desc: 'Bright palette for daytime' },
                    { id: 'auto', label: 'Auto', desc: 'Match OS system preference' },
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

        {/* Feature 8: Privacy & Sensitive Content Protection */}
        {isDesktop && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <span className="card-title">
                <Icon name="shield" size={16} className="card-title-icon" />
                <span className="card-title-text">Privacy & Sensitive Content Protection</span>
              </span>
              <span
                className={privacyEnabled ? 'badge badge-productive' : 'badge badge-neutral'}
                style={{ fontSize: 11 }}
              >
                {privacyEnabled ? 'Active' : 'Disabled'}
              </span>
            </div>
            <div className="card-body">
              {/* Master Toggle */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 16 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>
                    Enable Sensitive Window Auto-Protection
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    Automatically blurs password managers (Bitwarden, 1Password), banking portals, incognito sessions, and detected credentials in RAM before saving.
                  </div>
                </div>
                <label className="settings-switch" title="Toggle Sensitive Window Auto-Protection">
                  <input
                    type="checkbox"
                    checked={privacyEnabled}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setPrivacyEnabled(checked);
                      const w = window as any;
                      if (w.go?.main?.App?.UpdatePrivacySettings) {
                        callGo(() => w.go.main.App.UpdatePrivacySettings(checked, privacyBlurStyle, 35));
                      }
                    }}
                    aria-label="Toggle Sensitive Window Auto-Protection"
                  />
                  <span className="settings-switch-slider" />
                </label>
              </div>

              {/* Segmented Mode Selector */}
              <div className="form-group" style={{ marginBottom: 16 }}>
                <label className="form-label" style={{ marginBottom: 6 }}>
                  Protection Mode
                </label>
                <div className="settings-segmented-group" role="group" aria-label="Privacy protection mode">
                  {[
                    { id: 'blur', label: 'Heavy Blur', desc: 'Gaussian filter masks window' },
                    { id: 'shield', label: 'Frosted Shield', desc: 'Frosted overlay with lock' },
                    { id: 'skip', label: 'Skip Capture', desc: 'Zero disk storage' },
                  ].map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      className={`settings-segmented-btn ${privacyBlurStyle === mode.id ? 'is-active' : ''}`}
                      onClick={() => {
                        setPrivacyBlurStyle(mode.id);
                        const w = window as any;
                        if (w.go?.main?.App?.UpdatePrivacySettings) {
                          callGo(() => w.go.main.App.UpdatePrivacySettings(privacyEnabled, mode.id, 35));
                        }
                      }}
                      title={mode.desc}
                    >
                      {mode.id === 'shield' && <Icon name="shield" size={13} />}
                      {mode.id === 'blur' && <Icon name="palette" size={13} />}
                      {mode.id === 'skip' && <Icon name="lock" size={13} />}
                      <span>{mode.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom Privacy Filter Rules */}
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                    Active Protection Rules ({privacyRules.length})
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Built-in credentials, vaults & banks included automatically
                  </span>
                </div>

                {privacyRules.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                    {privacyRules.map((rule) => (
                      <span
                        key={rule.id}
                        className="rule-badge-pill"
                        style={{ opacity: rule.is_active ? 1 : 0.55 }}
                      >
                        <button
                          type="button"
                          onClick={() => handleTogglePrivacyRule(rule.id, !!rule.is_active)}
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex' }}
                          title={rule.is_active ? 'Click to disable' : 'Click to enable'}
                        >
                          <Icon
                            name={rule.is_active ? 'check' : 'x'}
                            size={12}
                            color={rule.is_active ? 'var(--accent-green)' : 'var(--text-muted)'}
                          />
                        </button>
                        <span className="pill-pattern">{rule.pattern}</span>
                        <span className={`pill-action action-${rule.action.startsWith('skip') ? 'skip' : rule.action}`}>
                          {rule.action.replace('_screenshot', '')}
                        </span>
                        {!rule.is_built_in && (
                          <button
                            type="button"
                            className="pill-del-btn"
                            onClick={() => handleDeletePrivacyRule(rule.id)}
                            title="Delete custom rule"
                            aria-label={`Delete rule ${rule.pattern}`}
                          >
                            <Icon name="x" size={11} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, fontStyle: 'italic' }}>
                    No custom rules defined yet. Add app names or regex patterns below.
                  </div>
                )}

                {/* Add Rule Inline Form */}
                <form onSubmit={handleAddPrivacyRule} className="privacy-rule-form">
                  <div className="privacy-rule-type-field">
                    <CustomSelect
                      fullWidth
                      compact
                      ariaLabel="Rule target type"
                      value={newRuleType}
                      onChange={(val) => setNewRuleType(val as 'app' | 'title_regex')}
                      options={RULE_TYPE_OPTIONS}
                      triggerStyle={{ height: 32, fontSize: 12 }}
                    />
                  </div>
                  <input
                    type="text"
                    placeholder={newRuleType === 'app' ? 'e.g. keepassxc, signal' : 'e.g. (?i)payroll|classified'}
                    value={newRulePattern}
                    onChange={(e) => setNewRulePattern(e.target.value)}
                    className="form-input privacy-rule-pattern-input"
                    aria-label="Filter pattern"
                  />
                  <div className="privacy-rule-action-field">
                    <CustomSelect
                      fullWidth
                      compact
                      align="right"
                      ariaLabel="Rule action"
                      value={newRuleAction}
                      onChange={(val) => setNewRuleAction(val as 'blur' | 'shield' | 'skip_screenshot')}
                      options={RULE_ACTION_OPTIONS}
                      triggerStyle={{ height: 32, fontSize: 12 }}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={addingRule || !newRulePattern.trim()}
                    className="btn btn-secondary privacy-rule-add-btn"
                    style={{ fontSize: 12, padding: '0 14px', height: 32, gap: 4 }}
                  >
                    <Icon name="plus" size={12} />
                    <span>Add Rule</span>
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {/* Feature 5: Smart Distraction Alerts */}
        {isDesktop && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <span className="card-title">
                <Icon name="bell" size={16} className="card-title-icon" />
                <span className="card-title-text">Smart Distraction Alerts</span>
              </span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span
                  className={distractionEnabled ? 'badge badge-productive' : 'badge badge-neutral'}
                  style={{ fontSize: 11 }}
                >
                  {distractionEnabled ? 'Active' : 'Disabled'}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    const w = window as any;
                    if (w.go?.main?.App?.SendTestDistractionAlert) {
                      callGo(() => w.go.main.App.SendTestDistractionAlert());
                      showStatus('✓ Test alert sent', 2500);
                    }
                  }}
                  style={{ fontSize: 11, padding: '3px 10px', height: 26, gap: 4 }}
                  title="Trigger a test distraction notification and sound"
                >
                  <Icon name="bell" size={12} />
                  <span>Test Nudge</span>
                </button>
              </div>
            </div>
            <div className="card-body">
              {/* Master Alert Switch */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>
                    Continuous Dwell Nudges
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    Receive non-intrusive in-app toasts and OS notifications when continuous time on non-productive applications exceeds your limit.
                  </div>
                </div>
                <label className="settings-switch" title="Toggle Continuous Dwell Nudges">
                  <input
                    type="checkbox"
                    checked={distractionEnabled}
                    onChange={(e) => updateDistractionSettings({ enabled: e.target.checked })}
                    aria-label="Toggle Continuous Dwell Nudges"
                  />
                  <span className="settings-switch-slider" />
                </label>
              </div>

              {/* Responsive Slider Control with Segmented Steps */}
              <div style={{ marginBottom: 16, background: 'var(--bg-surface)', padding: '12px 14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginBottom: 8 }}>
                  <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
                    Continuous Dwell Threshold
                  </span>
                  <span style={{ fontWeight: 700, color: 'var(--accent-primary)', fontVariantNumeric: 'tabular-nums' }}>
                    {distractionThresholdMins} minutes
                  </span>
                </div>
                <input
                  type="range"
                  min="5"
                  max="60"
                  step="5"
                  value={distractionThresholdMins}
                  onChange={(e) => updateDistractionSettings({ threshold: parseInt(e.target.value, 10) })}
                  className="settings-range-slider"
                  aria-label="Continuous Dwell Threshold"
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
                  <span>5m (Strict)</span>
                  <span>15m (Balanced)</span>
                  <span>30m</span>
                  <span>60m (Relaxed)</span>
                </div>
              </div>

              {/* Preference Controls */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
                  gap: 10,
                  opacity: distractionEnabled ? 1 : 0.55,
                  pointerEvents: distractionEnabled ? 'auto' : 'none',
                  transition: 'opacity var(--transition)',
                }}
              >
                <label
                  className={`settings-pref-card ${distractionFocusSuppression ? 'is-active' : ''}`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        color: distractionFocusSuppression ? 'var(--accent-primary)' : 'var(--text-muted)',
                        display: 'flex',
                        flexShrink: 0,
                      }}
                    >
                      <Icon name="target" size={15} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                        Focus suppression
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                        Silence alerts during focus goals
                      </div>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={distractionFocusSuppression}
                    disabled={!distractionEnabled}
                    onChange={(e) => updateDistractionSettings({ focusSuppression: e.target.checked })}
                    aria-label="Suppress alerts during focus goals"
                  />
                </label>

                <label
                  className={`settings-pref-card ${distractionInAppToast ? 'is-active' : ''}`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        color: distractionInAppToast ? 'var(--accent-primary)' : 'var(--text-muted)',
                        display: 'flex',
                        flexShrink: 0,
                      }}
                    >
                      <Icon name="message" size={15} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                        In-app nudge toast
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                        Show non-intrusive floating toast
                      </div>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={distractionInAppToast}
                    disabled={!distractionEnabled}
                    onChange={(e) => updateDistractionSettings({ inAppToast: e.target.checked })}
                    aria-label="Show in-app nudge toast"
                  />
                </label>

                <label
                  className={`settings-pref-card ${distractionNativeNotify ? 'is-active' : ''}`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        color: distractionNativeNotify ? 'var(--accent-primary)' : 'var(--text-muted)',
                        display: 'flex',
                        flexShrink: 0,
                      }}
                    >
                      <Icon name="desktop" size={15} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                        OS notifications
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                        Send desktop system banner
                      </div>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={distractionNativeNotify}
                    disabled={!distractionEnabled}
                    onChange={(e) => updateDistractionSettings({ nativeNotify: e.target.checked })}
                    aria-label="Send desktop OS notifications"
                  />
                </label>

                <label
                  className={`settings-pref-card ${distractionSound ? 'is-active' : ''}`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        color: distractionSound ? 'var(--accent-primary)' : 'var(--text-muted)',
                        display: 'flex',
                        flexShrink: 0,
                      }}
                    >
                      <Icon name="bell" size={15} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                        Audible alert chime
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                        Play gentle sound effect on nudge
                      </div>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={distractionSound}
                    disabled={!distractionEnabled}
                    onChange={(e) => updateDistractionSettings({ sound: e.target.checked })}
                    aria-label="Play sound effect on nudge"
                  />
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Feature 10 & 9: Connected Calendars & Away Tracking */}
        {isDesktop && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <span className="card-title">
                <Icon name="calendar" size={16} className="card-title-icon" />
                <span className="card-title-text">Connected Calendars & Away Intervals</span>
              </span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="badge badge-productive" style={{ fontSize: 11 }}>
                  Ready
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    loadCalendarIntegrations();
                    showStatus('✓ Refreshed calendar sync status', 2000);
                  }}
                  style={{ fontSize: 11, padding: '3px 10px', height: 26, gap: 4 }}
                  title="Check calendar sync status"
                >
                  <Icon name="refresh" size={12} />
                  <span>Refresh</span>
                </button>
              </div>
            </div>
            <div className="card-body">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 16 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', marginBottom: 4 }}>
                    Automated Calendar Meeting Matching
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    When stepping away for meetings or calls, get-Hike automatically correlates detected offline intervals with scheduled Google and Microsoft 365 calendar events.
                  </div>
                  <div style={{ marginTop: 12 }}>
                    {calendarIntegrations.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {calendarIntegrations.map((ci) => (
                          <div
                            key={ci.id}
                            className="calendar-account-card"
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '1 1 200px' }}>
                              <span style={{ color: 'var(--accent-primary)', display: 'flex', flexShrink: 0 }}>
                                <Icon name="calendar" size={14} />
                              </span>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {ci.account_email || ci.display_name}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                                  {ci.provider} {ci.last_synced_at && `• Synced ${new Date(ci.last_synced_at).toLocaleTimeString()}`}
                                </div>
                              </div>
                            </div>
                            <span className="badge badge-productive" style={{ fontSize: 10, flexShrink: 0 }}>
                              {ci.sync_status || 'connected'}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 10,
                          padding: '12px 14px',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--bg-surface)',
                          border: '1px dashed var(--border-medium)',
                          fontSize: 12,
                          color: 'var(--text-muted)',
                          lineHeight: 1.5,
                        }}
                      >
                        <span style={{ color: 'var(--text-muted)', display: 'flex', flexShrink: 0, marginTop: 2 }}>
                          <Icon name="info" size={14} />
                        </span>
                        <div>
                          Calendar sync configured via organization settings or environment secrets (Google & Microsoft 365 tokens).
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', marginBottom: 4 }}>
                    Offline Away Detection
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    Periods exceeding 5 minutes without keyboard or mouse input automatically pause active recording. Upon return, an offline interval modal allows one-click classification.
                  </div>
                  <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="badge badge-neutral" style={{ fontSize: 11, padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Icon name="clock" size={12} />
                      5m inactivity threshold
                    </span>
                    <span className="badge badge-productive" style={{ fontSize: 11, padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Icon name="check" size={12} />
                      Auto-prompt enabled
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </form>

      {/* Live AI Usage */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="card-title">
            <Icon name="activity" size={16} className="card-title-icon" />
            <span className="card-title-text">API Usage</span>
          </span>
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
              label="Requests Today"
              value={usageSummary?.total_requests ?? usageCount}
              valueClass="text-purple"
              sub="Total tracked requests (resets daily)"
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
            <span className="card-title" style={{ color: 'var(--danger-text)' }}>
              <Icon name="trash" size={16} className="card-title-icon" style={{ color: 'var(--danger-text)' }} />
              <span className="card-title-text">Danger Zone</span>
            </span>
          </div>
          <div className="card-body" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, flex: 1, minWidth: 220 }}>
              Permanently purge local screenshot caches and reset the activity database. Settings and API keys are preserved.
            </p>
            <button
              type="button"
              onClick={handleClearData}
              className="btn btn-danger"
              style={{
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Icon name="trash" size={13} />
              <span>Clear All Data & Reset</span>
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