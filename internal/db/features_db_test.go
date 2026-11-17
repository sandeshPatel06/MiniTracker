package db

import (
	"fmt"
	"testing"
	"time"
)

func TestCalendarIntegrationAndEventsCRUD(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	userID := int64(1)

	// 1. Initial integrations query should be empty
	integrations, err := database.GetCalendarIntegrations(userID)
	if err != nil {
		t.Fatalf("GetCalendarIntegrations failed: %v", err)
	}
	if len(integrations) != 0 {
		t.Fatalf("expected 0 integrations initially, got %d", len(integrations))
	}

	// 2. Upsert first integration (Google Calendar)
	gcal := CalendarIntegration{
		UserID:           userID,
		Provider:         "google",
		AccountEmail:     "developer@example.com",
		DisplayName:      "Google Work Calendar",
		EncryptedTokens:  "enc_token_abc_123",
		SyncStatus:       "connected",
		SyncToken:        "sync_token_v1",
		AutoMatchEnabled: true,
	}

	gcalID, err := database.UpsertCalendarIntegration(gcal)
	if err != nil {
		t.Fatalf("UpsertCalendarIntegration failed: %v", err)
	}
	if gcalID <= 0 {
		t.Fatalf("expected positive ID, got %d", gcalID)
	}

	// 3. Upsert second integration (Outlook)
	outlook := CalendarIntegration{
		UserID:           userID,
		Provider:         "outlook",
		AccountEmail:     "dev.office@enterprise.com",
		DisplayName:      "Office 365",
		EncryptedTokens:  "enc_token_ms_789",
		SyncStatus:       "connected",
		SyncToken:        "sync_token_ms_1",
		AutoMatchEnabled: false,
	}

	outlookID, err := database.UpsertCalendarIntegration(outlook)
	if err != nil {
		t.Fatalf("UpsertCalendarIntegration outlook failed: %v", err)
	}
	if outlookID <= 0 {
		t.Fatalf("expected positive ID, got %d", outlookID)
	}

	// 4. Query integrations
	list, err := database.GetCalendarIntegrations(userID)
	if err != nil {
		t.Fatalf("GetCalendarIntegrations failed: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 integrations, got %d", len(list))
	}

	// Verify fields
	var foundGCal, foundOutlook bool
	for _, itg := range list {
		if itg.Provider == "google" {
			foundGCal = true
			if itg.AccountEmail != "developer@example.com" {
				t.Errorf("expected email developer@example.com, got %s", itg.AccountEmail)
			}
			if !itg.AutoMatchEnabled {
				t.Errorf("expected AutoMatchEnabled true for google")
			}
		} else if itg.Provider == "outlook" {
			foundOutlook = true
			if itg.AutoMatchEnabled {
				t.Errorf("expected AutoMatchEnabled false for outlook")
			}
		}
	}
	if !foundGCal || !foundOutlook {
		t.Errorf("expected to find both gcal and outlook in list")
	}

	// 5. Insert events for Google integration
	now := time.Now().UTC().Truncate(time.Second)

	// Event 1: Today 09:00 - 10:00
	ev1Start := now.Add(-2 * time.Hour)
	ev1End := now.Add(-1 * time.Hour)
	_, err = database.rawDB.Exec(
		"INSERT INTO calendar_events (integration_id, external_id, title, description, start_time, end_time, all_day, status, meeting_url, is_matched, matched_log_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		gcalID, "evt_001", "Sprint Daily Standup", "Discuss blockers and roadmap",
		ev1Start.Format(time.RFC3339), ev1End.Format(time.RFC3339),
		0, "confirmed", "https://meet.google.com/abc-def-ghi", 1, 100, now.Format(time.RFC3339),
	)
	if err != nil {
		t.Fatalf("failed to insert event 1: %v", err)
	}

	// Event 2: Today 14:00 - 15:30
	ev2Start := now.Add(2 * time.Hour)
	ev2End := now.Add(3*time.Hour + 30*time.Minute)
	_, err = database.rawDB.Exec(
		"INSERT INTO calendar_events (integration_id, external_id, title, description, start_time, end_time, all_day, status, meeting_url, is_matched, matched_log_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		gcalID, "evt_002", "Architecture Review", "Security & Data model design",
		ev2Start.Format(time.RFC3339), ev2End.Format(time.RFC3339),
		0, "confirmed", "https://zoom.us/j/123456789", 0, 0, now.Format(time.RFC3339),
	)
	if err != nil {
		t.Fatalf("failed to insert event 2: %v", err)
	}

	// Event 3: Far future event (next week)
	ev3Start := now.Add(7 * 24 * time.Hour)
	ev3End := ev3Start.Add(1 * time.Hour)
	_, err = database.rawDB.Exec(
		"INSERT INTO calendar_events (integration_id, external_id, title, description, start_time, end_time, all_day, status, meeting_url, is_matched, matched_log_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		gcalID, "evt_003", "Future Townhall", "Company-wide all hands",
		ev3Start.Format(time.RFC3339), ev3End.Format(time.RFC3339),
		0, "confirmed", "", 0, 0, now.Format(time.RFC3339),
	)
	if err != nil {
		t.Fatalf("failed to insert event 3: %v", err)
	}

	// 6. Test Time Window Queries:
	// Window A: Covers today (ev1 and ev2), but NOT ev3
	todayFrom := now.Add(-4 * time.Hour)
	todayTo := now.Add(5 * time.Hour)
	eventsToday, err := database.GetCalendarEvents(userID, todayFrom, todayTo)
	if err != nil {
		t.Fatalf("GetCalendarEvents for today failed: %v", err)
	}
	if len(eventsToday) != 2 {
		t.Fatalf("expected 2 events in today window, got %d", len(eventsToday))
	}
	if eventsToday[0].Title != "Sprint Daily Standup" {
		t.Errorf("expected first event 'Sprint Daily Standup', got %s", eventsToday[0].Title)
	}
	if !eventsToday[0].IsMatched || eventsToday[0].MatchedLogID != 100 {
		t.Errorf("expected event 1 to be matched with log 100")
	}
	if eventsToday[0].MeetingURL != "https://meet.google.com/abc-def-ghi" {
		t.Errorf("expected meeting URL https://meet.google.com/abc-def-ghi, got %s", eventsToday[0].MeetingURL)
	}

	// Window B: Covers only Event 2
	windowEv2From := now.Add(1 * time.Hour)
	windowEv2To := now.Add(4 * time.Hour)
	eventsEv2, err := database.GetCalendarEvents(userID, windowEv2From, windowEv2To)
	if err != nil {
		t.Fatalf("GetCalendarEvents for window B failed: %v", err)
	}
	if len(eventsEv2) != 1 || eventsEv2[0].ExternalID != "evt_002" {
		t.Fatalf("expected only evt_002, got %v", eventsEv2)
	}

	// Window C: Completely in the past with no events
	pastFrom := now.Add(-48 * time.Hour)
	pastTo := now.Add(-24 * time.Hour)
	emptyEvents, err := database.GetCalendarEvents(userID, pastFrom, pastTo)
	if err != nil {
		t.Fatalf("GetCalendarEvents past failed: %v", err)
	}
	if len(emptyEvents) != 0 {
		t.Fatalf("expected 0 events in past window, got %d", len(emptyEvents))
	}

	// Window D: Query for a different user (e.g. userID = 999) should return nothing
	otherUserEvents, err := database.GetCalendarEvents(999, todayFrom, todayTo)
	if err != nil {
		t.Fatalf("GetCalendarEvents other user failed: %v", err)
	}
	if len(otherUserEvents) != 0 {
		t.Fatalf("expected 0 events for other user, got %d", len(otherUserEvents))
	}
}

func TestFeaturesDB_PrivacyRules(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	rules, err := database.GetPrivacyRules()
	if err != nil {
		t.Fatalf("GetPrivacyRules failed: %v", err)
	}
	initialCount := len(rules)

	newRule := PrivacyRule{
		RuleType:    "app",
		Pattern:     "1password",
		Action:      "blur",
		Description: "Password vault protection",
		IsActive:    true,
		IsBuiltIn:   false,
	}

	id, err := database.InsertPrivacyRule(newRule)
	if err != nil {
		t.Fatalf("InsertPrivacyRule failed: %v", err)
	}
	if id <= 0 {
		t.Fatalf("expected positive rule id, got %d", id)
	}

	rulesAfter, err := database.GetPrivacyRules()
	if err != nil {
		t.Fatalf("GetPrivacyRules after insert failed: %v", err)
	}
	if len(rulesAfter) != initialCount+1 {
		t.Fatalf("expected %d rules, got %d", initialCount+1, len(rulesAfter))
	}

	// Toggle rule inactive
	if err := database.TogglePrivacyRule(id, false); err != nil {
		t.Fatalf("TogglePrivacyRule failed: %v", err)
	}

	rulesAfterToggle, _ := database.GetPrivacyRules()
	for _, r := range rulesAfterToggle {
		if r.ID == id {
			if r.IsActive {
				t.Fatalf("expected rule to be inactive after toggle")
			}
		}
	}

	// Delete rule
	if err := database.DeletePrivacyRule(id); err != nil {
		t.Fatalf("DeletePrivacyRule failed: %v", err)
	}
	rulesAfterDelete, _ := database.GetPrivacyRules()
	if len(rulesAfterDelete) != initialCount {
		t.Fatalf("expected rule to be deleted, count was %d", len(rulesAfterDelete))
	}
}

func TestFeaturesDB_DistractionRulesAndAlerts(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	userID := int64(1)

	// 1. Distraction rule upsert
	rule := DistractionRule{
		OrgID:         1,
		UserID:        userID,
		Kind:          "domain",
		Pattern:       "reddit.com",
		IsDistraction: true,
	}
	ruleID, err := database.UpsertDistractionRule(rule)
	if err != nil {
		t.Fatalf("UpsertDistractionRule failed: %v", err)
	}
	if ruleID <= 0 {
		t.Fatalf("expected positive ruleID, got %d", ruleID)
	}

	rules, err := database.GetDistractionRules(userID)
	if err != nil {
		t.Fatalf("GetDistractionRules failed: %v", err)
	}
	if len(rules) == 0 {
		t.Fatalf("expected at least 1 distraction rule, got 0")
	}

	// 2. Distraction alert record
	alert := DistractionAlert{
		OrgID:            1,
		UserID:           userID,
		Timestamp:        time.Now().UTC(),
		AppName:          "Google Chrome",
		WindowTitle:      "Reddit: Dive into anything",
		DwellSeconds:     900,
		ThresholdSeconds: 600,
		ActionTaken:      "pending",
	}
	alertID, err := database.RecordDistractionAlert(alert)
	if err != nil {
		t.Fatalf("RecordDistractionAlert failed: %v", err)
	}
	if alertID <= 0 {
		t.Fatalf("expected positive alertID, got %d", alertID)
	}

	// Update action taken
	if err := database.UpdateDistractionAlertAction(alertID, "snoozed_10m"); err != nil {
		t.Fatalf("UpdateDistractionAlertAction failed: %v", err)
	}
}

func TestFeaturesDB_AllocateIdleBlock(t *testing.T) {
	database, cleanup := setupTestDB(t)
	defer cleanup()

	start := time.Now().UTC().Add(-30 * time.Minute)
	end := time.Now().UTC()

	params := RetroactiveAllocationParams{
		OrgID:           1,
		UserID:          1,
		StartTime:       start,
		EndTime:         end,
		ActionType:      "meeting",
		Category:        "Meeting",
		TaskTag:         "Sprint Backlog Grooming",
		IsProductive:    true,
		ProductiveScore: 90,
		IntervalSec:     60,
	}

	intervalID, err := database.AllocateIdleBlock(params)
	if err != nil {
		t.Fatalf("AllocateIdleBlock failed: %v", err)
	}
	if intervalID <= 0 {
		t.Fatalf("expected positive intervalID, got %d", intervalID)
	}

	// Check that synthetic logs were inserted
	var count int
	err = database.rawDB.QueryRow(fmt.Sprintf("SELECT COUNT(*) FROM logs WHERE idle_interval_id = %d", intervalID)).Scan(&count)
	if err != nil {
		t.Fatalf("failed to query synthetic logs: %v", err)
	}
	if count <= 0 {
		t.Fatalf("expected synthetic log entries, got %d", count)
	}
}
