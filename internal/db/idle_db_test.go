package db

import (
	"strings"
	"sync"
	"testing"
	"time"
)

// TestAllocateIdleBlockProductive verifies meeting / productive retroactive allocation:
// - IdleInterval record created with status="allocated"
// - Correct number of synthetic logs created across [StartTime, EndTime)
// - Synthetic logs have correct properties (productive_score, is_productive, is_retroactive=1, idle_interval_id)
func TestAllocateIdleBlockProductive(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	now := time.Now().UTC().Truncate(time.Second)
	startTime := now.Add(-10 * time.Minute)
	endTime := now // 10 minutes = 600s -> at 30s interval = 20 synthetic logs

	params := RetroactiveAllocationParams{
		OrgID:           1,
		UserID:          1,
		StartTime:       startTime,
		EndTime:         endTime,
		ActionType:      "meeting",
		Category:        "Meeting",
		TaskTag:         "Sprint Planning",
		IsProductive:    true,
		ProductiveScore: 90.0,
		IntervalSec:     30,
	}

	intervalID, err := database.AllocateIdleBlock(params)
	if err != nil {
		t.Fatalf("AllocateIdleBlock failed: %v", err)
	}
	if intervalID <= 0 {
		t.Fatalf("expected positive intervalID, got %d", intervalID)
	}

	// Verify idle_intervals table
	var dbOrgID, dbUserID, dbDur, dbProductive int64
	var dbStatus, dbAction, dbCategory, dbTaskTag string
	var dbScore float64
	row := database.rawDB.QueryRow(
		"SELECT org_id, user_id, duration_seconds, status, action_type, category, task_tag, is_productive, productive_score FROM idle_intervals WHERE id = ?",
		intervalID,
	)
	if err := row.Scan(&dbOrgID, &dbUserID, &dbDur, &dbStatus, &dbAction, &dbCategory, &dbTaskTag, &dbProductive, &dbScore); err != nil {
		t.Fatalf("failed to query idle_intervals: %v", err)
	}

	if dbStatus != "allocated" {
		t.Errorf("expected status 'allocated', got '%s'", dbStatus)
	}
	if dbDur != 600 {
		t.Errorf("expected duration 600s, got %d", dbDur)
	}
	if dbProductive != 1 {
		t.Errorf("expected is_productive 1, got %d", dbProductive)
	}
	if dbScore != 90.0 {
		t.Errorf("expected productive_score 90.0, got %f", dbScore)
	}
	if dbAction != "meeting" || dbCategory != "Meeting" || dbTaskTag != "Sprint Planning" {
		t.Errorf("mismatched metadata: action=%s, cat=%s, tag=%s", dbAction, dbCategory, dbTaskTag)
	}

	// Verify synthetic logs in logs table
	rows, err := database.rawDB.Query(
		"SELECT id, org_id, user_id, timestamp, app_name, app_category, window_title, is_productive, productive_score, is_retroactive, idle_interval_id, ai_confidence, ai_reason FROM logs WHERE idle_interval_id = ? ORDER BY timestamp ASC",
		intervalID,
	)
	if err != nil {
		t.Fatalf("failed to query synthetic logs: %v", err)
	}
	defer rows.Close()

	logCount := 0
	for rows.Next() {
		logCount++
		var logID, lOrg, lUser, isProd, isRetro, intID int64
		var ts, appName, appCat, winTitle, reason string
		var pScore, conf float64
		if err := rows.Scan(&logID, &lOrg, &lUser, &ts, &appName, &appCat, &winTitle, &isProd, &pScore, &isRetro, &intID, &conf, &reason); err != nil {
			t.Fatalf("scan log row failed: %v", err)
		}

		if isProd != 1 {
			t.Errorf("synthetic log %d: expected is_productive 1, got %d", logID, isProd)
		}
		if isRetro != 1 {
			t.Errorf("synthetic log %d: expected is_retroactive 1, got %d", logID, isRetro)
		}
		if pScore != 90.0 {
			t.Errorf("synthetic log %d: expected productive_score 90.0, got %f", logID, pScore)
		}
		if appName != "Meeting" || appCat != "Meeting" || winTitle != "Sprint Planning" {
			t.Errorf("synthetic log %d: unexpected app/title: %s / %s", logID, appName, winTitle)
		}
		if !strings.Contains(reason, "Sprint Planning") {
			t.Errorf("synthetic log %d: expected reason to contain task tag, got %s", logID, reason)
		}
	}

	expectedLogs := 600 / 30 // 20
	if logCount != expectedLogs {
		t.Errorf("expected %d synthetic logs, got %d", expectedLogs, logCount)
	}
}

// TestAllocateIdleBlockBreak verifies break / non-productive retroactive allocation.
func TestAllocateIdleBlockBreak(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	now := time.Now().UTC().Truncate(time.Second)
	startTime := now.Add(-5 * time.Minute) // 300s -> 10 logs
	endTime := now

	params := RetroactiveAllocationParams{
		OrgID:           1,
		UserID:          1,
		StartTime:       startTime,
		EndTime:         endTime,
		ActionType:      "break",
		Category:        "Break",
		TaskTag:         "Coffee Break",
		IsProductive:    false,
		ProductiveScore: 20.0,
		IntervalSec:     30,
	}

	intervalID, err := database.AllocateIdleBlock(params)
	if err != nil {
		t.Fatalf("AllocateIdleBlock failed: %v", err)
	}

	var isProductive int64
	var score float64
	var status string
	err = database.rawDB.QueryRow("SELECT status, is_productive, productive_score FROM idle_intervals WHERE id = ?", intervalID).
		Scan(&status, &isProductive, &score)
	if err != nil {
		t.Fatalf("query idle_intervals failed: %v", err)
	}

	if status != "allocated" || isProductive != 0 || score != 20.0 {
		t.Errorf("unexpected interval record: status=%s, prod=%d, score=%f", status, isProductive, score)
	}

	var count int
	_ = database.rawDB.QueryRow("SELECT COUNT(*) FROM logs WHERE idle_interval_id = ? AND is_productive = 0", intervalID).Scan(&count)
	if count != 10 {
		t.Errorf("expected 10 non-productive synthetic logs, got %d", count)
	}
}

// TestAllocateIdleBlockDiscard verifies discard allocation:
// - idle_intervals record is saved with status="discarded"
// - NO synthetic logs are injected into the logs table
func TestAllocateIdleBlockDiscard(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	now := time.Now().UTC().Truncate(time.Second)
	startTime := now.Add(-15 * time.Minute)
	endTime := now

	params := RetroactiveAllocationParams{
		OrgID:           1,
		UserID:          1,
		StartTime:       startTime,
		EndTime:         endTime,
		ActionType:      "discard",
		Category:        "Discarded",
		TaskTag:         "Away from keyboard",
		IsProductive:    false,
		ProductiveScore: 0.0,
		IntervalSec:     30,
	}

	intervalID, err := database.AllocateIdleBlock(params)
	if err != nil {
		t.Fatalf("AllocateIdleBlock discard failed: %v", err)
	}

	var status string
	var durSec int64
	err = database.rawDB.QueryRow("SELECT status, duration_seconds FROM idle_intervals WHERE id = ?", intervalID).
		Scan(&status, &durSec)
	if err != nil {
		t.Fatalf("query idle_intervals failed: %v", err)
	}

	if status != "discarded" {
		t.Errorf("expected status 'discarded', got '%s'", status)
	}
	if durSec != 900 {
		t.Errorf("expected duration 900s, got %d", durSec)
	}

	// Verify zero synthetic logs were created
	var logCount int
	_ = database.rawDB.QueryRow("SELECT COUNT(*) FROM logs WHERE idle_interval_id = ?", intervalID).Scan(&logCount)
	if logCount != 0 {
		t.Errorf("expected 0 synthetic logs for discarded block, got %d", logCount)
	}
}

// TestAllocateIdleBlockEdgeCases tests hostile and degenerate intervals:
// - EndTime <= StartTime (0 duration or negative interval)
// - Default IntervalSec fallback (when <= 0, defaults to 30s)
func TestAllocateIdleBlockEdgeCases(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	now := time.Now().UTC()

	// 1. Zero duration (EndTime == StartTime)
	_, err := database.AllocateIdleBlock(RetroactiveAllocationParams{
		StartTime: now,
		EndTime:   now,
	})
	if err == nil {
		t.Fatalf("expected error for zero duration interval, got nil")
	}

	// 2. Negative duration (EndTime before StartTime)
	_, err = database.AllocateIdleBlock(RetroactiveAllocationParams{
		StartTime: now,
		EndTime:   now.Add(-5 * time.Minute),
	})
	if err == nil {
		t.Fatalf("expected error for negative duration interval, got nil")
	}

	// 3. Default IntervalSec fallback (0 or negative IntervalSec)
	intervalID, err := database.AllocateIdleBlock(RetroactiveAllocationParams{
		OrgID:        1,
		UserID:       1,
		StartTime:    now.Add(-60 * time.Second),
		EndTime:      now,
		ActionType:   "meeting",
		Category:     "Meeting",
		IntervalSec:  0, // should default to 30s -> 2 logs
		IsProductive: true,
	})
	if err != nil {
		t.Fatalf("expected fallback to 30s interval, got error: %v", err)
	}
	var count int
	_ = database.rawDB.QueryRow("SELECT COUNT(*) FROM logs WHERE idle_interval_id = ?", intervalID).Scan(&count)
	if count != 2 {
		t.Errorf("expected 2 synthetic logs with default 30s interval, got %d", count)
	}
}

// TestAllocateIdleBlockConcurrent tests thread safety and concurrent allocations.
func TestAllocateIdleBlockConcurrent(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	now := time.Now().UTC()
	var wg sync.WaitGroup

	numGoroutines := 10
	errCh := make(chan error, numGoroutines)

	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			offset := time.Duration(idx*10) * time.Minute
			st := now.Add(-offset - 5*time.Minute)
			et := now.Add(-offset)

			action := "meeting"
			if idx%2 == 0 {
				action = "discard"
			}

			_, err := database.AllocateIdleBlock(RetroactiveAllocationParams{
				OrgID:           1,
				UserID:          1,
				StartTime:       st,
				EndTime:         et,
				ActionType:      action,
				Category:        "Test",
				TaskTag:         "Concurrent Task",
				IsProductive:    idx%2 != 0,
				ProductiveScore: 80.0,
				IntervalSec:     30,
			})
			if err != nil {
				errCh <- err
			}
		}(i)
	}

	wg.Wait()
	close(errCh)

	for err := range errCh {
		t.Errorf("concurrent allocate error: %v", err)
	}

	var count int
	_ = database.rawDB.QueryRow("SELECT COUNT(*) FROM idle_intervals").Scan(&count)
	if count != numGoroutines {
		t.Errorf("expected %d idle_intervals, got %d", numGoroutines, count)
	}
}

// TestAllocateIdleBlockNoOverlap verifies that synthetic logs skip minutes where real tracked logs already exist.
func TestAllocateIdleBlockNoOverlap(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	baseTime := time.Now().UTC().Truncate(time.Minute)
	startTime := baseTime.Add(-10 * time.Minute)
	endTime := baseTime

	// Pre-insert real tracked logs at minute -5 and minute -4
	realLog1Time := baseTime.Add(-5 * time.Minute)
	realLog2Time := baseTime.Add(-4 * time.Minute)

	_, err := database.InsertLog(&LogEntry{
		OrgID:         1,
		UserID:        1,
		Timestamp:     realLog1Time,
		AppName:       "Code",
		WindowTitle:   "main.go",
		IsRetroactive: false,
	})
	if err != nil {
		t.Fatalf("failed to insert realLog1: %v", err)
	}

	_, err = database.InsertLog(&LogEntry{
		OrgID:         1,
		UserID:        1,
		Timestamp:     realLog2Time,
		AppName:       "Code",
		WindowTitle:   "main.go",
		IsRetroactive: false,
	})
	if err != nil {
		t.Fatalf("failed to insert realLog2: %v", err)
	}

	params := RetroactiveAllocationParams{
		OrgID:           1,
		UserID:          1,
		StartTime:       startTime,
		EndTime:         endTime,
		ActionType:      "meeting",
		Category:        "Meeting",
		TaskTag:         "Sprint Discussion",
		IsProductive:    true,
		ProductiveScore: 85.0,
		IntervalSec:     60, // 1 log per minute: total 10 minutes, but 2 are already tracked -> expected 8 synthetic logs
	}

	intervalID, err := database.AllocateIdleBlock(params)
	if err != nil {
		t.Fatalf("AllocateIdleBlock failed: %v", err)
	}

	var syntheticCount int
	err = database.rawDB.QueryRow("SELECT COUNT(*) FROM logs WHERE idle_interval_id = ?", intervalID).Scan(&syntheticCount)
	if err != nil {
		t.Fatalf("query synthetic logs failed: %v", err)
	}

	if syntheticCount != 8 {
		t.Errorf("expected 8 synthetic logs (10 minus 2 overlapping), got %d", syntheticCount)
	}

	// Verify that none of the synthetic logs have timestamps matching the real logs' minute
	rows, err := database.rawDB.Query("SELECT timestamp FROM logs WHERE idle_interval_id = ?", intervalID)
	if err != nil {
		t.Fatalf("query timestamps failed: %v", err)
	}
	defer rows.Close()

	for rows.Next() {
		var tsStr string
		if err := rows.Scan(&tsStr); err == nil {
			parsed, _ := time.Parse(time.RFC3339, tsStr)
			if parsed.Truncate(time.Minute).Equal(realLog1Time) || parsed.Truncate(time.Minute).Equal(realLog2Time) {
				t.Errorf("synthetic log generated at overlapping timestamp minute: %s", tsStr)
			}
		}
	}
}
