package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// openWindow shows the app in a window of its own: Edge (or Chrome) in app mode, with a
// browser profile that belongs to Cuts alone. Returns nil when only the default browser
// could be used.
func (a *app) openWindow() *exec.Cmd {
	a.windowMu.Lock()
	defer a.windowMu.Unlock()
	url := a.baseURL() + "/"
	profile := filepath.Join(a.cacheDir, "window")
	for _, browser := range browserCandidates() {
		args := []string{
			"--app=" + url,
			"--user-data-dir=" + profile,
			"--window-size=1400,940",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-sync",
			"--disable-extensions",
			"--disable-default-apps",
			"--disable-background-mode",
			"--disable-features=Translate",
			"--hide-crash-restore-bubble",
		}
		cmd := exec.Command(browser, append(args, extraBrowserArgs()...)...)
		if err := cmd.Start(); err != nil {
			log.Printf("window: %s: %v", browser, err)
			continue
		}
		log.Printf("window: %s", browser)
		return cmd
	}
	log.Printf("window: no Edge or Chrome found, using the default browser")
	if err := openPath(url); err != nil {
		fatal("Cuts needs Microsoft Edge or Google Chrome to show its window, and couldn't find either.")
	}
	return nil
}

func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// The page the PDF is printed from: the statement sheet and the kit's statement stylesheet.
// Nothing in it may run script or load anything from outside this helper.
func printDocument(sheet, title string) string {
	if strings.TrimSpace(title) == "" {
		title = "Statement"
	}
	return "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n" +
		"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:\">\n" +
		"<title>" + html.EscapeString(title) + "</title>\n" +
		"<link rel=\"stylesheet\" href=\"/assets/css/statement.css\">\n</head>\n<body class=\"print-page\">\n" + sheet + "\n</body>\n</html>\n"
}

func (a *app) handlePrintDoc(w http.ResponseWriter, r *http.Request) {
	doc, ok := a.printDocs.Load(strings.TrimPrefix(r.URL.Path, "/print/"))
	if !ok || r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, doc.(string))
}

// printPDF prints the statement with Edge or Chrome running without a window, the same
// engine that draws the preview in the app.
func (a *app) printPDF(sheet, title string) ([]byte, error) {
	browsers := browserCandidates()
	if len(browsers) == 0 {
		return nil, errors.New("no browser to print with")
	}
	id := randomID()
	a.printDocs.Store(id, printDocument(sheet, title))
	defer a.printDocs.Delete(id)
	work, err := os.MkdirTemp(a.cacheDir, "print-")
	if err != nil {
		return nil, err
	}
	defer removeLater(work)
	url := a.baseURL() + "/print/" + id

	var last error
	for i, browser := range browsers {
		// each try has its own profile and its own file: an earlier browser may still be
		// holding on to what it was given
		out := filepath.Join(work, fmt.Sprintf("statement-%d.pdf", i))
		args := []string{
			"--headless=new",
			"--disable-gpu",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-extensions",
			"--disable-sync",
			"--disable-background-networking",
			"--user-data-dir=" + filepath.Join(work, fmt.Sprintf("profile-%d", i)),
			"--no-pdf-header-footer",
			"--print-to-pdf-no-header",
			"--virtual-time-budget=4000",
			"--print-to-pdf=" + out,
		}
		args = append(args, extraBrowserArgs()...)
		args = append(args, url)
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		cmd := exec.CommandContext(ctx, browser, args...)
		quiet(cmd)
		started := time.Now()
		output, runErr := cmd.CombinedOutput()
		cancel()
		// On Windows the program that was started can return at once and leave the printing
		// to another process, so the file is given time to arrive. A browser that failed
		// outright (it took a while and left nothing) gets a shorter wait.
		wait := 30 * time.Second
		if runErr != nil && time.Since(started) > 5*time.Second {
			wait = 3 * time.Second
		}
		data, readErr := waitForPDF(out, wait)
		if readErr == nil {
			return data, nil
		}
		last = fmt.Errorf("%s: %v; %v; %s", filepath.Base(browser), runErr, readErr, strings.TrimSpace(string(output)))
		log.Printf("pdf: %v", last)
	}
	return nil, last
}

// waitForPDF returns the file once it is a whole PDF: it starts and ends as one, and it has
// stopped growing.
func waitForPDF(path string, limit time.Duration) ([]byte, error) {
	deadline := time.Now().Add(limit)
	lastSize := -1
	for {
		data, err := os.ReadFile(path)
		if err == nil && wholePDF(data) {
			if len(data) == lastSize {
				return data, nil
			}
			lastSize = len(data)
		} else {
			lastSize = -1
		}
		if time.Now().After(deadline) {
			if err == nil {
				err = errors.New("the PDF was not finished in time")
			}
			return nil, err
		}
		time.Sleep(150 * time.Millisecond)
	}
}

func wholePDF(data []byte) bool {
	if len(data) < 800 || !strings.HasPrefix(string(data[:5]), "%PDF-") {
		return false
	}
	tail := data
	if len(tail) > 1024 {
		tail = tail[len(tail)-1024:]
	}
	return strings.Contains(string(tail), "%%EOF")
}

// removeLater deletes a work folder. The browser that printed may hold its files for a few
// more seconds, so the delete is tried again in the background.
func removeLater(dir string) {
	if os.RemoveAll(dir) == nil {
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			return
		}
	}
	go func() {
		for _, pause := range []time.Duration{2, 5, 15, 30, 60} {
			time.Sleep(pause * time.Second)
			if os.RemoveAll(dir) == nil {
				if _, err := os.Stat(dir); os.IsNotExist(err) {
					return
				}
			}
		}
	}()
}

// clearPrintLeftovers removes work folders an earlier run could not delete.
func (a *app) clearPrintLeftovers() {
	entries, err := os.ReadDir(a.cacheDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "print-") {
			_ = os.RemoveAll(filepath.Join(a.cacheDir, e.Name()))
		}
	}
}

/* ---------------------------------------------------------------- another Cuts already running */

func pingRunning() (string, bool) {
	client := http.Client{Timeout: 800 * time.Millisecond}
	res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/native/ping", preferredPort))
	if err != nil {
		return "", false
	}
	defer res.Body.Close()
	var info struct {
		App     string `json:"app"`
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&info); err != nil || info.App != "cuts" {
		return "", false
	}
	return info.Version, true
}

// askRunning sends "show" or "quit" to the Cuts that is already running. The second result
// says whether that one has a window open.
func askRunning(action string) (bool, bool) {
	client := http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/native/%s", preferredPort, action), strings.NewReader("{}"))
	if err != nil {
		return false, false
	}
	req.Header.Set("X-Cuts", "1")
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return false, false
	}
	defer res.Body.Close()
	var out struct {
		Open bool `json:"open"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&out)
	return res.StatusCode == http.StatusOK, out.Open
}
