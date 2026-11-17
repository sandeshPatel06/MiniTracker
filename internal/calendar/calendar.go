package calendar

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"time"
)

// CryptoKey derives or provides a deterministic key for token encryption.
func getEncryptionKey() []byte {
	key := os.Getenv("CALENDAR_SECRET_KEY")
	if len(key) >= 32 {
		return []byte(key[:32])
	}
	// Fallback 32-byte key
	return []byte("get-hike-calendar-secret-key-32b")
}

// EncryptToken encrypts token payload using AES-GCM.
func EncryptToken(plainText string) (string, error) {
	if plainText == "" {
		return "", nil
	}
	block, err := aes.NewCipher(getEncryptionKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plainText), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// DecryptToken decrypts an AES-GCM token payload.
func DecryptToken(cipherText string) (string, error) {
	if cipherText == "" {
		return "", nil
	}
	data, err := base64.StdEncoding.DecodeString(cipherText)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(getEncryptionKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", errors.New("ciphertext too short")
	}
	nonce, cipherBytes := data[:nonceSize], data[nonceSize:]
	plain, err := gcm.Open(nil, nonce, cipherBytes, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// CalendarEventItem represents standard calendar event item.
type CalendarEventItem struct {
	ExternalID  string    `json:"external_id"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	StartTime   time.Time `json:"start_time"`
	EndTime     time.Time `json:"end_time"`
	AllDay      bool      `json:"all_day"`
	Status      string    `json:"status"`
	MeetingURL  string    `json:"meeting_url"`
}

// CalendarProvider interface for multi-calendar providers (Google, Outlook, CalDAV).
type CalendarProvider interface {
	GetAuthURL() string
	ExchangeCode(code string) (tokens string, email string, err error)
	FetchEvents(tokens string, from, to time.Time) ([]CalendarEventItem, error)
}
