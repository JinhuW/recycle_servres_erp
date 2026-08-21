#!/usr/bin/env python3
"""Grab one frame from an unauthenticated x11vnc and write it as a PNG.

Stdlib only — neither the container nor the VM has ImageMagick, vncsnapshot or
PIL, and this needs no install anywhere.

    python3 vncshot.py 172.24.0.3 5900 /tmp/monitor.png
"""

from __future__ import annotations

import socket
import struct
import sys
import zlib


def recvall(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise EOFError(f"socket closed with {len(buf)}/{n} bytes read")
        buf += chunk
    return buf


def write_png(path: str, width: int, height: int, rgb: bytearray) -> None:
    raw = bytearray()
    stride = width * 3
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw += rgb[y * stride : (y + 1) * stride]

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def main() -> None:
    host, port, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    s = socket.create_connection((host, port), timeout=20)
    s.settimeout(20)

    banner = recvall(s, 12)
    if not banner.startswith(b"RFB "):
        raise SystemExit(f"not an RFB server: {banner!r}")
    s.sendall(b"RFB 003.008\n")

    n_sec = recvall(s, 1)[0]
    if n_sec == 0:
        reason_len = struct.unpack(">I", recvall(s, 4))[0]
        raise SystemExit(f"server refused: {recvall(s, reason_len).decode()}")
    sec_types = recvall(s, n_sec)
    if 1 not in sec_types:
        raise SystemExit(f"server wants auth (types {list(sec_types)}); expected 1 (None)")
    s.sendall(b"\x01")  # None
    if struct.unpack(">I", recvall(s, 4))[0] != 0:
        raise SystemExit("security handshake failed")

    s.sendall(b"\x01")  # ClientInit, shared
    width, height = struct.unpack(">HH", recvall(s, 4))
    pf = recvall(s, 16)
    name_len = struct.unpack(">I", recvall(s, 4))[0]
    name = recvall(s, name_len).decode(errors="replace")
    bpp, depth, big_endian, true_colour = pf[0], pf[1], pf[2], pf[3]
    r_max, g_max, b_max = struct.unpack(">HHH", pf[4:10])
    r_shift, g_shift, b_shift = pf[10], pf[11], pf[12]
    print(
        f"{name}  {width}x{height}  bpp={bpp} depth={depth} "
        f"big_endian={big_endian} truecolour={true_colour}",
        file=sys.stderr,
    )
    if not true_colour or bpp not in (8, 16, 32):
        raise SystemExit(f"unsupported pixel format bpp={bpp} truecolour={true_colour}")

    # SetEncodings: raw only, so there is nothing to decompress.
    s.sendall(struct.pack(">BBH", 2, 0, 1) + struct.pack(">i", 0))
    # FramebufferUpdateRequest, non-incremental, whole screen.
    s.sendall(struct.pack(">BBHHHH", 3, 0, 0, 0, width, height))

    rgb = bytearray(width * height * 3)
    order = ">" if big_endian else "<"
    nbytes = bpp // 8
    fmt = {1: "B", 2: "H", 4: "I"}[nbytes]

    while True:
        msg = recvall(s, 1)[0]
        if msg != 0:  # only FramebufferUpdate is expected here
            continue
        recvall(s, 1)
        (n_rects,) = struct.unpack(">H", recvall(s, 2))
        for _ in range(n_rects):
            rx, ry, rw, rh, enc = struct.unpack(">HHHHi", recvall(s, 12))
            if enc != 0:
                raise SystemExit(f"server sent encoding {enc}, expected raw")
            data = recvall(s, rw * rh * nbytes)
            pixels = struct.unpack(f"{order}{rw * rh}{fmt}", data)
            for i, px in enumerate(pixels):
                y, x = divmod(i, rw)
                o = ((ry + y) * width + (rx + x)) * 3
                rgb[o] = ((px >> r_shift) & r_max) * 255 // r_max
                rgb[o + 1] = ((px >> g_shift) & g_max) * 255 // g_max
                rgb[o + 2] = ((px >> b_shift) & b_max) * 255 // b_max
        break

    s.close()
    write_png(out, width, height, rgb)
    print(f"wrote {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
