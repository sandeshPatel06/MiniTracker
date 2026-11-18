//go:build linux || darwin

package main

import (
	"log"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"
	"time"
)

// detachSysProcAttr detaches the child into its own session.
func detachSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}

func terminateProcess(pid int) error {
	return syscall.Kill(pid, syscall.SIGTERM)
}

func killProcess(pid int) error {
	return syscall.Kill(pid, syscall.SIGKILL)
}

// acquireProcessLock acquires an exclusive, non-blocking file lock on path.
// If another process holds the lock, it immediately returns an error.
func acquireProcessLock(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

// releaseProcessLock unlocks and closes the file lock.
func releaseProcessLock(f *os.File) {
	if f == nil {
		return
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	_ = f.Close()
}

// notifyExistingGUIInstance sends SIGUSR2 to the existing GUI process to restore its window.
func notifyExistingGUIInstance(pid int) {
	if pid > 0 && processAlive(pid) {
		_ = syscall.Kill(pid, syscall.SIGUSR2)
	}
}

// registerSIGUSR2 registers ch to receive SIGUSR2 signals.
func registerSIGUSR2(ch chan os.Signal) {
	signal.Notify(ch, syscall.SIGUSR2)
}

// killAllBackgroundDaemons finds and terminates any get-hike background workers.
func killAllBackgroundDaemons() {
	if runtime.GOOS != "linux" {
		return
	}
	self := os.Getpid()
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	var killedPids []int
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 || pid == self {
			continue
		}
		if processMatchesBinary(pid) && processMatchesDaemon(pid) {
			log.Printf("[bg] terminating duplicate background worker (pid %d)", pid)
			_ = terminateProcess(pid)
			killedPids = append(killedPids, pid)
		}
	}
	if len(killedPids) == 0 {
		return
	}
	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) {
		allDone := true
		for _, pid := range killedPids {
			if processAlive(pid) {
				allDone = false
				break
			}
		}
		if allDone {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	for _, pid := range killedPids {
		if processAlive(pid) {
			_ = killProcess(pid)
		}
	}
}
