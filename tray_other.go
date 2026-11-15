//go:build !linux

package main

type TrayManager struct{}

func newTrayManager(app *App) *TrayManager {
	return &TrayManager{}
}

func (tm *TrayManager) Start() {}
func (tm *TrayManager) Stop()  {}
