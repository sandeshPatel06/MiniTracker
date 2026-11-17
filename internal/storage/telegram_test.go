package storage

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSanitizeCaption(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "regular caption",
			input:    "MiniTracker screenshot 2026-11-17",
			expected: "MiniTracker screenshot 2026-11-17",
		},
		{
			name:     "caption with null bytes and control chars",
			input:    "Bad\x00String\x07With\x1bControl\nChars",
			expected: "BadStringWithControl\nChars",
		},
		{
			name:     "caption exceeding max length",
			input:    strings.Repeat("a", 1500),
			expected: strings.Repeat("a", 1024),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeCaption(tt.input)
			if got != tt.expected {
				t.Errorf("sanitizeCaption() len %d, want len %d", len(got), len(tt.expected))
			}
		})
	}
}

func TestUploadPhotoEmptyPayload(t *testing.T) {
	tg := NewTelegramStorage("fake-token", "12345")
	if tg == nil {
		t.Fatal("expected non-nil tg storage")
	}

	_, err := tg.UploadPhoto(context.Background(), nil, "test")
	if err == nil {
		t.Fatal("expected error on empty payload, got nil")
	}
}

func TestUploadPhotoSuccessAndCache(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/sendPhoto") {
			resp := map[string]interface{}{
				"ok": true,
				"result": map[string]interface{}{
					"photo": []map[string]interface{}{
						{
							"file_id":   "test_file_id_123",
							"width":     800,
							"height":    600,
							"file_size": 1234,
						},
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	tg := &TelegramStorage{
		botToken:   "fake-token",
		chatID:     "12345",
		httpClient: ts.Client(),
		cache:      make(map[string][]byte),
	}

	// Override URL in a test context or replace client transport to rewrite URL
	// Since Telegram API URL is hardcoded to api.telegram.org, let's verify custom client transport
	customClient := ts.Client()
	customClient.Transport = &rewriteTransport{targetURL: ts.URL}
	tg.httpClient = customClient

	imgData := []byte("fake-jpeg-data")
	res, err := tg.UploadPhoto(context.Background(), imgData, "sample caption")
	if err != nil {
		t.Fatalf("UploadPhoto failed: %v", err)
	}

	if res != "tg://test_file_id_123" {
		t.Fatalf("expected tg://test_file_id_123, got %s", res)
	}

	// Verify cached
	cached, err := tg.GetPhotoBytes(context.Background(), "test_file_id_123")
	if err != nil {
		t.Fatalf("GetPhotoBytes failed: %v", err)
	}
	if string(cached) != string(imgData) {
		t.Fatalf("expected cached data %q, got %q", string(imgData), string(cached))
	}
}

func TestUploadPhotoRateLimitRetry(t *testing.T) {
	attempts := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"ok":false,"error_code":429,"parameters":{"retry_after":1}}`))
			return
		}
		resp := map[string]interface{}{
			"ok": true,
			"result": map[string]interface{}{
				"photo": []map[string]interface{}{
					{"file_id": "file_after_retry", "width": 100, "height": 100, "file_size": 50},
				},
			},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer ts.Close()

	tg := &TelegramStorage{
		botToken:   "fake-token",
		chatID:     "12345",
		httpClient: &http.Client{Transport: &rewriteTransport{targetURL: ts.URL}, Timeout: 5 * time.Second},
		cache:      make(map[string][]byte),
	}

	res, err := tg.UploadPhoto(context.Background(), []byte("data"), "caption")
	if err != nil {
		t.Fatalf("UploadPhoto failed after retry: %v", err)
	}
	if res != "tg://file_after_retry" {
		t.Fatalf("expected tg://file_after_retry, got %s", res)
	}
	if attempts < 2 {
		t.Fatalf("expected at least 2 attempts, got %d", attempts)
	}
}

type rewriteTransport struct {
	targetURL string
}

func (r *rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	target, _ := http.NewRequest(req.Method, r.targetURL+req.URL.Path, req.Body)
	target.Header = req.Header
	return http.DefaultTransport.RoundTrip(target)
}
