package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGuiPidPath(t *testing.T) {
	dir := t.TempDir()
	if got, want := guiPidPath(dir), filepath.Join(dir, "gui.pid"); got != want {
		t.Fatalf("guiPidPath() = %q, want %q", got, want)
	}
}

func TestGuiAppRunning(t *testing.T) {
	dir := t.TempDir()

	// No pidfile -> not running.
	if guiAppRunning(dir) {
		t.Fatal("guiAppRunning(empty dir) = true, want false")
	}

	// Garbage pidfile -> not running.
	if err := os.WriteFile(guiPidPath(dir), []byte("junk"), 0644); err != nil {
		t.Fatalf("write garbage pidfile: %v", err)
	}
	if guiAppRunning(dir) {
		t.Fatal("guiAppRunning(garbage pidfile) = true, want false")
	}

	// Dead pid -> not running.
	if err := os.WriteFile(guiPidPath(dir), []byte("999999"), 0644); err != nil {
		t.Fatalf("write dead pidfile: %v", err)
	}
	if guiAppRunning(dir) {
		t.Fatal("guiAppRunning(dead pid) = true, want false")
	}

	// Our own pid is never counted (a process cannot guard against itself).
	if err := writePIDFile(guiPidPath(dir), os.Getpid()); err != nil {
		t.Fatalf("write self pidfile: %v", err)
	}
	if guiAppRunning(dir) {
		t.Fatal("guiAppRunning(self pid) = true, want false")
	}
}

func TestProcessMatchesBinarySelf(t *testing.T) {
	if !processMatchesBinary(os.Getpid()) {
		t.Fatal("processMatchesBinary(self) = false, want true")
	}
	// Without /proc (non-linux/android) the pidfile is trusted, so a dead pid
	// cannot be distinguished and the check must not be asserted.
	if procAvailable() && processMatchesBinary(999999) {
		t.Fatal("processMatchesBinary(dead pid) = true, want false")
	}
}

func TestRemovePIDFileIfOwner(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "owner.pid")

	// Another owner's registration must survive.
	if err := writePIDFile(path, 4242); err != nil {
		t.Fatalf("write pidfile: %v", err)
	}
	removePIDFileIfOwner(path, 1234)
	if got := readPIDFile(path); got != 4242 {
		t.Fatalf("readPIDFile after foreign remove = %d, want 4242 (file must survive)", got)
	}

	// The owner removes its own registration.
	removePIDFileIfOwner(path, 4242)
	if got := readPIDFile(path); got != 0 {
		t.Fatalf("readPIDFile after owner remove = %d, want 0", got)
	}

	// Missing file is a no-op.
	removePIDFileIfOwner(path, 4242)
}
