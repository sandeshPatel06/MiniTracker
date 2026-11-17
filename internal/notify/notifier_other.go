//go:build !linux

package notify

import (
	"log"
)

type OtherNotifier struct{}

func NewNotifier() (PlatformNotifier, error) {
	return &OtherNotifier{}, nil
}

func (o *OtherNotifier) Send(n Notification) error {
	log.Printf("[notify] %s: %s", n.Title, n.Body)
	return nil
}

func (o *OtherNotifier) Close() error {
	return nil
}
