package config

import (
	"os"
	"testing"
	"time"
)

func TestLoadConfig(t *testing.T) {
	os.Setenv("GEMINI_API_KEY", "test-key-123")
	defer os.Unsetenv("GEMINI_API_KEY")
	os.Setenv("SCREENSHOT_INTERVAL_SECONDS", "30s")
	defer os.Unsetenv("SCREENSHOT_INTERVAL_SECONDS")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if cfg.GeminiAPIKey != "test-key-123" {
		t.Errorf("expected GeminiAPIKey to be test-key-123, got %s", cfg.GeminiAPIKey)
	}
	if cfg.ScreenshotInterval != 30*time.Second {
		t.Errorf("expected ScreenshotInterval to be 30s, got %v", cfg.ScreenshotInterval)
	}
}

func TestEnvVarFallbacks(t *testing.T) {
	// Test legacy BACKEND_PORT fallback when PORT is unset
	os.Unsetenv("PORT")
	os.Setenv("BACKEND_PORT", "9090")
	defer os.Unsetenv("BACKEND_PORT")

	// Test legacy BACKEND_ENDPOINT fallback when BACKEND_URL is unset
	os.Unsetenv("BACKEND_URL")
	os.Setenv("BACKEND_ENDPOINT", "https://custom-api.example.com")
	defer os.Unsetenv("BACKEND_ENDPOINT")

	// Test legacy AI_ANALYSIS_INTERVAL fallback
	os.Unsetenv("AI_ANALYSIS_INTERVAL_SECONDS")
	os.Setenv("AI_ANALYSIS_INTERVAL", "15m")
	defer os.Unsetenv("AI_ANALYSIS_INTERVAL")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if cfg.BackendPort != 9090 {
		t.Errorf("expected BackendPort to fall back to BACKEND_PORT 9090, got %d", cfg.BackendPort)
	}
	if cfg.BackendEndpoint != "https://custom-api.example.com" {
		t.Errorf("expected BackendEndpoint to fall back to BACKEND_ENDPOINT, got %s", cfg.BackendEndpoint)
	}
	if cfg.AIAnalysisInterval != 15*time.Minute {
		t.Errorf("expected AIAnalysisInterval to fall back to AI_ANALYSIS_INTERVAL 15m, got %v", cfg.AIAnalysisInterval)
	}
}
