package config

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/viper"
)

// Config holds application configuration managed by Viper.
type Config struct {
	GeminiAPIKey       string        `mapstructure:"gemini_api_key" json:"gemini_api_key"`
	GeminiModel        string        `mapstructure:"gemini_model" json:"gemini_model"`
	ScreenshotInterval time.Duration `mapstructure:"screenshot_interval_seconds" json:"screenshot_interval_seconds"`
	AIAnalysisInterval time.Duration `mapstructure:"ai_analysis_interval_seconds" json:"ai_analysis_interval_seconds"`
	DataDir            string        `mapstructure:"data_dir" json:"data_dir"`
	BackendPort        int           `mapstructure:"backend_port" json:"backend_port"`
	BackendEndpoint    string        `mapstructure:"backend_endpoint" json:"backend_endpoint"`
	DatabaseURL        string        `mapstructure:"database_url" json:"database_url"`
	GoogleClientID     string        `mapstructure:"google_client_id" json:"google_client_id"`
	GoogleClientSecret string        `mapstructure:"google_client_secret" json:"google_client_secret"`
	AzureClientID      string        `mapstructure:"azure_client_id" json:"azure_client_id"`
	AzureClientSecret  string        `mapstructure:"azure_client_secret" json:"azure_client_secret"`
	AzureTenantID      string        `mapstructure:"azure_tenant_id" json:"azure_tenant_id"`
	TelegramBotToken   string        `mapstructure:"telegram_bot_token" json:"telegram_bot_token"`
	TelegramChatID     string        `mapstructure:"telegram_chat_id" json:"telegram_chat_id"`

	// Screenshot Configuration
	ScreenshotQuality   int `mapstructure:"screenshot_quality" json:"screenshot_quality"`
	ScreenshotMaxWidth  int `mapstructure:"screenshot_max_width" json:"screenshot_max_width"`
	ScreenshotMaxHeight int `mapstructure:"screenshot_max_height" json:"screenshot_max_height"`

	// Feature 8: Privacy & Sensitive Content Protection
	PrivacyModeEnabled bool   `mapstructure:"privacy_mode_enabled" json:"privacy_mode_enabled"`
	PrivacyBlurStyle   string `mapstructure:"privacy_blur_style" json:"privacy_blur_style"`
	PrivacyBlurRadius  int    `mapstructure:"privacy_blur_radius" json:"privacy_blur_radius"`

	// Feature 9: Idle & Away Detection
	IdleDetectionEnabled bool          `mapstructure:"idle_detection_enabled" json:"idle_detection_enabled"`
	IdleThreshold        time.Duration `mapstructure:"idle_threshold_seconds" json:"idle_threshold_seconds"`

	// Feature 5: Smart Distraction Alerts
	DistractionAlertsEnabled      bool          `mapstructure:"distraction_alerts_enabled" json:"distraction_alerts_enabled"`
	DistractionThreshold          time.Duration `mapstructure:"distraction_threshold_seconds" json:"distraction_threshold_seconds"`
	DistractionDisableDuringFocus bool          `mapstructure:"distraction_disable_during_focus" json:"distraction_disable_during_focus"`
	DistractionSoundEnabled       bool          `mapstructure:"distraction_sound_enabled" json:"distraction_sound_enabled"`
	DistractionNativeNotify       bool          `mapstructure:"distraction_native_notify" json:"distraction_native_notify"`
	DistractionInAppToast         bool          `mapstructure:"distraction_in_app_toast" json:"distraction_in_app_toast"`
	DistractionCooldownMinutes    int           `mapstructure:"distraction_cooldown_minutes" json:"distraction_cooldown_minutes"`
}

// Load loads configuration using Viper from config.yaml, .env files, and environment variables.
func Load() (*Config, error) {
	v := viper.New()

	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}

	// 1. Set default values
	v.SetDefault("gemini_model", "models/gemini-3.5-flash-lite")
	v.SetDefault("screenshot_interval_seconds", 30*time.Second)
	v.SetDefault("screenshot_quality", 80)
	v.SetDefault("screenshot_max_width", 1920)
	v.SetDefault("screenshot_max_height", 1080)
	v.SetDefault("ai_analysis_interval_seconds", 3*time.Hour)
	v.SetDefault("backend_port", 8080)
	v.SetDefault("backend_endpoint", "https://minitracker-api.fly.dev")
	v.SetDefault("data_dir", filepath.Join(home, ".local", "share", "get-hike"))
	v.SetDefault("azure_tenant_id", "common")

	// Privacy Defaults
	v.SetDefault("privacy_mode_enabled", true)
	v.SetDefault("privacy_blur_style", "blur")
	v.SetDefault("privacy_blur_radius", 35)

	// Idle Defaults
	v.SetDefault("idle_detection_enabled", true)
	v.SetDefault("idle_threshold_seconds", 5*time.Minute)

	// Distraction Defaults
	v.SetDefault("distraction_alerts_enabled", true)
	v.SetDefault("distraction_threshold_seconds", 15*time.Minute)
	v.SetDefault("distraction_disable_during_focus", false)
	v.SetDefault("distraction_sound_enabled", true)
	v.SetDefault("distraction_native_notify", true)
	v.SetDefault("distraction_in_app_toast", true)
	v.SetDefault("distraction_cooldown_minutes", 15)

	// 2. Load .env files if present (current working directory and config directory)
	loadDotEnv(".env")
	loadDotEnv(filepath.Join(home, ".config", "get-hike", ".env"))

	// 3. Environment Variable Auto-Binding
	v.AutomaticEnv()
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))

	// Bind key environment variable names directly into Viper
	_ = v.BindEnv("database_url", "DATABASE_URL")
	_ = v.BindEnv("gemini_api_key", "GEMINI_API_KEY")
	_ = v.BindEnv("gemini_model", "GEMINI_MODEL")
	_ = v.BindEnv("backend_port", "PORT")
	_ = v.BindEnv("backend_endpoint", "BACKEND_URL")
	_ = v.BindEnv("google_client_id", "GOOGLE_CLIENT_ID")
	_ = v.BindEnv("google_client_secret", "GOOGLE_CLIENT_SECRET")
	_ = v.BindEnv("azure_client_id", "AZURE_CLIENT_ID")
	_ = v.BindEnv("azure_client_secret", "AZURE_CLIENT_SECRET")
	_ = v.BindEnv("azure_tenant_id", "AZURE_TENANT_ID")
	_ = v.BindEnv("data_dir", "DATA_DIR")
	_ = v.BindEnv("screenshot_interval_seconds", "SCREENSHOT_INTERVAL_SECONDS")
	_ = v.BindEnv("screenshot_quality", "SCREENSHOT_QUALITY")
	_ = v.BindEnv("screenshot_max_width", "SCREENSHOT_MAX_WIDTH")
	_ = v.BindEnv("screenshot_max_height", "SCREENSHOT_MAX_HEIGHT")
	_ = v.BindEnv("ai_analysis_interval_seconds", "AI_ANALYSIS_INTERVAL_SECONDS")
	_ = v.BindEnv("telegram_bot_token", "TELEGRAM_BOT_TOKEN")
	_ = v.BindEnv("telegram_chat_id", "TELEGRAM_CHAT_ID")
	_ = v.BindEnv("privacy_mode_enabled", "PRIVACY_MODE_ENABLED")
	_ = v.BindEnv("privacy_blur_style", "PRIVACY_BLUR_STYLE")
	_ = v.BindEnv("privacy_blur_radius", "PRIVACY_BLUR_RADIUS")
	_ = v.BindEnv("idle_detection_enabled", "IDLE_DETECTION_ENABLED")
	_ = v.BindEnv("idle_threshold_seconds", "IDLE_THRESHOLD_SECONDS")
	_ = v.BindEnv("distraction_alerts_enabled", "DISTRACTION_ALERTS_ENABLED")
	_ = v.BindEnv("distraction_threshold_seconds", "DISTRACTION_THRESHOLD_SECONDS")

	// 4. Config file locations for config.yaml / config.json
	v.SetConfigName("config")
	v.SetConfigType("yaml")
	v.AddConfigPath(".")
	v.AddConfigPath(filepath.Join(home, ".config", "get-hike"))
	v.AddConfigPath(home)

	// Attempt reading YAML configuration
	if err := v.ReadInConfig(); err != nil {
		// Fallback to JSON if yaml is not found
		v.SetConfigType("json")
		_ = v.ReadInConfig()
	}

	var cfg Config
	cfg.GeminiAPIKey = v.GetString("gemini_api_key")
	cfg.GeminiModel = v.GetString("gemini_model")
	cfg.DataDir = v.GetString("data_dir")
	cfg.BackendPort = v.GetInt("backend_port")
	if cfg.BackendPort == 0 || cfg.BackendPort == 8080 {
		if p := os.Getenv("BACKEND_PORT"); p != "" {
			if portVal := v.GetInt("backend_port"); portVal == 8080 {
				var parsed int
				for _, c := range p {
					if c >= '0' && c <= '9' {
						parsed = parsed*10 + int(c-'0')
					}
				}
				if parsed > 0 {
					cfg.BackendPort = parsed
				}
			}
		}
	}
	cfg.BackendEndpoint = v.GetString("backend_endpoint")
	if ep := os.Getenv("BACKEND_ENDPOINT"); ep != "" && os.Getenv("BACKEND_URL") == "" && !v.IsSet("backend_endpoint") {
		cfg.BackendEndpoint = ep
	}
	cfg.DatabaseURL = v.GetString("database_url")
	cfg.GoogleClientID = v.GetString("google_client_id")
	cfg.GoogleClientSecret = v.GetString("google_client_secret")
	cfg.AzureClientID = v.GetString("azure_client_id")
	cfg.AzureClientSecret = v.GetString("azure_client_secret")
	cfg.AzureTenantID = v.GetString("azure_tenant_id")
	if cfg.AzureTenantID == "" {
		cfg.AzureTenantID = "common"
	}
	cfg.TelegramBotToken = v.GetString("telegram_bot_token")
	cfg.TelegramChatID = v.GetString("telegram_chat_id")

	cfg.ScreenshotQuality = v.GetInt("screenshot_quality")
	if cfg.ScreenshotQuality < 30 || cfg.ScreenshotQuality > 100 {
		cfg.ScreenshotQuality = 80
	}
	cfg.ScreenshotMaxWidth = v.GetInt("screenshot_max_width")
	if cfg.ScreenshotMaxWidth <= 0 {
		cfg.ScreenshotMaxWidth = 1920
	}
	cfg.ScreenshotMaxHeight = v.GetInt("screenshot_max_height")
	if cfg.ScreenshotMaxHeight <= 0 {
		cfg.ScreenshotMaxHeight = 1080
	}

	cfg.PrivacyModeEnabled = v.GetBool("privacy_mode_enabled")
	cfg.PrivacyBlurStyle = v.GetString("privacy_blur_style")
	cfg.PrivacyBlurRadius = v.GetInt("privacy_blur_radius")
	if cfg.PrivacyBlurRadius <= 0 {
		cfg.PrivacyBlurRadius = 35
	}

	cfg.IdleDetectionEnabled = v.GetBool("idle_detection_enabled")
	cfg.IdleThreshold = v.GetDuration("idle_threshold_seconds")
	if cfg.IdleThreshold <= 0 {
		cfg.IdleThreshold = 5 * time.Minute
	}

	cfg.DistractionAlertsEnabled = v.GetBool("distraction_alerts_enabled")
	cfg.DistractionThreshold = v.GetDuration("distraction_threshold_seconds")
	if cfg.DistractionThreshold <= 0 {
		cfg.DistractionThreshold = 15 * time.Minute
	}
	cfg.DistractionDisableDuringFocus = v.GetBool("distraction_disable_during_focus")
	cfg.DistractionSoundEnabled = v.GetBool("distraction_sound_enabled")
	cfg.DistractionNativeNotify = v.GetBool("distraction_native_notify")
	cfg.DistractionInAppToast = v.GetBool("distraction_in_app_toast")
	cfg.DistractionCooldownMinutes = v.GetInt("distraction_cooldown_minutes")
	if cfg.DistractionCooldownMinutes <= 0 {
		cfg.DistractionCooldownMinutes = 15
	}

	// Helper duration getters with fallback
	dur := v.GetDuration("screenshot_interval_seconds")
	if dur < time.Second {
		if sec := v.GetInt("screenshot_interval_seconds"); sec > 0 {
			dur = time.Duration(sec) * time.Second
		} else {
			dur = 30 * time.Second
		}
	}
	cfg.ScreenshotInterval = dur

	aiDur := v.GetDuration("ai_analysis_interval_seconds")
	if legacy := os.Getenv("AI_ANALYSIS_INTERVAL"); legacy != "" && os.Getenv("AI_ANALYSIS_INTERVAL_SECONDS") == "" {
		if parsed, err := time.ParseDuration(legacy); err == nil && parsed >= time.Second {
			aiDur = parsed
		} else if sec := v.GetInt("ai_analysis_interval"); sec > 0 {
			aiDur = time.Duration(sec) * time.Second
		}
	} else if aiDur < time.Second {
		if sec := v.GetInt("ai_analysis_interval_seconds"); sec > 0 {
			aiDur = time.Duration(sec) * time.Second
		} else {
			aiDur = 3 * time.Hour
		}
	}
	cfg.AIAnalysisInterval = aiDur

	// Ensure DataDir fallback
	if cfg.DataDir == "" || (cfg.DataDir == "/data" && os.Geteuid() != 0) {
		cfg.DataDir = filepath.Join(home, ".local", "share", "get-hike")
	}

	// Ensure required directories exist
	if err := os.MkdirAll(cfg.DataDir, 0755); err != nil && cfg.DataDir != filepath.Join(home, ".local", "share", "get-hike") {
		cfg.DataDir = filepath.Join(home, ".local", "share", "get-hike")
		_ = os.MkdirAll(cfg.DataDir, 0755)
	}
	_ = os.MkdirAll(filepath.Join(home, ".config", "get-hike"), 0755)

	return &cfg, nil
}

// Save writes the config to ~/.config/get-hike/config.yaml using Viper.
func Save(cfg *Config) error {
	v := viper.New()
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	cfgDir := filepath.Join(home, ".config", "get-hike")
	_ = os.MkdirAll(cfgDir, 0755)

	v.Set("gemini_api_key", cfg.GeminiAPIKey)
	v.Set("gemini_model", cfg.GeminiModel)
	v.Set("screenshot_interval_seconds", cfg.ScreenshotInterval.String())
	v.Set("screenshot_quality", cfg.ScreenshotQuality)
	v.Set("screenshot_max_width", cfg.ScreenshotMaxWidth)
	v.Set("screenshot_max_height", cfg.ScreenshotMaxHeight)
	v.Set("ai_analysis_interval_seconds", cfg.AIAnalysisInterval.String())
	v.Set("data_dir", cfg.DataDir)
	v.Set("backend_port", cfg.BackendPort)
	v.Set("backend_endpoint", cfg.BackendEndpoint)
	v.Set("database_url", cfg.DatabaseURL)
	v.Set("google_client_id", cfg.GoogleClientID)
	v.Set("google_client_secret", cfg.GoogleClientSecret)
	v.Set("azure_client_id", cfg.AzureClientID)
	v.Set("azure_client_secret", cfg.AzureClientSecret)
	v.Set("azure_tenant_id", cfg.AzureTenantID)

	v.SetConfigName("config")
	v.SetConfigType("yaml")
	v.SetConfigFile(filepath.Join(cfgDir, "config.yaml"))
	return v.WriteConfig()
}

// loadDotEnv reads a simple .env file without overriding existing env vars.
func loadDotEnv(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	lines := splitLines(string(data))
	for _, line := range lines {
		line = trimSpace(line)
		if line == "" || line[0] == '#' {
			continue
		}
		eq := indexOf(line, '=')
		if eq > 0 {
			key := trimSpace(line[:eq])
			val := trimSpace(line[eq+1:])
			if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
				val = val[1 : len(val)-1]
			}
			if os.Getenv(key) == "" {
				os.Setenv(key, val)
			}
		}
	}
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			line := s[start:i]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			lines = append(lines, line)
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\r' || s[start] == '\n') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\r' || s[end-1] == '\n') {
		end--
	}
	return s[start:end]
}

func indexOf(s string, char byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == char {
			return i
		}
	}
	return -1
}
