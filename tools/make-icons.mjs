// Generates the app icons (PNG) without any dependencies: orange square with three white rising bars.
// Usage: node tools/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// signed distance to rounded rectangle centred at (cx,cy) with half-size (hw,hh) and radius r
function sdRound(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r, qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// Shapes in unit space (0..1). Bars sit inside the maskable safe zone (centre 60%).
const BARS = [
  { x: 0.34, h: 0.18 },
  { x: 0.50, h: 0.30 },
  { x: 0.66, h: 0.42 },
];
const BASE = 0.70, BW = 0.055;
function fgCoverage(u, v) {
  for (const b of BARS) {
    const top = BASE - b.h;
    if (sdRound(u, v, b.x, (top + BASE) / 2, BW, b.h / 2, 0.03) <= 0) return 1;
  }
  // small coin above the tallest bar
  if (Math.hypot(u - 0.66, v - 0.205) <= 0.055) return 1;
  return 0;
}
function render(size, { bg, fg, rounded }) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let a = 0, f = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS) / size, v = (y + (sy + 0.5) / SS) / size;
      const inBg = bg ? (rounded ? sdRound(u, v, 0.5, 0.5, 0.5, 0.5, 0.22) <= 0 : true) : false;
      const inFg = fgCoverage(u, v);
      if (inFg) f++;
      if (inBg || inFg) a++;
    }
    const n = SS * SS, fa = f / n, aa = a / n;
    const col = bg ? bg.map((c, i) => c * (1 - fa) + fg[i] * fa) : fg;
    const o = (y * size + x) * 4;
    buf[o] = col[0]; buf[o + 1] = col[1]; buf[o + 2] = col[2]; buf[o + 3] = Math.round(255 * aa);
  }
  return png(size, buf);
}
fs.mkdirSync(OUT, { recursive: true });
const ORANGE = [249, 115, 22], WHITE = [255, 255, 255];
fs.writeFileSync(path.join(OUT, 'icon-512.png'), render(512, { bg: ORANGE, fg: WHITE, rounded: false }));
fs.writeFileSync(path.join(OUT, 'icon-192.png'), render(192, { bg: ORANGE, fg: WHITE, rounded: false }));
fs.writeFileSync(path.join(OUT, 'badge-96.png'), render(96, { bg: null, fg: WHITE }));
console.log('Icons written to', OUT);
