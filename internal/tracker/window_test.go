package tracker

import (
	"errors"
	"testing"
	"testing/quick"

	"github.com/jezek/xgb/xproto"
)

// TestWindowIDFromProperty ensures the active-window property is parsed
// defensively: values shorter than the 4-byte WINDOW property (xgb.Get32 reads
// 4 bytes) must never panic, and a zero window id maps to ErrNoActiveWindow.
func TestWindowIDFromProperty(t *testing.T) {
	tests := []struct {
		name         string
		value        []byte
		wantID       xproto.Window
		wantInactive bool // err must be ErrNoActiveWindow
		wantFail     bool // err must be non-nil
	}{
		{"empty value", nil, 0, false, true},
		{"one byte", []byte{0x01}, 0, false, true},
		{"three bytes", []byte{0x01, 0x02, 0x03}, 0, false, true},
		{"zero id", []byte{0x00, 0x00, 0x00, 0x00}, 0, true, true},
		{"valid id", []byte{0x2A, 0x00, 0x00, 0x00}, 42, false, false},
		{"little-endian limbs", []byte{0x2A, 0x01, 0x00, 0x00}, 0x12A, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			id, err := windowIDFromProperty(tt.value)
			if tt.wantFail && err == nil {
				t.Fatalf("windowIDFromProperty(%v) = %d, nil error; want error", tt.value, id)
			}
			if !tt.wantFail && err != nil {
				t.Fatalf("windowIDFromProperty(%v) unexpected error: %v", tt.value, err)
			}
			if tt.wantInactive && !errors.Is(err, ErrNoActiveWindow) {
				t.Fatalf("windowIDFromProperty(%v) error = %v; want ErrNoActiveWindow", tt.value, err)
			}
			if id != tt.wantID {
				t.Fatalf("windowIDFromProperty(%v) = %d; want %d", tt.value, id, tt.wantID)
			}
		})
	}

	// Quick: any input shorter than 4 bytes must not panic.
	qc := func(b []byte) bool { _, _ = windowIDFromProperty(b); return true }
	if err := quick.Check(qc, &quick.Config{MaxCount: 100}); err != nil {
		t.Fatalf("quickcheck windowIDFromProperty: %v", err)
	}
}
