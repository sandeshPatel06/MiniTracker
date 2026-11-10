package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/reak/get-hike/internal/config"
)

// runBackgroundApp runs the headless tracking daemon. It reuses App.startup /
// App.shutdown / App.collect unchanged so behavior matches the GUI app.
func runBackgroundApp() {
	cfg, err := config.Load()
	if err == nil && cfg != nil {
		if guiAppRunning(cfg.DataDir) {
			log.Printf("[bg] desktop app is running — refusing to start a second capture loop (pidfile %s)", guiPidPath(cfg.DataDir))
			return
		}
		pid := readPIDFile(pidPath(cfg.DataDir))
		if pid > 0 && pid != os.Getpid() && processAlive(pid) && processMatchesDaemon(pid) {
			log.Printf("[bg] another background tracker is already running (pid %d) — exiting", pid)
			return
		}
	}

	app := NewApp()
	app.headless = true
	app.startup(context.Background())

	if app.cfg != nil {
		if err := writePIDFile(pidPath(app.cfg.DataDir), os.Getpid()); err != nil {
			log.Printf("[bg] write pidfile error: %v", err)
		}
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	sig := <-sigCh
	log.Printf("[bg] received signal %v — shutting down", sig)

	app.shutdown(context.Background())

	if app.cfg != nil {
		_ = os.Remove(pidPath(app.cfg.DataDir))
	}
}

// pidPath returns the pidfile location for a data directory.
func pidPath(dataDir string) string {
	return filepath.Join(dataDir, "tracker.pid")
}

// guiPidPath returns the pidfile marking a live GUI capture owner for a data
// directory. The GUI writes it at startup and releases it at shutdown; the
// daemon checks it so exactly one capture loop (GUI or daemon) ever runs.
func guiPidPath(dataDir string) string {
	return filepath.Join(dataDir, "gui.pid")
}

// guiAppRunning reports whether a live GUI capture owner is registered for
// dataDir. The pid is only trusted when the process is this same binary, so a
// recycled pid from a stale pidfile is never mistaken for a running app.
func guiAppRunning(dataDir string) bool {
	pid := readPIDFile(guiPidPath(dataDir))
	return pid > 0 && pid != os.Getpid() && processAlive(pid) && processMatchesBinary(pid)
}

// removePIDFileIfOwner removes path only when it still records pid, so a later
// instance's registration is never wiped by an exiting older one.
func removePIDFileIfOwner(path string, pid int) {
	if readPIDFile(path) == pid {
		_ = os.Remove(path)
	}
}

// processMatchesBinary verifies that pid runs this same binary: the
// /proc/<pid>/exe link where it names the binary (Linux), else the
// /proc/<pid>/cmdline basename — Android runs binaries through its dynamic
// linker so /proc/<pid>/exe names linker64 and cmdline must decide. Without
// /proc the pidfile is trusted as-is.
func processMatchesBinary(pid int) bool {
	if !procAvailable() {
		return true
	}
	self, err := os.Executable()
	if err != nil {
		return false
	}
	selfName := filepath.Base(self)

	if link, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid)); err == nil && filepath.Base(link) == selfName {
		return true
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return false
	}
	arg0 := strings.FieldsFunc(string(data), func(r rune) bool { return r == '\x00' })
	if len(arg0) == 0 {
		return false
	}
	return filepath.Base(arg0[0]) == selfName
}

// writePIDFile persists pid to path.
func writePIDFile(path string, pid int) error {
	return os.WriteFile(path, []byte(strconv.Itoa(pid)), 0644)
}

// readPIDFile reads a pid from path, returning 0 on any error.
func readPIDFile(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0
	}
	return pid
}

// procAvailable reports whether /proc pseudo-files can be inspected. Linux and
// Android both provide /proc/<pid>/{cmdline,exe}; other platforms rely on the
// pidfile being trusted as-is.
func procAvailable() bool {
	return runtime.GOOS == "linux" || runtime.GOOS == "android"
}

// processMatchesDaemon verifies on Linux that pid is indeed our --background daemon.
func processMatchesDaemon(pid int) bool {
	if !procAvailable() {
		return true
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return false
	}
	return strings.Contains(string(data), "--background")
}

// stopBackgroundDaemon terminates a running background tracker for dataDir, if any.
func stopBackgroundDaemon(dataDir string) {
	path := pidPath(dataDir)
	pid := readPIDFile(path)
	if pid <= 0 {
		_ = os.Remove(path)
		return
	}
	if !processAlive(pid) {
		_ = os.Remove(path)
		return
	}

	_ = terminateProcess(pid)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if processAlive(pid) {
		_ = killProcess(pid)
	}
	_ = os.Remove(path)
	log.Printf("[bg] stopped background tracker (pid %d)", pid)
}

// spawnBackgroundDaemon starts a detached copy of this binary in headless mode.
func spawnBackgroundDaemon(dataDir string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}

	cmd := exec.Command(exe, "--background")
	cmd.SysProcAttr = detachSysProcAttr()
	cmd.Env = os.Environ()

	if err := cmd.Start(); err != nil {
		return err
	}

	if err := writePIDFile(pidPath(dataDir), cmd.Process.Pid); err != nil {
		log.Printf("[bg] write pidfile error: %v", err)
	}
	return cmd.Process.Release()
}
