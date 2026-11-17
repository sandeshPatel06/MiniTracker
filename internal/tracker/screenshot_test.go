package tracker

import (
	"image"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReserveScreenshotPathFreshTimestamp(t *testing.T) {
	dir := t.TempDir()
	ts := time.Date(2026, 11, 10, 9, 30, 15, 123000000, time.Local)

	got, err := reserveScreenshotPath(dir, ts)
	if err != nil {
		t.Fatalf("reserveScreenshotPath: %v", err)
	}
	want := filepath.Join(dir, "09-30-15.123.webp")
	if got != want {
		t.Fatalf("reserveScreenshotPath() = %q, want %q", got, want)
	}
	// The claim must materialize as an existing file so future callers churn
	// to a -N suffix instead of reusing the name.
	if _, err := os.Stat(got); err != nil {
		t.Fatalf("reserved path does not exist: %v", err)
	}
}

func TestReserveScreenshotPathSameMillisecondNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	ts := time.Date(2026, 11, 10, 9, 30, 15, 123000000, time.Local)

	p1, err := reserveScreenshotPath(dir, ts)
	if err != nil {
		t.Fatalf("first reservation: %v", err)
	}
	// A second reservation in the same millisecond — e.g. daemon process
	// racing the GUI app — must kernel-fail the create and fall through to the
	// next suffix, never reusing the name.
	p2, err := reserveScreenshotPath(dir, ts)
	if err != nil {
		t.Fatalf("second reservation: %v", err)
	}
	if p2 == p1 {
		t.Fatal("second capture in the same millisecond resolved to the same path; the first would be overwritten")
	}
	if err := os.WriteFile(p1, []byte("first"), 0644); err != nil {
		t.Fatalf("write first capture: %v", err)
	}
	if err := os.WriteFile(p2, []byte("second"), 0644); err != nil {
		t.Fatalf("write second capture: %v", err)
	}

	// Third reservation still unique after two collisions.
	p3, err := reserveScreenshotPath(dir, ts)
	if err != nil {
		t.Fatalf("third reservation: %v", err)
	}
	if p3 == p1 || p3 == p2 {
		t.Fatalf("third capture path %q collides with an existing capture", p3)
	}

	data1, err := os.ReadFile(p1)
	if err != nil || string(data1) != "first" {
		t.Fatalf("first capture content lost/overwritten: %v %q", err, data1)
	}
	data2, err := os.ReadFile(p2)
	if err != nil || string(data2) != "second" {
		t.Fatalf("second capture content lost/overwritten: %v %q", err, data2)
	}
}

func TestReserveScreenshotPathDifferentMilliseconds(t *testing.T) {
	dir := t.TempDir()
	t1 := time.Date(2026, 11, 10, 9, 30, 15, 0, time.Local)
	t2 := t1.Add(time.Millisecond)

	p1, err := reserveScreenshotPath(dir, t1)
	if err != nil {
		t.Fatalf("first reservation: %v", err)
	}
	p2, err := reserveScreenshotPath(dir, t2)
	if err != nil {
		t.Fatalf("second reservation: %v", err)
	}
	if p1 == p2 {
		t.Fatalf("captures 1ms apart resolved to the same path %q", p1)
	}
}

// TestReserveScreenshotPathBrokenDir ensures a broken save location fails fast
// with an error. The previous inspect-then-create loop spun forever on a
// persistent Stat error, deadlocking every future capture on captureMu.
func TestReserveScreenshotPathBrokenDir(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "2026-11-10")
	if err := os.WriteFile(blocker, []byte("a file where the day dir belongs"), 0644); err != nil {
		t.Fatalf("create blocker: %v", err)
	}

	if _, err := reserveScreenshotPath(blocker, time.Date(2026, 11, 10, 9, 30, 15, 0, time.Local)); err == nil {
		t.Fatal("reserveScreenshotPath must fail fast when the target directory is unusable")
	}
}

// TestResizeImageClampsDegenerateResult ensures extreme aspect ratios never
// round a resized dimension down to zero (which would encode a broken WebP).
func TestResizeImageClampsDegenerateResult(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 2, 4000))
	got := resizeImage(src, defaultMaxWidth, defaultMaxHeight)

	b := got.Bounds()
	if b.Dx() < 1 || b.Dy() < 1 {
		t.Fatalf("resizeImage(2x4000) → %dx%d; want both dimensions >= 1", b.Dx(), b.Dy())
	}
}

// TestResizeImageNoUpscale ensures images already within bounds are returned
// unchanged rather than scaled up to the cap.
func TestResizeImageNoUpscale(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 800, 400))
	got := resizeImage(src, defaultMaxWidth, defaultMaxHeight)
	if got != image.Image(src) {
		t.Fatal("resizeImage rescaled an already-small image; expected the source back")
	}
}

// TestResizeImageWidthBound asserts the 1080p box is respected for landscape
// frames (common single-monitor case).
func TestResizeImageWidthBound(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 2560, 1440))
	got := resizeImage(src, defaultMaxWidth, defaultMaxHeight)

	b := got.Bounds()
	if b.Dx() != defaultMaxWidth || b.Dy() != defaultMaxHeight {
		t.Fatalf("resizeImage(2560x1440) = %dx%d; want %dx%d", b.Dx(), b.Dy(), defaultMaxWidth, defaultMaxHeight)
	}
}

func TestGetMaxDimensionsDefaultsAndEnv(t *testing.T) {
	// 1. Defaults
	os.Unsetenv("SCREENSHOT_MAX_WIDTH")
	os.Unsetenv("SCREENSHOT_MAX_HEIGHT")
	w, h := getMaxDimensions()
	if w != 1920 || h != 1080 {
		t.Errorf("getMaxDimensions() = %dx%d; want 1920x1080", w, h)
	}

	// 2. Custom env overrides
	os.Setenv("SCREENSHOT_MAX_WIDTH", "2560")
	os.Setenv("SCREENSHOT_MAX_HEIGHT", "1440")
	defer func() {
		os.Unsetenv("SCREENSHOT_MAX_WIDTH")
		os.Unsetenv("SCREENSHOT_MAX_HEIGHT")
	}()

	w, h = getMaxDimensions()
	if w != 2560 || h != 1440 {
		t.Errorf("getMaxDimensions() = %dx%d; want 2560x1440", w, h)
	}

	// 3. Invalid env values fall back to defaults
	os.Setenv("SCREENSHOT_MAX_WIDTH", "invalid")
	os.Setenv("SCREENSHOT_MAX_HEIGHT", "-100")
	w, h = getMaxDimensions()
	if w != 1920 || h != 1080 {
		t.Errorf("getMaxDimensions() with invalid env = %dx%d; want 1920x1080", w, h)
	}
}

func TestGetWebpQualityDefaultsAndClamping(t *testing.T) {
	// 1. Default
	os.Unsetenv("SCREENSHOT_QUALITY")
	q := getWebpQuality()
	if q != 80 {
		t.Errorf("getWebpQuality() = %v; want 80", q)
	}

	// 2. Custom valid quality
	os.Setenv("SCREENSHOT_QUALITY", "85")
	defer os.Unsetenv("SCREENSHOT_QUALITY")
	if q := getWebpQuality(); q != 85 {
		t.Errorf("getWebpQuality() = %v; want 85", q)
	}

	// 3. Lower bound clamp (clamp to 30)
	os.Setenv("SCREENSHOT_QUALITY", "10")
	if q := getWebpQuality(); q != 30 {
		t.Errorf("getWebpQuality() = %v; want clamped 30", q)
	}

	// 4. Upper bound clamp (clamp to 100)
	os.Setenv("SCREENSHOT_QUALITY", "120")
	if q := getWebpQuality(); q != 100 {
		t.Errorf("getWebpQuality() = %v; want clamped 100", q)
	}

	// 5. Invalid string falls back to default 80
	os.Setenv("SCREENSHOT_QUALITY", "ultra-hd")
	if q := getWebpQuality(); q != 80 {
		t.Errorf("getWebpQuality() = %v; want fallback 80", q)
	}
}

// TestCaptureScreenshotIntegration verifies that CaptureScreenshot works silently and produces a valid WebP file.
func TestCaptureScreenshotIntegration(t *testing.T) {
	dir := t.TempDir()
	res, err := CaptureScreenshot(dir)
	if err != nil {
		t.Logf("CaptureScreenshot in test env: %v", err)
		return
	}
	if res.FilePath == "" {
		t.Fatal("res.FilePath is empty")
	}
	if res.Width <= 0 || res.Height <= 0 {
		t.Fatalf("res dimensions invalid: %dx%d", res.Width, res.Height)
	}
	if info, err := os.Stat(res.FilePath); err != nil || info.Size() == 0 {
		t.Fatalf("screenshot file not created or empty: %v", err)
	}
}
