// Cuts for Windows: a small helper behind the app window.
//
// The app itself is the web page in docs/ (the same one the iPhone uses). This program
// serves it on 127.0.0.1, opens it in an app window of Edge or Chrome, keeps the locked
// ledger files in the user's profile, and prints statements to PDF with the same browser.
// It never talks to the internet: syncing with GitHub happens in the page.
package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	appName       = "Cuts"
	appVersion    = "1.0.0"
	preferredPort = 47615
)

//go:embed docs
var embedded embed.FS

type app struct {
	web      fs.FS
	port     int
	dataDir  string // the locked ledger and its daily copies
	cacheDir string // the app window's browser profile, scratch files, the log
	pdfDir   string // where statements are saved

	storeMu   sync.Mutex
	printMu   sync.Mutex
	printDocs sync.Map // one-time pages for the PDF printer, by random id
	saved     sync.Map // PDFs saved in this run, the only files /native/open will open

	streams  atomic.Int32 // app windows that are listening
	everSeen atomic.Bool
	lastSeen atomic.Int64
	quit     chan struct{}
	quitOnce sync.Once
	windowMu sync.Mutex
	noWindow bool
}

func main() {
	a := &app{quit: make(chan struct{})}
	a.noWindow = os.Getenv("CUTS_NO_WINDOW") == "1" // automated tests drive the page themselves

	sub, err := fs.Sub(embedded, "docs")
	if err != nil {
		fatal("Cuts is damaged: its pages are missing. Download it again.")
	}
	a.web = sub

	if err := a.preparePaths(); err != nil {
		fatal("Cuts can't create its folders.\n\n" + err.Error())
	}
	a.openLog()

	ln, err := a.listen()
	if err != nil {
		fatal("Cuts can't start: no free port on this computer.\n\n" + err.Error())
	}
	if ln == nil {
		return // another Cuts was already running and has been asked to show its window
	}
	a.port = ln.Addr().(*net.TCPAddr).Port
	log.Printf("%s %s listening on 127.0.0.1:%d", appName, appVersion, a.port)
	a.dailyCopy()

	server := &http.Server{Handler: a.routes(), ReadHeaderTimeout: 15 * time.Second}
	go func() {
		if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("server: %v", err)
		}
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() { <-signals; a.stop() }()

	var window *exec.Cmd
	if !a.noWindow {
		window = a.openWindow()
	}
	a.waitForEnd(window)
	log.Printf("closing")
	_ = server.Close()
}

func (a *app) stop() { a.quitOnce.Do(func() { close(a.quit) }) }

func (a *app) baseURL() string { return fmt.Sprintf("http://127.0.0.1:%d", a.port) }

func (a *app) preparePaths() error {
	config, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		cache = config
	}
	a.dataDir = filepath.Join(config, appName)
	a.cacheDir = filepath.Join(cache, appName)
	if dir := os.Getenv("CUTS_DATA_DIR"); dir != "" { // automated tests keep their files apart
		a.dataDir = filepath.Join(dir, "data")
		a.cacheDir = filepath.Join(dir, "cache")
	}
	a.pdfDir = filepath.Join(documentsDir(), appName)
	if dir := os.Getenv("CUTS_PDF_DIR"); dir != "" {
		a.pdfDir = dir
	}
	for _, dir := range []string{a.dataDir, a.cacheDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	return nil
}

func (a *app) openLog() {
	path := filepath.Join(a.cacheDir, "cuts.log")
	if info, err := os.Stat(path); err == nil && info.Size() > 1<<20 {
		_ = os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	log.SetOutput(f)
	log.SetFlags(log.LstdFlags)
}

// listen takes the usual port. If another Cuts already has it, that one is asked to show
// its window (or to make room, when it is an older version) and nil is returned.
func (a *app) listen() (net.Listener, error) {
	addr := fmt.Sprintf("127.0.0.1:%d", preferredPort)
	ln, err := net.Listen("tcp", addr)
	if err == nil {
		return ln, nil
	}
	if version, ok := pingRunning(); ok {
		if version == appVersion {
			if ok, open := askRunning("show"); ok {
				if open && !focusWindow(appName) {
					infoBox("Cuts is already open. Look for its window on the taskbar.")
				}
				return nil, nil
			}
		} else if ok, _ := askRunning("quit"); ok {
			for i := 0; i < 30; i++ {
				time.Sleep(150 * time.Millisecond)
				if ln, err = net.Listen("tcp", addr); err == nil {
					return ln, nil
				}
			}
		}
	}
	return net.Listen("tcp", "127.0.0.1:0")
}

// waitForEnd returns when the app window is closed.
func (a *app) waitForEnd(window *exec.Cmd) {
	if window == nil {
		if a.noWindow {
			<-a.quit
			return
		}
		a.waitForPageGone() // opened in the default browser: there is no process to wait for
		return
	}
	exited := make(chan struct{})
	go func() { _ = window.Wait(); close(exited) }()
	settle := time.NewTimer(12 * time.Second)
	defer settle.Stop()
	select {
	case <-a.quit:
	case <-exited:
		// The browser ended almost at once: it handed the window to a browser that was
		// already running with this profile. Follow the page itself instead.
		a.waitForPageGone()
	case <-settle.C:
		select {
		case <-exited: // the usual way out: the window was closed
		case <-a.quit:
		}
	}
}

// waitForPageGone returns a little after the last app window stops listening, or when no
// window ever shows up.
func (a *app) waitForPageGone() {
	started := time.Now()
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-a.quit:
			return
		case <-tick.C:
		}
		if a.streams.Load() > 0 {
			continue
		}
		if a.everSeen.Load() {
			if time.Since(time.UnixMilli(a.lastSeen.Load())) > 8*time.Second {
				return
			}
		} else if time.Since(started) > 2*time.Minute {
			return
		}
	}
}

func fatal(message string) {
	log.Print(message)
	fatalBox(message)
	os.Exit(1)
}
