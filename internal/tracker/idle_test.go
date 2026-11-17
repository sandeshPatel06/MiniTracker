package tracker

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestIdleDetectorStateTransitions tests ACTIVE -> IDLE -> AWAITING_CATEGORIZATION -> ACTIVE.
func TestIdleDetectorStateTransitions(t *testing.T) {
	var enteredCalled atomic.Bool
	var resumedCalled atomic.Bool
	var resumedBlock IdleBlock

	threshold := 1 * time.Minute

	d := NewIdleDetector(
		true,
		threshold,
		func(startedAt time.Time) {
			enteredCalled.Store(true)
		},
		func(block IdleBlock) {
			resumedBlock = block
			resumedCalled.Store(true)
		},
	)
	defer d.Stop()

	// Initial State should be ACTIVE
	if s := d.GetState(); s != StateActive {
		t.Fatalf("expected initial state ACTIVE, got %v", s)
	}

	// 1. Below threshold: Should remain ACTIVE
	var currentIdle atomic.Int64
	currentIdle.Store(int64(30 * time.Second))
	d.SetDurationFunc(func() time.Duration {
		return time.Duration(currentIdle.Load())
	})

	d.CheckIdleNow()
	if s := d.GetState(); s != StateActive {
		t.Fatalf("expected state ACTIVE when idleDur < threshold, got %v", s)
	}
	if enteredCalled.Load() {
		t.Fatalf("onIdleEntered should not be called below threshold")
	}

	// 2. Threshold exceeded (70s >= 60s): Transition to IDLE
	currentIdle.Store(int64(70 * time.Second))
	d.CheckIdleNow()

	// Give the goroutine callback a moment
	time.Sleep(20 * time.Millisecond)

	if s := d.GetState(); s != StateIdle {
		t.Fatalf("expected state IDLE after exceeding threshold, got %v", s)
	}
	if !enteredCalled.Load() {
		t.Fatalf("onIdleEntered should have been called")
	}

	// While in IDLE, staying idle (> 10s) maintains IDLE state
	currentIdle.Store(int64(80 * time.Second))
	d.CheckIdleNow()
	if s := d.GetState(); s != StateIdle {
		t.Fatalf("expected state to remain IDLE, got %v", s)
	}

	// 3. User returns: idle duration drops below 10s (e.g., 2s) -> AWAITING_CATEGORIZATION
	currentIdle.Store(int64(2 * time.Second))
	d.CheckIdleNow()

	time.Sleep(20 * time.Millisecond)

	if s := d.GetState(); s != StateAwaitingCategorization {
		t.Fatalf("expected state AWAITING_CATEGORIZATION after user returns, got %v", s)
	}
	if !resumedCalled.Load() {
		t.Fatalf("onIdleResumed should have been called on return")
	}
	if resumedBlock.DurationSeconds <= 0 {
		t.Fatalf("expected positive duration_seconds in IdleBlock, got %d", resumedBlock.DurationSeconds)
	}
	if resumedBlock.EndTime.Before(resumedBlock.StartTime) {
		t.Fatalf("expected EndTime >= StartTime, got start=%v, end=%v", resumedBlock.StartTime, resumedBlock.EndTime)
	}

	// While awaiting categorization, further checks stay in AWAITING_CATEGORIZATION
	d.CheckIdleNow()
	if s := d.GetState(); s != StateAwaitingCategorization {
		t.Fatalf("expected state to stay AWAITING_CATEGORIZATION, got %v", s)
	}

	// 4. MarkResolved returns to ACTIVE
	d.MarkResolved()
	if s := d.GetState(); s != StateActive {
		t.Fatalf("expected state ACTIVE after MarkResolved, got %v", s)
	}
}

// TestIdleDetectorThresholdClamping tests min threshold enforcement.
func TestIdleDetectorThresholdClamping(t *testing.T) {
	// Creating with < 30s should clamp to 5m
	d := NewIdleDetector(true, 10*time.Second, nil, nil)
	defer d.Stop()

	if d.threshold != 5*time.Minute {
		t.Fatalf("expected threshold clamped to 5m, got %v", d.threshold)
	}

	// Updating with >= 30s updates correctly
	d.SetThreshold(45 * time.Second)
	if d.threshold != 45*time.Second {
		t.Fatalf("expected threshold updated to 45s, got %v", d.threshold)
	}

	// Updating with < 30s is rejected/ignored
	d.SetThreshold(15 * time.Second)
	if d.threshold != 45*time.Second {
		t.Fatalf("expected threshold to remain 45s after invalid update, got %v", d.threshold)
	}
}

// TestIdleDetectorDisabledBehavior ensures disabled detector does nothing.
func TestIdleDetectorDisabledBehavior(t *testing.T) {
	var enteredCalled atomic.Bool
	d := NewIdleDetector(false, 30*time.Second, func(time.Time) {
		enteredCalled.Store(true)
	}, nil)
	defer d.Stop()

	d.SetDurationFunc(func() time.Duration {
		return 10 * time.Minute
	})

	d.CheckIdleNow()
	if s := d.GetState(); s != StateActive {
		t.Fatalf("expected state to stay ACTIVE when disabled, got %v", s)
	}
	if enteredCalled.Load() {
		t.Fatalf("onIdleEntered called while disabled")
	}

	// Enabling resumes normal check
	d.SetEnabled(true)
	d.CheckIdleNow()
	if s := d.GetState(); s != StateIdle {
		t.Fatalf("expected state to switch to IDLE after enabling, got %v", s)
	}
}

// TestIdleDetectorRecordActivity resets in-memory atomic timestamp.
func TestIdleDetectorRecordActivity(t *testing.T) {
	d := NewIdleDetector(true, 1*time.Minute, nil, nil)
	defer d.Stop()

	// Ensure no testDurFn override
	d.SetDurationFunc(nil)

	// Simulate old activity (e.g. 10 seconds ago)
	oldTime := time.Now().Add(-10 * time.Second).UnixNano()
	d.lastInputUnixNano.Store(oldTime)

	// GetIdleDuration should be >= 10 seconds (assuming no X11/dbus override)
	// Even if DBus returns something, RecordActivity should update lastInputUnixNano.
	d.RecordActivity()
	nano := d.lastInputUnixNano.Load()
	if time.Since(time.Unix(0, nano)) > 1*time.Second {
		t.Fatalf("expected lastInputUnixNano to be freshly updated")
	}
}

// TestIdleDetectorStopIdempotent tests multiple Stop calls without panicking.
func TestIdleDetectorStopIdempotent(t *testing.T) {
	d := NewIdleDetector(true, 1*time.Minute, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	d.Start(ctx)

	// Multiple Stop() calls must be safe and idempotent
	for i := 0; i < 5; i++ {
		d.Stop()
	}
}

// TestIdleDetectorConcurrency tests race conditions between RecordActivity, checkIdle, and MarkResolved.
func TestIdleDetectorConcurrency(t *testing.T) {
	d := NewIdleDetector(true, 30*time.Second, func(time.Time) {}, func(IdleBlock) {})
	defer d.Stop()

	var curDur atomic.Int64
	curDur.Store(int64(5 * time.Second))
	d.SetDurationFunc(func() time.Duration {
		return time.Duration(curDur.Load())
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var wg sync.WaitGroup

	// Goroutine 1: Continuous RecordActivity
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			default:
				d.RecordActivity()
				time.Sleep(1 * time.Millisecond)
			}
		}
	}()

	// Goroutine 2: Continuous checkIdle
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			default:
				d.CheckIdleNow()
				time.Sleep(2 * time.Millisecond)
			}
		}
	}()

	// Goroutine 3: Fluctuating idle durations
	wg.Add(1)
	go func() {
		defer wg.Done()
		toggle := false
		for {
			select {
			case <-ctx.Done():
				return
			default:
				toggle = !toggle
				if toggle {
					curDur.Store(int64(40 * time.Second))
				} else {
					curDur.Store(int64(2 * time.Second))
				}
				time.Sleep(5 * time.Millisecond)
			}
		}
	}()

	// Goroutine 4: Continuous MarkResolved and SetEnabled
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			default:
				d.MarkResolved()
				d.SetEnabled(true)
				_ = d.GetState()
				time.Sleep(3 * time.Millisecond)
			}
		}
	}()

	wg.Wait()
}

// TestIdleDetectorInvertedTimeProtection verifies boundary safety when clock skews or idleStartedAt is corrupted.
func TestIdleDetectorInvertedTimeProtection(t *testing.T) {
	var blockReceived IdleBlock
	var resumedCalled atomic.Bool

	d := NewIdleDetector(
		true,
		30*time.Second,
		nil,
		func(block IdleBlock) {
			blockReceived = block
			resumedCalled.Store(true)
		},
	)
	defer d.Stop()

	// 1. Force into StateIdle
	d.mu.Lock()
	d.state = StateIdle
	// Set an impossible future start time (clock jumped backwards or corrupt)
	d.idleStartedAt = time.Now().Add(10 * time.Minute)
	d.mu.Unlock()

	// 2. Simulate return
	d.SetDurationFunc(func() time.Duration {
		return 2 * time.Second
	})
	d.CheckIdleNow()

	time.Sleep(20 * time.Millisecond)

	if !resumedCalled.Load() {
		t.Fatalf("expected onIdleResumed to be called")
	}
	if blockReceived.DurationSeconds < 0 {
		t.Fatalf("expected non-negative duration_seconds, got %d", blockReceived.DurationSeconds)
	}
	if blockReceived.EndTime.Before(blockReceived.StartTime) {
		t.Fatalf("expected EndTime >= StartTime, got EndTime=%v, StartTime=%v", blockReceived.EndTime, blockReceived.StartTime)
	}
}
