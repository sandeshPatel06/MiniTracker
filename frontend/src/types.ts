// Type declarations for Wails Go bindings
export interface LogEntry {
  id: number;
  timestamp: string;
  image_path: string;
  total_keys: number;
  unique_keys: number;
  entropy_score: number;
  total_clicks: number;
  mouse_distance: number;
  app_name?: string;
  app_category?: string;
  window_title?: string;
  session_id?: number;
  session_title?: string;
  ai_category: string;
  is_productive: boolean;
  productive_score?: number;
  ai_confidence: number;
  ai_reason: string;
  is_blurred?: boolean;
  blur_reason?: string;
  is_retroactive?: boolean;
  idle_interval_id?: number;
}

export interface WorkSession {
  id: number;
  org_id?: number;
  user_id?: number;
  title: string;
  summary: string;
  start_time: string;
  end_time: string;
  log_count: number;
  productive_pct: number;
  top_app_name?: string;
  top_category?: string;
}

export interface ProductivityStats {
  date: string;
  total_minutes: number;
  productive_minutes: number;
  unproductive_minutes: number;
  avg_entropy_score: number;
  top_category: string;
}

export interface AppConfig {
  screenshot_interval_seconds: number;
  data_dir: string;
  ai_configured: boolean;
  backend_endpoint?: string;
}

export interface Organization {
  id: number;
  name: string;
  slug: string;
  created_at: string;
}

export interface User {
  id: number;
  org_id: number;
  email: string;
  full_name: string;
  role: 'owner' | 'admin' | 'member';
  created_at: string;
}

export interface Invitation {
  id: number;
  org_id: number;
  email: string;
  role: 'admin' | 'member';
  token: string;
  status: 'pending' | 'accepted' | 'expired';
  expires_at: string;
  created_at: string;
}

export interface UsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

export interface UserUsageBreakdown {
  user_id: number;
  full_name: string;
  email: string;
  role: string;
  total_requests: number;
  prompt_tokens: number;
  candidate_tokens: number;
  total_tokens: number;
}

export interface APIUsageSummary {
  total_requests: number;
  prompt_tokens: number;
  candidate_tokens: number;
  total_tokens: number;
  by_key_source: Record<string, number>;
  user_breakdown?: UserUsageBreakdown[];
}

export type Page = 'dashboard' | 'timeline' | 'analytics' | 'organization' | 'accept-invite' | 'auth' | 'settings';

export interface PrivacyRule {
  id: number;
  rule_type: 'app' | 'title_regex' | 'content_regex';
  pattern: string;
  action: 'blur' | 'shield' | 'skip_screenshot';
  description?: string;
  is_active: boolean;
  is_built_in?: boolean;
}

export interface DistractionRule {
  id: number;
  kind: 'app' | 'keyword' | 'domain';
  pattern: string;
  is_distraction: boolean;
}

export interface IdleBlock {
  id: number;
  start_time: string;
  end_time: string;
  duration_seconds: number;
}

export interface DistractionAlertPayload {
  alert_id: number;
  app_name: string;
  window_title: string;
  dwell_seconds: number;
  threshold_seconds: number;
  active_task?: string;
  timestamp: string;
}

export interface CalendarEvent {
  id: number;
  integration_id?: number;
  external_id?: string;
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  all_day?: boolean;
  status?: string;
  meeting_url?: string;
  is_matched?: boolean;
  matched_log_id?: number;
}

export interface CalendarIntegration {
  id: number;
  user_id: number;
  provider: string;
  account_email: string;
  display_name: string;
  sync_status: string;
  last_synced_at?: string;
  auto_match_enabled: boolean;
  created_at: string;
}

