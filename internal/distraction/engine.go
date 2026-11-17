package distraction

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/reak/get-hike/internal/db"
	"github.com/reak/get-hike/internal/notify"
)

// AlertPayload contains alert details dispatched to desktop & frontend.
type AlertPayload struct {
	AlertID          int64     `json:"alert_id"`
	AppName          string    `json:"app_name"`
	WindowTitle      string    `json:"window_title"`
	DwellSeconds     int       `json:"dwell_seconds"`
	ThresholdSeconds int       `json:"threshold_seconds"`
	ActiveTask       string    `json:"active_task"`
	Timestamp        time.Time `json:"timestamp"`
}

// Engine coordinates dwell tracking, leaky bucket grace debouncing, and notifications.
type Engine struct {
	mu sync.Mutex

	enabled            bool
	thresholdSeconds   int
	disableDuringFocus bool
	cooldownMinutes    int
	nativeNotify       bool
	inAppToast         bool
	soundEnabled       bool

	currentApp   string
	currentTitle string

	dwellSeconds  int
	graceSeconds  int
	lastAlertTime time.Time
	snoozeUntil   time.Time
	activeTask    string

	classifier *Classifier
	notifier   notify.PlatformNotifier
	db         *db.DB
	onAlert    func(AlertPayload)

	stopCh chan struct{}
}

// NewEngine creates a new distraction engine.
func NewEngine(
	enabled bool,
	thresholdSec int,
	disableDuringFocus bool,
	cooldownMin int,
	notifier notify.PlatformNotifier,
	database *db.DB,
	onAlert func(AlertPayload),
) *Engine {
	if thresholdSec < 60 {
		thresholdSec = 15 * 60
	}
	if cooldownMin <= 0 {
		cooldownMin = 15
	}
	return &Engine{
		enabled:            enabled,
		thresholdSeconds:   thresholdSec,
		disableDuringFocus: disableDuringFocus,
		cooldownMinutes:    cooldownMin,
		nativeNotify:       true,
		inAppToast:         true,
		soundEnabled:       true,
		classifier:         NewClassifier(nil),
		notifier:           notifier,
		db:                 database,
		onAlert:            onAlert,
		stopCh:             make(chan struct{}),
	}
}

// UpdateConfig updates configuration parameters.
func (e *Engine) UpdateConfig(enabled bool, thresholdSec int, disableDuringFocus bool, nativeNotify, inAppToast, sound bool, cooldownMin int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.enabled = enabled
	if thresholdSec >= 60 {
		e.thresholdSeconds = thresholdSec
	}
	e.disableDuringFocus = disableDuringFocus
	e.nativeNotify = nativeNotify
	e.inAppToast = inAppToast
	e.soundEnabled = sound
	if cooldownMin > 0 {
		e.cooldownMinutes = cooldownMin
	}
}

// SetRules updates the classifier rules.
func (e *Engine) SetRules(rules []db.DistractionRule) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.classifier.SetRules(rules)
}

// SetActiveTask updates the current user focus task.
func (e *Engine) SetActiveTask(task string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.activeTask = task
}

// Snooze silences alerts for duration.
func (e *Engine) Snooze(duration time.Duration) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.snoozeUntil = time.Now().Add(duration)
	e.dwellSeconds = 0
	e.graceSeconds = 0
	log.Printf("[distraction] snoozed alerts until %s", e.snoozeUntil.Format("15:04:05"))
}

// OnWindowFocus updates the focused window.
func (e *Engine) OnWindowFocus(appName, windowTitle string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.currentApp = appName
	e.currentTitle = windowTitle
}

// Start launches the 1-second dwell accumulation ticker.
func (e *Engine) Start(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Second)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-e.stopCh:
				return
			case <-ticker.C:
				e.tick()
			}
		}
	}()
}

// Stop terminates the engine.
func (e *Engine) Stop() {
	select {
	case <-e.stopCh:
		return
	default:
		close(e.stopCh)
	}
}

// Tick executes a single evaluation step. Exported for deterministic testing.
func (e *Engine) Tick() {
	e.tick()
}

// GetStats returns the internal engine counters for testing and telemetry.
func (e *Engine) GetStats() (dwellSec, graceSec int, snoozed bool, lastAlert time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.dwellSeconds, e.graceSeconds, time.Now().Before(e.snoozeUntil), e.lastAlertTime
}

func (e *Engine) tick() {
	e.mu.Lock()
	defer e.mu.Unlock()

	if !e.enabled || e.currentApp == "" {
		return
	}

	// 1. Snooze guard
	if time.Now().Before(e.snoozeUntil) {
		return
	}

	// 2. Active Focus session guard
	if e.disableDuringFocus && e.activeTask != "" {
		return
	}

	// 3. Classify current window
	class, _ := e.classifier.Classify(e.currentApp, e.currentTitle)

	if class == ClassDistracting {
		// Cancel grace period and accumulate dwell
		e.graceSeconds = 45 // Reset grace tank
		e.dwellSeconds++

		// Check if threshold reached and cooldown expired
		cooldown := time.Duration(e.cooldownMinutes) * time.Minute
		if e.dwellSeconds >= e.thresholdSeconds && (e.lastAlertTime.IsZero() || time.Since(e.lastAlertTime) >= cooldown) {
			e.fireAlert()
		}
	} else {
		// User is on productive/neutral app. Count down grace seconds before resetting dwell.
		if e.dwellSeconds > 0 {
			if e.graceSeconds > 0 {
				e.graceSeconds--
			} else {
				// Grace period elapsed: reset dwell streak
				e.dwellSeconds = 0
			}
		}
	}
}

func (e *Engine) fireAlert() {
	e.lastAlertTime = time.Now()
	now := time.Now()

	alert := db.DistractionAlert{
		OrgID:            1,
		UserID:           1,
		Timestamp:        now,
		AppName:          e.currentApp,
		WindowTitle:      e.currentTitle,
		DwellSeconds:     e.dwellSeconds,
		ThresholdSeconds: e.thresholdSeconds,
		ActionTaken:      "pending",
	}

	var alertID int64
	if e.db != nil {
		if id, err := e.db.RecordDistractionAlert(alert); err == nil {
			alertID = id
		}
	}

	payload := AlertPayload{
		AlertID:          alertID,
		AppName:          e.currentApp,
		WindowTitle:      e.currentTitle,
		DwellSeconds:     e.dwellSeconds,
		ThresholdSeconds: e.thresholdSeconds,
		ActiveTask:       e.activeTask,
		Timestamp:        now,
	}

	// 1. Native OS notification
	if e.nativeNotify && e.notifier != nil {
		mins := e.dwellSeconds / 60
		_ = e.notifier.Send(notify.Notification{
			Title:   "Time Check — get-Hike",
			Body:    "You've been on " + e.currentApp + " for " + time.Duration(e.dwellSeconds*int(time.Second)).String() + ". Ready to resume?",
			Timeout: 8000,
			Actions: []notify.ActionItem{
				{Key: "snooze_10m", Label: "Snooze 10m"},
				{Key: "dismiss", Label: "Dismiss"},
			},
			OnAction: func(key string) {
				if key == "snooze_10m" {
					e.Snooze(10 * time.Minute)
				}
			},
		})
		log.Printf("[distraction] native alert dispatched for %s (%dm dwell)", e.currentApp, mins)
	}

	// 2. In-App frontend toast callback
	if e.inAppToast && e.onAlert != nil {
		go e.onAlert(payload)
	}
}
