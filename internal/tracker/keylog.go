// Package tracker provides the Linux-native keystroke entropy monitor.
// It supports both direct /dev/input event monitoring and zero-sudo application/API input tracking.
// Zero-sudo tracking mode operates without root privileges, without 'sudo usermod -aG input $USER',
// and without requiring system logouts.
package tracker

import (
	"fmt"
	"math"
	"sync"
	"time"
)

// KeystrokeStats holds the keystroke uniqueness metrics for one interval.
type KeystrokeStats struct {
	TotalKeys    int     `json:"total_keys"`
	UniqueKeys   int     `json:"unique_keys"`
	EntropyScore float64 `json:"entropy_score"` // 0–100
}

// KeystrokeTracker monitors keyboard devices and aggregates keystroke uniqueness metrics.
type KeystrokeTracker struct {
	mu       sync.Mutex
	stopOnce sync.Once
	started  bool
	total    int
	unique   map[int]struct{}
	stopCh   chan struct{}
	interval time.Duration
}

// trackerDefaults are sane fallbacks for hostile/missing configuration.
const (
	defaultInterval = 30 * time.Second
	minInterval     = time.Second
	// syntheticKeyBase is where API-reported unique keys are mapped into the
	// key-code space (distinct from per-code evdev tracking; uniqueness is all
	// that matters for entropy scoring).
	syntheticKeyBase = 100
	// maxSyntheticUniqueKeys bounds API-reported unique keys per call so a
	// rogue payload can neither spin the insert loop nor bloat the map.
	maxSyntheticUniqueKeys = 256
)

// clampInterval guards time.NewTicker from a zero/negative interval panic and
// stops sub-second flush churn.
func clampInterval(interval time.Duration) time.Duration {
	if interval <= 0 {
		return defaultInterval
	}
	if interval < minInterval {
		return minInterval
	}
	return interval
}

// NewKeystrokeTracker creates a tracker with the given flush interval.
// Intervals <= 0 default to 30s; sub-second intervals are raised to 1s.
func NewKeystrokeTracker(interval time.Duration) *KeystrokeTracker {
	return &KeystrokeTracker{
		unique:   make(map[int]struct{}),
		stopCh:   make(chan struct{}),
		interval: clampInterval(interval),
	}
}

// Start launches native key capture (where supported) and a flush ticker.
// The provided channel receives a KeystrokeStats every interval.
// A second Start on the same tracker is rejected (the first aggregator would
// otherwise double-count); after Stop the tracker's goroutines are gone for
// good and must never be restarted.
func (t *KeystrokeTracker) Start() (<-chan KeystrokeStats, error) {
	t.mu.Lock()
	if t.started {
		t.mu.Unlock()
		return nil, fmt.Errorf("keystroke tracker already started")
	}
	t.started = true
	t.mu.Unlock()
	eventCh := make(chan int, 256)
	startNativeKeyCapture(eventCh, t.stopCh)

	// Aggregator
	go func() {
		for {
			select {
			case code := <-eventCh:
				t.mu.Lock()
				t.total++
				t.unique[code] = struct{}{}
				t.mu.Unlock()
			case <-t.stopCh:
				return
			}
		}
	}()

	statsCh := make(chan KeystrokeStats, 4)

	// Ticker flushes stats every interval
	go func() {
		ticker := time.NewTicker(t.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				stats := t.flush()
				select {
				case statsCh <- stats:
				default:
				}
			case <-t.stopCh:
				return
			}
		}
	}()

	return statsCh, nil
}

// RecordKeystrokes records keystroke activity submitted via API or desktop frontend.
// Negative values are ignored, and unique is clamped so it can never exceed
// total (or the synthetic-key cap), keeping entropy math inside 0-100.
func (t *KeystrokeTracker) RecordKeystrokes(total, unique int) {
	if total < 0 {
		total = 0
	}
	if unique < 0 {
		unique = 0
	}
	if unique > total {
		unique = total
	}
	if unique > maxSyntheticUniqueKeys {
		unique = maxSyntheticUniqueKeys
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	t.total += total
	if t.unique == nil {
		t.unique = make(map[int]struct{})
	}
	for i := 0; i < unique; i++ {
		t.unique[syntheticKeyBase+i] = struct{}{}
	}
}

// RecordKeyCode records a single keypress event code.
func (t *KeystrokeTracker) RecordKeyCode(code int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.total++
	if t.unique == nil {
		t.unique = make(map[int]struct{})
	}
	t.unique[code] = struct{}{}
}

// Stop signals all goroutines to exit. Safe to call multiple times.
func (t *KeystrokeTracker) Stop() {
	t.stopOnce.Do(func() { close(t.stopCh) })
}

// flush atomically reads and resets the counters, then computes the entropy score.
func (t *KeystrokeTracker) flush() KeystrokeStats {
	t.mu.Lock()
	total := t.total
	unique := len(t.unique)
	t.total = 0
	t.unique = make(map[int]struct{})
	t.mu.Unlock()

	score := ComputeEntropyScore(total, unique)
	return KeystrokeStats{
		TotalKeys:    total,
		UniqueKeys:   unique,
		EntropyScore: score,
	}
}

// ComputeEntropyScore returns a 0–100 score:
// high score = lots of distinct keys (real typing), low score = repetitive or idle.
// Hostile input (negative total, negative/oversized unique) is clamped so the
// result is always a sane number in [0, 100] — never NaN (a NaN score would
// break JSON serialization and the DB write path).
func ComputeEntropyScore(total, unique int) float64 {
	if total <= 0 {
		return 0
	}
	if unique < 0 {
		unique = 0
	}
	if unique > total {
		unique = total
	}
	// Uniqueness ratio × log factor, capped at 100
	ratio := float64(unique) / float64(total)
	logFactor := math.Log2(float64(total) + 1)
	score := ratio * logFactor * 10
	if score > 100 {
		score = 100
	}
	if score < 0 {
		score = 0
	}
	return math.Round(score*10) / 10
}
