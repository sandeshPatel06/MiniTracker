package privacy

import (
	"image"
	"regexp"
	"strings"
	"sync"
)

// PrivacyAction specifies what to do when a sensitive window or content is detected.
type PrivacyAction string

const (
	ActionBlur   PrivacyAction = "blur"
	ActionShield PrivacyAction = "shield"
	ActionSkip   PrivacyAction = "skip_screenshot"
)

// EvaluationResult contains the verdict of a privacy check.
type EvaluationResult struct {
	IsSensitive bool          `json:"is_sensitive"`
	Action      PrivacyAction `json:"action"`
	Reason      string        `json:"reason"`
	BlurRadius  int           `json:"blur_radius"`
}

// UserPrivacyRule defines a configurable pattern for sensitive window detection.
type UserPrivacyRule struct {
	ID        int64         `json:"id"`
	RuleType  string        `json:"rule_type"` // "app", "title_regex", "content_regex"
	Pattern   string        `json:"pattern"`
	Action    PrivacyAction `json:"action"` // "blur", "shield", "skip_screenshot"
	Desc      string        `json:"description"`
	IsActive  bool          `json:"is_active"`
	IsBuiltIn bool          `json:"is_built_in"`
}

type compiledPrivacyRule struct {
	UserPrivacyRule
	patLower string
	regex    *regexp.Regexp
}

// Engine coordinates sensitive window and token detection.
type Engine struct {
	mu          sync.RWMutex
	enabled     bool
	blurStyle   string // "blur", "shield", "skip"
	blurRadius  int
	customRules []UserPrivacyRule
	cachedRules []compiledPrivacyRule
}

// NewEngine creates a new privacy engine with default safety settings.
func NewEngine(enabled bool, style string, radius int) *Engine {
	if radius <= 0 {
		radius = 35
	}
	if style == "" {
		style = "blur"
	}
	return &Engine{
		enabled:    enabled,
		blurStyle:  style,
		blurRadius: radius,
	}
}

// SetEnabled updates the master privacy toggle.
func (e *Engine) SetEnabled(enabled bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.enabled = enabled
}

// IsEnabled reports whether the privacy engine is active.
func (e *Engine) IsEnabled() bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.enabled
}

// SetConfig updates engine parameters.
func (e *Engine) SetConfig(enabled bool, style string, radius int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.enabled = enabled
	if style != "" {
		e.blurStyle = style
	}
	if radius > 0 {
		e.blurRadius = radius
	}
}

// SetCustomRules replaces the active custom rules list and compiles regex patterns.
func (e *Engine) SetCustomRules(rules []UserPrivacyRule) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.customRules = rules
	e.cachedRules = make([]compiledPrivacyRule, 0, len(rules))
	for _, r := range rules {
		cpr := compiledPrivacyRule{
			UserPrivacyRule: r,
			patLower:        strings.ToLower(r.Pattern),
		}
		if r.RuleType == "title_regex" || r.RuleType == "content_regex" {
			if re, err := regexp.Compile(r.Pattern); err == nil {
				cpr.regex = re
			}
		}
		e.cachedRules = append(e.cachedRules, cpr)
	}
}

// EvaluateWindow checks whether the focused window matches sensitive rules.
func (e *Engine) EvaluateWindow(appName, windowTitle string) EvaluationResult {
	e.mu.RLock()
	defer e.mu.RUnlock()

	if !e.enabled {
		return EvaluationResult{IsSensitive: false}
	}

	appLower := strings.ToLower(strings.TrimSpace(appName))
	titleTrimmed := strings.TrimSpace(windowTitle)

	// 1. Check Custom User Rules first
	for _, rule := range e.cachedRules {
		if !rule.IsActive {
			continue
		}
		switch rule.RuleType {
		case "app":
			if appLower == rule.patLower || strings.Contains(appLower, rule.patLower) {
				return EvaluationResult{
					IsSensitive: true,
					Action:      rule.Action,
					Reason:      "Custom rule: " + rule.Pattern,
					BlurRadius:  e.blurRadius,
				}
			}
		case "title_regex":
			if rule.regex != nil && rule.regex.MatchString(titleTrimmed) {
				return EvaluationResult{
					IsSensitive: true,
					Action:      rule.Action,
					Reason:      "Custom regex rule: " + rule.Pattern,
					BlurRadius:  e.blurRadius,
				}
			}
		}
	}

	// 2. Built-in Tier 1: Known Sensitive Apps
	for knownApp, desc := range KnownSensitiveApps {
		if strings.Contains(appLower, knownApp) {
			return EvaluationResult{
				IsSensitive: true,
				Action:      e.resolveAction(),
				Reason:      desc,
				BlurRadius:  e.blurRadius,
			}
		}
	}

	// 3. Built-in Tier 1: Window Titles
	if RegexPasswordVault.MatchString(titleTrimmed) {
		return EvaluationResult{
			IsSensitive: true,
			Action:      e.resolveAction(),
			Reason:      "Password Manager or Vault Window",
			BlurRadius:  e.blurRadius,
		}
	}
	if RegexBanking.MatchString(titleTrimmed) {
		return EvaluationResult{
			IsSensitive: true,
			Action:      e.resolveAction(),
			Reason:      "Banking or Financial Portal",
			BlurRadius:  e.blurRadius,
		}
	}
	if RegexIncognito.MatchString(titleTrimmed) {
		return EvaluationResult{
			IsSensitive: true,
			Action:      e.resolveAction(),
			Reason:      "Private / Incognito Browsing Window",
			BlurRadius:  e.blurRadius,
		}
	}
	if RegexSensitiveFile.MatchString(titleTrimmed) {
		return EvaluationResult{
			IsSensitive: true,
			Action:      e.resolveAction(),
			Reason:      "Sensitive Configuration or Credentials File",
			BlurRadius:  e.blurRadius,
		}
	}

	// 4. Built-in Tier 2: Check window title for sensitive tokens
	if matched, reason := ScanSensitiveTokens(titleTrimmed); matched {
		return EvaluationResult{
			IsSensitive: true,
			Action:      e.resolveAction(),
			Reason:      reason,
			BlurRadius:  e.blurRadius,
		}
	}

	return EvaluationResult{IsSensitive: false}
}

func (e *Engine) resolveAction() PrivacyAction {
	switch e.blurStyle {
	case "shield":
		return ActionShield
	case "skip":
		return ActionSkip
	default:
		return ActionBlur
	}
}

// ProcessImage applies the evaluated privacy action to the in-memory RGBA buffer.
func (e *Engine) ProcessImage(img *image.RGBA, eval EvaluationResult) {
	if !eval.IsSensitive || img == nil {
		return
	}
	switch eval.Action {
	case ActionShield:
		ApplyFrostedShield(img, eval.Reason)
	case ActionBlur:
		radius := eval.BlurRadius
		if radius <= 0 {
			radius = 35
		}
		ApplyBoxBlur(img, img.Bounds(), radius, 3)
	case ActionSkip:
		// When action is skip, caller will omit disk write completely
	}
}
