//go:build linux

package tracker

import (
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/godbus/dbus/v5"
	"github.com/kbinani/screenshot"
)

// acquireCaptureLock claims the inter-process capture file lock (capture.lock).
// Returns an error if another worker/process is currently capturing.
func acquireCaptureLock(dataDir string) (*os.File, error) {
	if dataDir == "" {
		return nil, nil
	}
	lockPath := filepath.Join(dataDir, "capture.lock")
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

// releaseCaptureLock unlocks and closes the capture lock file.
func releaseCaptureLock(f *os.File) {
	if f == nil {
		return
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	_ = f.Close()
}

// captureDisplays grabs the desktop screen without playing camera shutter or click sounds.
func captureDisplays() (image.Image, error) {
	// 1. Direct GNOME Shell Screenshot D-Bus interface.
	// Flash=false guarantees GNOME will NOT play any camera shutter click sound or flash the screen.
	// It directly grabs the compositor stage, capturing all displays at once in ~15ms.
	if img, err := captureGnomeShell(); err == nil && img != nil {
		return img, nil
	}

	// 2. If on Wayland and `grim` CLI tool is available (Sway, Hyprland, etc.), use grim (silent).
	if isWayland() {
		if img, err := captureGrim(); err == nil && img != nil {
			return img, nil
		}
	}

	// 3. Fallback to X11/Xinerama or default capture.
	return captureKbinaniDisplays()
}

func isWayland() bool {
	return strings.ToLower(os.Getenv("XDG_SESSION_TYPE")) == "wayland" || os.Getenv("WAYLAND_DISPLAY") != ""
}

// captureGnomeShell calls org.gnome.Shell.Screenshot.Screenshot with flash=false,
// which performs an instant, silent screen capture on GNOME (Wayland & X11).
func captureGnomeShell() (image.Image, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("connect session bus: %w", err)
	}
	defer conn.Close()

	tmpFile, err := os.CreateTemp("", "hike-capture-*.png")
	if err != nil {
		return nil, fmt.Errorf("create temp capture: %w", err)
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer os.Remove(tmpPath)

	obj := conn.Object("org.gnome.Shell.Screenshot", dbus.ObjectPath("/org/gnome/Shell/Screenshot"))
	// Parameters: include_cursor = false, flash = false, filename = tmpPath
	// CRITICAL: flash=false prevents the camera shutter sound and screen flashing!
	call := obj.Call("org.gnome.Shell.Screenshot.Screenshot", 0, false, false, tmpPath)
	if call.Err != nil {
		return nil, fmt.Errorf("gnome screenshot call: %w", call.Err)
	}

	var success bool
	var filenameUsed string
	if err := call.Store(&success, &filenameUsed); err != nil {
		return nil, fmt.Errorf("store reply: %w", err)
	}
	if !success {
		return nil, fmt.Errorf("gnome screenshot returned success=false")
	}

	targetPath := filenameUsed
	if targetPath == "" {
		targetPath = tmpPath
	}
	if targetPath != tmpPath {
		defer os.Remove(targetPath)
	}

	f, err := os.Open(targetPath)
	if err != nil {
		return nil, fmt.Errorf("open capture file: %w", err)
	}
	defer f.Close()

	img, err := png.Decode(f)
	if err != nil {
		return nil, fmt.Errorf("decode capture file: %w", err)
	}
	return img, nil
}

func captureGrim() (image.Image, error) {
	grimPath, err := exec.LookPath("grim")
	if err != nil {
		return nil, err
	}
	tmpFile, err := os.CreateTemp("", "hike-grim-*.png")
	if err != nil {
		return nil, err
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer os.Remove(tmpPath)

	cmd := exec.Command(grimPath, "-t", "png", tmpPath)
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("grim capture failed: %w", err)
	}

	f, err := os.Open(tmpPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	return png.Decode(f)
}

func captureKbinaniDisplays() (image.Image, error) {
	n := screenshot.NumActiveDisplays()
	if n == 0 {
		return nil, fmt.Errorf("no active displays detected")
	}

	var displayImgs []image.Image
	for i := 0; i < n; i++ {
		bounds := screenshot.GetDisplayBounds(i)
		img, err := screenshot.CaptureRect(bounds)
		if err != nil {
			log.Printf("[tracker] capture screen display %d: %v", i, err)
			continue
		}
		displayImgs = append(displayImgs, img)
	}

	if len(displayImgs) == 0 {
		return nil, fmt.Errorf("failed to capture any active display")
	}

	return stitchDisplayImages(displayImgs), nil
}
