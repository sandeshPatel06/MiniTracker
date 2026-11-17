package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/crypto/hkdf"
)

const (
	// PrefixV1 is the prefix for v1 encrypted strings.
	PrefixV1 = "enc:v1:"
	// NonceSize is the standard 12-byte GCM nonce size.
	NonceSize = 12
	// KeySize is the 32-byte key size for AES-256.
	KeySize = 32
)

var (
	masterKeyOnce sync.Once
	cachedKey     []byte
	keyMu         sync.RWMutex
	customKey     []byte
)

// SetMasterKey overrides the master key for testing or custom initialisation.
// If set, this key is used directly (or HKDF-derived if not 32 bytes).
func SetMasterKey(key []byte) {
	keyMu.Lock()
	defer keyMu.Unlock()
	if len(key) == KeySize {
		customKey = make([]byte, KeySize)
		copy(customKey, key)
	} else {
		customKey = deriveKey(key, []byte("mini-tracker-key-expansion"))
	}
}

// ResetMasterKey resets any custom master key and cached master key.
func ResetMasterKey() {
	keyMu.Lock()
	defer keyMu.Unlock()
	customKey = nil
	masterKeyOnce = sync.Once{}
	cachedKey = nil
}

// deriveKey uses HKDF-SHA256 to derive a 32-byte AES-256 key from source material.
func deriveKey(secret []byte, info []byte) []byte {
	hkdfReader := hkdf.New(sha256.New, secret, nil, info)
	key := make([]byte, KeySize)
	if _, err := io.ReadFull(hkdfReader, key); err != nil {
		// SHA256 fallback if hkdf ReadFull fails for any reason
		sum := sha256.Sum256(secret)
		copy(key, sum[:])
	}
	return key
}

// getMasterKey loads or derives the 32-byte AES-256 master key.
// Priority:
// 1. Explicitly set custom key (via SetMasterKey)
// 2. ENCRYPTION_MASTER_KEY environment variable
// 3. JWT_SECRET environment variable
// 4. Persistent secret file in DATA_DIR or standard dirs
// 5. Ephemeral persistent fallback
func getMasterKey() ([]byte, error) {
	keyMu.RLock()
	if len(customKey) == KeySize {
		defer keyMu.RUnlock()
		return customKey, nil
	}
	keyMu.RUnlock()

	var err error
	masterKeyOnce.Do(func() {
		cachedKey, err = resolveMasterKey()
	})
	if err != nil {
		return nil, err
	}
	return cachedKey, nil
}

func resolveMasterKey() ([]byte, error) {
	// 1. ENCRYPTION_MASTER_KEY
	if emk := strings.TrimSpace(os.Getenv("ENCRYPTION_MASTER_KEY")); emk != "" {
		return deriveKey([]byte(emk), []byte("envelope-master-key")), nil
	}

	// 2. JWT_SECRET
	if jwtSec := strings.TrimSpace(os.Getenv("JWT_SECRET")); jwtSec != "" {
		return deriveKey([]byte(jwtSec), []byte("envelope-master-key")), nil
	}

	// 3. Fallback to system seed file in DATA_DIR or standard directories
	paths := []string{}
	if dataDir := strings.TrimSpace(os.Getenv("DATA_DIR")); dataDir != "" {
		paths = append(paths, filepath.Join(dataDir, "jwt.secret"))
		paths = append(paths, filepath.Join(dataDir, "encryption.key"))
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		paths = append(paths, filepath.Join(home, ".local", "share", "get-hike", "jwt.secret"))
		paths = append(paths, filepath.Join(home, ".local", "share", "get-hike", "encryption.key"))
		paths = append(paths, filepath.Join(home, ".config", "get-hike", "jwt.secret"))
		paths = append(paths, filepath.Join(home, ".config", "get-hike", "encryption.key"))
	}
	paths = append(paths, "jwt.secret", "encryption.key")

	for _, p := range paths {
		if data, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(data))) >= 16 {
			return deriveKey([]byte(strings.TrimSpace(string(data))), []byte("envelope-master-key")), nil
		}
	}

	// If no file exists, try creating an encryption.key in the first writable location
	randBytes := make([]byte, KeySize)
	if _, err := io.ReadFull(rand.Reader, randBytes); err != nil {
		host, _ := os.Hostname()
		sum := sha256.Sum256([]byte(fmt.Sprintf("envelope-seed-%s", host)))
		copy(randBytes, sum[:])
	}

	for _, p := range paths {
		dir := filepath.Dir(p)
		if err := os.MkdirAll(dir, 0700); err == nil {
			if err := os.WriteFile(p, randBytes, 0600); err == nil {
				return deriveKey(randBytes, []byte("envelope-master-key")), nil
			}
		}
	}

	// In-memory fallback if persistence fails
	return deriveKey(randBytes, []byte("envelope-master-key")), nil
}

// Encrypt encrypts plaintext using AES-256-GCM.
// A 12-byte cryptographically secure random nonce is generated and prepended to the ciphertext.
// The resulting binary data (nonce + ciphertext + tag) is Base64-encoded and returned with the 'enc:v1:' prefix.
func Encrypt(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}

	key, err := getMasterKey()
	if err != nil {
		return "", fmt.Errorf("failed to get master key: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("failed to create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("failed to create GCM: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("failed to generate nonce: %w", err)
	}

	// Seal appends ciphertext + 16-byte auth tag to nonce
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	encoded := base64.StdEncoding.EncodeToString(ciphertext)
	return PrefixV1 + encoded, nil
}

// Decrypt decrypts an envelope-encrypted ciphertext string.
// Backwards compatibility handling:
// - If the input does not have the 'enc:' prefix, or fails base64 decoding,
//   the raw input string is returned as plaintext (for seamless DB migration).
// - If it starts with 'enc:v1:', it extracts the base64 payload, unpacks the 12-byte nonce,
//   and verifies and decrypts the ciphertext using AES-256-GCM.
func Decrypt(ciphertext string) (string, error) {
	if ciphertext == "" {
		return "", nil
	}

	// If string does not have 'enc:' prefix, treat as plaintext for backward compatibility
	if !strings.HasPrefix(ciphertext, "enc:") {
		return ciphertext, nil
	}

	var rawB64 string
	if strings.HasPrefix(ciphertext, PrefixV1) {
		rawB64 = strings.TrimPrefix(ciphertext, PrefixV1)
	} else {
		// Generic 'enc:' prefix without recognized version: strip prefix up to first ':' after 'enc:'
		idx := strings.Index(ciphertext[4:], ":")
		if idx != -1 {
			rawB64 = ciphertext[4+idx+1:]
		} else {
			rawB64 = strings.TrimPrefix(ciphertext, "enc:")
		}
	}

	data, err := base64.StdEncoding.DecodeString(rawB64)
	if err != nil {
		// Backwards compatibility: if base64 decode fails, return raw string
		return ciphertext, nil
	}

	key, err := getMasterKey()
	if err != nil {
		return "", fmt.Errorf("failed to get master key: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("failed to create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("failed to create GCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", errors.New("ciphertext too short: missing nonce")
	}

	nonce, encryptedText := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, encryptedText, nil)
	if err != nil {
		return "", fmt.Errorf("failed to decrypt ciphertext: %w", err)
	}

	return string(plaintext), nil
}
