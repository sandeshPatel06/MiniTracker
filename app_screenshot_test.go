package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/reak/get-hike/internal/config"
)

func TestExpandHomePath(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir: %v", err)
	}

	if got := expandHomePath("~"); got != home {
		t.Fatalf("expandHomePath(~) = %q, want %q", got, home)
	}
	if got := expandHomePath("~/.local/share/get-hike"); got != filepath.Join(home, ".local", "share", "get-hike") {
		t.Fatalf("expandHomePath(~/...) = %q, want %q", got, filepath.Join(home, ".local", "share", "get-hike"))
	}
	if got := expandHomePath("/abs/path"); got != "/abs/path" {
		t.Fatalf("expandHomePath(/abs/path) = %q, want unchanged", got)
	}
	if got := expandHomePath("rel~path"); got != "rel~path" {
		t.Fatalf("expandHomePath(rel~path) = %q, want unchanged", got)
	}
	if got := expandHomePath("prefix~/x"); got != "prefix~/x" {
		t.Fatalf("expandHomePath(prefix~/x) = %q, want unchanged", got)
	}
}

func TestResolveImageRequestPath(t *testing.T) {
	dir := t.TempDir()
	a := &App{cfg: &config.Config{DataDir: dir}}

	imagesDir := filepath.Join(dir, "images", "2026-11-10")
	if err := os.MkdirAll(imagesDir, 0755); err != nil {
		t.Fatalf("mkdir images: %v", err)
	}
	img := filepath.Join(imagesDir, "10-00-00.webp")
	if err := os.WriteFile(img, []byte("RIFFfake-webp-data"), 0644); err != nil {
		t.Fatalf("write image: %v", err)
	}

	got, err := a.resolveImageRequestPath(img)
	if err != nil {
		t.Fatalf("resolveImageRequestPath(valid) error = %v", err)
	}
	if got != filepath.Clean(img) {
		t.Fatalf("resolveImageRequestPath(valid) = %q, want %q", got, filepath.Clean(img))
	}

	// Tilde-prefixed legacy DB rows (config.yaml.example documents
	// `data_dir: ~/...`) must resolve through the user home and stay servable.
	home, err := os.UserHomeDir()
	if err == nil && strings.HasPrefix(dir, home+string(os.PathSeparator)) {
		rel, err := filepath.Rel(home, img)
		if err != nil {
			t.Fatalf("rel to home: %v", err)
		}
		got, err := a.resolveImageRequestPath("~/" + rel)
		if err != nil {
			t.Fatalf("resolveImageRequestPath(tilde row) error = %v", err)
		}
		if got != filepath.Clean(img) {
			t.Fatalf("resolveImageRequestPath(tilde row) = %q, want %q", got, filepath.Clean(img))
		}
	}

	rejected := []string{
		"",
		"   ",
		"images/2026-11-10/10-00-00.webp",        // relative
		"../../etc/passwd",                       // relative traversal
		filepath.Join(dir, "..", "outside.webp"), // traversal via parent
		"/etc/passwd",                            // absolute outside data dir
		filepath.Join(dir, "images"),             // directory
	}
	for _, p := range rejected {
		if _, err := a.resolveImageRequestPath(p); err == nil {
			t.Fatalf("resolveImageRequestPath(%q) succeeded, want error", p)
		}
	}

	// Symlinks must not be followed out of the data directory.
	link := filepath.Join(imagesDir, "link.webp")
	if err := os.Symlink("/etc/passwd", link); err == nil {
		if _, err := a.resolveImageRequestPath(link); err == nil {
			t.Fatal("resolveImageRequestPath(symlink) succeeded, want error")
		}
	}

	// Oversized files are refused before being read into memory.
	huge := filepath.Join(imagesDir, "huge.webp")
	f, err := os.Create(huge)
	if err != nil {
		t.Fatalf("create huge: %v", err)
	}
	if err := f.Truncate(maxImageReadBytes + 1); err != nil {
		t.Fatalf("truncate huge: %v", err)
	}
	_ = f.Close()
	if _, err := a.resolveImageRequestPath(huge); err == nil {
		t.Fatal("resolveImageRequestPath(huge) succeeded, want error")
	}

	// Nil config is a hard error, not a free read.
	bare := &App{}
	if _, err := bare.resolveImageRequestPath(img); err == nil {
		t.Fatal("resolveImageRequestPath with nil config succeeded, want error")
	}
}

func TestGetImageBase64(t *testing.T) {
	dir := t.TempDir()
	a := &App{cfg: &config.Config{DataDir: dir}}

	pngPath := filepath.Join(dir, "images", "shot.png")
	if err := os.MkdirAll(filepath.Dir(pngPath), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	pngBytes := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 13, 'I', 'H', 'D', 'R'}
	if err := os.WriteFile(pngPath, pngBytes, 0644); err != nil {
		t.Fatalf("write png: %v", err)
	}

	got, err := a.GetImageBase64(pngPath)
	if err != nil {
		t.Fatalf("GetImageBase64(valid) error = %v", err)
	}
	if !strings.HasPrefix(got, "data:image/png;base64,") {
		t.Fatalf("GetImageBase64(valid) mime prefix wrong: %q", got[:30])
	}

	// WebP captures (the standard capture format) must advertise image/webp.
	webpPath := filepath.Join(dir, "images", "shot.webp")
	if err := os.WriteFile(webpPath, []byte("RIFF0000WEBPVP8 "), 0644); err != nil {
		t.Fatalf("write webp: %v", err)
	}
	got, err = a.GetImageBase64(webpPath)
	if err != nil {
		t.Fatalf("GetImageBase64(webp) error = %v", err)
	}
	if !strings.HasPrefix(got, "data:image/webp;base64,") {
		t.Fatalf("GetImageBase64(webp) mime prefix wrong: %q", got[:30])
	}

	if _, err := a.GetImageBase64("/etc/passwd"); err == nil {
		t.Fatal("GetImageBase64(outside data dir) succeeded, want error")
	}
}

func TestImageMimeForUnknownExtensionSniffsContent(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "capture.bin")
	if err := os.WriteFile(p, []byte("RIFF\x24\x00\x00\x00WEBPVP8 "), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := imageMimeFor(p); got != "image/webp" {
		t.Fatalf("imageMimeFor(webp content) = %q, want image/webp", got)
	}
	// Unknown extension AND missing file: no content to sniff.
	if got := imageMimeFor(filepath.Join(dir, "missing.unknown")); got != "application/octet-stream" {
		t.Fatalf("imageMimeFor(missing) = %q, want application/octet-stream", got)
	}
}

func TestAppVersion(t *testing.T) {
	if got := appVersion(); got == "" {
		t.Fatal("appVersion() is empty")
	}

	previous := version
	defer func() { version = previous }()

	version = "9.9.9"
	got := appVersion()
	if !strings.HasPrefix(got, "9.9.9") {
		t.Fatalf("appVersion() = %q, want prefix 9.9.9 (ldflags override)", got)
	}
	if strings.Contains(got, "dev") {
		t.Fatalf("appVersion() = %q, ldflags override must win over fallback", got)
	}
}
