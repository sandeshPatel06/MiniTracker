package main

import (
	"embed"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"

	"github.com/reak/get-hike/internal/config"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

// version is the release version reported by the app (Dev panel / diagnostics).
// Release builds override it at link time:
//
//	wails build -ldflags "-s -w -X main.version=2.1.0"
//
// Unset ("dev") builds fall back to VCS revision info embedded by the toolchain.
var version = "2.1.0"

func main() {
	cfg, err := config.Load()
	if err == nil && cfg != nil {
		cfg.DataDir = expandHomePath(filepath.Clean(cfg.DataDir))
	} else {
		home, _ := os.UserHomeDir()
		cfg = &config.Config{DataDir: filepath.Join(home, ".local", "share", "get-hike")}
	}
	_ = os.MkdirAll(cfg.DataDir, 0755)

	if len(os.Args) > 1 && os.Args[1] == "--background" {
		runBackgroundApp(cfg)
		return
	}

	// Kernel-level exclusive flock: guarantees strictly ONE desktop GUI instance runs.
	// If another instance is running, notify it to restore its window and exit immediately.
	lock, err := acquireProcessLock(filepath.Join(cfg.DataDir, "gui.lock"))
	if err != nil {
		existingPid := readPIDFile(guiPidPath(cfg.DataDir))
		log.Printf("[app] another desktop app instance is already running (pid %d) — focusing existing window and exiting", existingPid)
		notifyExistingGUIInstance(existingPid)
		os.Exit(0)
	}
	defer releaseProcessLock(lock)

	// Persist GUI PID file so background daemons / checkers know a GUI is open
	_ = writePIDFile(guiPidPath(cfg.DataDir), os.Getpid())
	defer removePIDFileIfOwner(guiPidPath(cfg.DataDir), os.Getpid())

	app := NewApp()
	app.cfg = cfg

	if err := runGUI(app); err != nil {
		println("Error:", err.Error())
		os.Exit(1)
	}
}

// runGUI starts the desktop window. On Linux a failed GTK initialisation
// panics inside Wails (gtk_init_check), typically because the process has no
// graphical session or is missing GTK3/WebKitGTK system libraries. Recover
// that panic and exit with clear guidance instead of a stack trace.
func runGUI(app *App) (err error) {
	if runtime.GOOS == "linux" && !hasGraphicalSession() {
		return fmt.Errorf("no graphical session detected (DISPLAY/WAYLAND_DISPLAY are empty).\n" +
			"  • Desktop use: launch get-Hike from your desktop environment.\n" +
			"  • SSH/headless: run the server binary instead (get-hike-server),\n" +
			"    or the capture-only daemon: ./get-hike --background")
	}

	defer func() {
		if r := recover(); r != nil {
			if fmt.Sprint(r) == "failed to init GTK" {
				err = fmt.Errorf("GTK could not start the desktop window.\n" +
					"  • Install the required system libraries (Debian/Ubuntu):\n" +
					"      sudo apt install libgtk-3-0 libwebkit2gtk-4.0-37\n" +
					"    (Fedora: gtk3 webkit2gtk-4.0 · Arch: gtk3 webkit2gtk)\n" +
					"  • Or run inside a graphical session — SSH/headless setups\n" +
					"    should use the get-hike-server binary instead")
				return
			}
			panic(r)
		}
	}()

	return wails.Run(&options.App{
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
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "get-hike-tracker-app-single-instance-lock",
			OnSecondInstanceLaunch: func(secondInstanceData options.SecondInstanceData) {
				if app.ctx != nil {
					wailsruntime.WindowShow(app.ctx)
					wailsruntime.WindowUnminimise(app.ctx)
				}
			},
		},
		Linux: &linux.Options{
			WindowIsTranslucent: false,
			WebviewGpuPolicy:    linux.WebviewGpuPolicyAlways,
		},
	})
}

// hasGraphicalSession reports whether the process can reach an X11 or Wayland
// display, which Wails' GTK backend requires on Linux.
func hasGraphicalSession() bool {
	return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""
}
