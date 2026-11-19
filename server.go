package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var contentTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".json":        "application/json",
	".webmanifest": "application/manifest+json",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".ico":         "image/x-icon",
	".woff":        "font/woff",
}

// The ledger files the page may read and write, and nothing else.
var storeFiles = map[string]string{
	"cuts.vault": "vault.json",
	"cuts.local": "local.json",
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/native/ping", a.handlePing)
	mux.HandleFunc("/native/info", a.guard(a.handleInfo))
	mux.HandleFunc("/native/show", a.guard(a.handleShow))
	mux.HandleFunc("/native/quit", a.guard(a.handleQuit))
	mux.HandleFunc("/native/store", a.guard(a.handleStoreAll))
	mux.HandleFunc("/native/store/", a.guard(a.handleStoreKey))
	mux.HandleFunc("/native/pdf", a.guard(a.handlePDF))
	mux.HandleFunc("/native/open", a.guard(a.handleOpen))
	mux.HandleFunc("/native/events", a.handleEvents)
	mux.HandleFunc("/print/", a.handlePrintDoc)
	mux.HandleFunc("/", a.handleStatic)
	return a.onlyThisComputer(mux)
}

// onlyThisComputer turns away every request that was not addressed to 127.0.0.1 itself.
// A web page that points its own domain at this computer still sends its own name here.
func (a *app) onlyThisComputer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if host != fmt.Sprintf("127.0.0.1:%d", a.port) && host != fmt.Sprintf("localhost:%d", a.port) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

func (a *app) sameOrigin(r *http.Request) bool {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		return false
	}
	origin := r.Header.Get("Origin")
	return origin == "" || origin == a.baseURL() || origin == fmt.Sprintf("http://localhost:%d", a.port)
}

// guard lets only the app's own page call the helper: other sites can't add the header
// without the browser asking first, and that question is never answered with yes.
func (a *app) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Cuts") != "1" || !a.sameOrigin(r) {
			writeError(w, http.StatusForbidden, "forbidden")
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func (a *app) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if name == "sw.js" { // only the iPhone web app keeps itself for offline use
		http.NotFound(w, r)
		return
	}
	data, err := fs.ReadFile(a.web, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	kind, ok := contentTypes[strings.ToLower(path.Ext(name))]
	if !ok {
		http.NotFound(w, r)
		return
	}
	if name == "index.html" {
		// Tells the page it runs inside the Windows app, with this helper behind it.
		data = bytes.Replace(data, []byte(`<html lang="en">`), []byte(`<html lang="en" data-native="1">`), 1)
	}
	w.Header().Set("Content-Type", kind)
	_, _ = w.Write(data)
}

func (a *app) handlePing(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"app": "cuts", "version": appVersion})
}

func (a *app) handleInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"app": "cuts", "version": appVersion, "pdfDir": a.pdfDir, "dataDir": a.dataDir, "canPrint": len(browserCandidates()) > 0,
	})
}

func (a *app) handleShow(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	// With a window already open there is nothing to start: the caller brings it forward.
	open := a.streams.Load() > 0
	if !open && !a.noWindow {
		go func() {
			if cmd := a.openWindow(); cmd != nil {
				_ = cmd.Wait()
			}
		}()
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "open": open})
}

func (a *app) handleQuit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	go func() { time.Sleep(100 * time.Millisecond); a.stop() }()
}

// handleEvents keeps a line open to each app window. The helper knows a window is there
// as long as its line is.
func (a *app) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok || r.Method != http.MethodGet || !a.sameOrigin(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "retry: 1500\n\n")
	flusher.Flush()
	a.everSeen.Store(true)
	a.streams.Add(1)
	defer func() {
		a.lastSeen.Store(time.Now().UnixMilli())
		a.streams.Add(-1)
	}()
	tick := time.NewTicker(20 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-a.quit:
			return
		case <-tick.C:
			if _, err := io.WriteString(w, ": here\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

/* ---------------------------------------------------------------- the ledger files */

func (a *app) handleStoreAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	a.storeMu.Lock()
	defer a.storeMu.Unlock()
	out := map[string]*string{}
	for key, file := range storeFiles {
		data, err := os.ReadFile(filepath.Join(a.dataDir, file))
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				log.Printf("store: reading %s: %v", file, err)
				writeError(w, http.StatusInternalServerError, "Cuts couldn't read its files.")
				return
			}
			out[key] = nil
			continue
		}
		text := string(data)
		out[key] = &text
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *app) handleStoreKey(w http.ResponseWriter, r *http.Request) {
	file, ok := storeFiles[strings.TrimPrefix(r.URL.Path, "/native/store/")]
	if !ok {
		writeError(w, http.StatusNotFound, "unknown file")
		return
	}
	target := filepath.Join(a.dataDir, file)
	a.storeMu.Lock()
	defer a.storeMu.Unlock()
	switch r.Method {
	case http.MethodPut:
		data, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
		if err != nil || !json.Valid(data) {
			writeError(w, http.StatusBadRequest, "not a ledger file")
			return
		}
		if err := writeFileAtomic(target, data); err != nil {
			log.Printf("store: writing %s: %v", file, err)
			writeError(w, http.StatusInternalServerError, "Cuts couldn't save its files.")
			return
		}
	case http.MethodDelete:
		if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusInternalServerError, "Cuts couldn't save its files.")
			return
		}
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// writeFileAtomic writes next to the target and swaps it in, so a crash never leaves half a file.
func writeFileAtomic(target string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(target), ".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, err = tmp.Write(data)
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(name, target)
	}
	if err != nil {
		_ = os.Remove(name)
	}
	return err
}

// dailyCopy keeps one copy of the locked ledger for each day Cuts is used, the newest thirty.
func (a *app) dailyCopy() {
	data, err := os.ReadFile(filepath.Join(a.dataDir, storeFiles["cuts.vault"]))
	if err != nil || len(data) == 0 {
		return
	}
	dir := filepath.Join(a.dataDir, "backups")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	target := filepath.Join(dir, "cuts-ledger-"+time.Now().Format("2006-01-02")+".json")
	if _, err := os.Stat(target); err == nil {
		return
	}
	if err := writeFileAtomic(target, data); err != nil {
		log.Printf("backup: %v", err)
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "cuts-ledger-") && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for len(names) > 30 {
		_ = os.Remove(filepath.Join(dir, names[0]))
		names = names[1:]
	}
}

/* ---------------------------------------------------------------- PDFs and folders */

func safeFileName(name string) string {
	clean := strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`\/:*?"<>|`, r) {
			return ' '
		}
		return r
	}, name)
	clean = strings.TrimRight(strings.Join(strings.Fields(clean), " "), ". ")
	if clean == "" {
		clean = "Statement"
	}
	if len([]rune(clean)) > 120 {
		clean = string([]rune(clean)[:120])
	}
	switch strings.ToUpper(clean) {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3":
		clean = "_" + clean
	}
	return clean
}

func (a *app) handlePDF(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var in struct {
		HTML  string `json:"html"`
		Name  string `json:"name"`
		Title string `json:"title"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<20)).Decode(&in); err != nil || strings.TrimSpace(in.HTML) == "" {
		writeError(w, http.StatusBadRequest, "nothing to print")
		return
	}
	a.printMu.Lock()
	defer a.printMu.Unlock()
	data, err := a.printPDF(in.HTML, in.Title)
	if err != nil {
		log.Printf("pdf: %v", err)
		writeError(w, http.StatusInternalServerError, "Couldn't make the PDF.")
		return
	}
	if err := os.MkdirAll(a.pdfDir, 0o755); err != nil {
		log.Printf("pdf: folder: %v", err)
		writeError(w, http.StatusInternalServerError, "Couldn't create the PDF folder.")
		return
	}
	base := safeFileName(in.Name)
	var target string
	for i := 1; i <= 30; i++ {
		name := base + ".pdf"
		if i > 1 {
			name = fmt.Sprintf("%s (%d).pdf", base, i)
		}
		target = filepath.Join(a.pdfDir, name)
		// The same statement saved again replaces the old file, unless a PDF reader has it open.
		if err = writeFileAtomic(target, data); err == nil {
			break
		}
	}
	if err != nil {
		log.Printf("pdf: saving: %v", err)
		writeError(w, http.StatusInternalServerError, "Couldn't save the PDF.")
		return
	}
	a.saved.Store(target, true)
	writeJSON(w, http.StatusOK, map[string]string{"path": target, "name": filepath.Base(target), "folder": a.pdfDir})
}

func (a *app) handleOpen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var in struct {
		Path   string `json:"path"`
		Reveal bool   `json:"reveal"`
		Dir    string `json:"dir"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "bad request")
		return
	}
	var err error
	switch {
	case in.Dir == "pdf":
		if err = os.MkdirAll(a.pdfDir, 0o755); err == nil {
			err = openPath(a.pdfDir)
		}
	case in.Dir == "data":
		err = openPath(a.dataDir)
	case in.Path != "":
		// Only a PDF this run saved can be opened, never a path the page made up.
		if _, known := a.saved.Load(in.Path); !known {
			writeError(w, http.StatusForbidden, "not a file Cuts saved")
			return
		}
		if _, statErr := os.Stat(in.Path); statErr != nil {
			writeError(w, http.StatusNotFound, "The file is gone.")
			return
		}
		if in.Reveal {
			err = revealPath(in.Path)
		} else {
			err = openPath(in.Path)
		}
	default:
		writeError(w, http.StatusBadRequest, "bad request")
		return
	}
	if err != nil {
		log.Printf("open: %v", err)
		writeError(w, http.StatusInternalServerError, "Couldn't open it.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
