package storage

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"sync"
	"time"
)

// TelegramStorage handles storing and retrieving images via Telegram Bot API.
type TelegramStorage struct {
	botToken   string
	chatID     string
	httpClient *http.Client
	cacheMu    sync.RWMutex
	cache      map[string][]byte
}

// NewTelegramStorage creates a new Telegram-backed storage provider.
func NewTelegramStorage(botToken, chatID string) *TelegramStorage {
	if botToken == "" || chatID == "" {
		return nil
	}
	return &TelegramStorage{
		botToken: botToken,
		chatID:   chatID,
		httpClient: &http.Client{
			Timeout: 45 * time.Second,
		},
		cache: make(map[string][]byte),
	}
}

// UploadPhoto uploads an image to the private Telegram channel/chat and returns "tg://<file_id>".
func (t *TelegramStorage) UploadPhoto(ctx context.Context, imgBytes []byte, caption string) (string, error) {
	if len(imgBytes) == 0 {
		return "", fmt.Errorf("empty image payload")
	}

	var reqBody bytes.Buffer
	writer := multipart.NewWriter(&reqBody)

	// chat_id field
	if err := writer.WriteField("chat_id", t.chatID); err != nil {
		return "", fmt.Errorf("write chat_id: %w", err)
	}

	// caption field
	if caption != "" {
		if err := writer.WriteField("caption", caption); err != nil {
			return "", fmt.Errorf("write caption: %w", err)
		}
	}

	// photo part
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
		return "", fmt.Errorf("execute telegram sendPhoto: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
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
	if len(t.cache) > 200 { // limit cache size
		t.cache = make(map[string][]byte)
	}
	t.cache[fileID] = imgBytes
	t.cacheMu.Unlock()

	return "tg://" + fileID, nil
}

// GetPhotoBytes downloads the image bytes given a Telegram file_id.
func (t *TelegramStorage) GetPhotoBytes(ctx context.Context, fileID string) ([]byte, error) {
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
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("getFile returned %d: %s", resp.StatusCode, string(body))
	}

	var fileResp struct {
		OK     bool `json:"ok"`
		Result struct {
			FilePath string `json:"file_path"`
		} `json:"result"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&fileResp); err != nil {
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

	imgBytes, err := io.ReadAll(dlResp.Body)
	if err != nil {
		return nil, fmt.Errorf("read file body: %w", err)
	}

	// Save to cache
	t.cacheMu.Lock()
	if len(t.cache) > 200 {
		t.cache = make(map[string][]byte)
	}
	t.cache[fileID] = imgBytes
	t.cacheMu.Unlock()

	return imgBytes, nil
}
