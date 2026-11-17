package main

import (
	"os"
	"testing"
	"time"

	"github.com/reak/get-hike/internal/db"
	"github.com/reak/get-hike/internal/tracker"
)

func TestAppResolveIdleInterval(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "minitracker-app-idle-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	database, err := db.Open(tmpDir)
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	defer database.Close()

	app := NewApp()
	app.database = database
	app.idleDetector = tracker.NewIdleDetector(true, 1*time.Minute, nil, nil)
	defer app.idleDetector.Stop()

	// Simulate transition to AwaitingCategorization
	app.idleDetector.SetDurationFunc(func() time.Duration { return 70 * time.Second })
	app.idleDetector.CheckIdleNow()
	app.idleDetector.SetDurationFunc(func() time.Duration { return 2 * time.Second })
	app.idleDetector.CheckIdleNow()

	if s := app.idleDetector.GetState(); s != tracker.StateAwaitingCategorization {
		t.Fatalf("expected state AWAITING_CATEGORIZATION, got %v", s)
	}

	st := time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339)
	et := time.Now().UTC().Format(time.RFC3339)

	// Resolve as productive meeting
	id, err := app.ResolveIdleInterval(st, et, "meeting", "Meeting", "Client sync", true, 95.0)
	if err != nil {
		t.Fatalf("ResolveIdleInterval failed: %v", err)
	}
	if id <= 0 {
		t.Fatalf("expected positive ID, got %d", id)
	}

	// Verify detector transitioned to StateActive
	if s := app.idleDetector.GetState(); s != tracker.StateActive {
		t.Fatalf("expected state ACTIVE after ResolveIdleInterval, got %v", s)
	}

	// Verify session time credited
	app.statsMu.Lock()
	accum := app.accumulatedSec
	app.statsMu.Unlock()
	if accum < 590 || accum > 610 {
		t.Fatalf("expected ~600 seconds accumulated, got %d", accum)
	}
}
