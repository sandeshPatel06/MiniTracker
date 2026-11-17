package distraction

import (
	"regexp"
	"strings"
	"sync"

	"github.com/reak/get-hike/internal/db"
)

// DistractionCategory represents classification outcome.
type Classification string

const (
	ClassProductive  Classification = "productive"
	ClassNeutral     Classification = "neutral"
	ClassDistracting Classification = "distracting"
)

// Known unproductive patterns for fast O(1) matching.
var (
	DistractingAppPatterns = []string{
		"steam", "discord", "epicgames", "lutris", "minecraft", "roblox",
		"battle.net", "spotify", "vlc", "stremio", "popcorntime",
		"netflix", "youtube", "tiktok", "instagram",
	}

	DistractingDomains = []string{
		"youtube.com", "netflix.com", "twitch.tv", "disneyplus.com",
		"primevideo.com", "hulu.com", "tiktok.com", "vimeo.com",
		"twitter.com", "x.com", "instagram.com", "facebook.com",
		"reddit.com", "9gag.com", "buzzfeed.com", "chess.com",
	}

	DistractingTitleKeywords = []string{
		"youtube", "netflix", "tiktok", "instagram", "twitch",
	}
)

type compiledRule struct {
	db.DistractionRule
	patLower string
	regex    *regexp.Regexp
}

// Classifier evaluates whether an active application/title is productive or distracting.
type Classifier struct {
	mu          sync.RWMutex
	customRules []db.DistractionRule
	cachedRules []compiledRule
}

// NewClassifier creates a classifier instance.
func NewClassifier(rules []db.DistractionRule) *Classifier {
	c := &Classifier{}
	c.SetRules(rules)
	return c
}

// SetRules updates custom user whitelist/blacklist rules and compiles cached patterns.
func (c *Classifier) SetRules(rules []db.DistractionRule) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.customRules = rules
	c.cachedRules = make([]compiledRule, 0, len(rules))
	for _, r := range rules {
		cr := compiledRule{
			DistractionRule: r,
			patLower:        strings.ToLower(r.Pattern),
		}
		if r.Kind == "regex" || (r.Kind != "app" && r.Kind != "domain" && r.Kind != "keyword") {
			if re, err := regexp.Compile("(?i)" + r.Pattern); err == nil {
				cr.regex = re
			}
		}
		c.cachedRules = append(c.cachedRules, cr)
	}
}

// Classify determines the productivity classification of an application and window title.
func (c *Classifier) Classify(appName, windowTitle string) (Classification, string) {
	appLower := strings.ToLower(strings.TrimSpace(appName))
	titleLower := strings.ToLower(strings.TrimSpace(windowTitle))

	c.mu.RLock()
	rules := c.cachedRules
	c.mu.RUnlock()

	// 1. Check custom user rules first (Whitelist takes priority)
	for _, rule := range rules {
		matched := false
		switch rule.Kind {
		case "app":
			matched = strings.Contains(appLower, rule.patLower)
		case "domain", "keyword":
			matched = strings.Contains(titleLower, rule.patLower) || strings.Contains(appLower, rule.patLower)
		default:
			// "regex" or any custom pattern type
			if rule.regex != nil {
				matched = rule.regex.MatchString(titleLower) || rule.regex.MatchString(appLower)
			}
		}

		if matched {
			if !rule.IsDistraction {
				return ClassProductive, "User Whitelist: " + rule.Pattern
			}
			return ClassDistracting, "User Blacklist: " + rule.Pattern
		}
	}

	// 2. Built-in Unproductive Domains & Keywords in browser window titles / app names
	for _, domain := range DistractingDomains {
		if strings.Contains(titleLower, domain) || strings.Contains(appLower, domain) {
			return ClassDistracting, "Entertainment / Social: " + domain
		}
	}
	for _, kw := range DistractingTitleKeywords {
		if strings.Contains(titleLower, kw) || strings.Contains(appLower, kw) {
			return ClassDistracting, "Entertainment / Social: " + kw
		}
	}

	// 3. Built-in Unproductive Desktop Apps
	for _, app := range DistractingAppPatterns {
		if strings.Contains(appLower, app) || strings.Contains(titleLower, app) {
			return ClassDistracting, "Entertainment App: " + app
		}
	}

	return ClassNeutral, "Unclassified"
}
