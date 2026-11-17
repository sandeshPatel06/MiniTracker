package ai

import (
	"strings"
	"testing"
)

func TestParseGeminiResponse(t *testing.T) {
	jsonResp := `{
		"candidates": [
			{
				"content": {
					"parts": [
						{
							"text": "{\"category\": \"Coding\", \"productive\": true, \"confidence\": 0.9, \"brief_reason\": \"Writing Go code\"}"
						}
					]
				}
			}
		]
	}`

	res, err := parseGeminiResponse(strings.NewReader(jsonResp))
	if err != nil {
		t.Fatalf("parseGeminiResponse failed: %v", err)
	}

	if res.Category != "Coding" {
		t.Errorf("expected category Coding, got %s", res.Category)
	}
	if !res.Productive {
		t.Errorf("expected productive true, got false")
	}
	if res.Confidence != 0.9 {
		t.Errorf("expected confidence 0.9, got %f", res.Confidence)
	}
	if res.Reason != "Writing Go code" {
		t.Errorf("expected reason 'Writing Go code', got %s", res.Reason)
	}
}

func TestBuildGeminiRequest(t *testing.T) {
	req := buildGeminiRequest("test prompt", "base64data")
	contents, ok := req["contents"].([]map[string]interface{})
	if !ok || len(contents) == 0 {
		t.Fatalf("invalid request contents structure")
	}
}

func TestRedactAPIKey(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "query param key at start",
			input:    "https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyD-abc1234XYZ",
			expected: "https://generativelanguage.googleapis.com/v1beta/models?key=REDACTED",
		},
		{
			name:     "query param key in middle",
			input:    "https://example.com/api?foo=bar&key=secret123&baz=qux",
			expected: "https://example.com/api?foo=bar&key=REDACTED&baz=qux",
		},
		{
			name:     "x-goog-api-key header format",
			input:    `Request failed: x-goog-api-key: "AIzaSyD_XYZ987" with 403 Forbidden`,
			expected: `Request failed: x-goog-api-key: "REDACTED" with 403 Forbidden`,
		},
		{
			name:     "no key present",
			input:    "connection refused: 127.0.0.1:8080",
			expected: "connection refused: 127.0.0.1:8080",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := redactAPIKey(tt.input)
			if got != tt.expected {
				t.Errorf("redactAPIKey(%q) = %q, want %q", tt.input, got, tt.expected)
			}
		})
	}
}
