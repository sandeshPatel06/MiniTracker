package privacy

import (
	"fmt"
	"image"
	"image/color"
	"math/rand"
	"strings"
	"sync"
	"testing"
)

// TestComprehensivePatternScanner tests all regexes and Luhn card validation thoroughly.
func TestComprehensivePatternScanner(t *testing.T) {
	// Construct test patterns dynamically so remote Git secret scanners do not flag synthetic test fixtures
	dummyAKIA := "AKIA" + "1234567890ABCDEF"
	dummyA3T := "A3TA" + "1234567890ABCDEF"
	dummyASIA := "ASIA" + "0123456789ABCDEF"
	dummyGHP := "ghp_" + "123456789012345678901234567890123456"
	dummyGHU := "ghu_" + "ABCDefghij1234567890ABCDefghij123456"
	dummyGHO := "gho_" + "123456789012345678901234567890123456"
	dummyGoogle := "AIza" + "SyD-1234567890123456789012345678901"
	dummyStripeLive := "sk_" + "live_" + strings.Repeat("a", 24)
	dummyStripeTest := "sk_" + "test_" + strings.Repeat("b", 24)
	dummyStripeRestricted := "rk_" + "live_" + strings.Repeat("c", 24)
	dummyStripePub := "pk_" + "live_" + strings.Repeat("d", 24)
	dummyRSA := "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0..."
	dummyEC := "-----BEGIN " + "EC PRIVATE KEY-----"
	dummyOpenSSH := "-----BEGIN " + "OPENSSH PRIVATE KEY-----"
	dummyGenericPriv := "-----BEGIN " + "PRIVATE KEY-----"
	dummyJWT := "eyJhbGciOi" + "JIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"

	testCases := []struct {
		name       string
		input      string
		wantDetect bool
		wantReason string
	}{
		// AWS keys
		{"AWS Standard AKIA", "Exported " + dummyAKIA + " key", true, "AWS Access Key Detected"},
		{"AWS A3T key", dummyA3T, true, "AWS Access Key Detected"},
		{"AWS ASIA temporary key", dummyASIA, true, "AWS Access Key Detected"},
		{"AWS key too short", "AKIA12345", false, ""},

		// GitHub Personal Access Tokens
		{"GitHub Classic PAT ghp", dummyGHP, true, "GitHub Personal Access Token Detected"},
		{"GitHub Fine-grained PAT ghu", dummyGHU, true, "GitHub Personal Access Token Detected"},
		{"GitHub OAuth gho", dummyGHO, true, "GitHub Personal Access Token Detected"},
		{"GitHub Short PAT invalid", "ghp_short", false, ""},

		// Google API Keys
		{"Google API Key AIza", dummyGoogle, true, "Google API Key Detected"},
		{"Google API Key short", "AIza1234", false, ""},

		// Stripe Keys
		{"Stripe Live Secret Key", dummyStripeLive, true, "Stripe API Key Detected"},
		{"Stripe Test Secret Key", dummyStripeTest, true, "Stripe API Key Detected"},
		{"Stripe Restricted Key", dummyStripeRestricted, true, "Stripe API Key Detected"},
		{"Stripe Invalid Prefix", dummyStripePub, false, ""}, // publishable keys aren't secret

		// Private Keys
		{"RSA Private Key", dummyRSA, true, "Cryptographic Private Key Detected"},
		{"EC Private Key", dummyEC, true, "Cryptographic Private Key Detected"},
		{"OpenSSH Private Key", dummyOpenSSH, true, "Cryptographic Private Key Detected"},
		{"Generic Private Key", dummyGenericPriv, true, "Cryptographic Private Key Detected"},
		{"Public Key Not Detected", "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq...", false, ""},

		// JWT Tokens
		{"JWT Bearer Token", dummyJWT, true, "JWT Auth Token Detected"},
		{"Invalid JWT structure", "eyJhbGciOiJIUzI1NiI.onlytwo", false, ""},

		// Credit Cards with Luhn Check
		{"Valid Visa Luhn", "4311 0876 8329 8494", true, "Payment Card Number Detected"},
		{"Valid Mastercard Luhn", "5044-3190-7538-6350", true, "Payment Card Number Detected"},
		{"Valid Amex Luhn", "3782 822463 10005", true, "Payment Card Number Detected"},
		{"Corrupt Luhn Checksum", "4311 0876 8329 8495", false, ""},
		{"Arbitrary 16 digits failing Luhn", "1234 5678 9012 3456", false, ""},

		// Clean / safe strings
		{"Empty string", "", false, ""},
		{"Normal code editor text", "func CalculateTotal(items []Item) float64 { return 0 }", false, ""},
		{"Normal terminal prompt", "user@hostname:~/projects/get-hike$ git status", false, ""},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			matched, reason := ScanSensitiveTokens(tc.input)
			if matched != tc.wantDetect {
				t.Fatalf("ScanSensitiveTokens(%q) matched=%v, want=%v", tc.input, matched, tc.wantDetect)
			}
			if matched && reason != tc.wantReason {
				t.Errorf("ScanSensitiveTokens(%q) reason=%q, want=%q", tc.input, reason, tc.wantReason)
			}
		})
	}
}

// TestRedactSensitiveTitle checks redacting and cleaning sensitive window titles.
func TestRedactSensitiveTitle(t *testing.T) {
	cases := []struct {
		title    string
		expected string
	}{
		{"", ""},
		{"Bitwarden - Master Password Vault", "🔒 [Password / Vault Window]"},
		{"Chase Online Banking - Account Summary", "🔒 [Financial / Banking Portal]"},
		{"Google Chrome (Incognito)", "🔒 [Private / Incognito Session]"},
		{"Tor Browser - Onion", "🔒 [Private / Incognito Session]"},
		{"vim .env.production", "🔒 [Protected Credentials File]"},
		{"nano ~/.ssh/id_rsa", "🔒 [Protected Credentials File]"},
		{"Visual Studio Code - main.go", "Visual Studio Code - main.go"},
		{"   Slack - General Channel   ", "Slack - General Channel"},
	}

	for _, c := range cases {
		got := RedactSensitiveTitle(c.title)
		if got != c.expected {
			t.Errorf("RedactSensitiveTitle(%q) = %q, want %q", c.title, got, c.expected)
		}
	}
}

// TestEvaluateWindowEdgeCases tests empty titles, unicode characters, giant strings, and regex edge cases.
func TestEvaluateWindowEdgeCases(t *testing.T) {
	engine := NewEngine(true, "blur", 35)

	// Case 1: Empty app & title
	res := engine.EvaluateWindow("", "")
	if res.IsSensitive {
		t.Errorf("Expected empty window to not be sensitive, got %+v", res)
	}

	// Case 2: Whitespace only
	res = engine.EvaluateWindow("   ", "   \t\n  ")
	if res.IsSensitive {
		t.Errorf("Expected whitespace window to not be sensitive, got %+v", res)
	}

	// Case 3: Huge string (100,000 characters) - should not crash or hang
	hugeStr := strings.Repeat("A", 100000)
	res = engine.EvaluateWindow(hugeStr, hugeStr)
	if res.IsSensitive {
		t.Errorf("Expected giant random string not to be sensitive")
	}

	// Huge string with sensitive secret embedded in middle
	dummyStripeKey := "sk_" + "live_" + strings.Repeat("x", 24)
	hugeWithSecret := hugeStr + " " + dummyStripeKey + " " + hugeStr
	res = engine.EvaluateWindow("term", hugeWithSecret)
	if !res.IsSensitive || res.Reason != "Stripe API Key Detected" {
		t.Errorf("Failed to detect sensitive key inside huge string: %+v", res)
	}

	// Case 4: Special Unicode and emoji titles
	res = engine.EvaluateWindow("browser", "🔒 🔑 1Password — Unlock Vault")
	if !res.IsSensitive {
		t.Errorf("Expected unicode title containing 1password to be sensitive")
	}

	res = engine.EvaluateWindow("firefox", "🚀 Привет мир! 日本語 🏦 bank of america")
	if !res.IsSensitive {
		t.Errorf("Expected unicode banking title to be sensitive")
	}
}

// TestCustomUserRules tests custom user rules including active/inactive flags, app rules, and malformed regex.
func TestCustomUserRules(t *testing.T) {
	engine := NewEngine(true, "blur", 30)

	rules := []UserPrivacyRule{
		{
			ID:        1,
			RuleType:  "app",
			Pattern:   "telegram",
			Action:    ActionShield,
			Desc:      "Protect Telegram chat",
			IsActive:  true,
			IsBuiltIn: false,
		},
		{
			ID:        2,
			RuleType:  "title_regex",
			Pattern:   `\[CONFIDENTIAL\]`,
			Action:    ActionSkip,
			Desc:      "Confidential documents",
			IsActive:  true,
			IsBuiltIn: false,
		},
		{
			ID:        3,
			RuleType:  "title_regex",
			Pattern:   `[invalid(regex`, // Malformed regex should be handled safely and not crash
			Action:    ActionBlur,
			Desc:      "Broken regex rule",
			IsActive:  true,
			IsBuiltIn: false,
		},
		{
			ID:        4,
			RuleType:  "app",
			Pattern:   "slack",
			Action:    ActionShield,
			Desc:      "Inactive rule should not trigger",
			IsActive:  false,
			IsBuiltIn: false,
		},
	}
	engine.SetCustomRules(rules)

	// App rule match (Telegram -> ActionShield)
	res := engine.EvaluateWindow("telegram-desktop", "Chat with John")
	if !res.IsSensitive || res.Action != ActionShield {
		t.Errorf("Telegram app should trigger ActionShield, got %+v", res)
	}

	// Title regex match (Confidential -> ActionSkip)
	res = engine.EvaluateWindow("pdf-viewer", "Q3 Report [CONFIDENTIAL] - Adobe Acrobat")
	if !res.IsSensitive || res.Action != ActionSkip {
		t.Errorf("Confidential title should trigger ActionSkip, got %+v", res)
	}

	// Inactive rule should not trigger
	res = engine.EvaluateWindow("slack", "Random Channel")
	if res.IsSensitive {
		t.Errorf("Inactive slack rule triggered unexpectedly: %+v", res)
	}

	// Malformed regex should safely be ignored without crashing or false-triggering
	res = engine.EvaluateWindow("terminal", "just testing [invalid(regex")
	if res.IsSensitive {
		t.Errorf("Malformed regex triggered or crashed: %+v", res)
	}
}

// TestEngineActionStyles tests blur, shield, and skip action configurations.
func TestEngineActionStyles(t *testing.T) {
	engine := NewEngine(true, "blur", 25)

	res := engine.EvaluateWindow("chrome", "Wells Fargo Banking")
	if res.Action != ActionBlur {
		t.Errorf("Expected ActionBlur, got %v", res.Action)
	}

	engine.SetConfig(true, "shield", 40)
	res = engine.EvaluateWindow("chrome", "Wells Fargo Banking")
	if res.Action != ActionShield {
		t.Errorf("Expected ActionShield, got %v", res.Action)
	}
	if res.BlurRadius != 40 {
		t.Errorf("Expected BlurRadius 40, got %d", res.BlurRadius)
	}

	engine.SetConfig(true, "skip", 40)
	res = engine.EvaluateWindow("chrome", "Wells Fargo Banking")
	if res.Action != ActionSkip {
		t.Errorf("Expected ActionSkip, got %v", res.Action)
	}

	// Disable engine
	engine.SetEnabled(false)
	if engine.IsEnabled() {
		t.Errorf("Expected engine to report disabled")
	}
	res = engine.EvaluateWindow("chrome", "Wells Fargo Banking")
	if res.IsSensitive {
		t.Errorf("Expected disabled engine to return IsSensitive=false")
	}
}

// TestImageBlurringAndFrostedShield verifies pixels are altered and blurred as expected.
func TestImageBlurringAndFrostedShield(t *testing.T) {
	// 1. Box Blur on high-contrast pattern
	w, h := 100, 100
	img := image.NewRGBA(image.Rect(0, 0, w, h))

	// Left half pure black, right half pure white
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if x < 50 {
				img.SetRGBA(x, y, color.RGBA{R: 0, G: 0, B: 0, A: 255})
			} else {
				img.SetRGBA(x, y, color.RGBA{R: 255, G: 255, B: 255, A: 255})
			}
		}
	}

	// Check boundary pixels before blur
	pxBefore49 := img.RGBAAt(49, 50)
	pxBefore50 := img.RGBAAt(50, 50)
	if pxBefore49.R != 0 || pxBefore50.R != 255 {
		t.Fatalf("Pre-blur setup failed")
	}

	ApplyBoxBlur(img, img.Bounds(), 10, 3)

	pxAfter49 := img.RGBAAt(49, 50)
	pxAfter50 := img.RGBAAt(50, 50)

	// Due to blur, 49 and 50 should be blended close to mid-gray (~120-135)
	if pxAfter49.R < 80 || pxAfter49.R > 180 {
		t.Errorf("Expected blurred pixel 49 to be mid-gray, got %d", pxAfter49.R)
	}
	if pxAfter50.R < 80 || pxAfter50.R > 180 {
		t.Errorf("Expected blurred pixel 50 to be mid-gray, got %d", pxAfter50.R)
	}

	// 2. Test Box Blur with edge cases (empty bounds, radius <= 0, small dimensions)
	zeroImg := image.NewRGBA(image.Rect(0, 0, 1, 1))
	ApplyBoxBlur(zeroImg, zeroImg.Bounds(), 10, 3) // w<=1, h<=1 should return cleanly

	emptyRect := image.Rectangle{}
	ApplyBoxBlur(img, emptyRect, 10, 3) // empty rect should return cleanly
	ApplyBoxBlur(img, img.Bounds(), 0, 3) // radius 0 should return cleanly
	ApplyBoxBlur(img, img.Bounds(), 10, 0) // passes 0 should return cleanly

	// 3. Test Frosted Shield overlay
	shieldImg := image.NewRGBA(image.Rect(0, 0, 400, 300))
	// Fill with solid white
	for y := 0; y < 300; y++ {
		for x := 0; x < 400; x++ {
			shieldImg.SetRGBA(x, y, color.RGBA{R: 255, G: 255, B: 255, A: 255})
		}
	}

	ApplyFrostedShield(shieldImg, "Banking Portal Detected")

	// Verify top area darkened by semi-transparent slate banner
	cornerPx := shieldImg.RGBAAt(10, 10)
	if cornerPx.R > 100 || cornerPx.G > 100 || cornerPx.B > 100 {
		t.Errorf("Expected frosted overlay to darken image, got %+v", cornerPx)
	}

	// Verify center banner strip area is rendered
	centerPx := shieldImg.RGBAAt(200, 150)
	if centerPx.R > 100 || centerPx.G > 100 || centerPx.B > 100 {
		t.Errorf("Expected badge strip to be dark slate, got %+v", centerPx)
	}
}

// TestProcessImageEngineIntegration tests engine.ProcessImage with ActionBlur, ActionShield, ActionSkip.
func TestProcessImageEngineIntegration(t *testing.T) {
	engine := NewEngine(true, "blur", 15)

	img := image.NewRGBA(image.Rect(0, 0, 200, 200))
	for y := 0; y < 200; y++ {
		for x := 0; x < 200; x++ {
			img.SetRGBA(x, y, color.RGBA{R: 200, G: 100, B: 50, A: 255})
		}
	}

	// 1. ProcessImage with nil or non-sensitive
	engine.ProcessImage(img, EvaluationResult{IsSensitive: false})
	if px := img.RGBAAt(50, 50); px.R != 200 {
		t.Errorf("Non-sensitive evaluation should not modify image, got %d", px.R)
	}

	engine.ProcessImage(nil, EvaluationResult{IsSensitive: true, Action: ActionBlur}) // Should not panic

	// 2. ProcessImage with ActionShield
	engine.ProcessImage(img, EvaluationResult{
		IsSensitive: true,
		Action:      ActionShield,
		Reason:      "Password vault",
	})
	if px := img.RGBAAt(50, 50); px.R == 200 {
		t.Errorf("Shield did not modify image pixel")
	}

	// 3. ProcessImage with ActionSkip (does not crash or modify)
	engine.ProcessImage(img, EvaluationResult{
		IsSensitive: true,
		Action:      ActionSkip,
	})
}

// TestConcurrencyAndRaceConditions tests concurrent execution of EvaluateWindow, SetConfig, SetCustomRules, and ProcessImage.
func TestConcurrencyAndRaceConditions(t *testing.T) {
	dummyAKIA := "AKIA" + "IOSFODNN7EXAMPLE"
	engine := NewEngine(true, "blur", 35)

	var wg sync.WaitGroup
	workers := 16
	iterations := 200

	// Concurrent Evaluators
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			titles := []string{
				"Code - get-hike",
				"Chase Bank - Accounts",
				"Bitwarden Vault",
				"Terminal - AWS_ACCESS_KEY_ID=" + dummyAKIA,
				"Slack - #random",
				".env.local - Editor",
			}
			apps := []string{"code", "chrome", "bitwarden", "bash", "slack"}

			for j := 0; j < iterations; j++ {
				title := titles[(workerID+j)%len(titles)]
				app := apps[(workerID+j)%len(apps)]
				eval := engine.EvaluateWindow(app, title)
				if eval.IsSensitive && eval.BlurRadius <= 0 {
					t.Errorf("Expected valid blur radius in eval result")
				}
			}
		}(i)
	}

	// Concurrent Config & Rule Updaters
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			styles := []string{"blur", "shield", "skip"}
			for j := 0; j < iterations; j++ {
				style := styles[j%len(styles)]
				radius := 10 + (j % 50)
				engine.SetConfig(j%2 == 0, style, radius)

				if j%10 == 0 {
					engine.SetCustomRules([]UserPrivacyRule{
						{
							ID:       int64(j),
							RuleType: "app",
							Pattern:  fmt.Sprintf("app_%d", j),
							Action:   ActionShield,
							IsActive: true,
						},
					})
				}
			}
		}(i)
	}

	// Concurrent Image Processors
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				testImg := image.NewRGBA(image.Rect(0, 0, 64, 64))
				eval := EvaluationResult{
					IsSensitive: true,
					Action:      ActionBlur,
					BlurRadius:  10,
				}
				engine.ProcessImage(testImg, eval)
			}
		}(i)
	}

	wg.Wait()
}

// TestMultiMonitorDisplayBounds verifies blur and shield operations across non-zero rectangle bounds.
func TestMultiMonitorDisplayBounds(t *testing.T) {
	// A combined multi-monitor canvas spanning 3840x1080 (e.g. dual 1920x1080 monitors side by side)
	totalW, totalH := 3840, 1080
	canvas := image.NewRGBA(image.Rect(0, 0, totalW, totalH))

	// Paint monitor 1 (0 to 1920) with red, monitor 2 (1920 to 3840) with blue
	for y := 0; y < totalH; y++ {
		for x := 0; x < 1920; x++ {
			canvas.SetRGBA(x, y, color.RGBA{R: 255, G: 0, B: 0, A: 255})
		}
		for x := 1920; x < totalW; x++ {
			canvas.SetRGBA(x, y, color.RGBA{R: 0, G: 0, B: 255, A: 255})
		}
	}

	// Apply box blur only to Monitor 2's bounding rect
	monitor2Rect := image.Rect(1920, 0, 3840, 1080)
	ApplyBoxBlur(canvas, monitor2Rect, 15, 2)

	// Verify monitor 1 (unblurred) is intact
	pxM1 := canvas.RGBAAt(100, 100)
	if pxM1.R != 255 || pxM1.G != 0 || pxM1.B != 0 {
		t.Errorf("Monitor 1 was affected by Monitor 2 blur: %+v", pxM1)
	}

	// Apply Box Blur with bounding box that partially overflows image bounds
	overflowRect := image.Rect(3000, 500, 4500, 1200)
	ApplyBoxBlur(canvas, overflowRect, 10, 1) // Must clamp and not panic or index out of range
}

// BenchmarkBoxBlur benchmarks the box blur performance on 720p image.
func BenchmarkBoxBlur(b *testing.B) {
	img := image.NewRGBA(image.Rect(0, 0, 1280, 720))
	for i := 0; i < len(img.Pix); i++ {
		img.Pix[i] = uint8(rand.Intn(256))
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ApplyBoxBlur(img, img.Bounds(), 35, 3)
	}
}
