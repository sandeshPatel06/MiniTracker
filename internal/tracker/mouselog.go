package tracker

import (
	"fmt"
	"sync"
	"time"
)

// MouseStats holds mouse click metrics for one flush interval.
type MouseStats struct {
	TotalClicks int `json:"total_clicks"`
}

// MouseTracker monitors mouse/pointer input devices and aggregates click metrics.
type MouseTracker struct {
	mu       sync.Mutex
	stopOnce sync.Once
	started  bool
	clicks   int
	stopCh   chan struct{}
	interval time.Duration
}

// NewMouseTracker creates a new MouseTracker with the given flush interval.
// Intervals <= 0 default to 30s; sub-second intervals are raised to 1s.
func NewMouseTracker(interval time.Duration) *MouseTracker {
	return &MouseTracker{
		stopCh:   make(chan struct{}),
		interval: clampInterval(interval),
	}
}

// mouseEvent is a lightweight tagged union sent from device readers to the aggregator.
type mouseEvent struct {
	isClick bool
}

// Start launches native mouse capture (where supported) and a flush ticker.
// A second Start on the same tracker is rejected; after Stop the tracker's
// goroutines are gone for good and must never be restarted.
func (m *MouseTracker) Start() (<-chan MouseStats, error) {
	m.mu.Lock()
	if m.started {
		m.mu.Unlock()
		return nil, fmt.Errorf("mouse tracker already started")
	}
	m.started = true
	m.mu.Unlock()

	// Buffered: drops events when aggregator is busy — never blocks the reader goroutine.
	eventCh := make(chan mouseEvent, 256)
	startNativeMouseCapture(eventCh, m.stopCh)

	// Event aggregator — single goroutine, no mutex contention on hot path.
	go func() {
		for {
			select {
			case <-eventCh:
				m.mu.Lock()
				m.clicks++
				m.mu.Unlock()
			case <-m.stopCh:
				return
			}
		}
	}()

	statsCh := make(chan MouseStats, 4)

	go func() {
		ticker := time.NewTicker(m.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				stats := m.flush()
				select {
				case statsCh <- stats:
				default:
				}
			case <-m.stopCh:
				return
			}
		}
	}()

	return statsCh, nil
}

// RecordMouseActivity records mouse clicks submitted via the frontend (zero-sudo mode).
// Negative payloads are ignored so counters can never go backwards.
func (m *MouseTracker) RecordMouseActivity(clicks int) {
	if clicks <= 0 {
		return
	}
	m.mu.Lock()
	m.clicks += clicks
	m.mu.Unlock()
}

// Stop signals all tracker goroutines to exit. Safe to call multiple times.
func (m *MouseTracker) Stop() {
	m.stopOnce.Do(func() { close(m.stopCh) })
}

// flush atomically reads and resets the click counter.
func (m *MouseTracker) flush() MouseStats {
	m.mu.Lock()
	clicks := m.clicks
	m.clicks = 0
	m.mu.Unlock()

	return MouseStats{TotalClicks: clicks}
}
