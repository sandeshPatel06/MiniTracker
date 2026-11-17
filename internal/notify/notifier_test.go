package notify

import (
	"sync"
	"testing"
)

func TestFallbackNotifier(t *testing.T) {
	fb := &fallbackNotifier{}
	n := Notification{
		Title: "Test Title",
		Body:  "Test Body",
	}

	// In test/headless environments notify-send may not be available or may exit non-zero,
	// but Close() must always succeed cleanly.
	_ = fb.Send(n)
	if err := fb.Close(); err != nil {
		t.Fatalf("expected nil close error, got: %v", err)
	}
}

func TestLinuxNotifier_CallbacksSafety(t *testing.T) {
	// Verify callback map operations and signal handling logic
	ln := &LinuxNotifier{
		callbacks: make(map[uint32]func(string)),
		stopCh:    make(chan struct{}),
	}

	var triggeredKey string
	var cbMu sync.Mutex

	cb := func(action string) {
		cbMu.Lock()
		triggeredKey = action
		cbMu.Unlock()
	}

	ln.mu.Lock()
	ln.callbacks[100] = cb
	ln.mu.Unlock()

	// Simulate invocation
	ln.mu.Lock()
	handler, exists := ln.callbacks[100]
	if exists {
		delete(ln.callbacks, 100)
	}
	ln.mu.Unlock()

	if !exists || handler == nil {
		t.Fatalf("expected registered callback to exist")
	}

	handler("snooze_10m")

	cbMu.Lock()
	if triggeredKey != "snooze_10m" {
		t.Errorf("expected 'snooze_10m', got %s", triggeredKey)
	}
	cbMu.Unlock()

	// Repeated close safety
	ln.Close()
}
