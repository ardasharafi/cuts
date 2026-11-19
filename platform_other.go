//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// Cuts ships for Windows. This file lets the same program run on the build machine,
// where the automated tests drive it.

func browserCandidates() []string {
	var out []string
	if b := os.Getenv("CUTS_BROWSER"); b != "" {
		out = append(out, b)
	}
	for _, name := range []string{"microsoft-edge", "google-chrome", "chromium", "chromium-browser"} {
		if p, err := exec.LookPath(name); err == nil {
			out = append(out, p)
		}
	}
	return out
}

func extraBrowserArgs() []string {
	if os.Geteuid() == 0 {
		return []string{"--no-sandbox"}
	}
	return nil
}

func documentsDir() string {
	home, _ := os.UserHomeDir()
	docs := filepath.Join(home, "Documents")
	if info, err := os.Stat(docs); err == nil && info.IsDir() {
		return docs
	}
	return home
}

func openPath(target string) error {
	opener := "xdg-open"
	if runtime.GOOS == "darwin" {
		opener = "open"
	}
	return exec.Command(opener, target).Start()
}

func revealPath(target string) error { return openPath(filepath.Dir(target)) }

func quiet(cmd *exec.Cmd) {}

func fatalBox(message string) { fmt.Fprintln(os.Stderr, message) }

func infoBox(message string) { fmt.Fprintln(os.Stderr, message) }

func focusWindow(title string) bool { return true }
