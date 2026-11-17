package main

import (
	"fmt"
	"time"

	"github.com/reak/get-hike/internal/db"
	"github.com/reak/get-hike/internal/notify"
	"github.com/reak/get-hike/internal/privacy"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// ---------------------------------------------------------------------------
// Features 5, 8, 9, 10 Frontend Wails Bindings
// ---------------------------------------------------------------------------

// GetPrivacySettings returns active privacy configurations.
func (a *App) GetPrivacySettings() (map[string]interface{}, error) {
	enabled := true
	style := "blur"
	radius := 35
	if a.privacyEngine != nil {
		enabled = a.privacyEngine.IsEnabled()
	}
	if a.cfg != nil {
		style = a.cfg.PrivacyBlurStyle
		radius = a.cfg.PrivacyBlurRadius
	}
	return map[string]interface{}{
		"enabled":     enabled,
		"blur_style":  style,
		"blur_radius": radius,
	}, nil
}

// UpdatePrivacySettings updates privacy configurations.
func (a *App) UpdatePrivacySettings(enabled bool, style string, radius int) error {
	if a.privacyEngine != nil {
		a.privacyEngine.SetConfig(enabled, style, radius)
	}
	if a.cfg != nil {
		a.cfg.PrivacyModeEnabled = enabled
		a.cfg.PrivacyBlurStyle = style
		a.cfg.PrivacyBlurRadius = radius
	}
	return nil
}

// TogglePrivacyMode flips the privacy shield on/off.
func (a *App) TogglePrivacyMode() (bool, error) {
	if a.privacyEngine == nil {
		return false, nil
	}
	newVal := !a.privacyEngine.IsEnabled()
	a.privacyEngine.SetEnabled(newVal)
	if a.cfg != nil {
		a.cfg.PrivacyModeEnabled = newVal
	}
	return newVal, nil
}

// GetPrivacyRules returns user privacy rules.
func (a *App) GetPrivacyRules() ([]db.PrivacyRule, error) {
	if a.database == nil {
		return nil, nil
	}
	return a.database.GetPrivacyRules()
}

// AddPrivacyRule inserts a new privacy rule.
func (a *App) AddPrivacyRule(ruleType, pattern, action, desc string) (*db.PrivacyRule, error) {
	if a.database == nil {
		return nil, fmt.Errorf("database not available")
	}
	r := db.PrivacyRule{
		RuleType:    ruleType,
		Pattern:     pattern,
		Action:      action,
		Description: desc,
		IsActive:    true,
	}
	id, err := a.database.InsertPrivacyRule(r)
	if err != nil {
		return nil, err
	}
	r.ID = id
	// Refresh engine cache
	if rules, err := a.database.GetPrivacyRules(); err == nil && a.privacyEngine != nil {
		var userRules []privacy.UserPrivacyRule
		for _, ru := range rules {
			userRules = append(userRules, privacy.UserPrivacyRule{
				ID:        ru.ID,
				RuleType:  ru.RuleType,
				Pattern:   ru.Pattern,
				Action:    privacy.PrivacyAction(ru.Action),
				Desc:      ru.Description,
				IsActive:  ru.IsActive,
				IsBuiltIn: ru.IsBuiltIn,
			})
		}
		a.privacyEngine.SetCustomRules(userRules)
	}
	return &r, nil
}

// TogglePrivacyRule toggles active state of a privacy rule.
func (a *App) TogglePrivacyRule(id int64, active bool) error {
	if a.database == nil {
		return nil
	}
	return a.database.TogglePrivacyRule(id, active)
}

// DeletePrivacyRule removes a privacy rule.
func (a *App) DeletePrivacyRule(id int64) error {
	if a.database == nil {
		return nil
	}
	return a.database.DeletePrivacyRule(id)
}

// ResolveIdleInterval allocates or discards a detected idle block.
func (a *App) ResolveIdleInterval(startTimeStr, endTimeStr, actionType, category, taskTag string, isProductive bool, score float64) (int64, error) {
	if a.database == nil {
		return 0, fmt.Errorf("database not available")
	}
	st, err := time.Parse(time.RFC3339, startTimeStr)
	if err != nil {
		st = time.Now().Add(-15 * time.Minute)
	}
	et, err := time.Parse(time.RFC3339, endTimeStr)
	if err != nil {
		et = time.Now()
	}

	params := db.RetroactiveAllocationParams{
		OrgID:           1,
		UserID:          1,
		StartTime:       st,
		EndTime:         et,
		ActionType:      actionType,
		Category:        category,
		TaskTag:         taskTag,
		IsProductive:    isProductive,
		ProductiveScore: score,
		IntervalSec:     30,
	}
	id, err := a.database.AllocateIdleBlock(params)
	if err != nil {
		return 0, err
	}

	// If productive meeting/planning, credit the session timer
	if isProductive {
		durSec := int64(et.Sub(st).Seconds())
		a.statsMu.Lock()
		a.accumulatedSec += durSec
		a.statsMu.Unlock()
	}

	// Resume tracker clock and mark detector resolved
	a.statsMu.Lock()
	a.trackerStartTime = time.Now()
	a.statsMu.Unlock()
	if a.idleDetector != nil {
		a.idleDetector.MarkResolved()
	}

	return id, nil
}

// GetDistractionConfig returns distraction preferences.
func (a *App) GetDistractionConfig() (map[string]interface{}, error) {
	enabled := true
	threshMins := 15
	disableFocus := false
	cooldown := 15
	nativeNotify := true
	inAppToast := true
	sound := true
	if a.cfg != nil {
		enabled = a.cfg.DistractionAlertsEnabled
		threshMins = int(a.cfg.DistractionThreshold.Minutes())
		disableFocus = a.cfg.DistractionDisableDuringFocus
		cooldown = a.cfg.DistractionCooldownMinutes
		nativeNotify = a.cfg.DistractionNativeNotify
		inAppToast = a.cfg.DistractionInAppToast
		sound = a.cfg.DistractionSoundEnabled
	}
	return map[string]interface{}{
		"enabled":               enabled,
		"threshold_minutes":     threshMins,
		"disable_during_focus":  disableFocus,
		"cooldown_minutes":      cooldown,
		"native_notify_enabled": nativeNotify,
		"in_app_toast_enabled":  inAppToast,
		"sound_enabled":         sound,
	}, nil
}

// UpdateDistractionConfig saves distraction preferences.
func (a *App) UpdateDistractionConfig(enabled bool, thresholdMins int, disableDuringFocus, nativeNotify, inAppToast, sound bool, cooldownMin int) error {
	if a.distractionEngine != nil {
		a.distractionEngine.UpdateConfig(enabled, thresholdMins*60, disableDuringFocus, nativeNotify, inAppToast, sound, cooldownMin)
	}
	if a.cfg != nil {
		a.cfg.DistractionAlertsEnabled = enabled
		a.cfg.DistractionThreshold = time.Duration(thresholdMins) * time.Minute
		a.cfg.DistractionDisableDuringFocus = disableDuringFocus
		a.cfg.DistractionNativeNotify = nativeNotify
		a.cfg.DistractionInAppToast = inAppToast
		a.cfg.DistractionSoundEnabled = sound
		a.cfg.DistractionCooldownMinutes = cooldownMin
	}
	return nil
}

// SnoozeDistractionAlerts silences alerts for duration in minutes.
func (a *App) SnoozeDistractionAlerts(minutes int) error {
	if a.distractionEngine != nil {
		a.distractionEngine.Snooze(time.Duration(minutes) * time.Minute)
	}
	return nil
}

// GetDistractionRules returns rules.
func (a *App) GetDistractionRules() ([]db.DistractionRule, error) {
	if a.database == nil {
		return nil, nil
	}
	return a.database.GetDistractionRules(1)
}

// AddDistractionRule inserts a rule.
func (a *App) AddDistractionRule(kind, pattern string, isDistraction bool) (*db.DistractionRule, error) {
	if a.database == nil {
		return nil, fmt.Errorf("database not available")
	}
	rule := db.DistractionRule{
		OrgID:         1,
		UserID:        1,
		Kind:          kind,
		Pattern:       pattern,
		IsDistraction: isDistraction,
	}
	id, err := a.database.UpsertDistractionRule(rule)
	if err != nil {
		return nil, err
	}
	rule.ID = id
	if dRules, err := a.database.GetDistractionRules(1); err == nil && a.distractionEngine != nil {
		a.distractionEngine.SetRules(dRules)
	}
	return &rule, nil
}

// DeleteDistractionRule deletes a distraction rule.
func (a *App) DeleteDistractionRule(id int64) error {
	if a.database == nil {
		return nil
	}
	return a.database.DeleteDistractionRule(id)
}

// SendTestDistractionAlert sends an immediate test notification.
func (a *App) SendTestDistractionAlert() error {
	if a.notifier != nil {
		_ = a.notifier.Send(notify.Notification{
			Title:   "Time Check (Test) — get-Hike",
			Body:    "Testing distraction alert delivery! Everything is configured properly.",
			Timeout: 5000,
		})
	}
	if a.ctx != nil {
		wailsruntime.EventsEmit(a.ctx, "distraction_alert", map[string]interface{}{
			"alert_id":          0,
			"app_name":          "YouTube (Demo)",
			"window_title":      "Demo Video - YouTube",
			"dwell_seconds":     900,
			"threshold_seconds": 900,
			"active_task":       a.GetActiveTask(),
			"timestamp":         time.Now().Format(time.RFC3339),
		})
	}
	return nil
}

// GetCalendarIntegrations lists connected calendar integrations.
func (a *App) GetCalendarIntegrations() ([]db.CalendarIntegration, error) {
	if a.database == nil {
		return nil, nil
	}
	return a.database.GetCalendarIntegrations(1)
}

// GetCalendarEvents returns events in time window.
func (a *App) GetCalendarEvents(fromStr, toStr string) ([]db.CalendarEvent, error) {
	if a.database == nil {
		return nil, nil
	}
	from, _ := time.Parse(time.RFC3339, fromStr)
	to, _ := time.Parse(time.RFC3339, toStr)
	if from.IsZero() {
		from = time.Now().Add(-24 * time.Hour)
	}
	if to.IsZero() {
		to = time.Now().Add(24 * time.Hour)
	}
	return a.database.GetCalendarEvents(1, from, to)
}
