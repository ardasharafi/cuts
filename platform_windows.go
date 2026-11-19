//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// browserCandidates lists the installed browsers that can show the app window and print
// PDFs: Edge first (it comes with Windows), then Chrome, then Brave.
func browserCandidates() []string {
	roots := []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("ProgramW6432"), os.Getenv("LocalAppData")}
	apps := []string{
		`Microsoft\Edge\Application\msedge.exe`,
		`Google\Chrome\Application\chrome.exe`,
		`BraveSoftware\Brave-Browser\Application\brave.exe`,
	}
	var out []string
	seen := map[string]bool{}
	for _, app := range apps {
		for _, root := range roots {
			if root == "" {
				continue
			}
			candidate := filepath.Join(root, app)
			key := strings.ToLower(candidate)
			if seen[key] || !exists(candidate) {
				continue
			}
			seen[key] = true
			out = append(out, candidate)
		}
	}
	return out
}

func extraBrowserArgs() []string { return nil }

// documentsDir finds the Documents folder, also when OneDrive has taken it over.
func documentsDir() string {
	home, _ := os.UserHomeDir()
	var candidates []string
	if home != "" {
		candidates = append(candidates, filepath.Join(home, "Documents"))
	}
	for _, name := range []string{"OneDrive", "OneDriveConsumer", "OneDriveCommercial"} {
		if root := os.Getenv(name); root != "" {
			candidates = append(candidates, filepath.Join(root, "Documents"))
		}
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			return c
		}
	}
	if home != "" {
		return home
	}
	return "."
}

// openPath opens a file, a folder or a web address with whatever Windows uses for it.
func openPath(target string) error {
	return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", target).Start()
}

// revealPath opens the folder with the file selected.
func revealPath(target string) error {
	cmd := exec.Command("explorer.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe /select,"` + target + `"`}
	return cmd.Start()
}

// quiet keeps a helper process from flashing a console window.
func quiet(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

var user32 = syscall.NewLazyDLL("user32.dll")

func messageBox(message string, flags uintptr) {
	text, err1 := syscall.UTF16PtrFromString(message)
	title, err2 := syscall.UTF16PtrFromString(appName)
	if err1 != nil || err2 != nil {
		return
	}
	_, _, _ = user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), flags)
}

func fatalBox(message string) { messageBox(message, 0x10) } // with the error icon

func infoBox(message string) { messageBox(message, 0x40) } // with the information icon

// focusWindow brings the window with this exact title to the front. The app window's
// title is the page's title.
func focusWindow(title string) bool {
	name, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return false
	}
	window, _, _ := user32.NewProc("FindWindowW").Call(0, uintptr(unsafe.Pointer(name)))
	if window == 0 {
		return false
	}
	if minimized, _, _ := user32.NewProc("IsIconic").Call(window); minimized != 0 {
		_, _, _ = user32.NewProc("ShowWindow").Call(window, 9) // restore
	}
	done, _, _ := user32.NewProc("SetForegroundWindow").Call(window)
	return done != 0
}
