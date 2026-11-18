//go:build !linux && !darwin && !windows

package main

import (
	"os"
	"syscall"
)

// detachSysProcAttr is a no-op on unsupported platforms.
func detachSysProcAttr() *syscall.SysProcAttr {
	return nil
}

func processAlive(pid int) bool {
	return false
}

func terminateProcess(pid int) error {
	return nil
}

func killProcess(pid int) error {
	return nil
}

func acquireProcessLock(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0644)
}

func releaseProcessLock(f *os.File) {
	if f != nil {
		_ = f.Close()
	}
}

func notifyExistingGUIInstance(pid int) {}

func registerSIGUSR2(ch chan os.Signal) {}

func killAllBackgroundDaemons() {}
