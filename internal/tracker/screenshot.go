package tracker

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/chai2010/webp"
	"github.com/reak/get-hike/internal/privacy"
	"golang.org/x/image/draw"
)

// ScreenshotResult holds the results of a screenshot capture.
type ScreenshotResult struct {
	FilePath   string `json:"file_path"`
	Base64Data string `json:"base64_data"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	SizeBytes  int    `json:"size_bytes"`
	IsBlurred  bool   `json:"is_blurred"`
	BlurReason string `json:"blur_reason"`
}

const (
	defaultMaxWidth    = 1920
	defaultMaxHeight   = 1080
	defaultWebpQuality = 80 // 80% produces crisp UI and code text with lightweight WebP payloads
)

// getMaxDimensions returns the maximum width and height for screenshots,
// reading SCREENSHOT_MAX_WIDTH and SCREENSHOT_MAX_HEIGHT environment variables
// if set, falling back to 1920x1080 Full HD.
func getMaxDimensions() (int, int) {
	maxW := defaultMaxWidth
	maxH := defaultMaxHeight

	if val := os.Getenv("SCREENSHOT_MAX_WIDTH"); val != "" {
		if parsed, err := strconv.Atoi(val); err == nil && parsed > 0 {
			maxW = parsed
		}
	}
	if val := os.Getenv("SCREENSHOT_MAX_HEIGHT"); val != "" {
		if parsed, err := strconv.Atoi(val); err == nil && parsed > 0 {
			maxH = parsed
		}
	}
	return maxW, maxH
}

// getWebpQuality returns the WebP quality setting clamped between 30 and 100,
// reading SCREENSHOT_QUALITY environment variable if set, falling back to 80.
func getWebpQuality() float32 {
	quality := defaultWebpQuality
	if val := os.Getenv("SCREENSHOT_QUALITY"); val != "" {
		if parsed, err := strconv.Atoi(val); err == nil {
			if parsed < 30 {
				parsed = 30
			} else if parsed > 100 {
				parsed = 100
			}
			quality = parsed
		}
	}
	return float32(quality)
}

// captureMu serializes concurrent CaptureScreenshot calls (scheduled tick,
// manual "collect now", daemon) so captures never overlap or interleave writes.
var (
	captureMu       sync.Mutex
	lastCaptureTime time.Time
	lastCaptureRes  *ScreenshotResult
)

// CaptureScreenshot takes a screenshot of all active displays, combines them into
// a single grid image, compresses it to WebP at high fidelity (Full HD 1080p, 80% quality), saves it
// to disk, and returns a base64 encoded copy for AI analysis.
func CaptureScreenshot(dataDir string) (*ScreenshotResult, error) {
	return CaptureScreenshotWithPrivacy(dataDir, nil, "", "")
}

// CaptureScreenshotWithPrivacy takes a screenshot and applies in-memory blurring/shielding
// before encoding or saving if sensitive content/windows are detected.
func CaptureScreenshotWithPrivacy(dataDir string, engine *privacy.Engine, appName, windowTitle string) (res *ScreenshotResult, retErr error) {
	captureMu.Lock()
	defer captureMu.Unlock()

	// Cross-process capture lock ensures only one worker captures screenshots across the entire system.
	lock, err := acquireCaptureLock(dataDir)
	if err != nil {
		log.Printf("[tracker] capture skipped: another worker is currently capturing")
		return lastCaptureRes, nil
	}
	defer releaseCaptureLock(lock)

	defer func() {
		if r := recover(); r != nil {
			res = nil
			retErr = fmt.Errorf("screenshot capture panic recovered: %v", r)
			log.Printf("[tracker] %v", retErr)
		}
	}()

	now := time.Now()
	if !lastCaptureTime.IsZero() && now.Sub(lastCaptureTime) < 2*time.Second && lastCaptureRes != nil {
		return lastCaptureRes, nil
	}

	// 1. Evaluate Privacy before touching disk
	var privEval privacy.EvaluationResult
	if engine != nil {
		privEval = engine.EvaluateWindow(appName, windowTitle)
		if privEval.IsSensitive && privEval.Action == privacy.ActionSkip {
			// Zero disk writes when action is skip_screenshot
			res = &ScreenshotResult{
				FilePath:   "",
				Base64Data: "",
				Width:      0,
				Height:     0,
				SizeBytes:  0,
				IsBlurred:  true,
				BlurReason: privEval.Reason,
			}
			lastCaptureTime = now
			lastCaptureRes = res
			return res, nil
		}
	}

	// Capture all displays combined without audio shutter sounds or flash
	combined, err := captureDisplays()
	if err != nil {
		return nil, err
	}

	// Resize maintaining aspect ratio within configured/environment bounds (default Full HD 1080p)
	maxW, maxH := getMaxDimensions()
	resized := resizeImage(combined, maxW, maxH)

	// Apply In-Memory Privacy Transformation (Blur or Shield) on the RAM buffer
	isBlurred := false
	blurReason := ""
	if privEval.IsSensitive {
		if rgba, ok := resized.(*image.RGBA); ok {
			engine.ProcessImage(rgba, privEval)
			isBlurred = true
			blurReason = privEval.Reason
		}
	}

	// Encode to WebP with sharp quality
	quality := getWebpQuality()
	var buf bytes.Buffer
	if err := webp.Encode(&buf, resized, &webp.Options{Quality: quality}); err != nil {
		return nil, fmt.Errorf("encode webp: %w", err)
	}

	webpData := buf.Bytes()

	dateDir := filepath.Join(dataDir, "images", now.Format("2006-01-02"))
	if err := os.MkdirAll(dateDir, 0755); err != nil {
		return nil, fmt.Errorf("create image dir: %w", err)
	}
	filePath, err := reserveScreenshotPath(dateDir, now)
	if err != nil {
		return nil, fmt.Errorf("reserve screenshot file: %w", err)
	}

	if err := os.WriteFile(filePath, webpData, 0644); err != nil {
		_ = os.Remove(filePath)
		return nil, fmt.Errorf("write screenshot: %w", err)
	}

	b := resized.Bounds()
	res = &ScreenshotResult{
		FilePath:   filePath,
		Base64Data: base64.StdEncoding.EncodeToString(webpData),
		Width:      b.Dx(),
		Height:     b.Dy(),
		SizeBytes:  len(webpData),
		IsBlurred:  isBlurred,
		BlurReason: blurReason,
	}
	lastCaptureTime = time.Now()
	lastCaptureRes = res
	return res, nil
}

// reserveScreenshotPath atomically claims an unused .webp path under dateDir
// for the given timestamp (HH-MM-SS.mmm.webp, with a -N suffix on collision).
// The claim is an O_CREATE|O_EXCL create, so two processes RACING on the same
// timestamp can never both win: the kernel rejects the second create exactly
// once, and the caller falls through to the next suffix. This replaces the
// old inspect-then-create flow, which raced across processes (daemon + GUI
// both saw "not exists" and overwrote each other's captures) and could loop
// forever on persistent Stat errors.
func reserveScreenshotPath(dateDir string, now time.Time) (string, error) {
	base := now.Format("15-04-05.000")
	for i := 0; ; i++ {
		name := base + ".webp"
		if i > 0 {
			name = fmt.Sprintf("%s-%d.webp", base, i)
		}
		filePath := filepath.Join(dateDir, name)
		f, err := os.OpenFile(filePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		switch {
		case err == nil:
			return filePath, f.Close()
		case os.IsExist(err):
			continue // suffix race lost — try the next one
		default:
			return "", err // permission/broken-path: fail fast, never spin
		}
	}
}

// stitchDisplayImages combines multiple display images into a single grid image.
func stitchDisplayImages(imgs []image.Image) image.Image {
	if len(imgs) == 1 {
		return imgs[0]
	}

	cols := 2
	if len(imgs) < 2 {
		cols = len(imgs)
	}
	rows := (len(imgs) + cols - 1) / cols

	// Find max cell width and height among displays
	cellW := 0
	cellH := 0
	for _, img := range imgs {
		b := img.Bounds()
		if b.Dx() > cellW {
			cellW = b.Dx()
		}
		if b.Dy() > cellH {
			cellH = b.Dy()
		}
	}

	totalW := cellW * cols
	totalH := cellH * rows

	dst := image.NewRGBA(image.Rect(0, 0, totalW, totalH))

	for idx, img := range imgs {
		r := idx / cols
		c := idx % cols
		xOffset := c * cellW
		yOffset := r * cellH

		targetRect := image.Rect(xOffset, yOffset, xOffset+cellW, yOffset+cellH)
		// BiLinear is 3-4x faster than CatmullRom with no perceptible quality difference
		// for AI-vision analysis at these resolutions.
		draw.BiLinear.Scale(dst, targetRect, img, img.Bounds(), draw.Over, nil)
	}

	return dst
}

// resizeImage resizes the image to fit within maxW×maxH, preserving aspect ratio.
// Uses draw.CatmullRom bicubic filtering to preserve crisp text and sharp UI fonts.
func resizeImage(src image.Image, maxW, maxH int) image.Image {
	srcBounds := src.Bounds()
	srcW := srcBounds.Dx()
	srcH := srcBounds.Dy()

	if srcW <= maxW && srcH <= maxH {
		return src
	}

	// Calculate scale factor to fit within bounds
	scaleW := float64(maxW) / float64(srcW)
	scaleH := float64(maxH) / float64(srcH)
	scale := scaleW
	if scaleH < scale {
		scale = scaleH
	}

	newW := int(float64(srcW) * scale)
	newH := int(float64(srcH) * scale)
	// Extreme aspect ratios can round a dimension to 0, which would produce a
	// zero-size WebP. Never allocate below 1px.
	if newW < 1 {
		newW = 1
	}
	if newH < 1 {
		newH = 1
	}

	dst := image.NewRGBA(image.Rect(0, 0, newW, newH))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, srcBounds, draw.Over, nil)
	return dst
}
