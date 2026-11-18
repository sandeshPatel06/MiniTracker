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
  { value: '15', label: '15 seconds · High frequency (fast-paced work)', leading: <Icon name="clock" size={14} /> },
  { value: '30', label: '30 seconds · Recommended (balanced)', leading: <Icon name="clock" size={14} /> },
  { value: '60', label: '1 minute · Standard (battery saver)', leading: <Icon name="clock" size={14} /> },
  { value: '120', label: '2 minutes · Low frequency', leading: <Icon name="clock" size={14} /> },
  { value: '300', label: '5 minutes · Minimal', leading: <Icon name="clock" size={14} /> },
];

const RULE_TYPE_OPTIONS: SelectOption[] = [
  { value: 'app', label: 'App name (e.g. WhatsApp, Slack, Spotify)', leading: <Icon name="desktop" size={13} /> },
  { value: 'title_regex', label: 'Window title contains (e.g. Bank, Netflix)', leading: <Icon name="search" size={13} /> },
];

const RULE_ACTION_OPTIONS: SelectOption[] = [
  { value: 'blur', label: 'Blur window', leading: <Icon name="palette" size={13} /> },
  { value: 'shield', label: 'Cover with lock shield', leading: <Icon name="shield" size={13} /> },
  { value: 'skip_screenshot', label: 'Do not take screenshot', leading: <Icon name="lock" size={13} /> },
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
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [trackingActive, setTrackingActive] = useState<boolean>(true);
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
          setDiagnostics(diag);
          if (typeof diag.version === 'string' && diag.version) setAppVersion(diag.version);
          if (typeof diag.tracking_active === 'boolean') setTrackingActive(diag.tracking_active);
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
        { value: stringVal, label: `${screenshotInterval} seconds (custom)`, leading: <Icon name="clock" size={14} /> },
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

  const handleOpenFolder = (kind: string) => {
    if (!isDesktop) return;
    const goApp = (window as any).go?.main?.App;
    if (goApp?.OpenFolder) {
      callGo(() => goApp.OpenFolder(kind)).catch((err: any) => {
        showStatus(`✕ Failed to open folder: ${err?.message || 'Error'}`, 4000);
      });
    }
  };

  const handleOpenURL = (url: string) => {
    const rt = (window as any).runtime;
    if (rt?.BrowserOpenURL) {
      rt.BrowserOpenURL(url);
    } else {
      window.open(url, '_blank');
    }
  };

  const displayVersion = appVersion
    ? (appVersion.startsWith('v') ? appVersion : `v${appVersion}`)
    : 'v2.1.0';

  const displayPlatform = (diagnostics?.platform as string) || 'Linux x86_64';

  return (
    <div className="page-container fade-in-up" style={{ paddingBottom: 40 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
      >
        {/* Minimal Header */}
        <div
          className="page-header"
          style={{
            marginBottom: 20,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h1 className="page-title" style={{ margin: 0 }}>Settings</h1>
              <span className="badge badge-neutral" style={{ fontSize: 11, padding: '2px 8px' }}>
                {displayVersion}
              </span>
              {isDirty && (
                <span className="badge badge-warning" style={{ fontSize: 11, padding: '2px 8px' }}>
                  Unsaved changes
                </span>
              )}
            </div>
            <p className="page-subtitle" style={{ margin: '4px 0 0', color: 'var(--text-muted)' }}>
              Preferences for tracking interval, appearance, AI, and privacy.
            </p>
          </div>
          <div>
            <button
              type="submit"
              disabled={saving || !isDirty}
              className="btn btn-primary"
              style={{
                padding: '8px 20px',
                fontSize: 13,
                fontWeight: 600,
                opacity: saving || !isDirty ? 0.6 : 1,
                cursor: saving || !isDirty ? 'not-allowed' : 'pointer',
              }}
            >
              {saving ? 'Saving…' : 'Save Changes'}
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

        {/* 1. General (Theme & Screenshot Interval) */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">
              <Icon name="desktop" size={16} className="card-title-icon" />
              <span className="card-title-text">General</span>
            </span>
          </div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label" style={{ fontWeight: 600 }}>Theme</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[
                    { id: 'dark', label: 'Dark' },
                    { id: 'light', label: 'Light' },
                    { id: 'auto', label: 'Auto' },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => onThemeChange?.(t.id as any)}
                      className={theme === t.id ? 'btn btn-primary' : 'btn btn-secondary'}
                      style={{ flex: 1, padding: '8px 12px', fontSize: 13, fontWeight: theme === t.id ? 700 : 500 }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label" style={{ fontWeight: 600 }}>Screenshot Frequency</label>
                <CustomSelect
                  fullWidth
                  ariaLabel="Screenshot Frequency"
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
              Captures are taken locally every {screenshotInterval}s and kept for 7 days.
            </div>
          </div>
        </div>

        {/* 2. AI Assistant (Google Gemini) */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span className="card-title">
              <Icon name="sparkles" size={16} className="card-title-icon" />
              <span className="card-title-text">Google Gemini AI</span>
            </span>
            {backendConfiguredKey && (
              <span className="badge badge-productive" style={{ fontSize: 11 }}>
                Connected
              </span>
            )}
          </div>
          <div className="card-body">
            <div className="form-group">
              <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 600 }}>
                <span>API Key</span>
                <span style={{ fontSize: 12 }}>
                  <button
                    type="button"
                    onClick={() => handleOpenURL('https://aistudio.google.com/app/apikey')}
                    style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', padding: 0 }}
                  >
                    Get free API key ↗
                  </button>
                  {apiKey && (
                    <>
                      <span style={{ margin: '0 6px', color: 'var(--text-muted)' }}>•</span>
                      <button
                        type="button"
                        onClick={handleClearApiKey}
                        style={{ background: 'none', border: 'none', color: 'var(--danger-text)', cursor: 'pointer', padding: 0 }}
                      >
                        Clear
                      </button>
                    </>
                  )}
                </span>
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="password"
                  placeholder={backendConfiguredKey ? '●●●●●●●● (Configured - enter to replace)' : 'AIzaSy... (Paste key)'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="form-input"
                  style={{ fontFamily: 'monospace', flex: 1 }}
                />
                <button
                  type="button"
                  onClick={handleTestAPI}
                  disabled={testing}
                  className="btn btn-secondary"
                  style={{ padding: '8px 14px', fontSize: 13, minWidth: 64 }}
                >
                  {testing ? 'Testing…' : 'Test'}
                </button>
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" style={{ fontWeight: 600 }}>Model</label>
              <CustomSelect
                fullWidth
                ariaLabel="AI Model"
                value={model}
                onChange={setModel}
                options={modelOptions}
                triggerStyle={{ height: 38 }}
              />
            </div>
          </div>
        </div>

        {/* 3. Privacy Shield */}
        {isDesktop && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="card-title">
                <Icon name="shield" size={16} className="card-title-icon" />
                <span className="card-title-text">Privacy Shield</span>
              </span>
              <span className={privacyEnabled ? 'badge badge-productive' : 'badge badge-neutral'} style={{ fontSize: 11 }}>
                {privacyEnabled ? 'Active' : 'Disabled'}
              </span>
            </div>
            <div className="card-body">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 16 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>
                    Protect Sensitive Windows
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    Automatically masks password managers (Bitwarden, 1Password) and banking before saving.
                  </div>
                </div>
                <label className="settings-switch">
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
                    aria-label="Toggle Privacy Shield"
                  />
                  <span className="settings-switch-slider" />
                </label>
              </div>

              <div className="form-group" style={{ marginBottom: 14 }}>
                <label className="form-label" style={{ marginBottom: 6, fontWeight: 600 }}>Protection Style</label>
                <div className="settings-segmented-group" role="group">
                  {[
                    { id: 'blur', label: 'Heavy Blur' },
                    { id: 'shield', label: 'Lock Shield' },
                    { id: 'skip', label: 'Skip Capture' },
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
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>

              {privacyRules.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {privacyRules.map((rule) => (
                    <span key={rule.id} className="rule-badge-pill" style={{ opacity: rule.is_active ? 1 : 0.55 }}>
                      <button
                        type="button"
                        onClick={() => handleTogglePrivacyRule(rule.id, !!rule.is_active)}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex' }}
                      >
                        <Icon name={rule.is_active ? 'check' : 'x'} size={12} color={rule.is_active ? 'var(--accent-green)' : 'var(--text-muted)'} />
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
                          title="Delete rule"
                        >
                          <Icon name="x" size={11} />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}

              <form onSubmit={handleAddPrivacyRule} className="privacy-rule-form">
                <div className="privacy-rule-type-field">
                  <CustomSelect
                    fullWidth
                    compact
                    ariaLabel="Rule type"
                    value={newRuleType}
                    onChange={(val) => setNewRuleType(val as 'app' | 'title_regex')}
                    options={RULE_TYPE_OPTIONS}
                    triggerStyle={{ height: 32, fontSize: 12 }}
                  />
                </div>
                <input
                  type="text"
                  placeholder={newRuleType === 'app' ? 'e.g. whatsapp, spotify' : 'e.g. bank, netflix'}
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
                  style={{ fontSize: 12, padding: '0 14px', height: 32 }}
                >
                  Add
                </button>
              </form>
            </div>
          </div>
        )}

        {/* 4. Focus & Distraction Nudges */}
        {isDesktop && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="card-title">
                <Icon name="bell" size={16} className="card-title-icon" />
                <span className="card-title-text">Distraction Reminders</span>
              </span>
              <span className={distractionEnabled ? 'badge badge-productive' : 'badge badge-neutral'} style={{ fontSize: 11 }}>
                {distractionEnabled ? 'Active' : 'Disabled'}
              </span>
            </div>
            <div className="card-body">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 16 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>
                    Gentle Break Reminders
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    Nudges you when continuous time on non-work apps exceeds your limit.
                  </div>
                </div>
                <label className="settings-switch">
                  <input
                    type="checkbox"
                    checked={distractionEnabled}
                    onChange={(e) => updateDistractionSettings({ enabled: e.target.checked })}
                    aria-label="Toggle Distraction Reminders"
                  />
                  <span className="settings-switch-slider" />
                </label>
              </div>

              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginBottom: 6 }}>
                  <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Remind after:</span>
                  <span style={{ fontWeight: 700, color: 'var(--accent-primary)' }}>{distractionThresholdMins} minutes</span>
                </div>
                <input
                  type="range"
                  min="5"
                  max="60"
                  step="5"
                  value={distractionThresholdMins}
                  onChange={(e) => updateDistractionSettings({ threshold: parseInt(e.target.value, 10) })}
                  className="settings-range-slider"
                  aria-label="Distraction Threshold"
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
                <label className={`settings-pref-card ${distractionSound ? 'is-active' : ''}`}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>Audio chime</span>
                  <input
                    type="checkbox"
                    checked={distractionSound}
                    disabled={!distractionEnabled}
                    onChange={(e) => updateDistractionSettings({ sound: e.target.checked })}
                  />
                </label>
                <label className={`settings-pref-card ${distractionNativeNotify ? 'is-active' : ''}`}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>Desktop banner</span>
                  <input
                    type="checkbox"
                    checked={distractionNativeNotify}
                    disabled={!distractionEnabled}
                    onChange={(e) => updateDistractionSettings({ nativeNotify: e.target.checked })}
                  />
                </label>
                <label className={`settings-pref-card ${distractionInAppToast ? 'is-active' : ''}`}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>In-app notification</span>
                  <input
                    type="checkbox"
                    checked={distractionInAppToast}
                    disabled={!distractionEnabled}
                    onChange={(e) => updateDistractionSettings({ inAppToast: e.target.checked })}
                  />
                </label>
              </div>
            </div>
          </div>
        )}
      </form>

      {/* 5. Local Storage & Reset */}
      {isDesktop && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">
              <Icon name="folder" size={16} className="card-title-icon" />
              <span className="card-title-text">Local Storage</span>
            </span>
          </div>
          <div
            className="card-body"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                All activity and screenshots are kept strictly on this device.
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => handleOpenFolder('data')}
                className="btn btn-secondary"
                style={{ fontSize: 12, padding: '7px 12px', gap: 6 }}
              >
                <Icon name="folder" size={13} />
                <span>Open Folder</span>
              </button>
              <button
                type="button"
                onClick={handleClearData}
                className="btn btn-danger"
                style={{ fontSize: 12, padding: '7px 12px', gap: 6 }}
              >
                <Icon name="trash" size={13} />
                <span>Clear All Data</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clean minimal footer */}
      {isDesktop && (
        <div style={{ marginTop: 16, textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
          get-Hike Desktop · version {displayVersion}
        </div>
      )}
    </div>
  );
}