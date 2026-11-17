package db

import (
	"database/sql"
	"fmt"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
)

// PrivacyRule represents a filter rule for sensitive window detection.
type PrivacyRule struct {
	ID          int64     `json:"id"`
	RuleType    string    `json:"rule_type"`   // "app", "title_regex", "content_regex"
	Pattern     string    `json:"pattern"`     // e.g. "bitwarden", "(?i)banking|chase", "AKIA[0-9A-Z]{16}"
	Action      string    `json:"action"`      // "blur", "shield", "skip_screenshot"
	Description string    `json:"description"` // e.g. "Password managers & credential vaults"
	IsActive    bool      `json:"is_active"`
	IsBuiltIn   bool      `json:"is_built_in"`
	CreatedAt   time.Time `json:"created_at"`
}

// DistractionRule represents custom whitelist or blacklist rules.
type DistractionRule struct {
	ID            int64     `json:"id"`
	OrgID         int64     `json:"org_id"`
	UserID        int64     `json:"user_id"`
	Kind          string    `json:"kind"`           // "app", "keyword", "domain"
	Pattern       string    `json:"pattern"`        // e.g. "reddit.com", "Steam"
	IsDistraction bool      `json:"is_distraction"` // true = blacklist, false = whitelist
	CreatedAt     time.Time `json:"created_at"`
}

// DistractionAlert records an alert event and user response.
type DistractionAlert struct {
	ID               int64     `json:"id"`
	OrgID            int64     `json:"org_id"`
	UserID           int64     `json:"user_id"`
	Timestamp        time.Time `json:"timestamp"`
	AppName          string    `json:"app_name"`
	WindowTitle      string    `json:"window_title"`
	DwellSeconds     int       `json:"dwell_seconds"`
	ThresholdSeconds int       `json:"threshold_seconds"`
	ActionTaken      string    `json:"action_taken"`
	ActionAt         time.Time `json:"action_at,omitempty"`
}

// IdleInterval records an away block.
type IdleInterval struct {
	ID              int64     `json:"id"`
	OrgID           int64     `json:"org_id"`
	UserID          int64     `json:"user_id"`
	StartTime       time.Time `json:"start_time"`
	EndTime         time.Time `json:"end_time"`
	DurationSeconds int64     `json:"duration_seconds"`
	Status          string    `json:"status"` // "pending", "allocated", "discarded"
	ActionType      string    `json:"action_type"`
	Category        string    `json:"category"`
	TaskTag         string    `json:"task_tag"`
	IsProductive    bool      `json:"is_productive"`
	ProductiveScore float64   `json:"productive_score"`
	CreatedAt       time.Time `json:"created_at"`
	ResolvedAt      time.Time `json:"resolved_at,omitempty"`
}

// CalendarIntegration represents a connected external calendar account.
type CalendarIntegration struct {
	ID               int64     `json:"id"`
	UserID           int64     `json:"user_id"`
	Provider         string    `json:"provider"` // "google", "outlook", "caldav", "ics"
	AccountEmail     string    `json:"account_email"`
	DisplayName      string    `json:"display_name"`
	EncryptedTokens  string    `json:"encrypted_tokens,omitempty"`
	SyncStatus       string    `json:"sync_status"`
	LastSyncedAt     time.Time `json:"last_synced_at,omitempty"`
	SyncToken        string    `json:"sync_token,omitempty"`
	AutoMatchEnabled bool      `json:"auto_match_enabled"`
	CreatedAt        time.Time `json:"created_at"`
}

// CalendarEvent represents a single meeting/event from a connected calendar.
type CalendarEvent struct {
	ID            int64     `json:"id"`
	IntegrationID int64     `json:"integration_id"`
	ExternalID    string    `json:"external_id"`
	Title         string    `json:"title"`
	Description   string    `json:"description"`
	StartTime     time.Time `json:"start_time"`
	EndTime       time.Time `json:"end_time"`
	AllDay        bool      `json:"all_day"`
	Status        string    `json:"status"`
	MeetingURL    string    `json:"meeting_url"`
	IsMatched     bool      `json:"is_matched"`
	MatchedLogID  int64     `json:"matched_log_id,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
}

// migrateFeatures initializes tables for Features 5, 8, 9, and 10.
func (db *DB) migrateFeatures() {
	tables := []string{
		// Feature 8: Privacy Rules
		`CREATE TABLE IF NOT EXISTS privacy_rules (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			rule_type   TEXT NOT NULL CHECK(rule_type IN ('app', 'title_regex', 'content_regex')),
			pattern     TEXT NOT NULL,
			action      TEXT NOT NULL CHECK(action IN ('blur', 'shield', 'skip_screenshot')) DEFAULT 'blur',
			description TEXT DEFAULT '',
			is_active   INTEGER DEFAULT 1,
			is_built_in INTEGER DEFAULT 0,
			created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE INDEX IF NOT EXISTS idx_privacy_rules_active ON privacy_rules(is_active);`,

		// Feature 5: Distraction Rules & Alerts
		`CREATE TABLE IF NOT EXISTS distraction_rules (
			id             INTEGER PRIMARY KEY AUTOINCREMENT,
			org_id         INTEGER DEFAULT 1,
			user_id        INTEGER DEFAULT 1,
			kind           TEXT NOT NULL CHECK(kind IN ('app', 'keyword', 'domain')),
			pattern        TEXT NOT NULL,
			is_distraction INTEGER NOT NULL DEFAULT 1,
			created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(user_id, pattern)
		);`,
		`CREATE INDEX IF NOT EXISTS idx_distraction_rules_user ON distraction_rules(user_id);`,

		`CREATE TABLE IF NOT EXISTS distraction_alerts (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			org_id            INTEGER DEFAULT 1,
			user_id           INTEGER DEFAULT 1,
			timestamp         DATETIME NOT NULL,
			app_name          TEXT NOT NULL,
			window_title      TEXT DEFAULT '',
			dwell_seconds     INTEGER NOT NULL,
			threshold_seconds INTEGER NOT NULL,
			action_taken      TEXT DEFAULT 'pending' CHECK(action_taken IN ('pending', 'dismissed', 'snoozed_10m', 'snoozed_30m', 'snoozed_1h', 'whitelisted', 'marked_productive')),
			action_at         DATETIME
		);`,
		`CREATE INDEX IF NOT EXISTS idx_distraction_alerts_ts ON distraction_alerts(timestamp);`,

		// Feature 9: Idle Intervals
		`CREATE TABLE IF NOT EXISTS idle_intervals (
			id               INTEGER PRIMARY KEY AUTOINCREMENT,
			org_id           INTEGER DEFAULT 1,
			user_id          INTEGER DEFAULT 1,
			start_time       DATETIME NOT NULL,
			end_time         DATETIME NOT NULL,
			duration_seconds INTEGER NOT NULL,
			status           TEXT CHECK(status IN ('pending', 'allocated', 'discarded')) DEFAULT 'pending',
			action_type      TEXT DEFAULT '',
			category         TEXT DEFAULT '',
			task_tag         TEXT DEFAULT '',
			is_productive    INTEGER DEFAULT 0,
			productive_score REAL DEFAULT 0,
			created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
			resolved_at      DATETIME
		);`,
		`CREATE INDEX IF NOT EXISTS idx_idle_intervals_user_time ON idle_intervals(user_id, start_time, end_time);`,
		`CREATE INDEX IF NOT EXISTS idx_idle_intervals_status ON idle_intervals(status);`,

		// Feature 10: Calendar Integrations & Events
		`CREATE TABLE IF NOT EXISTS calendar_integrations (
			id                 INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id            INTEGER DEFAULT 1,
			provider           TEXT NOT NULL CHECK(provider IN ('google', 'outlook', 'caldav', 'ics')),
			account_email      TEXT NOT NULL,
			display_name       TEXT DEFAULT '',
			encrypted_tokens   TEXT DEFAULT '',
			sync_status        TEXT DEFAULT 'idle',
			last_synced_at     DATETIME,
			sync_token         TEXT DEFAULT '',
			auto_match_enabled INTEGER DEFAULT 1,
			created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(user_id, provider, account_email)
		);`,
		`CREATE TABLE IF NOT EXISTS calendar_events (
			id             INTEGER PRIMARY KEY AUTOINCREMENT,
			integration_id INTEGER NOT NULL REFERENCES calendar_integrations(id) ON DELETE CASCADE,
			external_id    TEXT NOT NULL,
			title          TEXT NOT NULL,
			description    TEXT DEFAULT '',
			start_time     DATETIME NOT NULL,
			end_time       DATETIME NOT NULL,
			all_day        INTEGER DEFAULT 0,
			status         TEXT DEFAULT 'confirmed',
			meeting_url    TEXT DEFAULT '',
			is_matched     INTEGER DEFAULT 0,
			matched_log_id INTEGER DEFAULT 0,
			created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(integration_id, external_id)
		);`,
		`CREATE INDEX IF NOT EXISTS idx_calendar_events_time ON calendar_events(start_time, end_time);`,
	}

	if db.dialect == dialect.Postgres {
		tables = []string{
			`CREATE TABLE IF NOT EXISTS privacy_rules (
				id          SERIAL PRIMARY KEY,
				rule_type   TEXT NOT NULL CHECK(rule_type IN ('app', 'title_regex', 'content_regex')),
				pattern     TEXT NOT NULL,
				action      TEXT NOT NULL CHECK(action IN ('blur', 'shield', 'skip_screenshot')) DEFAULT 'blur',
				description TEXT DEFAULT '',
				is_active   BOOLEAN DEFAULT TRUE,
				is_built_in BOOLEAN DEFAULT FALSE,
				created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE TABLE IF NOT EXISTS distraction_rules (
				id             SERIAL PRIMARY KEY,
				org_id         INTEGER DEFAULT 1,
				user_id        INTEGER DEFAULT 1,
				kind           TEXT NOT NULL CHECK(kind IN ('app', 'keyword', 'domain')),
				pattern        TEXT NOT NULL,
				is_distraction BOOLEAN DEFAULT TRUE,
				created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(user_id, pattern)
			);`,
			`CREATE TABLE IF NOT EXISTS distraction_alerts (
				id                SERIAL PRIMARY KEY,
				org_id            INTEGER DEFAULT 1,
				user_id           INTEGER DEFAULT 1,
				timestamp         TIMESTAMPTZ NOT NULL,
				app_name          TEXT NOT NULL,
				window_title      TEXT DEFAULT '',
				dwell_seconds     INTEGER NOT NULL,
				threshold_seconds INTEGER NOT NULL,
				action_taken      TEXT DEFAULT 'pending' CHECK(action_taken IN ('pending', 'dismissed', 'snoozed_10m', 'snoozed_30m', 'snoozed_1h', 'whitelisted', 'marked_productive')),
				action_at         TIMESTAMPTZ
			);`,
			`CREATE TABLE IF NOT EXISTS idle_intervals (
				id               SERIAL PRIMARY KEY,
				org_id           INTEGER DEFAULT 1,
				user_id          INTEGER DEFAULT 1,
				start_time       TIMESTAMPTZ NOT NULL,
				end_time         TIMESTAMPTZ NOT NULL,
				duration_seconds INTEGER NOT NULL,
				status           TEXT CHECK(status IN ('pending', 'allocated', 'discarded')) DEFAULT 'pending',
				action_type      TEXT DEFAULT '',
				category         TEXT DEFAULT '',
				task_tag         TEXT DEFAULT '',
				is_productive    BOOLEAN DEFAULT FALSE,
				productive_score DOUBLE PRECISION DEFAULT 0,
				created_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
				resolved_at      TIMESTAMPTZ
			);`,
			`CREATE TABLE IF NOT EXISTS calendar_integrations (
				id                 SERIAL PRIMARY KEY,
				user_id            INTEGER DEFAULT 1,
				provider           TEXT NOT NULL CHECK(provider IN ('google', 'outlook', 'caldav', 'ics')),
				account_email      TEXT NOT NULL,
				display_name       TEXT DEFAULT '',
				encrypted_tokens   TEXT DEFAULT '',
				sync_status        TEXT DEFAULT 'idle',
				last_synced_at     TIMESTAMPTZ,
				sync_token         TEXT DEFAULT '',
				auto_match_enabled BOOLEAN DEFAULT TRUE,
				created_at         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(user_id, provider, account_email)
			);`,
			`CREATE TABLE IF NOT EXISTS calendar_events (
				id             SERIAL PRIMARY KEY,
				integration_id INTEGER NOT NULL REFERENCES calendar_integrations(id) ON DELETE CASCADE,
				external_id    TEXT NOT NULL,
				title          TEXT NOT NULL,
				description    TEXT DEFAULT '',
				start_time     TIMESTAMPTZ NOT NULL,
				end_time       TIMESTAMPTZ NOT NULL,
				all_day        BOOLEAN DEFAULT FALSE,
				status         TEXT DEFAULT 'confirmed',
				meeting_url    TEXT DEFAULT '',
				is_matched     BOOLEAN DEFAULT FALSE,
				matched_log_id INTEGER DEFAULT 0,
				created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(integration_id, external_id)
			);`,
		}
	}

	for _, stmt := range tables {
		_, _ = db.rawDB.Exec(stmt)
	}
}

// -------------------------------------------------------------
// Feature 8: Privacy Rules Methods
// -------------------------------------------------------------

func (db *DB) GetPrivacyRules() ([]PrivacyRule, error) {
	query := "SELECT id, rule_type, pattern, action, description, is_active, is_built_in, created_at FROM privacy_rules ORDER BY id ASC"
	rows, err := db.rawDB.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var rules []PrivacyRule
	for rows.Next() {
		var r PrivacyRule
		var isActive, isBuiltIn int
		var createdStr string
		if err := rows.Scan(&r.ID, &r.RuleType, &r.Pattern, &r.Action, &r.Description, &isActive, &isBuiltIn, &createdStr); err != nil {
			continue
		}
		r.IsActive = isActive == 1
		r.IsBuiltIn = isBuiltIn == 1
		r.CreatedAt, _ = time.Parse(time.RFC3339, createdStr)
		rules = append(rules, r)
	}
	return rules, nil
}

func (db *DB) InsertPrivacyRule(rule PrivacyRule) (int64, error) {
	activeInt := 0
	if rule.IsActive {
		activeInt = 1
	}
	builtInInt := 0
	if rule.IsBuiltIn {
		builtInInt = 1
	}
	res, err := db.rawDB.Exec(
		"INSERT INTO privacy_rules (rule_type, pattern, action, description, is_active, is_built_in, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		rule.RuleType, rule.Pattern, rule.Action, rule.Description, activeInt, builtInInt, time.Now().UTC().Format(time.RFC3339),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (db *DB) TogglePrivacyRule(id int64, active bool) error {
	activeInt := 0
	if active {
		activeInt = 1
	}
	_, err := db.rawDB.Exec("UPDATE privacy_rules SET is_active = ? WHERE id = ?", activeInt, id)
	return err
}

func (db *DB) DeletePrivacyRule(id int64) error {
	_, err := db.rawDB.Exec("DELETE FROM privacy_rules WHERE id = ?", id)
	return err
}

// -------------------------------------------------------------
// Feature 9: Idle Interval & Synthetic Log Allocation
// -------------------------------------------------------------

type RetroactiveAllocationParams struct {
	OrgID           int64     `json:"org_id"`
	UserID          int64     `json:"user_id"`
	StartTime       time.Time `json:"start_time"`
	EndTime         time.Time `json:"end_time"`
	ActionType      string    `json:"action_type"` // 'meeting', 'break', 'discard'
	Category        string    `json:"category"`    // 'Meeting', 'Break', 'Planning'
	TaskTag         string    `json:"task_tag"`    // Discussion note
	IsProductive    bool      `json:"is_productive"`
	ProductiveScore float64   `json:"productive_score"`
	IntervalSec     int64     `json:"interval_sec"`
}

func (db *DB) AllocateIdleBlock(params RetroactiveAllocationParams) (int64, error) {
	if params.IntervalSec <= 0 {
		params.IntervalSec = 30
	}

	tx, err := db.rawDB.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	durationSec := int64(params.EndTime.Sub(params.StartTime).Seconds())
	if durationSec <= 0 {
		return 0, fmt.Errorf("invalid interval duration (%d seconds)", durationSec)
	}

	productiveInt := 0
	if params.IsProductive {
		productiveInt = 1
	}

	status := "allocated"
	if params.ActionType == "discard" {
		status = "discarded"
	}

	// 1. Insert Idle Interval Record
	builder := entsql.Dialect(db.dialect).Insert("idle_intervals").
		Columns("org_id", "user_id", "start_time", "end_time", "duration_seconds", "status", "action_type", "category", "task_tag", "is_productive", "productive_score", "resolved_at").
		Values(
			params.OrgID,
			params.UserID,
			params.StartTime.UTC().Format(time.RFC3339),
			params.EndTime.UTC().Format(time.RFC3339),
			durationSec,
			status,
			params.ActionType,
			params.Category,
			params.TaskTag,
			productiveInt,
			params.ProductiveScore,
			time.Now().UTC().Format(time.RFC3339),
		)

	var intervalID int64
	if db.dialect == dialect.Postgres {
		builder.Returning("id")
		query, args := builder.Query()
		if err := tx.QueryRow(query, args...).Scan(&intervalID); err != nil {
			return 0, fmt.Errorf("insert idle_interval: %w", err)
		}
	} else {
		query, args := builder.Query()
		res, err := tx.Exec(query, args...)
		if err != nil {
			return 0, fmt.Errorf("insert idle_interval: %w", err)
		}
		intervalID, _ = res.LastInsertId()
	}

	if params.ActionType == "discard" {
		return intervalID, tx.Commit()
	}

	// 2. Inject synthetic discrete log entries across [StartTime, EndTime)
	curr := params.StartTime
	step := time.Duration(params.IntervalSec) * time.Second

	for curr.Before(params.EndTime) {
		logBuilder := entsql.Dialect(db.dialect).Insert("logs").
			Columns(
				"org_id", "user_id", "timestamp", "image_path",
				"total_keys", "unique_keys", "entropy_score", "total_clicks", "mouse_distance",
				"app_name", "app_category", "window_title",
				"ai_category", "is_productive", "productive_score", "ai_confidence", "ai_reason",
				"sync_status", "is_retroactive", "idle_interval_id",
			).
			Values(
				params.OrgID,
				params.UserID,
				curr.UTC().Format(time.RFC3339),
				"", // zero image
				0, 0, 0, 0, 0,
				params.Category,
				params.Category,
				params.TaskTag,
				params.Category,
				productiveInt,
				params.ProductiveScore,
				1.0,
				fmt.Sprintf("Retroactively allocated by user: %s", params.TaskTag),
				"pending_upload",
				1,
				intervalID,
			)

		lQuery, lArgs := logBuilder.Query()
		if _, err := tx.Exec(lQuery, lArgs...); err != nil {
			return 0, fmt.Errorf("insert synthetic log at %s: %w", curr, err)
		}

		curr = curr.Add(step)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit allocation tx: %w", err)
	}

	return intervalID, nil
}

// -------------------------------------------------------------
// Feature 5: Distraction Rules & Alerts Methods
// -------------------------------------------------------------

func (db *DB) RecordDistractionAlert(alert DistractionAlert) (int64, error) {
	res, err := db.rawDB.Exec(
		"INSERT INTO distraction_alerts (org_id, user_id, timestamp, app_name, window_title, dwell_seconds, threshold_seconds, action_taken, action_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		alert.OrgID, alert.UserID, alert.Timestamp.UTC().Format(time.RFC3339), alert.AppName, alert.WindowTitle, alert.DwellSeconds, alert.ThresholdSeconds, alert.ActionTaken, time.Now().UTC().Format(time.RFC3339),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (db *DB) UpdateDistractionAlertAction(id int64, action string) error {
	_, err := db.rawDB.Exec("UPDATE distraction_alerts SET action_taken = ?, action_at = ? WHERE id = ?", action, time.Now().UTC().Format(time.RFC3339), id)
	return err
}

func (db *DB) GetDistractionRules(userID int64) ([]DistractionRule, error) {
	rows, err := db.rawDB.Query("SELECT id, org_id, user_id, kind, pattern, is_distraction, created_at FROM distraction_rules WHERE user_id = ? ORDER BY id ASC", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var rules []DistractionRule
	for rows.Next() {
		var r DistractionRule
		var isDist int
		var createdStr string
		if err := rows.Scan(&r.ID, &r.OrgID, &r.UserID, &r.Kind, &r.Pattern, &isDist, &createdStr); err != nil {
			continue
		}
		r.IsDistraction = isDist == 1
		r.CreatedAt, _ = time.Parse(time.RFC3339, createdStr)
		rules = append(rules, r)
	}
	return rules, nil
}

func (db *DB) UpsertDistractionRule(rule DistractionRule) (int64, error) {
	isDist := 0
	if rule.IsDistraction {
		isDist = 1
	}
	res, err := db.rawDB.Exec(
		"INSERT OR REPLACE INTO distraction_rules (org_id, user_id, kind, pattern, is_distraction, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		rule.OrgID, rule.UserID, rule.Kind, rule.Pattern, isDist, time.Now().UTC().Format(time.RFC3339),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (db *DB) DeleteDistractionRule(id int64) error {
	_, err := db.rawDB.Exec("DELETE FROM distraction_rules WHERE id = ?", id)
	return err
}

// -------------------------------------------------------------
// Feature 10: Calendar Integrations & Events Methods
// -------------------------------------------------------------

func (db *DB) GetCalendarIntegrations(userID int64) ([]CalendarIntegration, error) {
	rows, err := db.rawDB.Query("SELECT id, user_id, provider, account_email, display_name, sync_status, last_synced_at, auto_match_enabled, created_at FROM calendar_integrations WHERE user_id = ?", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var integrations []CalendarIntegration
	for rows.Next() {
		var ci CalendarIntegration
		var autoMatch int
		var lastSync sql.NullString
		var createdStr string
		if err := rows.Scan(&ci.ID, &ci.UserID, &ci.Provider, &ci.AccountEmail, &ci.DisplayName, &ci.SyncStatus, &lastSync, &autoMatch, &createdStr); err != nil {
			continue
		}
		ci.AutoMatchEnabled = autoMatch == 1
		if lastSync.Valid {
			ci.LastSyncedAt, _ = time.Parse(time.RFC3339, lastSync.String)
		}
		ci.CreatedAt, _ = time.Parse(time.RFC3339, createdStr)
		integrations = append(integrations, ci)
	}
	return integrations, nil
}

func (db *DB) UpsertCalendarIntegration(ci CalendarIntegration) (int64, error) {
	autoMatch := 0
	if ci.AutoMatchEnabled {
		autoMatch = 1
	}
	res, err := db.rawDB.Exec(
		"INSERT OR REPLACE INTO calendar_integrations (user_id, provider, account_email, display_name, encrypted_tokens, sync_status, last_synced_at, sync_token, auto_match_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		ci.UserID, ci.Provider, ci.AccountEmail, ci.DisplayName, ci.EncryptedTokens, ci.SyncStatus, time.Now().UTC().Format(time.RFC3339), ci.SyncToken, autoMatch, time.Now().UTC().Format(time.RFC3339),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (db *DB) GetCalendarEvents(userID int64, from, to time.Time) ([]CalendarEvent, error) {
	query := `SELECT e.id, e.integration_id, e.external_id, e.title, e.description, e.start_time, e.end_time, e.all_day, e.status, e.meeting_url, e.is_matched, e.matched_log_id, e.created_at
		FROM calendar_events e
		JOIN calendar_integrations i ON e.integration_id = i.id
		WHERE i.user_id = ? AND e.start_time <= ? AND e.end_time >= ?
		ORDER BY e.start_time ASC`
	rows, err := db.rawDB.Query(query, userID, to.UTC().Format(time.RFC3339), from.UTC().Format(time.RFC3339))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []CalendarEvent
	for rows.Next() {
		var ce CalendarEvent
		var allDay, isMatched int
		var startStr, endStr, createdStr string
		var desc, url sql.NullString
		if err := rows.Scan(&ce.ID, &ce.IntegrationID, &ce.ExternalID, &ce.Title, &desc, &startStr, &endStr, &allDay, &ce.Status, &url, &isMatched, &ce.MatchedLogID, &createdStr); err != nil {
			continue
		}
		ce.Description = desc.String
		ce.MeetingURL = url.String
		ce.AllDay = allDay == 1
		ce.IsMatched = isMatched == 1
		ce.StartTime, _ = time.Parse(time.RFC3339, startStr)
		ce.EndTime, _ = time.Parse(time.RFC3339, endStr)
		ce.CreatedAt, _ = time.Parse(time.RFC3339, createdStr)
		events = append(events, ce)
	}
	return events, nil
}
