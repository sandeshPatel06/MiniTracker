package main

import (
	"runtime"
	"strings"
	"testing"
)

func TestHasGraphicalSession(t *testing.T) {
	t.Run("no display vars", func(t *testing.T) {
		t.Setenv("DISPLAY", "")
		t.Setenv("WAYLAND_DISPLAY", "")
		if hasGraphicalSession() {
			t.Fatal("expected false when DISPLAY and WAYLAND_DISPLAY are empty")
		}
	})

	t.Run("x11 session", func(t *testing.T) {
		t.Setenv("DISPLAY", ":0")
		t.Setenv("WAYLAND_DISPLAY", "")
		if !hasGraphicalSession() {
			t.Fatal("expected true when DISPLAY is set")
		}
	})

	t.Run("wayland session", func(t *testing.T) {
		t.Setenv("DISPLAY", "")
		t.Setenv("WAYLAND_DISPLAY", "wayland-0")
		if !hasGraphicalSession() {
			t.Fatal("expected true when WAYLAND_DISPLAY is set")
		}
	})
}

func TestRunGUIPreflight(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("preflight check only guards linux")
	}
	t.Setenv("DISPLAY", "")
	t.Setenv("WAYLAND_DISPLAY", "")

	err := runGUI(NewApp())
	if err == nil {
		t.Fatal("expected preflight error without a graphical session")
	}
	if !strings.Contains(err.Error(), "no graphical session") {
		t.Fatalf("unexpected error: %v", err)
	}
}
