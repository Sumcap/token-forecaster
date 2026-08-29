#!/usr/bin/env node
/**
 * Generate the extension icons. Kept as a script so the PNGs in src/icons are
 * reproducible rather than mystery binaries.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/icons");

// A lightning bolt in a 0..1 square, drawn clockwise.
const BOLT = [
  [0.56, 0.08],
  [0.28, 0.54],
  [0.46, 0.54],
  [0.4, 0.92],
  [0.72, 0.44],
  [0.53, 0.44],
];

function insidePolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xed_b8_83_20 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const samples = 3;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      let coverage = 0;
      let bolt = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + 0.5) / samples) / size;
          const py = (y + (sy + 0.5) / samples) / size;
          const dx = px - 0.5;
          const dy = py - 0.5;
          if (dx * dx + dy * dy <= 0.5 * 0.5) coverage += 1;
          if (insidePolygon(BOLT, px, py)) bolt += 1;
        }
      }
      const total = samples * samples;
      const alpha = Math.round((coverage / total) * 255);
      const boltRatio = bolt / total;
      // Claude orange disc, near-white bolt.
      const r = Math.round(217 + (255 - 217) * boltRatio);
      const g = Math.round(119 + (250 - 119) * boltRatio);
      const b = Math.round(87 + (245 - 87) * boltRatio);
      const offset = 1 + x * 4;
      row[offset] = r;
      row[offset + 1] = g;
      row[offset + 2] = b;
      row[offset + 3] = alpha;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  writeFileSync(resolve(outDir, `icon${size}.png`), png(size));
  console.log(`wrote icon${size}.png`);
}
