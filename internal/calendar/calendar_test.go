package calendar_test

import (
	"crypto/rand"
	"encoding/base64"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/reak/get-hike/internal/calendar"
)

func TestEncryptDecryptRoundTrip(t *testing.T) {
	testCases := []struct {
		name      string
		plaintext string
	}{
		{"empty string", ""},
		{"simple string", "hello world token 12345"},
		{"json oauth token", `{"access_token":"ya29.a0AfH6SM...","refresh_token":"1//0gXYZ...","token_type":"Bearer","expiry":"2026-11-17T12:00:00Z"}`},
		{"unicode and symbols", "OAuth🔑Token: 日本語 & Special %$#@!*&^~`"},
		{"long token string", strings.Repeat("A-Very-Long-Auth-Token-Segment-1234567890", 50)},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ciphertext, err := calendar.EncryptToken(tc.plaintext)
			if err != nil {
				t.Fatalf("EncryptToken failed: %v", err)
			}

			if tc.plaintext == "" {
				if ciphertext != "" {
					t.Fatalf("expected empty ciphertext for empty input, got %q", ciphertext)
				}
			} else {
				if ciphertext == tc.plaintext {
					t.Fatalf("ciphertext matches plaintext; encryption did not happen")
				}
			}

			decrypted, err := calendar.DecryptToken(ciphertext)
			if err != nil {
				t.Fatalf("DecryptToken failed: %v", err)
			}

			if decrypted != tc.plaintext {
				t.Fatalf("round-trip mismatch: got %q, want %q", decrypted, tc.plaintext)
			}
		})
	}
}

func TestCorruptedAndInvalidCiphertexts(t *testing.T) {
	t.Run("empty string returns empty", func(t *testing.T) {
		res, err := calendar.DecryptToken("")
		if err != nil {
			t.Fatalf("unexpected error for empty string: %v", err)
		}
		if res != "" {
			t.Fatalf("expected empty string, got %q", res)
		}
	})

	t.Run("invalid base64", func(t *testing.T) {
		_, err := calendar.DecryptToken("not-valid-base64!@#$%")
		if err == nil {
			t.Fatal("expected error for non-base64 ciphertext, got nil")
		}
	})

	t.Run("too short ciphertext (less than nonce)", func(t *testing.T) {
		shortData := []byte("short")
		encoded := base64.StdEncoding.EncodeToString(shortData)
		_, err := calendar.DecryptToken(encoded)
		if err == nil {
			t.Fatal("expected error for ciphertext shorter than nonce, got nil")
		}
	})

	t.Run("corrupted ciphertext bytes / authentication tag failure", func(t *testing.T) {
		plain := "confidential-refresh-token"
		encrypted, err := calendar.EncryptToken(plain)
		if err != nil {
			t.Fatalf("EncryptToken failed: %v", err)
		}

		rawBytes, err := base64.StdEncoding.DecodeString(encrypted)
		if err != nil {
			t.Fatalf("DecodeString failed: %v", err)
		}

		// Flip byte in ciphertext portion
		rawBytes[len(rawBytes)-1] ^= 0xFF
		corruptedCipher := base64.StdEncoding.EncodeToString(rawBytes)

		_, err = calendar.DecryptToken(corruptedCipher)
		if err == nil {
			t.Fatal("expected authentication failure error on tampered ciphertext, got nil")
		}
	})

	t.Run("random garbage bytes", func(t *testing.T) {
		garbage := make([]byte, 64)
		_, _ = rand.Read(garbage)
		encoded := base64.StdEncoding.EncodeToString(garbage)

		_, err := calendar.DecryptToken(encoded)
		if err == nil {
			t.Fatal("expected error decrypting random bytes, got nil")
		}
	})
}

func TestCustomSecretKeyEnvironment(t *testing.T) {
	origEnv := os.Getenv("CALENDAR_SECRET_KEY")
	defer func() {
		_ = os.Setenv("CALENDAR_SECRET_KEY", origEnv)
	}()

	customKey := "01234567890123456789012345678901_custom"
	_ = os.Setenv("CALENDAR_SECRET_KEY", customKey)

	plain := "my-secret-calendar-token"
	enc, err := calendar.EncryptToken(plain)
	if err != nil {
		t.Fatalf("EncryptToken with custom key failed: %v", err)
	}

	dec, err := calendar.DecryptToken(enc)
	if err != nil {
		t.Fatalf("DecryptToken with custom key failed: %v", err)
	}
	if dec != plain {
		t.Fatalf("custom key roundtrip mismatch: got %q, want %q", dec, plain)
	}

	// Now change the key and ensure decryption fails
	_ = os.Setenv("CALENDAR_SECRET_KEY", "different-secret-key-32-chars-long!")
	_, err = calendar.DecryptToken(enc)
	if err == nil {
		t.Fatal("expected decryption to fail with different key, but succeeded")
	}
}

func TestConcurrentEncryptDecrypt(t *testing.T) {
	const goroutines = 20
	const iterations = 50

	var wg sync.WaitGroup
	wg.Add(goroutines)

	for i := 0; i < goroutines; i++ {
		go func(workerID int) {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				plain := "worker-token-test-payload"
				enc, err := calendar.EncryptToken(plain)
				if err != nil {
					t.Errorf("worker %d encrypt failed: %v", workerID, err)
					return
				}
				dec, err := calendar.DecryptToken(enc)
				if err != nil {
					t.Errorf("worker %d decrypt failed: %v", workerID, err)
					return
				}
				if dec != plain {
					t.Errorf("worker %d mismatch: got %q, want %q", workerID, dec, plain)
					return
				}
			}
		}(i)
	}

	wg.Wait()
}
