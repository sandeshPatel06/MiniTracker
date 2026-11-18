//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"image"
	_ "image/png"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"
	"github.com/godbus/dbus/v5/prop"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/image/draw"
)

// TrayManager manages the system tray icon and menu via D-Bus StatusNotifierItem and DBusMenu.
// This is pure Go, zero CGO, and natively integrated with GNOME (AppIndicator), KDE Plasma, XFCE, etc.
type TrayManager struct {
	app      *App
	conn     *dbus.Conn
	mu       sync.Mutex
	running  bool
	stopCh   chan struct{}
	revision uint32

	cachedStatsAt   time.Time
	cachedProdMin   int
	cachedTotalMin  int
	cachedCategory  string
}

type statusNotifierItemServer struct {
	manager *TrayManager
}

func (s *statusNotifierItemServer) Activate(x, y int32) *dbus.Error {
	s.manager.OpenGUI()
	return nil
}

func (s *statusNotifierItemServer) ContextMenu(x, y int32) *dbus.Error {
	// StatusNotifierWatcher delegates context menu opening to DBusMenu (/MenuBar)
	return nil
}

func (s *statusNotifierItemServer) SecondaryActivate(x, y int32) *dbus.Error {
	s.manager.ToggleTracking()
	return nil
}

func (s *statusNotifierItemServer) Scroll(delta int32, orientation string) *dbus.Error {
	return nil
}

// DBusMenu implementation for context menu on right click / indicator tap
type dbusMenuServer struct {
	manager *TrayManager
}

type menuItemLayout struct {
	Id       int32
	Props    map[string]dbus.Variant
	Children []interface{}
}

func (m *dbusMenuServer) AboutToShow(id int32) (bool, *dbus.Error) {
	// Returning true tells the shell the menu items were refreshed
	return true, nil
}

func (m *dbusMenuServer) Event(id int32, eventId string, data dbus.Variant, timestamp uint32) *dbus.Error {
	if eventId != "clicked" {
		return nil
	}

	switch id {
	case 1:
		// Status click -> Open GUI
		m.manager.OpenGUI()
	case 2:
		// Start / Pause Tracking
		m.manager.ToggleTracking()
	case 3:
		// Open Dashboard Window
		m.manager.OpenGUI()
	case 4:
		// Trigger Sync
		m.manager.TriggerSync()
	case 5:
		// Open Screenshots Folder
		m.manager.OpenScreenshotsFolder()
	case 6:
		// Open Web Dashboard in Browser
		m.manager.OpenWebDashboard()
	case 7:
		// Quit Application
		m.manager.QuitApp()
	}
	return nil
}

func (m *dbusMenuServer) GetGroupProperties(ids []int32, propertyNames []string) ([]struct {
	Id    int32
	Props map[string]dbus.Variant
}, *dbus.Error) {
	return nil, nil
}

func (m *dbusMenuServer) GetLayout(parentId int32, recursionDepth int32, propertyNames []string) (uint32, menuItemLayout, *dbus.Error) {
	tm := m.manager
	active := false
	var elapsed int64
	var productiveMin int = 0
	var totalMin int = 0
	var topCategory string = ""

	if tm.app != nil {
		status := tm.app.GetTrackingStatus()
		if act, ok := status["active"].(bool); ok {
			active = act
		}
		if el, ok := status["elapsed_seconds"].(int64); ok {
			elapsed = el
		} else if elFloat, ok := status["elapsed_seconds"].(float64); ok {
			elapsed = int64(elFloat)
		}

		// Quick stats for today (cached for 15s to avoid disk I/O on 1s ticker)
		tm.mu.Lock()
		if time.Since(tm.cachedStatsAt) < 15*time.Second {
			productiveMin = tm.cachedProdMin
			totalMin = tm.cachedTotalMin
			topCategory = tm.cachedCategory
			tm.mu.Unlock()
		} else {
			tm.mu.Unlock()
			if stats, err := tm.app.GetStats(time.Now().Format("2006-01-02")); err == nil && stats != nil {
				productiveMin = stats.ProductiveMin
				totalMin = stats.TotalMinutes
				topCategory = stats.TopCategory

				tm.mu.Lock()
				tm.cachedStatsAt = time.Now()
				tm.cachedProdMin = productiveMin
				tm.cachedTotalMin = totalMin
				tm.cachedCategory = topCategory
				tm.mu.Unlock()
			}
		}
	}

	h := elapsed / 3600
	min := (elapsed % 3600) / 60
	sec := elapsed % 60
	timeStr := fmt.Sprintf("%02d:%02d:%02d", h, min, sec)

	statusLabel := fmt.Sprintf("⏸ Paused — Today: %s", timeStr)
	toggleLabel := "▶ Resume Tracking"
	if active {
		statusLabel = fmt.Sprintf("● Tracking Active — %s", timeStr)
		toggleLabel = "⏸ Pause Tracking"
	}

	trackedMin := int(elapsed / 60)
	prodMin := 0
	prodPercent := 0
	if totalMin > 0 {
		percentRatio := float64(productiveMin) / float64(totalMin)
		if percentRatio > 1.0 {
			percentRatio = 1.0
		}
		prodPercent = int(percentRatio * 100)
		prodMin = int(float64(trackedMin) * percentRatio)
	}

	scoreLabel := "⚡ Productivity: 0% · 0m focus"
	if prodPercent > 0 || prodMin > 0 {
		if topCategory != "" {
			scoreLabel = fmt.Sprintf("⚡ Productivity: %d%% (%dm) · %s", prodPercent, prodMin, topCategory)
		} else {
			scoreLabel = fmt.Sprintf("⚡ Productivity: %d%% (%dm)", prodPercent, prodMin)
		}
	} else if topCategory != "" {
		scoreLabel = fmt.Sprintf("⚡ Productivity: 0%% · %s", topCategory)
	}

	tm.mu.Lock()
	tm.revision++
	rev := tm.revision
	tm.mu.Unlock()

	layout := menuItemLayout{
		Id: 0,
		Props: map[string]dbus.Variant{
			"children-display": dbus.MakeVariant("submenu"),
		},
		Children: []interface{}{
			menuItemLayout{
				Id: 1,
				Props: map[string]dbus.Variant{
					"label": dbus.MakeVariant(statusLabel),
				},
				Children: []interface{}{},
			},
			menuItemLayout{
				Id: 101,
				Props: map[string]dbus.Variant{
					"label":   dbus.MakeVariant(scoreLabel),
					"enabled": dbus.MakeVariant(false),
				},
				Children: []interface{}{},
			},
			menuItemLayout{
				Id: 10,
				Props: map[string]dbus.Variant{
					"type": dbus.MakeVariant("separator"),
				},
				Children: []interface{}{},
			},
			menuItemLayout{
				Id: 2,
				Props: map[string]dbus.Variant{
					"label": dbus.MakeVariant(toggleLabel),
				},
				Children: []interface{}{},
			},
			menuItemLayout{
				Id: 3,
				Props: map[string]dbus.Variant{
					"label": dbus.MakeVariant("🖥  Open get-Hike Window"),
				},
				Children: []interface{}{},
			},
			menuItemLayout{
				Id: 12,
				Props: map[string]dbus.Variant{
					"type": dbus.MakeVariant("separator"),
				},
				Children: []interface{}{},
			},
			menuItemLayout{
				Id: 7,
				Props: map[string]dbus.Variant{
					"label": dbus.MakeVariant("✕  Quit get-Hike"),
				},
				Children: []interface{}{},
			},
		},
	}

	return rev, layout, nil
}

type trayPixmap struct {
	Width  int32
	Height int32
	Data   []byte
}

func newTrayManager(app *App) *TrayManager {
	return &TrayManager{
		app:    app,
		stopCh: make(chan struct{}),
	}
}

func (tm *TrayManager) OpenGUI() {
	if tm.app != nil && !tm.app.headless && tm.app.ctx != nil {
		wailsruntime.WindowShow(tm.app.ctx)
		wailsruntime.WindowUnminimise(tm.app.ctx)
		return
	}

	// In headless background mode, clicking tray launches the desktop UI
	exe := "/home/reak/.local/bin/get-hike"
	if _, err := os.Stat(exe); err != nil {
		exe, _ = os.Executable()
	}

	cmd := exec.Command(exe)
	cmd.Env = os.Environ()
	// Ensure display environment is passed through
	if os.Getenv("DISPLAY") == "" {
		cmd.Env = append(cmd.Env, "DISPLAY=:0")
	}
	_ = cmd.Start()
	if cmd.Process != nil {
		_ = cmd.Process.Release()
	}
}

func (tm *TrayManager) ToggleTracking() {
	if tm.app != nil {
		_, _ = tm.app.ToggleTracking()
		tm.NotifyMenuUpdate()
	}
}

func (tm *TrayManager) TriggerSync() {
	if tm.app != nil {
		go func() {
			_, _ = tm.app.TriggerSyncNow()
		}()
	}
}

func (tm *TrayManager) OpenScreenshotsFolder() {
	home, _ := os.UserHomeDir()
	todayDir := filepath.Join(home, ".local/share/get-hike/images", time.Now().Format("2006-01-02"))
	if _, err := os.Stat(todayDir); err != nil {
		todayDir = filepath.Join(home, ".local/share/get-hike/images")
	}
	_ = exec.Command("xdg-open", todayDir).Start()
}

func (tm *TrayManager) OpenWebDashboard() {
	url := "http://localhost:3000"
	if tm.app != nil && tm.app.cfg != nil && tm.app.cfg.BackendEndpoint != "" {
		url = tm.app.cfg.BackendEndpoint
	}
	_ = exec.Command("xdg-open", url).Start()
}

func (tm *TrayManager) QuitApp() {
	if tm.app != nil {
		if !tm.app.headless && tm.app.ctx != nil {
			wailsruntime.Quit(tm.app.ctx)
			return
		}
		tm.app.shutdown(context.Background())
	}
	os.Exit(0)
}

func (tm *TrayManager) NotifyMenuUpdate() {
	tm.mu.Lock()
	conn := tm.conn
	rev := tm.revision + 1
	tm.revision = rev
	tm.mu.Unlock()

	if conn != nil {
		_ = conn.Emit("/MenuBar", "com.canonical.dbusmenu.LayoutUpdated", rev, int32(0))
	}
}

// Start registers the tray icon with org.kde.StatusNotifierWatcher on the user's session bus.
func (tm *TrayManager) Start() {
	if !hasGraphicalSession() {
		return
	}

	go func() {
		time.Sleep(300 * time.Millisecond)

		conn, err := dbus.ConnectSessionBus()
		if err != nil {
			log.Printf("[tray] dbus session connect error: %v", err)
			return
		}

		tm.mu.Lock()
		tm.conn = conn
		tm.running = true
		tm.mu.Unlock()

		busName := fmt.Sprintf("org.kde.StatusNotifierItem-%d-1", os.Getpid())
		reply, err := conn.RequestName(busName, dbus.NameFlagDoNotQueue)
		if err != nil || reply != dbus.RequestNameReplyPrimaryOwner {
			log.Printf("[tray] failed to request bus name %s: %v", busName, err)
			return
		}

		server := &statusNotifierItemServer{manager: tm}
		err = conn.Export(server, "/StatusNotifierItem", "org.kde.StatusNotifierItem")
		if err != nil {
			log.Printf("[tray] failed to export SNI object: %v", err)
			return
		}

		menuServer := &dbusMenuServer{manager: tm}
		err = conn.Export(menuServer, "/MenuBar", "com.canonical.dbusmenu")
		if err != nil {
			log.Printf("[tray] failed to export DBusMenu object: %v", err)
		}

		menuIntrospect := &introspect.Node{
			Name: "/MenuBar",
			Interfaces: []introspect.Interface{
				introspect.IntrospectData,
				{
					Name: "com.canonical.dbusmenu",
					Methods: []introspect.Method{
						{
							Name: "GetLayout",
							Args: []introspect.Arg{
								{Name: "parentId", Type: "i", Direction: "in"},
								{Name: "recursionDepth", Type: "i", Direction: "in"},
								{Name: "propertyNames", Type: "as", Direction: "in"},
								{Name: "revision", Type: "u", Direction: "out"},
								{Name: "layout", Type: "(ia{sv}av)", Direction: "out"},
							},
						},
						{
							Name: "GetGroupProperties",
							Args: []introspect.Arg{
								{Name: "ids", Type: "ai", Direction: "in"},
								{Name: "propertyNames", Type: "as", Direction: "in"},
								{Name: "properties", Type: "a(ia{sv})", Direction: "out"},
							},
						},
						{
							Name: "AboutToShow",
							Args: []introspect.Arg{
								{Name: "id", Type: "i", Direction: "in"},
								{Name: "needUpdate", Type: "b", Direction: "out"},
							},
						},
						{
							Name: "Event",
							Args: []introspect.Arg{
								{Name: "id", Type: "i", Direction: "in"},
								{Name: "eventId", Type: "s", Direction: "in"},
								{Name: "data", Type: "v", Direction: "in"},
								{Name: "timestamp", Type: "u", Direction: "in"},
							},
						},
					},
					Signals: []introspect.Signal{
						{
							Name: "LayoutUpdated",
							Args: []introspect.Arg{
								{Name: "revision", Type: "u"},
								{Name: "parentId", Type: "i"},
							},
						},
					},
				},
			},
		}
		_ = conn.Export(introspect.NewIntrospectable(menuIntrospect), "/MenuBar", "org.freedesktop.DBus.Introspectable")

		home, _ := os.UserHomeDir()
		iconPath := filepath.Join(home, ".local/share/icons/hicolor/512x512/apps/get-hike.png")
		if _, err := os.Stat(iconPath); err != nil {
			iconPath = filepath.Join(home, ".local/share/get-hike/app/get-hike.png")
		}

		pixmaps := loadTrayPixmaps(iconPath)

		propsSpec := map[string]map[string]*prop.Prop{
			"org.kde.StatusNotifierItem": {
				"Category": {
					Value:    "ApplicationStatus",
					Writable: false,
					Emit:     prop.EmitConst,
				},
				"Id": {
					Value:    "get-hike",
					Writable: false,
					Emit:     prop.EmitConst,
				},
				"Title": {
					Value:    "get-Hike Tracker",
					Writable: false,
					Emit:     prop.EmitTrue,
				},
				"Status": {
					Value:    "Active",
					Writable: false,
					Emit:     prop.EmitTrue,
				},
				"IconName": {
					Value:    "get-hike",
					Writable: false,
					Emit:     prop.EmitTrue,
				},
				"IconThemePath": {
					Value:    filepath.Join(home, ".local/share/icons/hicolor/512x512/apps"),
					Writable: false,
					Emit:     prop.EmitConst,
				},
				"ItemIsMenu": {
					Value:    true,
					Writable: false,
					Emit:     prop.EmitConst,
				},
				"Menu": {
					Value:    dbus.ObjectPath("/MenuBar"),
					Writable: false,
					Emit:     prop.EmitConst,
				},
			},
		}

		if len(pixmaps) > 0 {
			var pixmapData []struct {
				Width  int32
				Height int32
				Data   []byte
			}
			for _, p := range pixmaps {
				pixmapData = append(pixmapData, struct {
					Width  int32
					Height int32
					Data   []byte
				}{Width: p.Width, Height: p.Height, Data: p.Data})
			}
			propsSpec["org.kde.StatusNotifierItem"]["IconPixmap"] = &prop.Prop{
				Value:    pixmapData,
				Writable: false,
				Emit:     prop.EmitConst,
			}
		}

		_, err = prop.Export(conn, "/StatusNotifierItem", propsSpec)
		if err != nil {
			log.Printf("[tray] prop.Export error: %v", err)
			return
		}

		watcher := conn.Object("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher")
		call := watcher.Call("org.kde.StatusNotifierWatcher.RegisterStatusNotifierItem", 0, busName)
		if call.Err != nil {
			log.Printf("[tray] StatusNotifierWatcher registration note: %v", call.Err)
		} else {
			log.Printf("[tray] system tray with context menu registered (bus: %s)", busName)
		}

		// Keep ticker to refresh tray duration every 1 second in real-time
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-tm.stopCh:
				_ = conn.Close()
				return
			case <-ticker.C:
				tm.NotifyMenuUpdate()
			}
		}
	}()
}

// Stop unregisters and cleans up the tray connection.
func (tm *TrayManager) Stop() {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if tm.running {
		tm.running = false
		close(tm.stopCh)
	}
}

func loadTrayPixmaps(path string) []trayPixmap {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	src, _, err := image.Decode(f)
	if err != nil {
		return nil
	}

	// StatusNotifierItem renders best when provided multiple crisp sizes: 22x22, 24x24, 32x32, 48x48
	sizes := []int{22, 24, 32, 48}
	var res []trayPixmap

	for _, sz := range sizes {
		dst := image.NewRGBA(image.Rect(0, 0, sz, sz))
		draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Over, nil)

		buf := new(bytes.Buffer)
		for y := 0; y < sz; y++ {
			for x := 0; x < sz; x++ {
				c := dst.At(x, y)
				r, g, bl, a := c.RGBA()
				_ = binary.Write(buf, binary.BigEndian, uint8(a>>8))
				_ = binary.Write(buf, binary.BigEndian, uint8(r>>8))
				_ = binary.Write(buf, binary.BigEndian, uint8(g>>8))
				_ = binary.Write(buf, binary.BigEndian, uint8(bl>>8))
			}
		}
		res = append(res, trayPixmap{
			Width:  int32(sz),
			Height: int32(sz),
			Data:   buf.Bytes(),
		})
	}

	return res
}
