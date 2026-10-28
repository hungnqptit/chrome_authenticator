"""Draws the extension icon (padlock on an indigo tile) as PNGs, stdlib only."""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'extension', 'icons')
TOP = (79, 70, 229)
BOTTOM = (124, 58, 237)
SS = 4  # supersampling per axis


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def shade(x, y):
    """Returns (rgb, alpha) for a point in unit coordinates."""
    if not in_round_rect(x, y, 0, 0, 1, 1, 0.22):
        return None
    bg = tuple(round(a + (b - a) * (x + y) / 2) for a, b in zip(TOP, BOTTOM))
    keyhole = (x - 0.5) ** 2 + (y - 0.6) ** 2 <= 0.05 ** 2 or (0.475 <= x <= 0.525 and 0.6 <= y <= 0.71)
    body = in_round_rect(x, y, 0.27, 0.45, 0.73, 0.81, 0.06)
    d = ((x - 0.5) ** 2 + (y - 0.45) ** 2) ** 0.5
    shackle = y <= 0.5 and 0.115 <= d <= 0.175
    if body and not keyhole:
        return (255, 255, 255)
    if shackle and not body:
        return (255, 255, 255)
    return bg


def render(size):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0]
            hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)
                    if c:
                        hits += 1
                        for i in range(3):
                            acc[i] += c[i]
            if hits:
                row += bytes([round(acc[0] / hits), round(acc[1] / hits), round(acc[2] / hits), round(255 * hits / SS**2)])
            else:
                row += bytes(4)
        rows.append(bytes(row))
    return png(size, b''.join(rows))


def png(size, raw):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 32, 48, 128):
        with open(os.path.join(OUT, f'icon{size}.png'), 'wb') as f:
            f.write(render(size))
    print('icons written to', os.path.normpath(OUT))
