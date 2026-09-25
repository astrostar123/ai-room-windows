// Makes ai-room.ico (the robot head) for the desktop shortcut.
// Run once:  node tools/make-icon.js   (needs Node 22 or newer)
// No packages needed: it draws the pixels itself and packs them as PNGs.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Same head as the robot sprite in public/sprites.js
const HEAD = [
  '......sss......',
  '......sss......',
  '.......k.......',
  '...ooooooooo...',
  '..olllllllllo..',
  '..obfffffffbo..',
  '..obfefffefbo..',
  '..obfefffefbo..',
  '..obfffffffbo..',
  '..odbbbbbbbdo..',
  '...ooooooooo...',
];
const COLORS = {
  o: [0x15, 0x16, 0x1f], b: [0x8d, 0xa0, 0xc9], d: [0x5b, 0x6c, 0x93], l: [0xc3, 0xd0, 0xf0],
  s: [0x3d, 0xdc, 0x84], e: [0x3d, 0xdc, 0x84], k: [0x43, 0x48, 0x60], f: [0x10, 0x12, 0x1b],
};

// Draws the head, as big as fits, in the middle of a size x size square
function pixels(size) {
  const scale = Math.max(1, Math.floor(size / 15));
  const w = 15 * scale, h = 11 * scale;
  const ox = Math.floor((size - w) / 2), oy = Math.floor((size - h) / 2);
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = COLORS[HEAD[Math.floor(y / scale)][Math.floor(x / scale)]];
      if (!c) continue;
      const i = ((oy + y) * size + (ox + x)) * 4;
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const rgba = pixels(size);
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(Buffer.from([0]), rgba.subarray(y * size * 4, (y + 1) * size * 4));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// An .ico file is a small directory followed by the images (PNGs are allowed)
const sizes = [16, 32, 48, 256];
const images = sizes.map(png);
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const at = 6 + i * 16;
  header[at] = size === 256 ? 0 : size;
  header[at + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, at + 4);  // colour planes
  header.writeUInt16LE(32, at + 6); // bits per pixel
  header.writeUInt32LE(images[i].length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += images[i].length;
});

const out = path.join(__dirname, '..', 'ai-room.ico');
fs.writeFileSync(out, Buffer.concat([header, ...images]));
fs.writeFileSync(path.join(__dirname, '..', 'public', 'icon.png'), images[3]);
console.log('Wrote', out);
