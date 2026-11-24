const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// 4x 超采样画圆点，再盒式降采样做抗锯齿
function makeDot(rgb, size = 96) {
  const SS = 4;
  const W = size * SS;
  const hi = new Float32Array(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x / (W - 1)) * 2 - 1;
      const dy = (y / (W - 1)) * 2 - 1;
      const r = Math.hypot(dx, dy);
      let a = 0;
      let col = rgb;
      if (r <= 0.46) a = 0.22;
      if (r <= 0.34) a = 1;
      if (r <= 0.14) col = [255, 255, 255];
      if (r > 0.46) a = 0;
      const i = (y * W + x) * 4;
      hi[i] = col[0];
      hi[i + 1] = col[1];
      hi[i + 2] = col[2];
      hi[i + 3] = a * 255;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          r += hi[i]; g += hi[i + 1]; b += hi[i + 2]; a += hi[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, out);
}

const dir = path.join(__dirname, '..', 'miniprogram', 'images');
fs.mkdirSync(dir, { recursive: true });

const targets = [
  ['mk-pending.png', [226, 75, 74]],
  ['mk-processing.png', [239, 159, 39]],
  ['mk-resolved.png', [76, 154, 106]],
  ['mk-review.png', [138, 143, 152]]
];

targets.forEach(([name, rgb]) => {
  fs.writeFileSync(path.join(dir, name), makeDot(rgb));
  console.log('written', name);
});
