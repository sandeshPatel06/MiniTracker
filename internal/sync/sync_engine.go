package sync

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/reak/get-hike/internal/appname"
	"github.com/reak/get-hike/internal/db"
)

// HTTPClient interface enables mocking network calls in tests.
type HTTPClient interface {
	Do(req *http.Request) (*http.Response, error)
}

// RetryPolicy configures the exponential backoff retry parameters.
type RetryPolicy struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
}

// DefaultRetryPolicy returns standard retry configuration for network operations.
func DefaultRetryPolicy() RetryPolicy {
	return RetryPolicy{
		MaxAttempts: 4,
		BaseDelay:   250 * time.Millisecond,
		MaxDelay:    4 * time.Second,
	}
}

// SyncEngine manages background and manual telemetry pushes & analytics pulls
// between the desktop client's local SQLite database and the backend server.
type SyncEngine struct {
	database        *db.DB
	backendEndpoint string
	authToken       string
	httpClient      HTTPClient
	retryPolicy     RetryPolicy

	mutex        sync.Mutex
	isSyncing    bool
	lastSyncedAt time.Time
}

// NewSyncEngine creates a new SyncEngine instance.
func NewSyncEngine(database *db.DB, endpoint string) *SyncEngine {
	if endpoint == "" {
		endpoint = "http://localhost:8080"
	}
	return &SyncEngine{
		database:        database,
		backendEndpoint: endpoint,
		httpClient:      &http.Client{Timeout: 30 * time.Second},
		retryPolicy:     DefaultRetryPolicy(),
	}
}

// SetHTTPClient sets a custom HTTPClient (useful for unit testing).
func (s *SyncEngine) SetHTTPClient(client HTTPClient) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if client != nil {
		s.httpClient = client
	}
}

// SetRetryPolicy sets a custom retry policy (e.g. fast retries for tests).
func (s *SyncEngine) SetRetryPolicy(policy RetryPolicy) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.retryPolicy = policy
}

// SetAuthToken updates the authentication token used for API requests.
func (s *SyncEngine) SetAuthToken(token string) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.authToken = token
}

// SetBackendEndpoint updates the remote server URL.
func (s *SyncEngine) SetBackendEndpoint(endpoint string) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if endpoint != "" {
		s.backendEndpoint = endpoint
	}
}

// telemetryPayloadItem represents an individual telemetry entry in a batch payload.
type telemetryPayloadItem struct {
	LocalID      int64   `json:"local_id"`
	Timestamp    string  `json:"timestamp"`
	ImageBase64  string  `json:"image_base64,omitempty"`
	TotalKeys    int     `json:"total_keys"`
	UniqueKeys   int     `json:"unique_keys"`
	EntropyScore float64 `json:"entropy_score"`
	TotalClicks  int     `json:"total_clicks"`
	AppName      string  `json:"app_name"`
	WindowTitle  string  `json:"window_title"`
}

// batchPushRequest is the envelope format for batch telemetry ingestion.
type batchPushRequest struct {
	Logs []telemetryPayloadItem `json:"logs"`
}

// batchPushResultItem represents an individual log confirmation from the server.
type batchPushResultItem struct {
	LocalID  int64 `json:"local_id"`
	RemoteID int64 `json:"remote_id"`
}

// batchPushResponse represents the server's response to telemetry push/push-batch.
type batchPushResponse struct {
	Success     bool                  `json:"success"`
	SyncedCount int                   `json:"synced_count"`
	Results     []batchPushResultItem `json:"results"`
	// Backwards compatibility for single-log response:
	LocalID  int64 `json:"local_id"`
	RemoteID int64 `json:"remote_id"`
}

// isRetryableStatus checks whether an HTTP status code indicates a transient error.
func isRetryableStatus(code int) bool {
	return code == http.StatusTooManyRequests ||
		code == http.StatusInternalServerError ||
		code == http.StatusBadGateway ||
		code == http.StatusServiceUnavailable ||
		code == http.StatusGatewayTimeout
}

// parseRetryAfter extracts Retry-After delay if present in HTTP response headers.
func parseRetryAfter(h http.Header) time.Duration {
	if h == nil {
		return 0
	}
	val := h.Get("Retry-After")
	if val == "" {
		return 0
	}
	if secs, err := strconv.Atoi(val); err == nil && secs > 0 {
		if secs > 300 {
			secs = 300
		}
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(val); err == nil {
		d := time.Until(t)
		if d > 0 {
			if d > 5*time.Minute {
				d = 5 * time.Minute
			}
			return d
		}
	}
	return 0
}

// drainAndClose ensures an HTTP response body is completely read and closed,
// allowing underlying TCP sockets to be safely reused by keep-alive.
func drainAndClose(body io.ReadCloser) {
	if body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 64*1024))
	_ = body.Close()
}

// executeWithRetry executes an HTTP request with exponential backoff on transient network or 5xx/429 errors.
func (s *SyncEngine) executeWithRetry(ctx context.Context, client HTTPClient, policy RetryPolicy, makeReq func() (*http.Request, error)) (*http.Response, error) {
	if policy.MaxAttempts <= 0 {
		policy.MaxAttempts = 4
	}
	if policy.BaseDelay <= 0 {
		policy.BaseDelay = 250 * time.Millisecond
	}
	if policy.MaxDelay <= 0 {
		policy.MaxDelay = 4 * time.Second
	}

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	var lastErr error

	for attempt := 1; attempt <= policy.MaxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		req, err := makeReq()
		if err != nil {
			return nil, err
		}

		resp, err := client.Do(req)
		if err != nil {
			// Network transport error: retryable
			lastErr = err
			if attempt == policy.MaxAttempts {
				return nil, lastErr
			}
		} else {
			// If response is not retryable, return immediately (caller must drain & close resp.Body)
			if !isRetryableStatus(resp.StatusCode) {
				return resp, nil
			}

			// Transient 5xx or 429 status: record error and drain body for connection reuse
			retryAfter := parseRetryAfter(resp.Header)
			statusMsg := resp.Status
			drainAndClose(resp.Body)

			lastErr = fmt.Errorf("server returned transient status %s", statusMsg)
			if attempt == policy.MaxAttempts {
				return nil, lastErr
			}

			// Honor Retry-After if larger than computed backoff
			shift := attempt - 1
			if shift > 30 {
				shift = 30
			}
			backoff := policy.BaseDelay * (1 << shift)
			if backoff > policy.MaxDelay || backoff <= 0 {
				backoff = policy.MaxDelay
			}
			jitterFactor := 0.8 + 0.4*rng.Float64()
			delay := time.Duration(float64(backoff) * jitterFactor)
			if retryAfter > delay {
				delay = retryAfter
			}
			if delay > policy.MaxDelay && retryAfter <= policy.MaxDelay {
				delay = policy.MaxDelay
			}

			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
			continue
		}

		// Compute backoff for transport error
		shift := attempt - 1
		if shift > 30 {
			shift = 30
		}
		backoff := policy.BaseDelay * (1 << shift)
		if backoff > policy.MaxDelay || backoff <= 0 {
			backoff = policy.MaxDelay
		}
		jitterFactor := 0.8 + 0.4*rng.Float64()
		delay := time.Duration(float64(backoff) * jitterFactor)

		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}

	return nil, lastErr
}

// PushTelemetry flushes pending local log entries to the backend server as a single batch.
func (s *SyncEngine) PushTelemetry(ctx context.Context) (int, error) {
	if s.database == nil {
		return 0, nil
	}

	pendingLogs, err := s.database.GetPendingUploadLogs(50)
	if err != nil || len(pendingLogs) == 0 {
		return 0, err
	}

	s.mutex.Lock()
	endpoint := s.backendEndpoint
	token := s.authToken
	client := s.httpClient
	policy := s.retryPolicy
	s.mutex.Unlock()

	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}

	// Build batch payload and track valid local IDs in the batch
	batchItems := make([]telemetryPayloadItem, 0, len(pendingLogs))
	localIDSet := make(map[int64]bool, len(pendingLogs))

	for _, entry := range pendingLogs {
		localIDSet[entry.ID] = true
		var imgBase64 string
		if entry.ImagePath != "" {
			if data, err := os.ReadFile(entry.ImagePath); err == nil {
				imgBase64 = base64.StdEncoding.EncodeToString(data)
			}
		}

		batchItems = append(batchItems, telemetryPayloadItem{
			LocalID:      entry.ID,
			Timestamp:    entry.Timestamp.Format(time.RFC3339),
			ImageBase64:  imgBase64,
			TotalKeys:    entry.TotalKeys,
			UniqueKeys:   entry.UniqueKeys,
			EntropyScore: entry.EntropyScore,
			TotalClicks:  entry.TotalClicks,
			AppName:      appname.Canonical(entry.AppName),
			WindowTitle:  entry.WindowTitle,
		})
	}

	reqEnvelope := batchPushRequest{Logs: batchItems}
	bodyBytes, err := json.Marshal(reqEnvelope)
	if err != nil {
		return 0, fmt.Errorf("marshal batch payload: %w", err)
	}

	// Try POST /api/telemetry/push-batch, falling back to /api/telemetry/push if 404
	targetPaths := []string{"/api/telemetry/push-batch", "/api/telemetry/push"}
	var resp *http.Response
	var lastErr error

	for _, path := range targetPaths {
		pushURL := endpoint + path
		makeReq := func() (*http.Request, error) {
			r, err := http.NewRequestWithContext(ctx, http.MethodPost, pushURL, bytes.NewReader(bodyBytes))
			if err != nil {
				return nil, err
			}
			r.Header.Set("Content-Type", "application/json")
			if token != "" {
				r.Header.Set("Authorization", "Bearer "+token)
			}
			return r, nil
		}

		resp, err = s.executeWithRetry(ctx, client, policy, makeReq)
		if err != nil {
			lastErr = err
			break
		}

		// If endpoint returns 404 Not Found, try alternate path
		if resp.StatusCode == http.StatusNotFound {
			drainAndClose(resp.Body)
			continue
		}
		break
	}

	if resp == nil {
		if lastErr != nil {
			log.Printf("[sync] telemetry push batch request failed: %v", lastErr)
			return 0, lastErr
		}
		return 0, errors.New("telemetry push endpoints not available")
	}
	defer drainAndClose(resp.Body)

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		bodySnippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		log.Printf("[sync] telemetry push rejected: HTTP %d %s", resp.StatusCode, string(bodySnippet))
		return 0, fmt.Errorf("telemetry push rejected with status %d: %s", resp.StatusCode, string(bodySnippet))
	}

	var pushResp batchPushResponse
	if err := json.NewDecoder(resp.Body).Decode(&pushResp); err != nil {
		return 0, fmt.Errorf("decode push batch response: %w", err)
	}

	if !pushResp.Success {
		return 0, errors.New("server indicated batch push was unsuccessful")
	}

	var confirmedLocalIDs []int64
	var confirmedRemoteIDs []int64

	// Security validation & mapping of confirmed items
	if len(pushResp.Results) > 0 {
		for _, item := range pushResp.Results {
			// Security validation: verify returned local ID belongs to this batch and remote ID is non-zero
			if localIDSet[item.LocalID] && item.RemoteID > 0 {
				confirmedLocalIDs = append(confirmedLocalIDs, item.LocalID)
				confirmedRemoteIDs = append(confirmedRemoteIDs, item.RemoteID)
			}
		}
	} else if pushResp.LocalID > 0 && pushResp.RemoteID > 0 && localIDSet[pushResp.LocalID] {
		// Single log fallback response validation
		confirmedLocalIDs = append(confirmedLocalIDs, pushResp.LocalID)
		confirmedRemoteIDs = append(confirmedRemoteIDs, pushResp.RemoteID)
	}

	if len(confirmedLocalIDs) > 0 {
		if err := s.database.MarkLogsSynced(confirmedLocalIDs, confirmedRemoteIDs); err != nil {
			log.Printf("[sync] error updating sync status in db: %v", err)
			return 0, fmt.Errorf("mark logs synced: %w", err)
		}
		log.Printf("[sync] successfully pushed %d/%d pending telemetry logs in batch to backend", len(confirmedLocalIDs), len(pendingLogs))
	} else {
		log.Printf("[sync] warning: no matching remote IDs returned from backend push response")
	}

	return len(confirmedLocalIDs), nil
}

// PullAnalytics pulls newly analyzed AI log entries from backend and updates local DB.
func (s *SyncEngine) PullAnalytics(ctx context.Context) (int, error) {
	if s.database == nil {
		return 0, nil
	}

	s.mutex.Lock()
	endpoint := s.backendEndpoint
	token := s.authToken
	client := s.httpClient
	policy := s.retryPolicy
	sinceStr := s.lastSyncedAt.Format(time.RFC3339)
	s.mutex.Unlock()

	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}

	pullURL := fmt.Sprintf("%s/api/telemetry/pull?since=%s", endpoint, url.QueryEscape(sinceStr))
	makeReq := func() (*http.Request, error) {
		r, err := http.NewRequestWithContext(ctx, http.MethodGet, pullURL, nil)
		if err != nil {
			return nil, err
		}
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		return r, nil
	}

	resp, err := s.executeWithRetry(ctx, client, policy, makeReq)
	if err != nil {
		log.Printf("[sync] pull analytics request error: %v", err)
		return 0, err
	}
	defer drainAndClose(resp.Body)

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return 0, fmt.Errorf("pull failed with status %d: %s", resp.StatusCode, string(body))
	}

	var remoteLogs []db.LogEntry
	if err := json.NewDecoder(resp.Body).Decode(&remoteLogs); err != nil {
		return 0, fmt.Errorf("decode remote logs: %w", err)
	}

	if len(remoteLogs) == 0 {
		s.mutex.Lock()
		s.lastSyncedAt = time.Now()
		s.mutex.Unlock()
		return 0, nil
	}

	syncedCount := 0
	for _, remoteLog := range remoteLogs {
		if remoteLog.ID > 0 {
			if err := s.database.UpdateAIResultByRemoteID(
				remoteLog.ID,
				remoteLog.AICategory,
				remoteLog.IsProductive,
				remoteLog.ProductiveScore,
				remoteLog.AIConfidence,
				remoteLog.AIReason,
			); err != nil {
				log.Printf("[sync] warning: failed to update AI result for remote ID %d: %v", remoteLog.ID, err)
				continue
			}
			syncedCount++
		}
	}

	s.mutex.Lock()
	s.lastSyncedAt = time.Now()
	s.mutex.Unlock()

	log.Printf("[sync] pulled %d analyzed log records from backend server", syncedCount)
	return syncedCount, nil
}

// TriggerSyncNow performs an immediate manual Push + Pull cycle (e.g. via UI button),
// or local/background retry. When no auth token is set (local guest mode) the
// desktop app runs fully standalone, so the round-trip is skipped entirely.
func (s *SyncEngine) TriggerSyncNow(ctx context.Context) error {
	s.mutex.Lock()
	if s.authToken == "" {
		s.mutex.Unlock()
		return nil
	}
	if s.isSyncing {
		s.mutex.Unlock()
		return nil // Already syncing
	}
	s.isSyncing = true
	s.mutex.Unlock()

	defer func() {
		s.mutex.Lock()
		s.isSyncing = false
		s.mutex.Unlock()
	}()

	log.Printf("[sync] initiating manual sync cycle...")
	var totalPushed int
	var pushErr error
	for batch := 0; batch < 10; batch++ {
		var pushed int
		pushed, pushErr = s.PushTelemetry(ctx)
		if pushErr != nil {
			log.Printf("[sync] push error on batch %d: %v", batch+1, pushErr)
			break
		}
		totalPushed += pushed
		if pushed < 50 {
			break
		}
	}
	if totalPushed > 0 {
		log.Printf("[sync] total pushed in cycle: %d logs", totalPushed)
	}
	_, pullErr := s.PullAnalytics(ctx)

	if pushErr != nil && pullErr != nil {
		return fmt.Errorf("push err: %v; pull err: %v", pushErr, pullErr)
	}
	return nil
}

// LastSyncedAt returns the time of the last completed pull cycle (zero if never synced).
func (s *SyncEngine) LastSyncedAt() time.Time {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.lastSyncedAt
}

// Enabled reports whether an auth token is set (authenticated org sync mode).
func (s *SyncEngine) Enabled() bool {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.authToken != ""
}

// Endpoint returns the currently configured backend endpoint.
func (s *SyncEngine) Endpoint() string {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.backendEndpoint
}

// StartBackgroundPullCron starts a ticker routine executing periodic sync (e.g., 3-hour pull window).
func (s *SyncEngine) StartBackgroundPullCron(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 3 * time.Hour
	}

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		log.Printf("[sync] background sync pull cron active (interval: %v)", interval)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				ctxTimeout, cancel := context.WithTimeout(ctx, 2*time.Minute)
				_ = s.TriggerSyncNow(ctxTimeout)
				cancel()
			}
		}
	}()
}
