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
	got := resizeImage(src, maxWidth, maxHeight)

	b := got.Bounds()
	if b.Dx() < 1 || b.Dy() < 1 {
		t.Fatalf("resizeImage(2x4000) → %dx%d; want both dimensions >= 1", b.Dx(), b.Dy())
	}
}

// TestResizeImageNoUpscale ensures images already within bounds are returned
// unchanged rather than scaled up to the cap.
func TestResizeImageNoUpscale(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 800, 400))
	got := resizeImage(src, maxWidth, maxHeight)
	if got != image.Image(src) {
		t.Fatal("resizeImage rescaled an already-small image; expected the source back")
	}
}

// TestResizeImageWidthBound asserts the 720p box is respected for landscape
// frames (common single-monitor case).
func TestResizeImageWidthBound(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 2560, 1440))
	got := resizeImage(src, maxWidth, maxHeight)

	b := got.Bounds()
	if b.Dx() != maxWidth || b.Dy() != maxHeight {
		t.Fatalf("resizeImage(2560x1440) = %dx%d; want %dx%d", b.Dx(), b.Dy(), maxWidth, maxHeight)
	}
}
