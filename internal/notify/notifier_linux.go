//go:build linux

package notify

import (
	"os/exec"
	"sync"

	"github.com/godbus/dbus/v5"
)

type LinuxNotifier struct {
	conn      *dbus.Conn
	mu        sync.Mutex
	callbacks map[uint32]func(string)
	stopCh    chan struct{}
}

func NewNotifier() (PlatformNotifier, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return &fallbackNotifier{}, nil
	}
	ln := &LinuxNotifier{
		conn:      conn,
		callbacks: make(map[uint32]func(string)),
		stopCh:    make(chan struct{}),
	}
	go ln.listenSignals()
	return ln, nil
}

func (l *LinuxNotifier) Send(n Notification) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	var actions []string
	for _, a := range n.Actions {
		actions = append(actions, a.Key, a.Label)
	}

	obj := l.conn.Object("org.freedesktop.Notifications", "/org/freedesktop/Notifications")
	call := obj.Call("org.freedesktop.Notifications.Notify", 0,
		"get-Hike",
		uint32(0),
		n.IconPath,
		n.Title,
		n.Body,
		actions,
		map[string]dbus.Variant{"urgency": dbus.MakeVariant(byte(1))},
		int32(n.Timeout),
	)
	if call.Err != nil {
		// Fallback to notify-send CLI
		return exec.Command("notify-send", "-a", "get-Hike", "-u", "normal", n.Title, n.Body).Start()
	}

	var id uint32
	if err := call.Store(&id); err == nil && n.OnAction != nil {
		l.callbacks[id] = n.OnAction
	}
	return nil
}

func (l *LinuxNotifier) Close() error {
	close(l.stopCh)
	if l.conn != nil {
		return l.conn.Close()
	}
	return nil
}

func (l *LinuxNotifier) listenSignals() {
	_ = l.conn.AddMatchSignal(
		dbus.WithMatchInterface("org.freedesktop.Notifications"),
		dbus.WithMatchMember("ActionInvoked"),
	)
	ch := make(chan *dbus.Signal, 10)
	l.conn.Signal(ch)

	for {
		select {
		case <-l.stopCh:
			return
		case sig := <-ch:
			if sig.Name == "org.freedesktop.Notifications.ActionInvoked" && len(sig.Body) >= 2 {
				id, okID := sig.Body[0].(uint32)
				action, okAct := sig.Body[1].(string)
				if okID && okAct {
					l.mu.Lock()
					cb, exists := l.callbacks[id]
					if exists {
						delete(l.callbacks, id)
					}
					l.mu.Unlock()
					if exists && cb != nil {
						cb(action)
					}
				}
			}
		}
	}
}

type fallbackNotifier struct{}

func (f *fallbackNotifier) Send(n Notification) error {
	return exec.Command("notify-send", "-a", "get-Hike", n.Title, n.Body).Start()
}

func (f *fallbackNotifier) Close() error {
	return nil
}
