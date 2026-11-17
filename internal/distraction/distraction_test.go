package distraction

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/reak/get-hike/internal/db"
	"github.com/reak/get-hike/internal/notify"
)

// mockNotifier captures notifications dispatched by the Engine.
type mockNotifier struct {
	mu     sync.Mutex
	alerts []notify.Notification
}

func (m *mockNotifier) Send(n notify.Notification) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.alerts = append(m.alerts, n)
	return nil
}

func (m *mockNotifier) Close() error {
	return nil
}

func (m *mockNotifier) getAlerts() []notify.Notification {
	m.mu.Lock()
	defer m.mu.Unlock()
	copied := make([]notify.Notification, len(m.alerts))
	copy(copied, m.alerts)
	return copied
}

func (m *mockNotifier) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.alerts)
}

// -----------------------------------------------------------------------------
// Classifier Tests
// -----------------------------------------------------------------------------

func TestClassifier_BuiltInRules(t *testing.T) {
	c := NewClassifier(nil)

	testCases := []struct {
		appName     string
		windowTitle string
		wantClass   Classification
		name        string
	}{
		// Built-in entertainment domains in window titles
		{"Google Chrome", "YouTube - Watch Trending Videos", ClassDistracting, "youtube domain"},
		{"Firefox", "Netflix - Watch TV Shows Online", ClassDistracting, "netflix domain"},
		{"Brave", "twitch.tv/shroud - Twitch", ClassDistracting, "twitch domain"},
		{"Safari", "reddit.com: the front page of the internet", ClassDistracting, "reddit domain"},
		{"Chrome", "X.com / Home", ClassDistracting, "x.com domain"},
		{"Edge", "Instagram photos and videos", ClassDistracting, "instagram domain"},
		{"Chrome", "Play Chess Online - Chess.com", ClassDistracting, "chess.com domain"},
		{"Chrome", "TikTok - Make Your Day", ClassDistracting, "tiktok domain"},

		// Built-in gaming apps
		{"Steam", "Steam Community Market", ClassDistracting, "steam app"},
		{"Discord", "Discord | #general | Friends Server", ClassDistracting, "discord app"},
		{"epicgames", "Epic Games Launcher", ClassDistracting, "epicgames app"},
		{"Minecraft", "Minecraft 1.20.4", ClassDistracting, "minecraft app"},
		{"RobloxPlayer", "Roblox", ClassDistracting, "roblox app"},
		{"Spotify", "Spotify Free", ClassDistracting, "spotify app"},
		{"vlc", "movie.mp4 - VLC media player", ClassDistracting, "vlc app"},

		// Neutral / Productive apps
		{"Code", "main.go - MiniTracker - Visual Studio Code", ClassNeutral, "vscode"},
		{"GoLand", "MiniTracker [~/git/sandesh/MiniTracker] - GoLand", ClassNeutral, "goland"},
		{"Terminal", "bash - reak@desktop:~", ClassNeutral, "terminal"},
		{"Google Chrome", "Pull Request #42 · reak/get-hike · GitHub", ClassNeutral, "github on chrome"},
		{"Slack", "Slack | #team-dev | Acme Corp", ClassNeutral, "slack app"},
		{"Zoom", "Zoom Meeting", ClassNeutral, "zoom meeting"},
		{"", "", ClassNeutral, "empty strings"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			gotClass, reason := c.Classify(tc.appName, tc.windowTitle)
			if gotClass != tc.wantClass {
				t.Errorf("Classify(%q, %q) = %v (reason: %q); want %v",
					tc.appName, tc.windowTitle, gotClass, reason, tc.wantClass)
			}
		})
	}
}

func TestClassifier_WhitelistBlacklistPrecedence(t *testing.T) {
	// Whitelist should override built-in blacklist
	// If a user whitelists YouTube for educational video watching:
	rules := []db.DistractionRule{
		{
			Kind:          "domain",
			Pattern:       "youtube.com",
			IsDistraction: false, // Whitelist
		},
		{
			Kind:          "app",
			Pattern:       "slack",
			IsDistraction: true, // Blacklist Slack
		},
	}

	c := NewClassifier(rules)

	// YouTube would normally be distracting, but custom rule whitelisted it
	gotClass, reason := c.Classify("Google Chrome", "Go Tutorial - youtube.com")
	if gotClass != ClassProductive {
		t.Errorf("Expected youtube.com to be ClassProductive due to whitelist, got %v (%s)", gotClass, reason)
	}

	// Slack is normally neutral, but custom rule blacklisted it
	gotClass, reason = c.Classify("Slack", "Slack - #random")
	if gotClass != ClassDistracting {
		t.Errorf("Expected Slack to be ClassDistracting due to custom blacklist, got %v (%s)", gotClass, reason)
	}

	// Dynamic rule update via SetRules
	c.SetRules([]db.DistractionRule{
		{
			Kind:          "keyword",
			Pattern:       "Stack Overflow",
			IsDistraction: false, // Whitelist
		},
	})

	// Now YouTube returns to default built-in Distracting
	gotClass, _ = c.Classify("Google Chrome", "YouTube - Trending")
	if gotClass != ClassDistracting {
		t.Errorf("Expected youtube to revert to ClassDistracting after rule reset, got %v", gotClass)
	}

	// And Stack Overflow is explicitly Productive
	gotClass, _ = c.Classify("Firefox", "goroutine leak - Stack Overflow")
	if gotClass != ClassProductive {
		t.Errorf("Expected Stack Overflow to be ClassProductive, got %v", gotClass)
	}
}

func TestClassifier_RegexRule(t *testing.T) {
	// Rule with regex pattern
	rules := []db.DistractionRule{
		{
			Kind:          "regex",
			Pattern:       `(?i)reddit\.com/r/(gaming|funny)`,
			IsDistraction: true,
		},
		{
			Kind:          "regex",
			Pattern:       `(?i)reddit\.com/r/golang`,
			IsDistraction: false, // Whitelist productive subreddit
		},
	}

	c := NewClassifier(rules)

	got, _ := c.Classify("Chrome", "https://reddit.com/r/gaming - cool clips")
	if got != ClassDistracting {
		t.Errorf("Expected /r/gaming to match regex blacklist, got %v", got)
	}

	got, _ = c.Classify("Chrome", "https://reddit.com/r/golang - generics discussion")
	if got != ClassProductive {
		t.Errorf("Expected /r/golang to match regex whitelist, got %v", got)
	}
}

// -----------------------------------------------------------------------------
// Dwell Engine Tests
// -----------------------------------------------------------------------------

func TestEngine_DwellThresholdAndNotification(t *testing.T) {
	mockNotif := &mockNotifier{}
	var toastAlerts []AlertPayload
	var toastMu sync.Mutex

	thresholdSec := 60 // minimum allowed threshold
	cooldownMin := 15

	eng := NewEngine(
		true,
		thresholdSec,
		false,
		cooldownMin,
		mockNotif,
		nil,
		func(p AlertPayload) {
			toastMu.Lock()
			toastAlerts = append(toastAlerts, p)
			toastMu.Unlock()
		},
	)

	eng.OnWindowFocus("Google Chrome", "YouTube - Fun Cat Videos")

	// Advance ticks up to thresholdSec - 1: no alert should fire
	for i := 0; i < thresholdSec-1; i++ {
		eng.Tick()
	}

	if mockNotif.count() != 0 {
		t.Fatalf("Expected 0 alerts before threshold, got %d", mockNotif.count())
	}

	// 60th tick hits the threshold -> fires alert
	eng.Tick()

	// Give a moment for async onAlert goroutine
	time.Sleep(20 * time.Millisecond)

	if mockNotif.count() != 1 {
		t.Fatalf("Expected exactly 1 native notification at threshold, got %d", mockNotif.count())
	}

	toastMu.Lock()
	if len(toastAlerts) != 1 {
		t.Fatalf("Expected exactly 1 toast alert at threshold, got %d", len(toastAlerts))
	}
	toast := toastAlerts[0]
	toastMu.Unlock()

	if toast.AppName != "Google Chrome" || toast.DwellSeconds < thresholdSec {
		t.Errorf("Unexpected toast payload: %+v", toast)
	}
}

func TestEngine_LeakyBucketGracePeriod(t *testing.T) {
	mockNotif := &mockNotifier{}
	thresholdSec := 60
	eng := NewEngine(true, thresholdSec, false, 15, mockNotif, nil, nil)

	// Step 1: Accumulate 30 seconds of distraction on Steam
	eng.OnWindowFocus("Steam", "Store")
	for i := 0; i < 30; i++ {
		eng.Tick()
	}

	dwell, grace, _, _ := eng.GetStats()
	if dwell != 30 {
		t.Fatalf("Expected dwell=30, got %d", dwell)
	}

	// Step 2: Micro-switch to VS Code (productive) for 20 seconds (< 45s grace)
	eng.OnWindowFocus("Code", "main.go")
	for i := 0; i < 20; i++ {
		eng.Tick()
	}

	dwell, grace, _, _ = eng.GetStats()
	// Dwell must NOT reset because grace period is 45s!
	if dwell != 30 {
		t.Fatalf("Expected dwell to remain 30 during grace period, got %d", dwell)
	}
	if grace != 25 { // started at 45, decremented 20 times -> 25
		t.Fatalf("Expected remaining grace=25, got %d", grace)
	}

	// Step 3: Switch back to Steam. Dwell should resume from 30, and grace resets to 45.
	eng.OnWindowFocus("Steam", "Store")
	eng.Tick() // 31st second of dwell

	dwell, grace, _, _ = eng.GetStats()
	if dwell != 31 {
		t.Fatalf("Expected dwell=31 after switching back to distraction, got %d", dwell)
	}
	if grace != 45 {
		t.Fatalf("Expected grace to be reset to 45, got %d", grace)
	}

	// Step 4: Now switch to productive code and stay there for > 45 seconds
	eng.OnWindowFocus("Code", "main.go")
	for i := 0; i < 46; i++ {
		eng.Tick()
	}

	dwell, grace, _, _ = eng.GetStats()
	// After 45s grace elapsed, dwell streak must be completely wiped to 0!
	if dwell != 0 {
		t.Fatalf("Expected dwell=0 after staying productive > 45s, got %d", dwell)
	}
}

func TestEngine_CooldownSuppression(t *testing.T) {
	mockNotif := &mockNotifier{}
	thresholdSec := 60
	cooldownMin := 15
	eng := NewEngine(true, thresholdSec, false, cooldownMin, mockNotif, nil, nil)

	eng.OnWindowFocus("Google Chrome", "netflix.com/watch")

	// Reach threshold -> First alert fires
	for i := 0; i < thresholdSec; i++ {
		eng.Tick()
	}

	if mockNotif.count() != 1 {
		t.Fatalf("Expected 1 alert at threshold, got %d", mockNotif.count())
	}

	// User continues watching Netflix for another 100 seconds
	for i := 0; i < 100; i++ {
		eng.Tick()
	}

	// Alert count should STILL be 1 because 15-minute cooldown is active!
	if mockNotif.count() != 1 {
		t.Fatalf("Expected cooldown to suppress alerts, but got %d alerts", mockNotif.count())
	}
}

func TestEngine_ActiveFocusSuppression(t *testing.T) {
	mockNotif := &mockNotifier{}
	thresholdSec := 60

	// Case 1: disableDuringFocus = true, activeTask != ""
	eng := NewEngine(true, thresholdSec, true, 15, mockNotif, nil, nil)
	eng.SetActiveTask("Implementing Distraction Alerts")
	eng.OnWindowFocus("Discord", "Discord Server")

	// Tick 100 times
	for i := 0; i < 100; i++ {
		eng.Tick()
	}

	if mockNotif.count() != 0 {
		t.Fatalf("Expected alerts to be suppressed during active focus session, got %d", mockNotif.count())
	}

	dwell, _, _, _ := eng.GetStats()
	if dwell != 0 {
		t.Fatalf("Expected dwell to remain 0 during active focus suppression, got %d", dwell)
	}

	// Case 2: Clear active task -> dwell starts accumulating
	eng.SetActiveTask("")
	for i := 0; i < thresholdSec; i++ {
		eng.Tick()
	}

	if mockNotif.count() != 1 {
		t.Fatalf("Expected alert to fire once focus task ended, got %d", mockNotif.count())
	}
}

func TestEngine_SnoozeLogic(t *testing.T) {
	mockNotif := &mockNotifier{}
	thresholdSec := 60
	eng := NewEngine(true, thresholdSec, false, 15, mockNotif, nil, nil)

	eng.OnWindowFocus("Google Chrome", "youtube.com")

	// Accumulate 50 seconds
	for i := 0; i < 50; i++ {
		eng.Tick()
	}

	dwell, _, _, _ := eng.GetStats()
	if dwell != 50 {
		t.Fatalf("Expected dwell=50, got %d", dwell)
	}

	// User snoozes for 100ms
	eng.Snooze(100 * time.Millisecond)

	dwell, grace, snoozed, _ := eng.GetStats()
	if dwell != 0 || grace != 0 {
		t.Fatalf("Snooze should reset dwell and grace, got dwell=%d, grace=%d", dwell, grace)
	}
	if !snoozed {
		t.Fatalf("Expected engine to be snoozed")
	}

	// Tick while snoozed: should do nothing
	eng.Tick()
	dwell, _, _, _ = eng.GetStats()
	if dwell != 0 {
		t.Fatalf("Dwell should not increment while snoozed, got %d", dwell)
	}

	// Wait for snooze duration to expire
	time.Sleep(120 * time.Millisecond)

	// Now ticks resume dwell accumulation
	for i := 0; i < thresholdSec; i++ {
		eng.Tick()
	}

	if mockNotif.count() != 1 {
		t.Fatalf("Expected alert after snooze expired, got %d", mockNotif.count())
	}
}

func TestEngine_StartStopLifecycle(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mockNotif := &mockNotifier{}
	eng := NewEngine(true, 60, false, 15, mockNotif, nil, nil)

	eng.Start(ctx)

	// Verify Stop can be called multiple times without panicking
	eng.Stop()
	eng.Stop()
}

func TestEngine_UpdateConfig(t *testing.T) {
	mockNotif := &mockNotifier{}
	eng := NewEngine(true, 60, false, 15, mockNotif, nil, nil)

	// Update config with higher threshold and focus suppression
	eng.UpdateConfig(false, 300, true, false, false, false, 30)

	eng.OnWindowFocus("Steam", "Store")
	eng.Tick()

	dwell, _, _, _ := eng.GetStats()
	if dwell != 0 {
		t.Fatalf("Engine is disabled, dwell should not increment, got %d", dwell)
	}
}

// -----------------------------------------------------------------------------
// Concurrency & Race Condition Tests
// -----------------------------------------------------------------------------

func TestDistraction_ConcurrentAccess(t *testing.T) {
	mockNotif := &mockNotifier{}
	var toastCount int64

	eng := NewEngine(
		true,
		60,
		false,
		1,
		mockNotif,
		nil,
		func(p AlertPayload) {
			atomic.AddInt64(&toastCount, 1)
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	eng.Start(ctx)
	defer eng.Stop()

	var wg sync.WaitGroup
	workers := 10

	// Worker 1: Rapid window focus switches
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			apps := []string{"Google Chrome", "Code", "Discord", "Steam", "Terminal", "Spotify"}
			titles := []string{"youtube.com", "main.go", "gaming chat", "Store", "bash", "Music"}

			idx := 0
			for {
				select {
				case <-ctx.Done():
					return
				default:
					eng.OnWindowFocus(apps[idx%len(apps)], titles[idx%len(titles)])
					idx++
					time.Sleep(5 * time.Millisecond)
				}
			}
		}(i)
	}

	// Worker 2: Concurrent Rule Updates
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-ctx.Done():
				return
			default:
				eng.SetRules([]db.DistractionRule{
					{Kind: "app", Pattern: fmt.Sprintf("custom_app_%d", i%5), IsDistraction: i%2 == 0},
				})
				time.Sleep(10 * time.Millisecond)
			}
		}
	}()

	// Worker 3: Concurrent Active Task and Snooze updates
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-ctx.Done():
				return
			default:
				if i%2 == 0 {
					eng.SetActiveTask(fmt.Sprintf("Task #%d", i))
				} else {
					eng.SetActiveTask("")
				}
				if i%10 == 0 {
					eng.Snooze(50 * time.Millisecond)
				}
				time.Sleep(8 * time.Millisecond)
			}
		}
	}()

	// Worker 4: Concurrent Config Updates and Stats reads
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			default:
				eng.UpdateConfig(true, 60, false, true, true, true, 1)
				_, _, _, _ = eng.GetStats()
				time.Sleep(15 * time.Millisecond)
			}
		}
	}()

	wg.Wait()
}
