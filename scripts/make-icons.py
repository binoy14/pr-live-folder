#!/usr/bin/env python3
"""Generate simple PR-style icons (16/32/48/128) using only the stdlib."""

import struct, zlib, os

SIZES = [16, 32, 48, 128]
BLUE = (31, 111, 235)      # GitHub-ish blue #1f6feb
WHITE = (255, 255, 255)

# Layout in a 48x48 logical space, scaled per size.
def in_rounded_rect(x, y, s=48, r=10):
    cx = min(max(x, r), s - r)
    cy = min(max(y, r), s - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2

def circle_outline(px, py, cx, cy, radius, width):
    d = ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5
    return abs(d - radius) <= width / 2

def dist_to_segment(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    if dx == dy == 0:
        return ((px - x1) ** 2 + (py - y1) ** 2) ** 0.5
    t = max(0, min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    return ((px - x1 - t * dx) ** 2 + (py - y1 - t * dy) ** 2) ** 0.5

def glyph_white(x, y):
    # pull-request style glyph: two circles + connecting line
    if circle_outline(x, y, 12.5, 12.5, 5, 2.5):
        return True
    if circle_outline(x, y, 35.5, 35.5, 5, 2.5):
        return True
    # vertical line from top circle down to bottom circle's row
    if dist_to_segment(x, y, 12.5, 18, 12.5, 35.5) <= 1.25:
        return True
    # horizontal line into the bottom circle
    if dist_to_segment(x, y, 12.5, 35.5, 30, 35.5) <= 1.25:
        return True
    return False

def render(size):
    scale = size / 48
    ss = 4  # supersampling factor
    px = [[(0, 0, 0, 0)] * size for _ in range(size)]
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    lx = (x + (sx + 0.5) / ss) / scale
                    ly = (y + (sy + 0.5) / ss) / scale
                    if in_rounded_rect(lx, ly):
                        r, g, b = BLUE
                        a += 255
                        if glyph_white(lx, ly):
                            r, g, b = WHITE
            px[y][x] = (r, g, b, min(255, a // (ss * ss)))
    return px

def write_png(path, size, pixels):
    raw = b""
    for row in pixels:
        raw += b"\x00" + b"".join(struct.pack("4B", *p) for p in row)
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "..", "icons")
    os.makedirs(out, exist_ok=True)
    for s in SIZES:
        write_png(os.path.join(out, f"icon{s}.png"), s, render(s))
        print(f"icon{s}.png")

if __name__ == "__main__":
    main()
