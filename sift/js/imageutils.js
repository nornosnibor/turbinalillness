// Everything here runs locally in the browser: reading EXIF, making
// thumbnails, preparing the copy that gets sent to Jev, duplicate hashes,
// and color palettes.

// ---------- EXIF (JPEG only) ----------

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

export function readExif(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return {};
  let offset = 2;
  while (offset + 4 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    const size = view.getUint16(offset + 2);
    if (marker === 0xe1 && view.getUint32(offset + 4) === 0x45786966) {
      try { return parseTiff(view, offset + 10); } catch { return {}; }
    }
    if (marker === 0xda) break; // start of image data, no EXIF found
    offset += 2 + size;
  }
  return {};
}

function parseTiff(view, start) {
  const little = view.getUint16(start) === 0x4949;
  const u16 = (o) => view.getUint16(start + o, little);
  const u32 = (o) => view.getUint32(start + o, little);
  const i32 = (o) => view.getInt32(start + o, little);

  const readValue = (entry) => {
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    const bytes = (TYPE_SIZE[type] || 1) * count;
    const at = bytes <= 4 ? entry + 8 : u32(entry + 8);
    if (start + at + bytes > view.byteLength) return undefined;
    const one = (i) => {
      switch (type) {
        case 1: case 7: return view.getUint8(start + at + i);
        case 3: return u16(at + i * 2);
        case 4: return u32(at + i * 4);
        case 9: return i32(at + i * 4);
        case 5: { const d = u32(at + i * 8 + 4); return d ? u32(at + i * 8) / d : 0; }
        case 10: { const d = i32(at + i * 8 + 4); return d ? i32(at + i * 8) / d : 0; }
        default: return undefined;
      }
    };
    if (type === 2) {
      let s = '';
      for (let i = 0; i < count; i++) {
        const c = view.getUint8(start + at + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    }
    if (count === 1) return one(0);
    return Array.from({ length: Math.min(count, 16) }, (_, i) => one(i));
  };

  const readIfd = (ifdOffset) => {
    const tags = {};
    if (!ifdOffset || start + ifdOffset + 2 > view.byteLength) return tags;
    const n = u16(ifdOffset);
    for (let i = 0; i < n; i++) {
      const entry = ifdOffset + 2 + i * 12;
      if (start + entry + 12 > view.byteLength) break;
      tags[u16(entry)] = readValue(entry);
    }
    return tags;
  };

  const ifd0 = readIfd(u32(4));
  const exif = readIfd(ifd0[0x8769]);
  const gps = readIfd(ifd0[0x8825]);

  const out = {};
  if (ifd0[0x010f]) out.make = ifd0[0x010f];
  if (ifd0[0x0110]) out.model = ifd0[0x0110];
  if (exif[0xa434]) out.lens = exif[0xa434];
  if (exif[0x8827]) out.iso = Array.isArray(exif[0x8827]) ? exif[0x8827][0] : exif[0x8827];
  if (exif[0x829d]) out.fNumber = exif[0x829d];
  if (exif[0x829a]) out.exposure = exif[0x829a];
  if (exif[0x920a]) out.focal = exif[0x920a];
  const dateStr = exif[0x9003] || exif[0x9004] || ifd0[0x0132];
  const date = parseExifDate(dateStr);
  if (date) out.taken = date.getTime();

  if (Array.isArray(gps[2]) && Array.isArray(gps[4])) {
    const toDeg = ([d, m, s]) => d + m / 60 + s / 3600;
    let lat = toDeg(gps[2]);
    let lon = toDeg(gps[4]);
    if (gps[1] === 'S') lat = -lat;
    if (gps[3] === 'W') lon = -lon;
    if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) out.gps = { lat, lon };
  }
  // Clean up camera names like "Apple iPhone 15 Pro" vs make "Apple".
  if (out.make && out.model && out.model.toLowerCase().startsWith(out.make.toLowerCase())) {
    out.model = out.model.slice(out.make.length).trim();
  }
  return out;
}

function parseExifDate(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(d.getTime()) || +m[1] < 1971 ? null : d;
}

// ---------- Decoding & resizing ----------

// Returns an upright bitmap (browsers apply EXIF rotation when decoding).
export async function decode(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Fallback for browsers without createImageBitmap options.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toBlob(c, type = 'image/jpeg', quality = 0.85) {
  if (c.convertToBlob) return c.convertToBlob({ type, quality });
  return new Promise((resolve) => c.toBlob(resolve, type, quality));
}

const dims = (src) => ({ w: src.width || src.naturalWidth, h: src.height || src.naturalHeight });

export async function makeThumb(src, maxSide = 520) {
  const { w, h } = dims(src);
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = canvas(Math.round(w * scale), Math.round(h * scale));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return toBlob(c, 'image/jpeg', 0.82);
}

// Jev accepts 280–1568 px per side. We send a smaller copy than the original
// to save tokens (and your usage), padding tiny or very thin images.
const JEV_MIN = 280;
const JEV_MAX = 1568;

export async function makeJevCopy(src, maxSide = 768) {
  const { w, h } = dims(src);
  const target = Math.min(Math.max(maxSide, JEV_MIN), JEV_MAX);
  let scale = target / Math.max(w, h);
  if (Math.min(w, h) * scale < JEV_MIN) {
    scale = Math.min(JEV_MIN / Math.min(w, h), JEV_MAX / Math.max(w, h));
  }
  const dw = Math.round(w * scale);
  const dh = Math.round(h * scale);
  const cw = Math.max(dw, JEV_MIN);
  const ch = Math.max(dh, JEV_MIN);
  const c = canvas(cw, ch);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, Math.round((cw - dw) / 2), Math.round((ch - dh) / 2), dw, dh);
  const blob = await toBlob(c, 'image/jpeg', 0.85);
  return { base64: await blobToBase64(blob), width: cw, height: ch };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ---------- Duplicate detection (difference hash) ----------

export function dHash(src) {
  const c = canvas(9, 8);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, 9, 8);
  const px = ctx.getImageData(0, 0, 9, 8).data;
  const gray = (i) => px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
  let hex = '';
  let nibble = 0;
  let bit = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      nibble = (nibble << 1) | (gray(y * 9 + x) > gray(y * 9 + x + 1) ? 1 : 0);
      if (++bit % 4 === 0) { hex += nibble.toString(16); nibble = 0; }
    }
  }
  return hex;
}

const POP = Array.from({ length: 16 }, (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}

// ---------- Colors ----------

export function palette(src) {
  const size = 32;
  const c = canvas(size, size);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const buckets = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
    const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += px[i]; b.g += px[i + 1]; b.b += px[i + 2];
    buckets.set(key, b);
  }
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  const picks = [];
  for (const s of sorted) {
    const rgb = [s.r / s.n, s.g / s.n, s.b / s.n].map(Math.round);
    if (picks.every((p) => colorDist(p.rgb, rgb) > 60)) picks.push({ rgb, n: s.n });
    if (picks.length === 5) break;
  }
  const total = size * size;
  return picks.map((p) => ({ hex: rgbToHex(p.rgb), share: p.n / total, name: colorName(p.rgb) }));
}

const colorDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const rgbToHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

export const COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'black', 'gray', 'white'];

export function colorName([r, g, b]) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  if (l < 0.13) return 'black';
  if (l > 0.9 && s < 0.4) return 'white';
  if (s < 0.16) return l > 0.7 ? 'white' : 'gray';
  let h;
  const R = r / 255, G = g / 255, B = b / 255, d = max - min;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  if ((h < 45 && l < 0.45 && s < 0.7) || (h >= 15 && h < 45 && l < 0.55)) return 'brown';
  if (h < 15 || h >= 340) return 'red';
  if (h < 45) return 'orange';
  if (h < 68) return 'yellow';
  if (h < 160) return 'green';
  if (h < 195) return 'teal';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}
