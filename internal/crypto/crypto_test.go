package crypto

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestEncryptDecryptRoundTrip(t *testing.T) {
	ResetMasterKey()
	defer ResetMasterKey()

	testInputs := []string{
		"AIzaSyD-abc1234567890-test_key",
		"sk-proj-987654321-secret-key-gemini",
		"hello world with special unicode chars: 🔒🔑🎉",
		"a",
		"a very long api key string that goes on and on and contains multiple characters 1234567890!@#$%^&*()_+~`",
	}

	for _, input := range testInputs {
		encrypted, err := Encrypt(input)
		if err != nil {
			t.Fatalf("Encrypt(%q) failed: %v", input, err)
		}

		if !strings.HasPrefix(encrypted, PrefixV1) {
			t.Errorf("Encrypt result %q does not have prefix %s", encrypted, PrefixV1)
		}

		decrypted, err := Decrypt(encrypted)
		if err != nil {
			t.Fatalf("Decrypt(%q) failed: %v", encrypted, err)
		}

		if decrypted != input {
			t.Errorf("Roundtrip mismatch: got %q, want %q", decrypted, input)
		}
	}
}

func TestEmptyStringHandling(t *testing.T) {
	ResetMasterKey()
	defer ResetMasterKey()

	enc, err := Encrypt("")
	if err != nil {
		t.Fatalf("Encrypt(\"\") failed: %v", err)
	}
	if enc != "" {
		t.Errorf("expected empty string, got %q", enc)
	}

	dec, err := Decrypt("")
	if err != nil {
		t.Fatalf("Decrypt(\"\") failed: %v", err)
	}
	if dec != "" {
		t.Errorf("expected empty string, got %q", dec)
	}
}

func TestBackwardsCompatibilityPlaintext(t *testing.T) {
	ResetMasterKey()
	defer ResetMasterKey()

	rawKey := "AIzaSyLegacyKeyWithoutPrefix-12345"
	decrypted, err := Decrypt(rawKey)
	if err != nil {
		t.Fatalf("Decrypt on legacy plaintext failed: %v", err)
	}
	if decrypted != rawKey {
		t.Errorf("expected legacy plaintext %q, got %q", rawKey, decrypted)
	}

	// Invalid base64 with enc: prefix should also fallback to raw string
	invalidB64 := "enc:v1:not-a-valid-base64-string!@#$%"
	decFallback, err := Decrypt(invalidB64)
	if err != nil {
		t.Fatalf("Decrypt on invalid base64 failed: %v", err)
	}
	if decFallback != invalidB64 {
		t.Errorf("expected fallback to raw string %q, got %q", invalidB64, decFallback)
	}
}

func TestTamperResistance(t *testing.T) {
	ResetMasterKey()
	defer ResetMasterKey()

	original := "secret-api-key-test-tamper"
	encrypted, err := Encrypt(original)
	if err != nil {
		t.Fatalf("Encrypt failed: %v", err)
	}

	rawB64 := strings.TrimPrefix(encrypted, PrefixV1)
	decoded, err := base64.StdEncoding.DecodeString(rawB64)
	if err != nil {
		t.Fatalf("failed to decode base64: %v", err)
	}

	// Tamper with the last byte (auth tag)
	tampered := make([]byte, len(decoded))
	copy(tampered, decoded)
	tampered[len(tampered)-1] ^= 0x01

	tamperedEncrypted := PrefixV1 + base64.StdEncoding.EncodeToString(tampered)
	_, err = Decrypt(tamperedEncrypted)
	if err == nil {
		t.Fatal("expected decryption error on tampered auth tag, got nil")
	}

	// Tamper with ciphertext byte (in the middle)
	tamperedCipher := make([]byte, len(decoded))
	copy(tamperedCipher, decoded)
	tamperedCipher[NonceSize+2] ^= 0xFF

	tamperedEncryptedCipher := PrefixV1 + base64.StdEncoding.EncodeToString(tamperedCipher)
	_, err = Decrypt(tamperedEncryptedCipher)
	if err == nil {
		t.Fatal("expected decryption error on tampered ciphertext, got nil")
	}
}

func TestTruncatedCiphertext(t *testing.T) {
	ResetMasterKey()
	defer ResetMasterKey()

	// Base64 of less than 12 bytes
	shortData := base64.StdEncoding.EncodeToString([]byte("too-short"))
	truncated := PrefixV1 + shortData
	_, err := Decrypt(truncated)
	if err == nil {
		t.Fatal("expected error on truncated ciphertext (< 12 byte nonce), got nil")
	}
}

func TestKeyDerivationDifferentSecrets(t *testing.T) {
	defer ResetMasterKey()

	secret1 := []byte("secret-key-1-alpha")
	secret2 := []byte("secret-key-2-beta")

	SetMasterKey(secret1)
	msg := "test-message-derivation"
	encrypted, err := Encrypt(msg)
	if err != nil {
		t.Fatalf("Encrypt failed: %v", err)
	}

	// Change to different key
	SetMasterKey(secret2)
	_, err = Decrypt(encrypted)
	if err == nil {
		t.Fatal("expected decryption failure with different master key, got nil")
	}

	// Restore original key
	SetMasterKey(secret1)
	decrypted, err := Decrypt(encrypted)
	if err != nil {
		t.Fatalf("Decrypt with original key failed: %v", err)
	}
	if decrypted != msg {
		t.Fatalf("got %q, want %q", decrypted, msg)
	}
}
