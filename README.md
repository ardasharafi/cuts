# Cuts

Cuts works out a manager's share of artists' earnings. Add the invoice PDFs, type
the percentage for each artist, and save one statement for the manager as a PDF.

- **iPhone:** open <https://ardasharafi.github.io/cuts/>, or scan the QR code in Cuts
  on the computer: Settings, Sync with GitHub, Use Cuts on your iPhone.
- **Windows:** `Cuts.exe`, built from this repository (see below).

This repository holds only the app's code. The ledger itself never comes here:
it stays encrypted (AES-256-GCM, unlocked only by your password) in a private
repository, and it is opened only on your own devices.

## What is where

| Path | What it is |
|---|---|
| `docs/` | The app. GitHub Pages serves this folder as the iPhone web app, and the Windows app carries the same files inside it. |
| `docs/assets/js/engine.js` | The ledger: encryption, the record store, syncing with GitHub. |
| `docs/assets/js/lib.js` | Money, percentages, dates and the statement sheet. |
| `docs/assets/js/invoice.js` | Reads "Total Earnings" and the invoice details from a PDF. |
| `*.go` | The Windows helper: serves the app on 127.0.0.1, opens it in an Edge or Chrome app window, keeps the locked ledger files, prints PDFs. |
| `build/` | Icon, version information and the build script for `Cuts.exe`. |
| `tools/` | Tests and the scripts that draw the icons. |

The look comes from the Splits design kit: `docs/assets/css/app.css` and
`statement.css` are the kit's files, unchanged. `cuts.css` holds the few extra rules.

## Building the Windows app

```
sh build/build.sh
```

This writes `dist/Cuts.exe`. It needs Go, Node with `sharp`, Python with Pillow,
and LLVM's `llvm-rc` and `llvm-cvtres`. Nothing is downloaded.

## Tests

```
node tools/test-lib.mjs                      # amounts, percentages, dates, reading an invoice
node tools/test-engine.mjs                   # the ledger against a stand-in GitHub
node tools/test-qr.mjs <out.json> <out.svg>  # QR codes in many sizes
node tools/e2e-phone.mjs <scratch folder>    # the iPhone web app in a phone-sized browser
go build -o <scratch folder>/out/cuts-linux .
node tools/e2e-desktop.mjs <scratch folder>  # the Windows app, helper included
```

The end-to-end tests need Playwright with Chromium; the desktop one also uses
`pdftotext`, `pdffonts`, `pdfinfo`, `pdftoppm` and Python with OpenCV.

Every name and invoice number in the tests is invented. So is the invoice they read,
`tools/sample/HaloNine_HaloNine_202607_2026-07_100231.pdf`, which
`tools/make-sample-invoice.mjs` writes. To check a real invoice, pass its path to
`test-lib.mjs`; it prints what was read. Real invoices never belong in this repository.

## A new version

Change the number in `docs/assets/js/lib.js`, `main.go`, `build/cuts.rc`,
`build/cuts.manifest` and the `?v=` marks in `docs/index.html`, then run
`sh build/build.sh` (it also rewrites `docs/sw.js`, which is what makes iPhones
pick up the new files).

## Credits

Inter (SIL Open Font License 1.1), TeX Gyre Adventor (GUST Font License),
PDF.js, the build for older browsers (Apache License 2.0).
