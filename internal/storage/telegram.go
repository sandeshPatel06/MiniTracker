package storage

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxCacheEntries   = 200
	maxCaptionLength  = 1024
	maxUploadRetries  = 3
	defaultTimeout    = 45 * time.Second
	maxResponseBody   = 10 * 1024 * 1024  // 10 MB limit for response reading
)

// TelegramStorage handles storing and retrieving images via Telegram Bot API.
type TelegramStorage struct {
	botToken   string
	chatID     string
	httpClient *http.Client
	cacheMu    sync.RWMutex
	cache      map[string][]byte
}

// sanitizeCaption strips control characters and truncates the caption to Telegram's 1024 char limit.
func sanitizeCaption(caption string) string {
	// Telegram captions cannot exceed 1024 UTF-16 code units / UTF-8 chars
	caption = strings.TrimSpace(caption)
	// Strip null bytes and non-printable control characters except newline and tab
	var b strings.Builder
	for _, r := range caption {
		if r == '\n' || r == '\r' || r == '\t' || r >= 32 {
			b.WriteRune(r)
		}
	}
	res := b.String()
	runes := []rune(res)
	if len(runes) > maxCaptionLength {
		runes = runes[:maxCaptionLength]
	}
	return string(runes)
}

// createResilientHTTPClient creates an HTTP client with dual-stack (IPv4/IPv6 fallback) and sensible timeouts.
func createResilientHTTPClient() *http.Client {
	dialer := &net.Dialer{
		Timeout:   15 * time.Second,
		KeepAlive: 30 * time.Second,
		DualStack: true, // Happy Eyeballs: IPv4 & IPv6 fallback
	}

	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          50,
		MaxIdleConnsPerHost:   10,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}

	return &http.Client{
		Transport: transport,
		Timeout:   defaultTimeout,
	}
}

// NewTelegramStorage creates a new Telegram-backed storage provider.
func NewTelegramStorage(botToken, chatID string) *TelegramStorage {
	botToken = strings.TrimSpace(botToken)
	chatID = strings.TrimSpace(chatID)
	if botToken == "" || chatID == "" {
		return nil
	}
	return &TelegramStorage{
		botToken:   botToken,
		chatID:     chatID,
		httpClient: createResilientHTTPClient(),
		cache:      make(map[string][]byte),
	}
}

// parseRetryAfter checks the Retry-After header or Telegram error parameters for retry seconds.
func parseRetryAfter(resp *http.Response, body []byte) time.Duration {
	if headerVal := resp.Header.Get("Retry-After"); headerVal != "" {
		if sec, err := strconv.Atoi(headerVal); err == nil && sec > 0 {
			return time.Duration(sec) * time.Second
		}
	}

	var tgErr struct {
		Parameters struct {
			RetryAfter int `json:"retry_after"`
		} `json:"parameters"`
	}
	if err := json.Unmarshal(body, &tgErr); err == nil && tgErr.Parameters.RetryAfter > 0 {
		return time.Duration(tgErr.Parameters.RetryAfter) * time.Second
	}

	return 2 * time.Second
}

// UploadPhoto uploads an image to the private Telegram channel/chat and returns "tg://<file_id>".
// It incorporates caption sanitization, rate limit backoff (HTTP 429), and retry resilience.
func (t *TelegramStorage) UploadPhoto(ctx context.Context, imgBytes []byte, caption string) (string, error) {
	if len(imgBytes) == 0 {
		return "", fmt.Errorf("empty image payload")
	}

	sanitizedCap := sanitizeCaption(caption)

	var lastErr error
	for attempt := 0; attempt < maxUploadRetries; attempt++ {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		default:
		}

		var reqBody bytes.Buffer
		writer := multipart.NewWriter(&reqBody)

		if err := writer.WriteField("chat_id", t.chatID); err != nil {
			return "", fmt.Errorf("write chat_id: %w", err)
		}

		if sanitizedCap != "" {
			if err := writer.WriteField("caption", sanitizedCap); err != nil {
				return "", fmt.Errorf("write caption: %w", err)
			}
		}

		part, err := writer.CreateFormFile("photo", "screenshot.jpg")
		if err != nil {
			return "", fmt.Errorf("create form file: %w", err)
		}
		if _, err := io.Copy(part, bytes.NewReader(imgBytes)); err != nil {
			return "", fmt.Errorf("copy photo data: %w", err)
		}

		if err := writer.Close(); err != nil {
			return "", fmt.Errorf("close multipart writer: %w", err)
		}

		apiURL := fmt.Sprintf("https://api.telegram.org/bot%s/sendPhoto", t.botToken)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, &reqBody)
		if err != nil {
			return "", fmt.Errorf("new request: %w", err)
		}
		req.Header.Set("Content-Type", writer.FormDataContentType())

		resp, err := t.httpClient.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("execute telegram sendPhoto: %w", err)
			time.Sleep(time.Duration(attempt+1) * 500 * time.Millisecond)
			continue
		}

		bodyBytes, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody))
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("read telegram sendPhoto response: %w", readErr)
			continue
		}

		if resp.StatusCode == http.StatusTooManyRequests {
			// Rate limited: backoff and retry
			backoff := parseRetryAfter(resp, bodyBytes)
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(backoff):
			}
			lastErr = fmt.Errorf("telegram rate limited (429): %s", string(bodyBytes))
			continue
		}

		if resp.StatusCode != http.StatusOK {
			return "", fmt.Errorf("telegram sendPhoto returned status %d: %s", resp.StatusCode, string(bodyBytes))
		}

		var tgResp struct {
			OK     bool `json:"ok"`
			Result struct {
				Photo []struct {
					FileID   string `json:"file_id"`
					Width    int    `json:"width"`
					Height   int    `json:"height"`
					FileSize int    `json:"file_size"`
				} `json:"photo"`
			} `json:"result"`
		}

		if err := json.Unmarshal(bodyBytes, &tgResp); err != nil {
			return "", fmt.Errorf("unmarshal telegram response: %w", err)
		}

		if !tgResp.OK || len(tgResp.Result.Photo) == 0 {
			return "", fmt.Errorf("telegram response missing photo details: %s", string(bodyBytes))
		}

		// Largest photo size is always the last element in Telegram's photo array
		bestPhoto := tgResp.Result.Photo[len(tgResp.Result.Photo)-1]
		fileID := bestPhoto.FileID

		// Cache the raw bytes immediately
		t.cacheMu.Lock()
		if len(t.cache) >= maxCacheEntries {
			t.cache = make(map[string][]byte)
		}
		t.cache[fileID] = imgBytes
		t.cacheMu.Unlock()

		return "tg://" + fileID, nil
	}

	return "", fmt.Errorf("telegram sendPhoto failed after %d attempts: %w", maxUploadRetries, lastErr)
}

// GetPhotoBytes downloads the image bytes given a Telegram file_id.
func (t *TelegramStorage) GetPhotoBytes(ctx context.Context, fileID string) ([]byte, error) {
	fileID = strings.TrimSpace(fileID)
	if fileID == "" {
		return nil, fmt.Errorf("empty fileID")
	}

	// Check cache
	t.cacheMu.RLock()
	if data, ok := t.cache[fileID]; ok {
		t.cacheMu.RUnlock()
		return data, nil
	}
	t.cacheMu.RUnlock()

	// 1. Get file path from Telegram
	getFileURL := fmt.Sprintf("https://api.telegram.org/bot%s/getFile?file_id=%s", t.botToken, fileID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, getFileURL, nil)
	if err != nil {
		return nil, fmt.Errorf("new getFile request: %w", err)
	}

	resp, err := t.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("execute getFile: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody))
		return nil, fmt.Errorf("getFile returned %d: %s", resp.StatusCode, string(body))
	}

	var fileResp struct {
		OK     bool `json:"ok"`
		Result struct {
			FilePath string `json:"file_path"`
		} `json:"result"`
	}

	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBody)).Decode(&fileResp); err != nil {
		return nil, fmt.Errorf("decode getFile response: %w", err)
	}

	if !fileResp.OK || fileResp.Result.FilePath == "" {
		return nil, fmt.Errorf("empty file path from telegram")
	}

	// 2. Download actual file
	downloadURL := fmt.Sprintf("https://api.telegram.org/file/bot%s/%s", t.botToken, fileResp.Result.FilePath)
	dlReq, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return nil, fmt.Errorf("new download request: %w", err)
	}

	dlResp, err := t.httpClient.Do(dlReq)
	if err != nil {
		return nil, fmt.Errorf("execute download: %w", err)
	}
	defer dlResp.Body.Close()

	if dlResp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download returned %d", dlResp.StatusCode)
	}

	imgBytes, err := io.ReadAll(io.LimitReader(dlResp.Body, 50*1024*1024)) // 50MB file max
	if err != nil {
		return nil, fmt.Errorf("read file body: %w", err)
	}

	// Save to cache
	t.cacheMu.Lock()
	if len(t.cache) >= maxCacheEntries {
		t.cache = make(map[string][]byte)
	}
	t.cache[fileID] = imgBytes
	t.cacheMu.Unlock()

	return imgBytes, nil
}
