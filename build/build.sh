#!/bin/sh
# Builds Cuts.exe for Windows (64-bit) from this folder's parent. Needs Go, Node with
# sharp, Python with Pillow, and LLVM's llvm-rc and llvm-cvtres. No downloads.
set -e
cd "$(dirname "$0")/.."
node tools/make-icons.mjs
python3 tools/make-ico.py build/icon.ico build/png docs/assets/img/favicon.ico
node tools/make-sw.mjs
(cd build && llvm-rc /FO cuts.res cuts.rc)
llvm-cvtres /MACHINE:X64 /OUT:rsrc_windows_amd64.syso build/cuts.res
gofmt -l .
go vet ./...
GOOS=windows GOARCH=amd64 go vet ./...
mkdir -p dist
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w" -o dist/Cuts.exe .
ls -la dist/Cuts.exe
