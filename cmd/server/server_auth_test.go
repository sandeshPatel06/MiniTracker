package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/reak/get-hike/internal/db"
)

func TestAuthSecurityAndRegistrationFlow(t *testing.T) {
	tmpDir := t.TempDir()
	database, err := db.Open(tmpDir)
	if err != nil {
		t.Fatalf("failed to init db: %v", err)
	}
	defer database.Close()

	// 1. Test generateNumericOTP and hashOTP
	otp, err := generateNumericOTP()
	if err != nil {
		t.Fatalf("generateNumericOTP failed: %v", err)
	}
	if len(otp) != 6 {
		t.Fatalf("expected 6-digit OTP, got %s", otp)
	}
	h1 := hashOTP(otp)
	h2 := hashOTP(otp)
	if h1 != h2 || len(h1) != 64 {
		t.Errorf("expected deterministic sha256 hex OTP hash, got: %s", h1)
	}

	// 2. Test persistent JWT secret fallback
	secret := loadJWTSecret()
	if len(secret) < 32 {
		t.Errorf("expected secret length >= 32 bytes, got %d", len(secret))
	}
	secret2 := loadJWTSecret()
	if string(secret) != string(secret2) {
		t.Errorf("expected persistent secret to remain consistent across calls")
	}

	// 3. Test isLoopbackRequest security against spoofed headers
	reqLocal, _ := http.NewRequest("GET", "/api/tracker/status", nil)
	reqLocal.RemoteAddr = "127.0.0.1:45123"
	if !isLoopbackRequest(reqLocal) {
		t.Errorf("expected genuine 127.0.0.1 request to be loopback")
	}

	// Hostile external header injection over proxy
	reqProxyFly, _ := http.NewRequest("GET", "/api/tracker/status", nil)
	reqProxyFly.RemoteAddr = "127.0.0.1:45123"
	reqProxyFly.Header.Set("Fly-Client-IP", "203.0.113.195")
	if isLoopbackRequest(reqProxyFly) {
		t.Errorf("Fly-Client-IP should prevent loopback bypass")
	}

	reqProxyCF, _ := http.NewRequest("GET", "/api/tracker/status", nil)
	reqProxyCF.RemoteAddr = "127.0.0.1:45123"
	reqProxyCF.Header.Set("CF-Connecting-IP", "198.51.100.2")
	if isLoopbackRequest(reqProxyCF) {
		t.Errorf("CF-Connecting-IP should prevent loopback bypass")
	}

	reqProxyXFF, _ := http.NewRequest("GET", "/api/tracker/status", nil)
	reqProxyXFF.RemoteAddr = "127.0.0.1:45123"
	reqProxyXFF.Header.Set("X-Forwarded-For", "203.0.113.50, 10.0.0.1")
	if isLoopbackRequest(reqProxyXFF) {
		t.Errorf("X-Forwarded-For with external IP should prevent loopback bypass")
	}

	// 4. Test isSecureRequest detection
	reqPlain, _ := http.NewRequest("POST", "/api/auth/login", nil)
	if isSecureRequest(reqPlain) {
		t.Errorf("expected plain HTTP request to be not secure")
	}
	reqTLS, _ := http.NewRequest("POST", "/api/auth/login", nil)
	reqTLS.Header.Set("X-Forwarded-Proto", "https")
	if !isSecureRequest(reqTLS) {
		t.Errorf("expected X-Forwarded-Proto: https to be detected as secure")
	}

	// 5. Test setJWTTokenCookie sets HttpOnly, SameSite=Lax, Secure
	rec := httptest.NewRecorder()
	u := &db.User{ID: 10, Email: "test@example.com", Role: "member", OrgID: 1}
	tok := setJWTTokenCookie(rec, u, true)
	if tok == "" {
		t.Fatalf("expected non-empty JWT token")
	}
	respCookies := rec.Result().Cookies()
	var sessionCookie *http.Cookie
	for _, c := range respCookies {
		if c.Name == "mini_session_jwt" {
			sessionCookie = c
			break
		}
	}
	if sessionCookie == nil {
		t.Fatalf("session cookie not found in response")
	}
	if !sessionCookie.HttpOnly {
		t.Errorf("expected cookie to have HttpOnly = true")
	}
	if !sessionCookie.Secure {
		t.Errorf("expected cookie to have Secure = true on HTTPS")
	}
	if sessionCookie.SameSite != http.SameSiteLaxMode {
		t.Errorf("expected cookie SameSite = Lax")
	}

	// 6. Test Store & Verify Registration OTP Flow
	testEmail := "audit-flow@example.com"
	rawOTP := "482910"
	payload := `{"name":"Audit Corp","email":"audit-flow@example.com","password":"hashedpassword123","full_name":"Auditor"}`
	expires := time.Now().Add(10 * time.Minute)

	err = database.StoreEmailVerification(testEmail, hashOTP(rawOTP), payload, expires)
	if err != nil {
		t.Fatalf("failed to store email verification: %v", err)
	}

	ev, err := database.GetEmailVerification(testEmail)
	if err != nil {
		t.Fatalf("failed to get email verification: %v", err)
	}
	if ev.OTPHash != hashOTP(rawOTP) {
		t.Errorf("mismatched OTP hash")
	}

	// Verify increment attempts on failed match
	_ = database.IncrementVerificationAttempts(testEmail)
	evAfter, _ := database.GetEmailVerification(testEmail)
	if evAfter.Attempts != 1 {
		t.Errorf("expected 1 attempt, got %d", evAfter.Attempts)
	}

	// Verify cleanup
	_ = database.DeleteEmailVerification(testEmail)
	evDeleted, _ := database.GetEmailVerification(testEmail)
	if evDeleted != nil {
		t.Errorf("expected nil after delete, got %+v", evDeleted)
	}
}
