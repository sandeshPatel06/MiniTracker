package main

import (
	"embed"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
)

//go:embed all:frontend/dist
var assets embed.FS

// version is the release version reported by the app (Dev panel / diagnostics).
// Release builds override it at link time:
//
//	wails build -ldflags "-s -w -X main.version=2.1.0"
//
// Unset ("dev") builds fall back to VCS revision info embedded by the toolchain.
var version = "dev"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--background" {
		runBackgroundApp()
		return
	}

	app := NewApp()

	err := wails.Run(&options.App{
		Title:            "get-Hike",
		Width:            1200,
		Height:           800,
		MinWidth:         900,
		MinHeight:        600,
		BackgroundColour: &options.RGBA{R: 10, G: 11, B: 18, A: 1},
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
		Bind: []interface{}{
			app,
		},
		Linux: &linux.Options{
			WindowIsTranslucent: false,
			WebviewGpuPolicy:    linux.WebviewGpuPolicyAlways,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
