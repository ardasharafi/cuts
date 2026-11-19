"""Packs the PNGs into one .ico: classic bitmaps for the small sizes, PNG for 256."""
import struct, sys
from PIL import Image

def dib(path):
    im = Image.open(path).convert('RGBA')
    w, h = im.size
    px = im.load()
    rows = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            rows += bytes((b, g, r, a))
    mask_row = ((w + 31) // 32) * 4
    mask = bytes(mask_row * h)
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(rows) + len(mask), 0, 0, 0, 0)
    return header + bytes(rows) + mask

def build(out, folder, sizes):
    images = []
    for s in sizes:
        path = '%s/icon-%d.png' % (folder, s)
        data = open(path, 'rb').read() if s >= 256 else dib(path)
        images.append((s, data))
    offset = 6 + 16 * len(images)
    head = struct.pack('<HHH', 0, 1, len(images))
    entries = b''
    for s, data in images:
        entries += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    open(out, 'wb').write(head + entries + b''.join(d for _, d in images))

build(sys.argv[1], sys.argv[2], [16, 20, 24, 32, 40, 48, 64, 256])
build(sys.argv[3], sys.argv[2], [16, 32, 48])
