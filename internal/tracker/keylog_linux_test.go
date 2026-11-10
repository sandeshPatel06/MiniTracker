//go:build linux

package tracker

import (
	"testing"

	"github.com/holoplot/go-evdev"
)

// TestIsTypingKeyboard guards keyboard discovery: devices that only emit
// button codes (mice, touchpads, power buttons) must not be classified as
// keyboards, otherwise their BTN_* press codes (272+) leak into the keystroke
// entropy stream and inflate the unique-key count.
func TestIsTypingKeyboard(t *testing.T) {
	tests := []struct {
		name      string
		keyCodes  []evdev.EvCode
		wantTruth bool
	}{
		{
			name:      "mouse buttons only",
			keyCodes:  []evdev.EvCode{272, 273, 274},
			wantTruth: false,
		},
		{
			name:      "power button only",
			keyCodes:  []evdev.EvCode{116},
			wantTruth: false,
		},
		{
			name:      "touchpad buttons only",
			keyCodes:  []evdev.EvCode{325, 326, 330, 331},
			wantTruth: false,
		},
		{
			name:      "real keyboard letter",
			keyCodes:  []evdev.EvCode{evdev.KEY_A, evdev.KEY_SPACE, evdev.KEY_ENTER, evdev.KEY_LEFTSHIFT},
			wantTruth: true,
		},
		{
			name:      "combined receiver (keyboard part)",
			keyCodes:  []evdev.EvCode{272, 273, evdev.KEY_Q, evdev.KEY_W, evdev.KEY_E},
			wantTruth: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isTypingKeyboard(tt.keyCodes); got != tt.wantTruth {
				t.Fatalf("isTypingKeyboard(%v) = %v; want %v", tt.keyCodes, got, tt.wantTruth)
			}
		})
	}
}
