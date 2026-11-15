//go:build !linux

package tracker

import (
	"fmt"
	"image"
	"log"

	"github.com/kbinani/screenshot"
)

func captureDisplays() (image.Image, error) {
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
