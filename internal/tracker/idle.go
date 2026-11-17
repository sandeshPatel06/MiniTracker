package tracker

import (
	"context"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/godbus/dbus/v5"
)

// IdleState tracks user activity state.
type IdleState int32

const (
	StateActive IdleState = iota
	StateIdle
	StateAwaitingCategorization
)

func (s IdleState) String() string {
	switch s {
	case StateActive:
		return "ACTIVE"
	case StateIdle:
		return "IDLE"
	case StateAwaitingCategorization:
		return "AWAITING_CATEGORIZATION"
	default:
		return "UNKNOWN"
	}
}

// IdleBlock represents an away time block requiring user resolution.
type IdleBlock struct {
	ID              int64     `json:"id"`
	StartTime       time.Time `json:"start_time"`
	EndTime         time.Time `json:"end_time"`
	DurationSeconds int64     `json:"duration_seconds"`
	Resolved        bool      `json:"resolved"`
}

// IdleDetector monitors keyboard/mouse inactivity using D-Bus, X11 timers, and atomic input hooks.
type IdleDetector struct {
	mu sync.Mutex

	enabled        bool
	threshold      time.Duration
	state          IdleState
	idleStartedAt  time.Time
	idleEndedAt    time.Time
	lastActiveTime time.Time

	lastInputUnixNano atomic.Int64

	dbusConn *dbus.Conn
	stopCh   chan struct{}
	stopOnce sync.Once
	testDurFn func() time.Duration

	onIdleEntered func(startedAt time.Time)
	onIdleResumed func(block IdleBlock)
}

// NewIdleDetector creates a new cross-desktop idle detector.
func NewIdleDetector(enabled bool, threshold time.Duration, onEntered func(time.Time), onResumed func(IdleBlock)) *IdleDetector {
	if threshold < 30*time.Second {
		threshold = 5 * time.Minute
	}
	d := &IdleDetector{
		enabled:        enabled,
		threshold:      threshold,
		state:          StateActive,
		lastActiveTime: time.Now(),
		stopCh:         make(chan struct{}),
		onIdleEntered:  onEntered,
		onIdleResumed:  onResumed,
	}
	d.lastInputUnixNano.Store(time.Now().UnixNano())
	d.initDBus()
	return d
}

// SetEnabled toggles idle detection.
func (d *IdleDetector) SetEnabled(enabled bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.enabled = enabled
}

// SetThreshold updates idle duration threshold.
func (d *IdleDetector) SetThreshold(threshold time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if threshold >= 30*time.Second {
		d.threshold = threshold
	}
}

// RecordActivity is called by input trackers (evdev / window focus) whenever activity occurs.
func (d *IdleDetector) RecordActivity() {
	d.lastInputUnixNano.Store(time.Now().UnixNano())
}

func (d *IdleDetector) initDBus() {
	conn, err := dbus.ConnectSessionBus()
	if err == nil {
		d.dbusConn = conn
	}
}

// Start launches the 1-second monitoring ticker.
func (d *IdleDetector) Start(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Second)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-d.stopCh:
				return
			case <-ticker.C:
				d.checkIdle()
			}
		}
	}()
}

// Stop terminates the detector cleanly.
func (d *IdleDetector) Stop() {
	d.stopOnce.Do(func() {
		close(d.stopCh)
		if d.dbusConn != nil {
			_ = d.dbusConn.Close()
		}
	})
}

// GetState returns the current idle state thread-safely.
func (d *IdleDetector) GetState() IdleState {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.state
}

// CheckIdleNow runs a manual evaluation cycle (useful for deterministic tests and forced updates).
func (d *IdleDetector) CheckIdleNow() {
	d.checkIdle()
}

// SetDurationFunc overrides the duration calculation (for tests).
func (d *IdleDetector) SetDurationFunc(fn func() time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.testDurFn = fn
}

// GetIdleDuration queries native OS channels for milliseconds of user inactivity.
func (d *IdleDetector) GetIdleDuration() time.Duration {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.getIdleDurationLocked()
}

func (d *IdleDetector) getIdleDurationLocked() time.Duration {
	if d.testDurFn != nil {
		return d.testDurFn()
	}

	// Tier 1: GNOME Mutter IdleMonitor (Wayland & X11)
	if d.dbusConn != nil {
		obj := d.dbusConn.Object("org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core")
		var idleMs uint64
		err := obj.Call("org.gnome.Mutter.IdleMonitor.GetIdletime", 0).Store(&idleMs)
		if err == nil {
			return time.Duration(idleMs) * time.Millisecond
		}

		// Tier 1b: FreeDesktop / KDE ScreenSaver DBus
		objKde := d.dbusConn.Object("org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver")
		var kdeIdleMs uint32
		err = objKde.Call("org.freedesktop.ScreenSaver.GetSessionIdleTime", 0).Store(&kdeIdleMs)
		if err == nil {
			return time.Duration(kdeIdleMs) * time.Millisecond
		}
	}

	// Tier 2: xprintidle fallback on Linux X11
	if os.Getenv("DISPLAY") != "" {
		if out, err := exec.Command("xprintidle").Output(); err == nil {
			if ms, parseErr := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64); parseErr == nil {
				return time.Duration(ms) * time.Millisecond
			}
		}
	}

	// Tier 3: In-memory atomic timestamp from evdev / window events / IPC
	lastNano := d.lastInputUnixNano.Load()
	if lastNano > 0 {
		return time.Since(time.Unix(0, lastNano))
	}

	return 0
}

func (d *IdleDetector) checkIdle() {
	d.mu.Lock()
	defer d.mu.Unlock()

	if !d.enabled {
		return
	}

	idleDur := d.getIdleDurationLocked()

	switch d.state {
	case StateActive:
		if idleDur >= d.threshold {
			d.state = StateIdle
			d.idleStartedAt = time.Now().Add(-idleDur)
			log.Printf("[idle] user entered idle state (duration: %v, started_at: %s)",
				idleDur.Round(time.Second), d.idleStartedAt.Format("15:04:05"))

			if d.onIdleEntered != nil {
				go d.onIdleEntered(d.idleStartedAt)
			}
		} else {
			d.lastActiveTime = time.Now()
		}

	case StateIdle:
		// User returned! Activity resumed (idle duration fell back below 10 seconds)
		if idleDur < 10*time.Second {
			d.state = StateAwaitingCategorization
			d.idleEndedAt = time.Now()

			// Defensive boundary check: EndTime must never be before StartTime
			if d.idleEndedAt.Before(d.idleStartedAt) {
				d.idleEndedAt = d.idleStartedAt
			}
			awayDuration := d.idleEndedAt.Sub(d.idleStartedAt)
			durationSeconds := int64(awayDuration.Seconds())
			if durationSeconds < 0 {
				durationSeconds = 0
			}

			log.Printf("[idle] user returned after %v away (from %s to %s)",
				awayDuration.Round(time.Second),
				d.idleStartedAt.Format("15:04:05"),
				d.idleEndedAt.Format("15:04:05"))

			block := IdleBlock{
				ID:              time.Now().UnixNano(),
				StartTime:       d.idleStartedAt,
				EndTime:         d.idleEndedAt,
				DurationSeconds: durationSeconds,
				Resolved:        false,
			}

			if d.onIdleResumed != nil {
				go d.onIdleResumed(block)
			}
		}

	case StateAwaitingCategorization:
		d.lastActiveTime = time.Now()
	}
}

// MarkResolved transitions back to StateActive.
func (d *IdleDetector) MarkResolved() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.state = StateActive
	d.lastInputUnixNano.Store(time.Now().UnixNano())
	d.lastActiveTime = time.Now()
}
