package tracker

import (
	"math"
	"sync"
	"testing"
	"time"
)

func TestComputeEntropyScore(t *testing.T) {
	tests := []struct {
		name     string
		total    int
		unique   int
		minScore float64
		maxScore float64
	}{
		{
			name:     "zero keys",
			total:    0,
			unique:   0,
			minScore: 0,
			maxScore: 0,
		},
		{
			name:     "repetitive key typing (aaaa)",
			total:    100,
			unique:   1,
			minScore: 0,
			maxScore: 10,
		},
		{
			name:     "high diversity typing",
			total:    100,
			unique:   40,
			minScore: 20,
			maxScore: 100,
		},
		{
			name:     "high volume and high unique keys",
			total:    1000,
			unique:   500,
			minScore: 40,
			maxScore: 60,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			score := ComputeEntropyScore(tt.total, tt.unique)
			if score < tt.minScore || score > tt.maxScore {
				t.Errorf("ComputeEntropyScore(%d, %d) = %f; want score between %f and %f",
					tt.total, tt.unique, score, tt.minScore, tt.maxScore)
			}
		})
	}
}

// TestComputeEntropyScoreHostileInput guards the 0-100 contract: negative or
// nonsensical inputs (e.g. hostile /api/tracker/input payloads) must never
// produce NaN or an out-of-range score (NaN breaks JSON serialization all the
// way to the DB/bundle layers).
func TestComputeEntropyScoreHostileInput(t *testing.T) {
	tests := []struct {
		name   string
		total  int
		unique int
	}{
		{"negative total", -5, 3},
		{"negative unique", 10, -3},
		{"negative both", -10, -3},
		{"zero total with keys", 0, 5},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			score := ComputeEntropyScore(tt.total, tt.unique)
			if math.IsNaN(score) {
				t.Fatalf("ComputeEntropyScore(%d, %d) = NaN; want value in [0,100]", tt.total, tt.unique)
			}
			if score < 0 || score > 100 {
				t.Fatalf("ComputeEntropyScore(%d, %d) = %f; want value in [0,100]", tt.total, tt.unique, score)
			}
		})
	}
}

// TestComputeEntropyScoreUniqueAboveTotal ensures unique > total is clamped
// (uniqueness is a ratio; more distinct keys than pressed keys is impossible).
func TestComputeEntropyScoreUniqueAboveTotal(t *testing.T) {
	score := ComputeEntropyScore(10, 20)
	if math.IsNaN(score) || score < 0 || score > 100 {
		t.Fatalf("ComputeEntropyScore(10, 20) = %f; want value in [0,100]", score)
	}
	// Clamped to unique==total → ratio 1.0 → same as (10, 10).
	if want := ComputeEntropyScore(10, 10); score != want {
		t.Fatalf("ComputeEntropyScore(10, 20) = %f; want clamped to (10,10) = %f", score, want)
	}
}

// TestNewKeystrokeTrackerClampsInterval ensures extreme interval values are
// clamped: zero/negative must not panic time.NewTicker and sub-second values
// must not cause high-frequency flush churn.
func TestNewKeystrokeTrackerClampsInterval(t *testing.T) {
	tests := []struct {
		name string
		in   time.Duration
		want time.Duration
	}{
		{"zero", 0, 30 * time.Second},
		{"negative", -5 * time.Second, 30 * time.Second},
		{"sub-second", 500 * time.Millisecond, time.Second},
		{"normal", 30 * time.Second, 30 * time.Second},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tr := NewKeystrokeTracker(tt.in)
			if tr.interval != tt.want {
				t.Fatalf("NewKeystrokeTracker(%v).interval = %v; want %v", tt.in, tr.interval, tt.want)
			}
			tr.Stop()
		})
	}
}

// TestKeystrokeTrackerDoubleStartRejected ensures a second Start is rejected
// instead of silently spawning duplicate aggregators that double-count keys.
func TestKeystrokeTrackerDoubleStartRejected(t *testing.T) {
	tr := NewKeystrokeTracker(time.Second)
	defer tr.Stop()

	if _, err := tr.Start(); err != nil {
		t.Fatalf("first Start(): %v", err)
	}
	if _, err := tr.Start(); err == nil {
		t.Fatal("second Start() must be rejected, duplicate aggregators would double-count keystrokes")
	}
}

// TestRecordKeystrokesHostileInput ensures negative totals/unique are ignored
// and the synthetic unique-key insertion from API input is bounded so a rogue
// API payload can neither decrement nor DoS the counter loop.
func TestRecordKeystrokesHostileInput(t *testing.T) {
	tr := NewKeystrokeTracker(time.Second)
	defer tr.Stop()

	tr.RecordKeystrokes(5, 2)
	tr.RecordKeystrokes(-100, -3) // must be a no-op, never decrement

	if got := tr.total; got != 5 {
		t.Fatalf("total after hostile record = %d; want 5", got)
	}
	if got := len(tr.unique); got != 2 {
		t.Fatalf("unique after hostile record = %d; want 2", got)
	}

	// Oversized unique payload: capped per call, must return quickly and only
	// add keys bounded by the call total.
	tr.RecordKeystrokes(1, 1_000_000)
	if got := tr.total; got != 6 {
		t.Fatalf("total after oversized unique = %d; want 6", got)
	}
}

// TestKeystrokeTrackerFlushAtomic exercises concurrent RecordKeyCode writers
// against flush() to prove the counters never lose or double-count events
// (run with -race).
func TestKeystrokeTrackerFlushAtomic(t *testing.T) {
	tr := NewKeystrokeTracker(time.Second)
	defer tr.Stop()

	const goroutines = 8
	const perGoroutine = 200

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(base int) {
			defer wg.Done()
			for i := 0; i < perGoroutine; i++ {
				tr.RecordKeyCode(base + i%10)
			}
		}(g * 10)
	}
	wg.Wait()

	// All writers done: the first flush must hold everything, the second must
	// be empty (counters reset atomically under the mutex).
	first := tr.flush()
	if first.TotalKeys != goroutines*perGoroutine {
		t.Fatalf("first flush total = %d; want %d", first.TotalKeys, goroutines*perGoroutine)
	}
	second := tr.flush()
	if second.TotalKeys != 0 {
		t.Fatalf("second flush total = %d; want 0 (counters must reset atomically)", second.TotalKeys)
	}
}

// TestKeystrokeTrackerStopIdempotent ensures Stop is safe to call repeatedly.
func TestKeystrokeTrackerStopIdempotent(t *testing.T) {
	tr := NewKeystrokeTracker(time.Second)
	if _, err := tr.Start(); err != nil {
		t.Fatalf("Start(): %v", err)
	}
	tr.Stop()
	tr.Stop()
	tr.Stop()
}
