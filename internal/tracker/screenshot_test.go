package tracker

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestUniqueScreenshotPathDistinctTimestamps(t *testing.T) {
	dir := t.TempDir()
	ts := time.Date(2026, 11, 10, 9, 30, 15, 123000000, time.Local)

	got := uniqueScreenshotPath(dir, ts)
	want := filepath.Join(dir, "09-30-15.123.webp")
	if got != want {
		t.Fatalf("uniqueScreenshotPath() = %q, want %q", got, want)
	}
}

func TestUniqueScreenshotPathCollisionNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	ts := time.Date(2026, 11, 10, 9, 30, 15, 123000000, time.Local)

	p1 := uniqueScreenshotPath(dir, ts)
	if err := os.WriteFile(p1, []byte("first"), 0644); err != nil {
		t.Fatalf("write first capture: %v", err)
	}

	// A second capture in the same millisecond must not resolve to the same
	// file (which would silently overwrite the first capture).
	p2 := uniqueScreenshotPath(dir, ts)
	if p2 == p1 {
		t.Fatal("second capture in the same millisecond resolved to the same path; it would overwrite the first")
	}
	if err := os.WriteFile(p2, []byte("second"), 0644); err != nil {
		t.Fatalf("write second capture: %v", err)
	}

	// Third capture still unique after two collisions.
	p3 := uniqueScreenshotPath(dir, ts)
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

func TestUniqueScreenshotPathDifferentMilliseconds(t *testing.T) {
	dir := t.TempDir()
	t1 := time.Date(2026, 11, 10, 9, 30, 15, 0, time.Local)
	t2 := t1.Add(time.Millisecond)

	p1 := uniqueScreenshotPath(dir, t1)
	p2 := uniqueScreenshotPath(dir, t2)
	if p1 == p2 {
		t.Fatalf("captures 1ms apart resolved to the same path %q", p1)
	}
}
