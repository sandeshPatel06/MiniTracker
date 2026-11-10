package db

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func setupTestDB(t *testing.T) (*DB, func()) {
	t.Helper()
	tmpDir, err := os.MkdirTemp("", "minitracker-db-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	database, err := Open(tmpDir)
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("failed to open database: %v", err)
	}

	cleanup := func() {
		database.Close()
		os.RemoveAll(tmpDir)
	}

	return database, cleanup
}

func TestDatabaseMigrationAndDefaults(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	// Default organization (ID 1) should exist
	org, err := database.GetOrganization(1)
	if err != nil {
		t.Fatalf("expected default org, got error: %v", err)
	}
	if org.Name != "Default Beta Org" {
		t.Errorf("expected org name 'Default Beta Org', got '%s'", org.Name)
	}
}

func TestOrganizationCRUD(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	// Create org
	org, err := database.CreateOrganization("Test Corp", "test-corp")
	if err != nil {
		t.Fatalf("failed to create organization: %v", err)
	}
	if org.ID == 0 {
		t.Errorf("expected valid org ID, got 0")
	}

	// Fetch org by ID
	fetched, err := database.GetOrganization(org.ID)
	if err != nil {
		t.Fatalf("failed to get organization: %v", err)
	}
	if fetched.Name != "Test Corp" || fetched.Slug != "test-corp" {
		t.Errorf("unexpected org details: %+v", fetched)
	}

	// Fetch org by Slug
	bySlug, err := database.GetOrganizationBySlug("test-corp")
	if err != nil {
		t.Fatalf("failed to get organization by slug: %v", err)
	}
	if bySlug.ID != org.ID || bySlug.Name != "Test Corp" {
		t.Errorf("unexpected org by slug: %+v", bySlug)
	}
}

func TestUserAndTeamManagement(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	org, err := database.CreateOrganization("Dev Corp", "dev-corp")
	if err != nil {
		t.Fatalf("failed to create org: %v", err)
	}

	// Create User
	user, err := database.CreateUser(org.ID, "user@devcorp.com", "hashedpass123", "Alice Developer", "owner")
	if err != nil {
		t.Fatalf("failed to create user: %v", err)
	}
	if user.Email != "user@devcorp.com" || user.Role != "owner" {
		t.Errorf("unexpected user values: %+v", user)
	}

	// Get user by email
	byEmail, err := database.GetUserByEmail("user@devcorp.com")
	if err != nil {
		t.Fatalf("failed to get user by email: %v", err)
	}
	if byEmail.ID != user.ID || byEmail.FullName != "Alice Developer" {
		t.Errorf("mismatched user from GetUserByEmail: %+v", byEmail)
	}

	// Get team members
	members, err := database.GetOrgMembers(org.ID)
	if err != nil {
		t.Fatalf("failed to get org members: %v", err)
	}
	if len(members) != 1 || members[0].Email != "user@devcorp.com" {
		t.Errorf("expected 1 team member, got %d", len(members))
	}
}

func TestInvitationFlow(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	org, _ := database.CreateOrganization("Invite Corp", "invite-corp")

	// Create Invitation
	inv, err := database.CreateInvitation(org.ID, "newmember@invitecorp.com", "member", "token_abc123", time.Now().Add(48*time.Hour))
	if err != nil {
		t.Fatalf("failed to create invitation: %v", err)
	}
	if inv.Status != "pending" || inv.Token != "token_abc123" {
		t.Errorf("unexpected invitation state: %+v", inv)
	}

	// Fetch invitation by token
	fetchedInv, err := database.GetInvitationByToken("token_abc123")
	if err != nil {
		t.Fatalf("failed to get invitation by token: %v", err)
	}
	if fetchedInv.Email != "newmember@invitecorp.com" {
		t.Errorf("unexpected invitation email: %s", fetchedInv.Email)
	}

	// Accept Invitation
	user, err := database.AcceptInvitation("token_abc123", "Bob Member", "hashedpass456")
	if err != nil {
		t.Fatalf("failed to accept invitation: %v", err)
	}
	if user.Email != "newmember@invitecorp.com" || user.OrgID != org.ID {
		t.Errorf("unexpected accepted user: %+v", user)
	}

	// Verify status updated to accepted
	updatedInv, err := database.GetInvitationByToken("token_abc123")
	if err != nil {
		t.Fatalf("failed to fetch updated invitation: %v", err)
	}
	if updatedInv.Status != "accepted" {
		t.Errorf("expected status 'accepted', got '%s'", updatedInv.Status)
	}

	// Duplicate acceptance should fail
	_, err = database.AcceptInvitation("token_abc123", "Bob Member", "hashedpass456")
	if err == nil {
		t.Errorf("expected error accepting already accepted invitation")
	}
}

func TestLogEntryCRUD(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	now := time.Now()
	entry := &LogEntry{
		Timestamp:    now,
		ImagePath:    filepath.Join(os.TempDir(), "screenshot.png"),
		TotalKeys:    120,
		UniqueKeys:   25,
		EntropyScore: 45.5,
	}

	id, err := database.InsertLog(entry)
	if err != nil {
		t.Fatalf("failed to insert log: %v", err)
	}
	if id == 0 {
		t.Errorf("expected non-zero log ID")
	}

	// Verify unanalyzed log query
	unanalyzed, err := database.GetUnanalyzedLogs()
	if err != nil {
		t.Fatalf("failed to get unanalyzed logs: %v", err)
	}
	if len(unanalyzed) != 1 || unanalyzed[0].ID != id {
		t.Errorf("expected 1 unanalyzed log, got %d", len(unanalyzed))
	}

	// Update AI Result
	err = database.UpdateAIResult(id, "Coding", true, 95.0, 0.9, "Active Golang development in IDE")
	if err != nil {
		t.Fatalf("failed to update AI result: %v", err)
	}

	// Verify unanalyzed log is now empty
	unanalyzedAfter, _ := database.GetUnanalyzedLogs()
	if len(unanalyzedAfter) != 0 {
		t.Errorf("expected 0 unanalyzed logs after update, got %d", len(unanalyzedAfter))
	}

	// Fetch logs for date
	dateStr := now.Format("2006-01-02")
	logs, err := database.GetLogsForDate(dateStr)
	if err != nil {
		t.Fatalf("failed to get logs for date: %v", err)
	}
	if len(logs) != 1 || logs[0].AICategory != "Coding" || !logs[0].IsProductive {
		t.Errorf("unexpected logs returned: %+v", logs)
	}

	// Get productivity stats
	stats, err := database.GetProductivityStats(dateStr)
	if err != nil {
		t.Fatalf("failed to get stats: %v", err)
	}
	if stats.TotalMinutes != 1 || stats.ProductiveMin != 1 || stats.TopCategory != "Coding" {
		t.Errorf("unexpected stats: %+v", stats)
	}
}

func TestKeyResolutionHierarchy(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	// 1. Fallback to Global Key
	key, model, source, err := database.ResolveEffectiveGeminiKey(1, 1, "global-key-123", "gemma-4-31b-it")
	if err != nil || key != "global-key-123" || source != "global_system" {
		t.Errorf("expected global_system key fallback, got key=%s source=%s err=%v", key, source, err)
	}

	// 2. Solo user sets personal key
	_ = database.SetUserPersonalKey(1, "user-personal-key-456")
	key, model, source, err = database.ResolveEffectiveGeminiKey(1, 0, "global-key-123", "gemma-4-31b-it")
	if err != nil || key != "user-personal-key-456" || source != "user_personal" {
		t.Errorf("expected user_personal key, got key=%s source=%s err=%v", key, source, err)
	}

	// 3. Org Admin sets Org key
	_ = database.SetOrgGeminiConfig(1, "org-admin-key-789", "gemma-4-31b-it")
	key, model, source, err = database.ResolveEffectiveGeminiKey(1, 1, "global-key-123", "gemma-4-31b-it")
	if err != nil || key != "org-admin-key-789" || source != "org_admin" {
		t.Errorf("expected org_admin key priority, got key=%s source=%s err=%v", key, source, err)
	}
	_ = model
}

func TestResolveServerTimeZone(t *testing.T) {
	t.Setenv("TZ", "Asia/Kolkata")
	if got := resolveServerTimeZone(); got != "Asia/Kolkata" {
		t.Fatalf("expected Asia/Kolkata, got %q", got)
	}

	// Invalid TZ falls back to the system zone or a numeric offset.
	t.Setenv("TZ", "Not/AZone")
	if got := resolveServerTimeZone(); got == "" {
		t.Fatal("expected a non-empty fallback timezone")
	}
}

func TestWithPostgresSessionTimeZone(t *testing.T) {
	t.Setenv("TZ", "Asia/Kolkata")

	got := withPostgresSessionTimeZone("postgres://u:p@localhost:5432/db?sslmode=disable")
	if !strings.Contains(got, "timezone%3DAsia%2FKolkata") && !strings.Contains(got, "timezone=Asia/Kolkata") {
		t.Fatalf("expected timezone option to be injected, got %q", got)
	}

	// Explicit options are respected untouched.
	explicit := "postgres://u:p@localhost:5432/db?options=-c%20timezone%3DUTC"
	if got := withPostgresSessionTimeZone(explicit); got != explicit {
		t.Fatalf("expected explicit options to be preserved, got %q", got)
	}
}

func TestGetTodayUsageSummary(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	if err := database.RecordAPIUsage(0, 0, "guest", 100, 20, 120, "gemini-3.5-flash-lite"); err != nil {
		t.Fatalf("RecordAPIUsage: %v", err)
	}
	if err := database.RecordAPIUsage(0, 0, "guest", 50, 10, 60, "gemini-3.5-flash-lite"); err != nil {
		t.Fatalf("RecordAPIUsage: %v", err)
	}

	summary, err := database.GetTodayUsageSummary()
	if err != nil {
		t.Fatalf("GetTodayUsageSummary: %v", err)
	}
	if summary.TotalRequests != 2 {
		t.Fatalf("requests = %d, want 2", summary.TotalRequests)
	}
	if summary.PromptTokens != 150 || summary.CandidateTokens != 30 || summary.TotalTokens != 180 {
		t.Fatalf("tokens = %d/%d/%d, want 150/30/180", summary.PromptTokens, summary.CandidateTokens, summary.TotalTokens)
	}
}

func TestGetAppEventsBetween(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	base := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	events := []AppEvent{
		{Timestamp: base.Add(-2 * time.Minute), Kind: "focus", AppName: "Before", WindowTitle: "outside"},
		{Timestamp: base.Add(1 * time.Minute), Kind: "focus", AppName: "Chrome", WindowTitle: "docs"},
		{Timestamp: base.Add(2 * time.Minute), Kind: "open", AppName: "Code", WindowTitle: "main.go"},
		{Timestamp: base.Add(5 * time.Minute), Kind: "close", AppName: "After", WindowTitle: "outside"},
	}
	for _, ev := range events {
		ev := ev
		if _, err := database.InsertAppEvent(&ev); err != nil {
			t.Fatalf("InsertAppEvent: %v", err)
		}
	}

	got, err := database.GetAppEventsBetween(base, base.Add(5*time.Minute), 40)
	if err != nil {
		t.Fatalf("GetAppEventsBetween: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d events, want 2", len(got))
	}
	if got[0].AppName != "Chrome" || got[1].AppName != "Code" {
		t.Fatalf("unexpected order: %s, %s", got[0].AppName, got[1].AppName)
	}
}

// TestUpdateLogAnalysisPreservesUnsetFields locks the partial-update contract:
// empty appCategory/windowTitle and zero sessionID/empty sessionTitle must not
// clobber previously stored values (server pipelines and retry paths pass
// 0/""), while provided enrichment fields still overwrite.
func TestUpdateLogAnalysisPreservesUnsetFields(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	id, err := database.InsertLog(&LogEntry{
		Timestamp:    time.Now().UTC(),
		ImagePath:    "/tmp/shot.png",
		TotalKeys:    10,
		UniqueKeys:   5,
		EntropyScore: 30,
		AppName:      "Code Editor",
		WindowTitle:  "main.go - preview",
	})
	if err != nil {
		t.Fatalf("InsertLog: %v", err)
	}

	full := func(category, appCategory, windowTitle string, sessionID int64, sessionTitle string, score float64) error {
		return database.UpdateLogAnalysis(id, category, "", appCategory, windowTitle, sessionID, sessionTitle, score >= 50, score, 0.9, "reason")
	}
	if err := full("Coding", "Development", "main.go | editor", 7, "Morning Work", 80); err != nil {
		t.Fatalf("full analysis update: %v", err)
	}

	partial := func(category string, score float64) error {
		return database.UpdateLogAnalysis(id, category, "", "", "", 0, "", false, score, 0.5, "re-analysis")
	}
	if err := partial("Browsing", 20); err != nil {
		t.Fatalf("partial analysis update: %v", err)
	}

	logs, err := database.GetLogsFiltered(0, 0, "", "")
	if err != nil {
		t.Fatalf("GetLogsFiltered: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("got %d logs, want 1", len(logs))
	}
	e := logs[0]
	if e.AICategory != "Browsing" || e.ProductiveScore != 20 {
		t.Errorf("AI fields not updated: category=%q score=%v", e.AICategory, e.ProductiveScore)
	}
	if e.SessionID != 7 || e.SessionTitle != "Morning Work" {
		t.Errorf("session fields clobbered: id=%d title=%q", e.SessionID, e.SessionTitle)
	}
	if e.AppCategory != "Development" {
		t.Errorf("app_category clobbered: %q", e.AppCategory)
	}
	if e.WindowTitle != "main.go | editor" {
		t.Errorf("window_title clobbered: %q", e.WindowTitle)
	}

	if err := database.UpdateLogAnalysis(id, "Browsing", "", "", "", 0, "All Day", false, 20, 0.5, "re"); err != nil {
		t.Fatalf("session title only update: %v", err)
	}
	logs, _ = database.GetLogsFiltered(0, 0, "", "")
	if logs[0].SessionTitle != "All Day" || logs[0].SessionID != 7 {
		t.Errorf("session pairing broken: id=%d title=%q", logs[0].SessionID, logs[0].SessionTitle)
	}
}

// TestIncrementAIRetryCountCapsAndPreservesCaptureFields exercises the atomic
// retry gate: 9 increments still leave the row eligible, the 10th marks it
// Failed (excluded from the retry queue) without wiping the capture fields.
func TestIncrementAIRetryCountCapsAndPreservesCaptureFields(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	id, err := database.InsertLog(&LogEntry{
		Timestamp:    time.Now().UTC(),
		ImagePath:    "/tmp/shot.png",
		EntropyScore: 12,
		AppName:      "Terminal",
		WindowTitle:  "work-session-log — konsole",
	})
	if err != nil {
		t.Fatalf("InsertLog: %v", err)
	}

	for i := 1; i <= 9; i++ {
		if err := database.IncrementAIRetryCount(id); err != nil {
			t.Fatalf("increment %d: %v", i, err)
		}
		eligible, err := database.CountUnanalyzedLogs()
		if err != nil {
			t.Fatalf("CountUnanalyzedLogs: %v", err)
		}
		if eligible != 1 {
			t.Fatalf("after %d increments: %d eligible, want 1", i, eligible)
		}
	}

	if err := database.IncrementAIRetryCount(id); err != nil {
		t.Fatalf("capping increment: %v", err)
	}
	if eligible, _ := database.CountUnanalyzedLogs(); eligible != 0 {
		t.Fatalf("retry-capped entry still eligible: %d", eligible)
	}
	if latest, _ := database.GetLatestUnanalyzedLog(); latest != nil {
		t.Fatalf("GetLatestUnanalyzedLog returned retry-capped entry: %+v", latest)
	}

	entry, err := database.GetLogByID(id)
	if err != nil {
		t.Fatalf("GetLogByID: %v", err)
	}
	if entry.AICategory != "Failed" {
		t.Errorf("expected Failed category, got %q", entry.AICategory)
	}
	if entry.AIRetryCount != 9 {
		t.Errorf("expected retry count 9, got %d", entry.AIRetryCount)
	}
	if entry.WindowTitle != "work-session-log — konsole" {
		t.Errorf("retry-cap path clobbered window title: %q", entry.WindowTitle)
	}

	// Non-existent IDs must not panic or resurrect anything.
	if err := database.IncrementAIRetryCount(987654); err != nil {
		t.Errorf("increment on missing row: %v", err)
	}
}

// TestIsProductiveReadDerivations verifies the read-side healing of
// legacy is_productive=1 rows that lack a stored score, and that a legit
// analyzed unproductive row (productive=0, score=0) is never promoted to 100.
func TestIsProductiveReadDerivations(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	unproductiveID, err := database.InsertLog(&LogEntry{Timestamp: time.Now().UTC(), ImagePath: "/tmp/u.png"})
	if err != nil {
		t.Fatalf("insert unproductive: %v", err)
	}
	if err := database.UpdateLogAnalysis(unproductiveID, "Browsing", "", "Web", "news", 0, "", false, 0, 0.7, "reading the news"); err != nil {
		t.Fatalf("analysis on unproductive: %v", err)
	}

	productiveNoScoreID, err := database.InsertLog(&LogEntry{Timestamp: time.Now().UTC(), ImagePath: "/tmp/p.png"})
	if err != nil {
		t.Fatalf("insert productive: %v", err)
	}
	if err := database.UpdateLogAnalysis(productiveNoScoreID, "Coding", "", "Development", "ide", 0, "", true, 0, 0.9, "coding"); err != nil {
		t.Fatalf("analysis on productive: %v", err)
	}

	highScoreID, err := database.InsertLog(&LogEntry{Timestamp: time.Now().UTC(), ImagePath: "/tmp/h.png"})
	if err != nil {
		t.Fatalf("insert high score: %v", err)
	}
	if err := database.UpdateLogAnalysis(highScoreID, "Coding", "", "Development", "ide", 0, "", false, 60, 0.9, "deep work"); err != nil {
		t.Fatalf("analysis on high score: %v", err)
	}

	logs, err := database.GetLogsFiltered(0, 0, "", "")
	if err != nil {
		t.Fatalf("GetLogsFiltered: %v", err)
	}
	byID := make(map[int64]LogEntry, len(logs))
	for _, l := range logs {
		byID[l.ID] = l
	}

	low := byID[unproductiveID]
	if low.IsProductive || low.ProductiveScore != 0 {
		t.Errorf("0/0 analyzed unproductive row became productive: %+v — condition ordering must stay (productive==1 || score>=50) BEFORE the 0-score heal", low)
	}

	leg := byID[productiveNoScoreID]
	if !leg.IsProductive || leg.ProductiveScore != 100 {
		t.Errorf("legacy productive row without score not healed to 100: %+v", leg)
	}

	high := byID[highScoreID]
	if !high.IsProductive {
		t.Errorf("writer invariant violation: score >= 50 must store is_productive=1: %+v", high)
	}

	if single, err := database.GetLogByID(unproductiveID); err != nil || single == nil {
		t.Fatalf("GetLogByID: %v %v", single, err)
	} else if single.IsProductive || single.ProductiveScore != 0 {
		t.Errorf("GetLogByID derivation diverges from the list readers: %+v", single)
	} else if healed, err := database.GetLogByID(productiveNoScoreID); err != nil {
		t.Fatalf("GetLogByID healed: %v", err)
	} else if !healed.IsProductive || healed.ProductiveScore != 100 {
		t.Errorf("GetLogByID does not apply the same legacy heal: %+v", healed)
	}
}

// TestDateWindowPredicatesHelper checks the month/year boundary arithmetic of
// the local-day window helper with a fixed non-UTC timezone.
func TestDateWindowPredicatesHelper(t *testing.T) {
	ist := time.FixedZone("IST", 5*3600+1800)

	w, ok := parseDateWindow("2026-01-01", "2026-01-01", ist)
	if !ok {
		t.Fatal("inclusive single-day window must parse")
	}
	if got, want := w.start.Format(time.RFC3339), "2025-12-31T18:30:00Z"; got != want {
		t.Errorf("start = %s, want %s", got, want)
	}
	if got, want := w.end.Format(time.RFC3339), "2026-01-01T18:30:00Z"; got != want {
		t.Errorf("end = %s, want %s", got, want)
	}

	startOnly, ok := parseDateWindow("2026-03-10", "", ist)
	if !ok || startOnly.start == nil || startOnly.end != nil {
		t.Fatalf("start-only window = %+v ok=%v", startOnly, ok)
	}

	endOnly, ok := parseDateWindow("", "2026-03-10", ist)
	if !ok || endOnly.start != nil || endOnly.end == nil {
		t.Fatalf("end-only window = %+v ok=%v", endOnly, ok)
	}

	if _, ok := parseDateWindow("not-a-date", "also-not", ist); ok {
		t.Fatal("unparseable strings must not contribute a window")
	}

	preds := dateWindowPredicates("timestamp", "2026-01-01", "2026-01-01", ist)
	if len(preds) != 2 {
		t.Fatalf("expected GTE+LT predicates, got %d", len(preds))
	}
	if len(dateWindowPredicates("timestamp", "", "", ist)) != 0 {
		t.Fatal("empty range must produce no predicates")
	}
}

// TestDateFiltersUseLocalDayWindows inserts one log per calendar day around
// local midnight and asserts every date-filtered reader agrees with the LOCAL
// calendar, not the UTC calendar used for storage.
func TestDateFiltersUseLocalDayWindows(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	nowLocal := time.Now()
	today := nowLocal.Format("2006-01-02")
	yesterdayNoon := nowLocal.AddDate(0, 0, -1)
	yesterday := yesterdayNoon.Format("2006-01-02")

	todayNoon := time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 12, 0, 0, 0, nowLocal.Location())
	insert := func(ts time.Time) int64 {
		id, err := database.InsertLog(&LogEntry{Timestamp: ts.UTC(), ImagePath: "/tmp/x.png", EntropyScore: 5})
		if err != nil {
			t.Fatalf("InsertLog: %v", err)
		}
		return id
	}
	todayID := insert(todayNoon)
	insert(yesterdayNoon)

	days, err := database.GetLogsForDate(today)
	if err != nil {
		t.Fatalf("GetLogsForDate(today): %v", err)
	}
	if len(days) != 1 || days[0].ID != todayID {
		t.Fatalf("today filter = %+v, want exactly today's log %d — stored-UTC timestamps must not shift local day bucketing", days, todayID)
	}

	yesterdayLogs, err := database.GetLogsForDate(yesterday)
	if err != nil {
		t.Fatalf("GetLogsForDate(yesterday): %v", err)
	}
	if len(yesterdayLogs) != 1 || yesterdayLogs[0].ID == todayID {
		t.Fatalf("yesterday filter = %+v, want exactly yesterday's log", yesterdayLogs)
	}

	page, err := database.GetLogsFilteredPaginated(0, 0, today, today, 1, 50)
	if err != nil {
		t.Fatalf("GetLogsFilteredPaginated: %v", err)
	}
	if page.Total != 1 || len(page.Logs) != 1 || page.Logs[0].ID != todayID {
		t.Fatalf("paginated today = %+v", page)
	}

	var page2, err2 = database.GetLogsFilteredPaginated(0, 0, yesterday, yesterday, 1, 50)
	if err2 != nil {
		t.Fatalf("paginated yesterday: %v", err2)
	}
	if page2.Total != 1 || page2.Logs[0].ID == todayID {
		t.Fatalf("paginated yesterday = %+v", page2)
	}

	statsToday, err := database.GetProductivityStats(today)
	if err != nil {
		t.Fatalf("GetProductivityStats(today): %v", err)
	}
	if statsToday.TotalMinutes != 1 {
		t.Fatalf("today stats minutes = %d, want 1", statsToday.TotalMinutes)
	}
	statsYesterday, _ := database.GetProductivityStats(yesterday)
	if statsYesterday.TotalMinutes != 1 {
		t.Fatalf("yesterday stats minutes = %d, want 1", statsYesterday.TotalMinutes)
	}

	yesterdaySessions, err := database.GetWorkSessionsForDate(yesterday)
	if err != nil {
		t.Fatalf("GetWorkSessionsForDate(yesterday): %v", err)
	}
	if len(yesterdaySessions) != 1 {
		t.Fatalf("yesterday work sessions from logs = %d, want 1 (logs fallback)", len(yesterdaySessions))
	}
}

// TestGetLogsFilteredPaginatedStableWithEqualTimestamps pins the (timestamp, id)
// sort contract: colliding timestamps must not duplicate or drop rows across
// pages.
func TestGetLogsFilteredPaginatedStableWithEqualTimestamps(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	shared := time.Now().UTC().Truncate(time.Second)
	var ids []int64
	for i := 0; i < 3; i++ {
		id, err := database.InsertLog(&LogEntry{Timestamp: shared, ImagePath: "/tmp/x.png"})
		if err != nil {
			t.Fatalf("InsertLog: %v", err)
		}
		ids = append(ids, id)
	}

	seen := make(map[int64]bool)
	for page := 1; page <= 3; page++ {
		res, err := database.GetLogsFilteredPaginated(0, 0, "", "", page, 1)
		if err != nil {
			t.Fatalf("page %d: %v", page, err)
		}
		if len(res.Logs) != 1 {
			t.Fatalf("page %d returned %d rows, want 1", page, len(res.Logs))
		}
		if seen[res.Logs[0].ID] {
			t.Fatalf("row %d repeated across pages", res.Logs[0].ID)
		}
		seen[res.Logs[0].ID] = true
	}
	if len(seen) != 3 {
		t.Fatalf("pagination dropped rows: seen=%v ids=%v", seen, ids)
	}
}

// TestGetTodayTrackedSeconds counts only captures belonging to today's local
// calendar day, with the interval multiplier intact.
func TestGetTodayTrackedSeconds(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	nowLocal := time.Now()
	todayNoon := time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 12, 0, 0, 0, nowLocal.Location())
	if _, err := database.InsertLog(&LogEntry{Timestamp: todayNoon.UTC(), ImagePath: "/tmp/x.png"}); err != nil {
		t.Fatalf("InsertLog today: %v", err)
	}
	yesterdayNoon := nowLocal.AddDate(0, 0, -1)
	if _, err := database.InsertLog(&LogEntry{Timestamp: yesterdayNoon.UTC(), ImagePath: "/tmp/y.png"}); err != nil {
		t.Fatalf("InsertLog yesterday: %v", err)
	}

	if got := database.GetTodayTrackedSeconds(30); got != 30 {
		t.Fatalf("tracked seconds = %d, want 30 — yesterday's log must not leak into the today bucket", got)
	}
	if got := database.GetTodayTrackedSeconds(0); got != 30 {
		t.Fatalf("tracked seconds with defaulted interval = %d, want 30", got)
	}
}

// TestSaveWorkSessionsRoundTripAndWindow verifies the transactional write and
// the local-day start_time window (including the end-only half-open branch).
func TestSaveWorkSessionsRoundTripAndWindow(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	// Build both sessions inside the SAME local calendar day (local mid-day
	// hours) so the day window asserts correctly in any runner timezone.
	nowLocal := time.Now()
	dayDate := nowLocal.Format("2006-01-02")
	at := func(hour int) time.Time {
		return time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), hour, 0, 0, 0, nowLocal.Location())
	}
	want := []WorkSession{
		{OrgID: 1, UserID: 1, Title: "morning", Summary: "s", StartTime: at(10), EndTime: at(11), LogCount: 5, ProductivePct: 60, TopAppName: "Code Editor", TopCategory: "Development"},
		{OrgID: 1, UserID: 1, Title: "late", Summary: "s", StartTime: at(16), EndTime: at(17), LogCount: 3, ProductivePct: 40, TopAppName: "Terminal", TopCategory: "Development"},
	}
	if err := database.SaveWorkSessions(want); err != nil {
		t.Fatalf("SaveWorkSessions: %v", err)
	}

	got, err := database.GetWorkSessionsFiltered(1, 1, "", "")
	if err != nil {
		t.Fatalf("GetWorkSessionsFiltered: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d sessions, want 2", len(got))
	}
	byTitle := make(map[string]WorkSession, len(got))
	for _, s := range got {
		byTitle[s.Title] = s
	}
	if s := byTitle["late"]; s.StartTime.UTC() != at(16).UTC() {
		t.Errorf("insert/scan roundtrip mismatch for %q: %v vs %v", s.Title, s.StartTime.UTC(), at(16).UTC())
	}

	fullDay, err := database.GetWorkSessionsFiltered(1, 1, dayDate, dayDate)
	if err != nil {
		t.Fatalf("windowed sessions: %v", err)
	}
	if len(fullDay) != 2 {
		t.Fatalf("full-day window got %d sessions, want 2", len(fullDay))
	}

	startOnly, err := database.GetWorkSessionsFiltered(1, 1, dayDate, "")
	if err != nil {
		t.Fatalf("start-only window: %v", err)
	}
	if len(startOnly) != 2 {
		t.Fatalf("start-only window got %d sessions, want 2", len(startOnly))
	}
}

// TestLegacyTimestampNormalizationMigration feeds legacy go-sqlite3 /
// CURRENT_TIMESTAMP elapsed formats into a fresh database, resets the schema
// version, and asserts reopening rewrites them into UTC RFC3339 exactly once.
func TestLegacyTimestampNormalizationMigration(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "minitracker-legacy-ts-*")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	os.RemoveAll(tmpDir)
	database, err := Open(tmpDir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	if _, err := database.rawDB.Exec(`INSERT INTO work_sessions (title, summary, start_time, end_time, log_count)
		VALUES ('legacy', 's', '2026-01-05 09:30:00.123456789+05:30', '2026-01-05 11:30:00.123456789+05:30', 3)`); err != nil {
		t.Fatalf("legacy work session insert: %v", err)
	}
	if _, err := database.rawDB.Exec(`INSERT INTO api_usage_logs (key_source, prompt_tokens, candidate_tokens, total_tokens, model_name, created_at)
		VALUES ('guest', 10, 5, 15, 'm', '2026-01-05 10:00:00')`); err != nil {
		t.Fatalf("legacy usage insert: %v", err)
	}
	if _, err := database.rawDB.Exec("PRAGMA user_version = 0"); err != nil {
		t.Fatalf("reset schema version: %v", err)
	}
	database.Close()

	database2, err := Open(tmpDir)
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("re-open: %v", err)
	}
	defer func() {
		database2.Close()
		os.RemoveAll(tmpDir)
	}()

	var schemaVersion int
	if err := database2.rawDB.QueryRow("PRAGMA user_version").Scan(&schemaVersion); err != nil || schemaVersion != 1 {
		t.Fatalf("schema version after re-open = %d (err %v), want 1", schemaVersion, err)
	}

	var startTS, endTS string
	if err := database2.rawDB.QueryRow("SELECT start_time, end_time FROM work_sessions WHERE title = 'legacy'").Scan(&startTS, &endTS); err != nil {
		t.Fatalf("read legacy session: %v", err)
	}
	if startTS != "2026-01-05T04:00:00Z" || endTS != "2026-01-05T06:00:00Z" {
		t.Errorf("normalized timestamps = %q / %q, want UTC RFC3339 04:00/06:00", startTS, endTS)
	}

	var createdAt string
	if err := database2.rawDB.QueryRow("SELECT created_at FROM api_usage_logs WHERE model_name = 'm'").Scan(&createdAt); err != nil {
		t.Fatalf("read legacy usage: %v", err)
	}
	if createdAt != "2026-01-05T10:00:00Z" {
		t.Errorf("normalized created_at = %q, want 2026-01-05T10:00:00Z", createdAt)
	}

	// After normalization the legacy row must be reachable by its local
	// calendar day. Derive the date from the runner's own zone so the assertion
	// holds regardless of the CI timezone.
	local, err := time.Parse(time.RFC3339, startTS)
	if err != nil {
		t.Fatalf("parse normalized start time: %v", err)
	}
	day := local.In(time.Local).Format("2006-01-02")
	session, err := database2.GetWorkSessionsFiltered(0, 0, day, day)
	if err != nil {
		t.Fatalf("normalized session date filter: %v", err)
	}
	if len(session) != 1 {
		t.Errorf("normalized legacy row not found by its local day %s, got %d", day, len(session))
	}
}
