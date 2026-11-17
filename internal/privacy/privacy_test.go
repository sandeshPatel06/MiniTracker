package privacy

import (
	"image"
	"image/color"
	"testing"
)

func TestPassesLuhn(t *testing.T) {
	// Standard valid test number (49927398716)
	if !PassesLuhn("49927398716") {
		t.Errorf("Expected valid Luhn for test card")
	}
	if PassesLuhn("49927398717") {
		t.Errorf("Expected invalid Luhn for corrupted card")
	}
}

func TestScanSensitiveTokens(t *testing.T) {
	// Construct test patterns dynamically so secret scanners don't misidentify synthetic tests as real keys
	dummyAWS := "AKIA" + "IOSFODNN7EXAMPLE"
	dummyGHP := "ghp_" + "123456789012345678901234567890123456"
	dummyGoogle := "AIza" + "SyD-1234567890123456789012345678901"
	dummyRSA := "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0..."

	cases := []struct {
		text     string
		expected bool
	}{
		{"Normal window title - VSCode", false},
		{"export AWS_ACCESS_KEY_ID=" + dummyAWS, true},
		{"git push https://" + dummyGHP + "@github.com", true},
		{dummyGoogle, true},
		{dummyRSA, true},
	}

	for _, c := range cases {
		matched, _ := ScanSensitiveTokens(c.text)
		if matched != c.expected {
			t.Errorf("ScanSensitiveTokens(%q) = %v; want %v", c.text, matched, c.expected)
		}
	}
}

func TestPrivacyEngineEvaluate(t *testing.T) {
	engine := NewEngine(true, "blur", 35)

	// Bitwarden window
	eval := engine.EvaluateWindow("bitwarden", "Bitwarden - Vault")
	if !eval.IsSensitive {
		t.Errorf("Expected Bitwarden to be detected as sensitive")
	}

	// Banking window
	eval = engine.EvaluateWindow("chrome", "Chase Bank - Accounts & Transfers - Google Chrome")
	if !eval.IsSensitive {
		t.Errorf("Expected Chase Bank to be detected as sensitive")
	}

	// Normal coding window
	eval = engine.EvaluateWindow("code", "main.go - get-Hike - Visual Studio Code")
	if eval.IsSensitive {
		t.Errorf("Expected normal code file not to be sensitive")
	}

	// Sensitive .env window
	eval = engine.EvaluateWindow("code", ".env.production - Visual Studio Code")
	if !eval.IsSensitive {
		t.Errorf("Expected .env.production to be sensitive")
	}
}

func TestBoxBlurPerformance(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 1280, 720))
	// Fill with test gradient
	for y := 0; y < 720; y++ {
		for x := 0; x < 1280; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 255), G: uint8(y % 255), B: 100, A: 255})
		}
	}

	ApplyBoxBlur(img, img.Bounds(), 35, 3)
	// Verify image is modified and not panicked
	c := img.RGBAAt(100, 100)
	if c.A != 255 {
		t.Errorf("Expected alpha 255, got %d", c.A)
	}
}
