package sync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/reak/get-hike/internal/db"
)

// setupTestDB initializes an isolated in-memory or temp SQLite database for tests.
func setupTestDB(t *testing.T) (*db.DB, func()) {
	t.Helper()
	tmpDir, err := os.MkdirTemp("", "sync_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	database, err := db.Open(tmpDir)
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("failed to init db: %v", err)
	}

	cleanup := func() {
		_ = database.Close()
		_ = os.RemoveAll(tmpDir)
	}
	return database, cleanup
}

// mockHTTPClient allows test cases to intercept HTTP requests and provide controlled responses.
type mockHTTPClient struct {
	mu       sync.Mutex
	doFunc   func(req *http.Request) (*http.Response, error)
	requests []*http.Request
}

func (m *mockHTTPClient) Do(req *http.Request) (*http.Response, error) {
	m.mu.Lock()
	m.requests = append(m.requests, req)
	fn := m.doFunc
	m.mu.Unlock()

	if fn != nil {
		return fn(req)
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(bytes.NewReader([]byte(`{"success":true,"results":[]}`))),
		Header:     make(http.Header),
	}, nil
}

func (m *mockHTTPClient) getRequests() []*http.Request {
	m.mu.Lock()
	defer m.mu.Unlock()
	res := make([]*http.Request, len(m.requests))
	copy(res, m.requests)
	return res
}

func TestBatchTelemetryIngestion(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	// Insert 5 test log entries waiting to be synced
	for i := 1; i <= 5; i++ {
		_, err := database.InsertLog(&db.LogEntry{
			OrgID:        1,
			UserID:       1,
			Timestamp:    time.Now().UTC().Add(time.Duration(i) * time.Minute),
			TotalKeys:    10 * i,
			UniqueKeys:   5 * i,
			EntropyScore: 0.8,
			TotalClicks:  2 * i,
			AppName:      "code",
			WindowTitle:  fmt.Sprintf("editor-%d", i),
		})
		if err != nil {
			t.Fatalf("insert test log failed: %v", err)
		}
	}

	mockClient := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			// Verify auth header
			authHeader := req.Header.Get("Authorization")
			if authHeader != "Bearer test-secret-token" {
				return &http.Response{
					StatusCode: http.StatusUnauthorized,
					Body:       io.NopCloser(bytes.NewReader([]byte(`{"error":"unauthorized"}`))),
					Header:     make(http.Header),
				}, nil
			}

			// Verify payload is a batch JSON
			body, err := io.ReadAll(req.Body)
			if err != nil {
				return nil, err
			}

			var batchReq batchPushRequest
			if err := json.Unmarshal(body, &batchReq); err != nil {
				return nil, fmt.Errorf("failed to unmarshal batch request: %w", err)
			}

			if len(batchReq.Logs) != 5 {
				return nil, fmt.Errorf("expected 5 logs in batch, got %d", len(batchReq.Logs))
			}

			// Generate remote IDs matching the local IDs
			results := make([]batchPushResultItem, 0, len(batchReq.Logs))
			for idx, item := range batchReq.Logs {
				results = append(results, batchPushResultItem{
					LocalID:  item.LocalID,
					RemoteID: int64(1000 + idx + 1),
				})
			}

			respData, _ := json.Marshal(batchPushResponse{
				Success:     true,
				SyncedCount: len(results),
				Results:     results,
			})

			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(bytes.NewReader(respData)),
				Header:     make(http.Header),
			}, nil
		},
	}

	engine := NewSyncEngine(database, "http://mock-server:8080")
	engine.SetAuthToken("test-secret-token")
	engine.SetHTTPClient(mockClient)
	engine.SetRetryPolicy(RetryPolicy{
		MaxAttempts: 2,
		BaseDelay:   10 * time.Millisecond,
		MaxDelay:    50 * time.Millisecond,
	})

	syncedCount, err := engine.PushTelemetry(context.Background())
	if err != nil {
		t.Fatalf("PushTelemetry failed: %v", err)
	}

	if syncedCount != 5 {
		t.Fatalf("expected 5 synced logs, got %d", syncedCount)
	}

	// Verify only 1 batch HTTP request was sent instead of 5 individual requests
	reqs := mockClient.getRequests()
	if len(reqs) != 1 {
		t.Errorf("expected exactly 1 batch HTTP request, got %d", len(reqs))
	}

	// Verify database rows were updated to synced
	remainingPending, err := database.GetPendingUploadLogs(50)
	if err != nil {
		t.Fatalf("GetPendingUploadLogs failed: %v", err)
	}
	if len(remainingPending) != 0 {
		t.Errorf("expected 0 pending logs after batch sync, got %d", len(remainingPending))
	}
}

func TestExponentialBackoffRetryOn5xx(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	_, err := database.InsertLog(&db.LogEntry{
		OrgID:       1,
		UserID:      1,
		Timestamp:   time.Now().UTC(),
		AppName:     "terminal",
		WindowTitle: "bash",
	})
	if err != nil {
		t.Fatalf("insert test log failed: %v", err)
	}

	var callCount int32
	mockClient := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			count := atomic.AddInt32(&callCount, 1)
			if count < 3 {
				// Return transient 503 Service Unavailable for first 2 attempts
				return &http.Response{
					StatusCode: http.StatusServiceUnavailable,
					Status:     "503 Service Unavailable",
					Body:       io.NopCloser(bytes.NewReader([]byte(`{"error":"temporarily unavailable"}`))),
					Header:     make(http.Header),
				}, nil
			}

			// Succeed on 3rd attempt
			respData, _ := json.Marshal(batchPushResponse{
				Success: true,
				Results: []batchPushResultItem{
					{LocalID: 1, RemoteID: 777},
				},
			})
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(bytes.NewReader(respData)),
				Header:     make(http.Header),
			}, nil
		},
	}

	engine := NewSyncEngine(database, "http://mock-server:8080")
	engine.SetAuthToken("sample-token")
	engine.SetHTTPClient(mockClient)
	engine.SetRetryPolicy(RetryPolicy{
		MaxAttempts: 4,
		BaseDelay:   10 * time.Millisecond,
		MaxDelay:    50 * time.Millisecond,
	})

	syncedCount, err := engine.PushTelemetry(context.Background())
	if err != nil {
		t.Fatalf("PushTelemetry with retry failed: %v", err)
	}

	if syncedCount != 1 {
		t.Errorf("expected 1 synced log, got %d", syncedCount)
	}

	if atomic.LoadInt32(&callCount) != 3 {
		t.Errorf("expected 3 attempts before success, got %d", atomic.LoadInt32(&callCount))
	}
}

func TestSecurityRemoteIDMismatchValidation(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	// Insert local log with ID=1
	_, err := database.InsertLog(&db.LogEntry{
		OrgID:       1,
		UserID:      1,
		Timestamp:   time.Now().UTC(),
		AppName:     "slack",
		WindowTitle: "general",
	})
	if err != nil {
		t.Fatalf("insert log failed: %v", err)
	}

	// Mock server returns success but with an un-requested or spoofed LocalID=999
	mockClient := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			respData, _ := json.Marshal(batchPushResponse{
				Success: true,
				Results: []batchPushResultItem{
					{LocalID: 999, RemoteID: 888}, // LocalID 999 was not in the batch!
				},
			})
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(bytes.NewReader(respData)),
				Header:     make(http.Header),
			}, nil
		},
	}

	engine := NewSyncEngine(database, "http://mock-server:8080")
	engine.SetAuthToken("token")
	engine.SetHTTPClient(mockClient)
	engine.SetRetryPolicy(RetryPolicy{
		MaxAttempts: 1,
		BaseDelay:   5 * time.Millisecond,
		MaxDelay:    10 * time.Millisecond,
	})

	syncedCount, err := engine.PushTelemetry(context.Background())
	if err != nil {
		t.Fatalf("PushTelemetry unexpected error: %v", err)
	}

	// Should not have marked any local logs synced because LocalID 999 doesn't match local log 1
	if syncedCount != 0 {
		t.Errorf("expected 0 synced logs due to security mismatch, got %d", syncedCount)
	}

	// Verify local log 1 is still pending
	pending, err := database.GetPendingUploadLogs(10)
	if err != nil || len(pending) != 1 {
		t.Errorf("expected local log to remain in pending state, pending len: %d", len(pending))
	}
}

// trackedReadCloser tracks whether Close() was invoked on response body.
type trackedReadCloser struct {
	io.Reader
	closed atomic.Bool
}

func (t *trackedReadCloser) Close() error {
	t.closed.Store(true)
	return nil
}

func TestResponseBodyDrainAndClose(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	_, err := database.InsertLog(&db.LogEntry{
		OrgID:     1,
		UserID:    1,
		Timestamp: time.Now().UTC(),
		AppName:   "browser",
	})
	if err != nil {
		t.Fatalf("insert log failed: %v", err)
	}

	tracker := &trackedReadCloser{
		Reader: bytes.NewReader([]byte(`{"success":true,"results":[{"local_id":1,"remote_id":555}]}`)),
	}

	mockClient := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       tracker,
				Header:     make(http.Header),
			}, nil
		},
	}

	engine := NewSyncEngine(database, "http://mock-server:8080")
	engine.SetHTTPClient(mockClient)
	engine.SetRetryPolicy(RetryPolicy{MaxAttempts: 1})

	_, err = engine.PushTelemetry(context.Background())
	if err != nil {
		t.Fatalf("PushTelemetry failed: %v", err)
	}

	if !tracker.closed.Load() {
		t.Errorf("response body was not closed, risk of socket leak")
	}
}

func TestNetworkFailureExhaustion(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	_, err := database.InsertLog(&db.LogEntry{
		OrgID:     1,
		UserID:    1,
		Timestamp: time.Now().UTC(),
		AppName:   "browser",
	})
	if err != nil {
		t.Fatalf("insert log failed: %v", err)
	}

	var attempts int32
	mockClient := &mockHTTPClient{
		doFunc: func(req *http.Request) (*http.Response, error) {
			atomic.AddInt32(&attempts, 1)
			return nil, errors.New("connection refused")
		},
	}

	engine := NewSyncEngine(database, "http://mock-server:8080")
	engine.SetHTTPClient(mockClient)
	engine.SetRetryPolicy(RetryPolicy{
		MaxAttempts: 3,
		BaseDelay:   5 * time.Millisecond,
		MaxDelay:    15 * time.Millisecond,
	})

	_, err = engine.PushTelemetry(context.Background())
	if err == nil {
		t.Fatalf("expected error on persistent network failure, got nil")
	}

	if atomic.LoadInt32(&attempts) != 3 {
		t.Errorf("expected 3 attempts before failure, got %d", atomic.LoadInt32(&attempts))
	}
}
