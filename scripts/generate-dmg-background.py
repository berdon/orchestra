#!/usr/bin/env python3
import math
import os
import struct
import sys
import zlib

WIDTH = 680
HEIGHT = 420


def clamp(value, low=0, high=255):
    return max(low, min(high, int(value)))


def blend(base, overlay, alpha):
    return tuple(
        clamp(base[i] * (1.0 - alpha) + overlay[i] * alpha)
        for i in range(3)
    )


def point_in_triangle(px, py, ax, ay, bx, by, cx, cy):
    v0x, v0y = cx - ax, cy - ay
    v1x, v1y = bx - ax, by - ay
    v2x, v2y = px - ax, py - ay

    dot00 = v0x * v0x + v0y * v0y
    dot01 = v0x * v1x + v0y * v1y
    dot02 = v0x * v2x + v0y * v2y
    dot11 = v1x * v1x + v1y * v1y
    dot12 = v1x * v2x + v1y * v2y

    denom = dot00 * dot11 - dot01 * dot01
    if denom == 0:
        return False
    inv = 1.0 / denom
    u = (dot11 * dot02 - dot01 * dot12) * inv
    v = (dot00 * dot12 - dot01 * dot02) * inv
    return u >= 0 and v >= 0 and (u + v) <= 1


def point_segment_distance(px, py, ax, ay, bx, by):
    abx = bx - ax
    aby = by - ay
    apx = px - ax
    apy = py - ay
    ab_len_sq = abx * abx + aby * aby
    if ab_len_sq == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, (apx * abx + apy * aby) / ab_len_sq))
    cx = ax + t * abx
    cy = ay + t * aby
    return math.hypot(px - cx, py - cy)


def draw_background():
    pixels = bytearray()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            top = (246, 247, 252)
            bottom = (229, 233, 245)
            t = y / float(HEIGHT - 1)
            base = tuple(clamp(top[i] * (1.0 - t) + bottom[i] * t) for i in range(3))

            cx1, cy1 = 150, 210
            cx2, cy2 = 530, 210
            r = 84
            dist1 = math.hypot(x - cx1, y - cy1)
            dist2 = math.hypot(x - cx2, y - cy2)
            if dist1 < r:
                alpha = 0.18 * (1.0 - dist1 / r)
                base = blend(base, (255, 255, 255), alpha)
            if dist2 < r:
                alpha = 0.18 * (1.0 - dist2 / r)
                base = blend(base, (255, 255, 255), alpha)

            shadow = point_segment_distance(x, y, 250, 216, 430, 216) <= 23 or point_in_triangle(x, y, 430, 178, 520, 216, 430, 254)
            arrow = point_segment_distance(x, y, 250, 210, 430, 210) <= 19 or point_in_triangle(x, y, 430, 172, 520, 210, 430, 248)

            if shadow:
                base = blend(base, (255, 255, 255), 0.55)
            if arrow:
                base = blend(base, (122, 92, 255), 0.82)

            pixels.extend(base)

    return pixels


def png_chunk(tag, data):
    return (
        struct.pack('>I', len(data))
        + tag
        + data
        + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path, width, height, rgb_bytes):
    raw = bytearray()
    stride = width * 3
    for row in range(height):
        raw.append(0)
        start = row * stride
        raw.extend(rgb_bytes[start:start + stride])

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    image = zlib.compress(bytes(raw), 9)

    with open(path, 'wb') as handle:
        handle.write(b'\x89PNG\r\n\x1a\n')
        handle.write(png_chunk(b'IHDR', ihdr))
        handle.write(png_chunk(b'IDAT', image))
        handle.write(png_chunk(b'IEND', b''))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: generate-dmg-background.py <output-path>', file=sys.stderr)
        sys.exit(1)
    output_path = sys.argv[1]
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    write_png(output_path, WIDTH, HEIGHT, draw_background())
