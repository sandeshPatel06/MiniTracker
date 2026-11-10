package tracker

import (
	"testing"
	"time"
)

// TestNewMouseTrackerClampsInterval ensures extreme interval values are
// clamped: zero/negative must not panic time.NewTicker and sub-second values
// must not cause high-frequency flush churn.
func TestNewMouseTrackerClampsInterval(t *testing.T) {
	tests := []struct {
		name string
		in   time.Duration
		want time.Duration
	}{
		{"zero", 0, 30 * time.Second},
		{"negative", -5 * time.Second, 30 * time.Second},
		{"sub-second", 250 * time.Millisecond, time.Second},
		{"normal", 30 * time.Second, 30 * time.Second},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tr := NewMouseTracker(tt.in)
			if tr.interval != tt.want {
				t.Fatalf("NewMouseTracker(%v).interval = %v; want %v", tt.in, tr.interval, tt.want)
			}
			tr.Stop()
		})
	}
}

// TestMouseTrackerDoubleStartRejected ensures a second Start is rejected
// instead of silently spawning duplicate aggregators that double-count clicks.
func TestMouseTrackerDoubleStartRejected(t *testing.T) {
	tr := NewMouseTracker(time.Second)
	defer tr.Stop()

	if _, err := tr.Start(); err != nil {
		t.Fatalf("first Start(): %v", err)
	}
	if _, err := tr.Start(); err == nil {
		t.Fatal("second Start() must be rejected, duplicate aggregators would double-count clicks")
	}
}

// TestRecordMouseActivityRejectsNegative ensures negative click payloads cannot
// decrement the counter (hostile/graph-broken API input).
func TestRecordMouseActivityRejectsNegative(t *testing.T) {
	tr := NewMouseTracker(time.Second)
	defer tr.Stop()

	tr.RecordMouseActivity(7)
	tr.RecordMouseActivity(-100)

	if got := tr.clicks; got != 7 {
		t.Fatalf("clicks after negative payload = %d; want 7", got)
	}
}

// TestMouseTrackerFlushResets proves flush reads and resets atomically.
func TestMouseTrackerFlushResets(t *testing.T) {
	tr := NewMouseTracker(time.Second)
	defer tr.Stop()

	tr.RecordMouseActivity(7)
	if got := tr.flush(); got.TotalClicks != 7 {
		t.Fatalf("first flush = %d; want 7", got.TotalClicks)
	}
	if got := tr.flush(); got.TotalClicks != 0 {
		t.Fatalf("second flush = %d; want 0 (counter must reset)", got.TotalClicks)
	}
}

// TestMouseTrackerStopIdempotent ensures Stop is safe to call repeatedly.
func TestMouseTrackerStopIdempotent(t *testing.T) {
	tr := NewMouseTracker(time.Second)
	if _, err := tr.Start(); err != nil {
		t.Fatalf("Start(): %v", err)
	}
	tr.Stop()
	tr.Stop()
	tr.Stop()
}
