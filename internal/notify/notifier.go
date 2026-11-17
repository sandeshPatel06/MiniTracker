package notify

// ActionItem represents an interactive notification button.
type ActionItem struct {
	Key   string `json:"key"`   // e.g. "snooze_10m", "dismiss", "whitelist"
	Label string `json:"label"` // e.g. "Snooze 10m", "Dismiss", "I'm Working"
}

// Notification contains data for a desktop notification.
type Notification struct {
	ID       uint32
	Title    string
	Body     string
	AppName  string
	IconPath string
	Timeout  int // Milliseconds
	Actions  []ActionItem
	OnAction func(actionKey string)
}

// PlatformNotifier defines cross-platform desktop notification dispatch.
type PlatformNotifier interface {
	Send(n Notification) error
	Close() error
}
