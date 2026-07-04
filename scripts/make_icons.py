import struct, zlib, os
def png(path, size):
    bg = (247, 201, 72)        # #f7c948
    fg = (27, 29, 35)          # #1b1d23
    rows = []
    cx = cy = size / 2
    r  = size / 2 - 1
    for y in range(size):
        line = bytearray([0])  # filter
        for x in range(size):
            dx, dy = x - cx, y - cy
            d = (dx*dx + dy*dy) ** 0.5
            if d > r:
                line += bytes((0, 0, 0, 0))
            elif d > r * 0.4:
                line += bytes((bg[0], bg[1], bg[2], 255))
            else:
                line += bytes((fg[0], fg[1], fg[2], 255))
        rows.append(bytes(line))
    raw = b"".join(rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    out = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    with open(path, "wb") as f: f.write(out)
for s in (16, 32, 48, 128):
    png(f"icons/icon{s}.png", s)
    print(f"icons/icon{s}.png", os.path.getsize(f"icons/icon{s}.png"), "bytes")