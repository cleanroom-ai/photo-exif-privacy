import { crc32 } from "./zip.js";

const dec = new TextDecoder("latin1");
const utf8 = new TextDecoder();
const enc = new TextEncoder();
const XMP_NS = "http://ns.adobe.com/xap/1.0/\0";
const EXTENDED_XMP_NS = "http://ns.adobe.com/xmp/extension/\0";

export function parseMetadata(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return parseJpeg(bytes, options);
  if (isPng(bytes)) return parsePng(bytes, options);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return parseWebp(bytes, options);
  return { format: "unknown", risks: [], safe: [], warnings: ["This file type is not supported for metadata parsing."] };
}

export function isPng(bytes) {
  return bytes.length >= 8 && bytes[0] === 137 && ascii(bytes, 1, 3) === "PNG";
}

function ascii(bytes, start, len) { return dec.decode(bytes.subarray(start, start + len)); }
function text(bytes) { return utf8.decode(bytes); }
function be16(bytes, p) { return (bytes[p] << 8) | bytes[p + 1]; }
function be32(bytes, p) { return ((bytes[p] << 24) | (bytes[p+1] << 16) | (bytes[p+2] << 8) | bytes[p+3]) >>> 0; }
const cleanAscii = (v) => String(v ?? "").replace(/\0+$/g, "").trim();
const addRisk = (out, severity, kind, label, value, detail = "") => out.risks.push({ severity, kind, label, value, detail });
const addSafe = (out, label, value) => out.safe.push({ label, value });

export function parseJpeg(bytes, options = {}) {
  const out = { format: "jpeg", risks: [], safe: [], warnings: [], segments: [], orientation: 1, hasIcc: false };
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) { p++; continue; }
    while (bytes[p] === 0xff) p++;
    const marker = bytes[p++];
    if (marker === 0xd9) break;
    if (marker === 0xda) {
      const len = be16(bytes, p); const scanStart = p + len;
      const eoiEnd = findJpegEoi(bytes, scanStart);
      if (eoiEnd >= 0 && eoiEnd < bytes.length) {
        out.trailingBytes = bytes.length - eoiEnd;
        addRisk(out, "red", "trailing", "Trailing data after JPEG EOI", `${out.trailingBytes} bytes`, "Motion Photo or appended private data can contain hidden photos, GPS or serials.");
      } else if (eoiEnd < 0) {
        out.warnings.push("JPEG scan has no EOI marker.");
      }
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const len = be16(bytes, p); const start = p + 2; const end = start + len - 2;
    if (len < 2 || end > bytes.length) break;
    const seg = bytes.subarray(start, end);
    out.segments.push({ marker, length: len });
    classifyJpegSegment(out, marker, seg);
    p = end;
  }
  return rank(out);
}

function classifyJpegSegment(out, marker, seg) {
    if (marker === 0xe0) {
      const jfif = parseJfif(seg);
      if (jfif) {
        if (jfif.thumbnailBytes) addRisk(out, "red", "thumbnail", "JFIF thumbnail", `${jfif.xThumb}×${jfif.yThumb} thumbnail in APP0`, "APP0 thumbnails can reveal the original uncropped image.");
        else addSafe(out, "JFIF", "APP0 without thumbnail");
      } else addRisk(out, "red", "app", "JPEG APP0 metadata", `${seg.length} bytes`, "Unknown APP segments may contain private metadata.");
    } else if (marker === 0xe1 && ascii(seg, 0, 6) === "Exif\0\0") {
      const t = parseTiff(seg.subarray(6));
      mergeTiff(out, t); out.exif = t;
    } else if (marker === 0xe1 && ascii(seg, 0, XMP_NS.length) === XMP_NS) {
      const xmp = text(seg.subarray(XMP_NS.length)); out.xmp = xmp;
      addRisk(out, "red", "xmp", "XMP edit history", summarizeXml(xmp), "XMP can include edit history, tool names, document IDs and names.");
    } else if (marker === 0xe1 && ascii(seg, 0, EXTENDED_XMP_NS.length) === EXTENDED_XMP_NS) {
      const xmp = text(seg.subarray(EXTENDED_XMP_NS.length)); out.extendedXmp = xmp;
      addRisk(out, "red", "xmp", "Extended XMP metadata", summarizeXml(xmp), "Extended XMP can carry hidden edit history, GPS fields or camera serials.");
    } else if (marker === 0xed) {
      const iptc = parseIptc(seg); out.iptc = iptc;
      if (iptc.length) for (const item of iptc) addRisk(out, "red", "iptc", item.label, item.value, "IPTC caption/byline/copyright metadata can identify you.");
      else addRisk(out, "red", "app", "JPEG APP13 metadata", `${seg.length} bytes`, "Photoshop/IPTC blocks can include private metadata.");
    } else if (marker === 0xe2 && isValidIccProfile(seg)) {
      out.hasIcc = true; addSafe(out, "Color profile", "ICC profile kept");
    } else if (marker === 0xe2 && ascii(seg, 0, 4) === "MPF\0") {
      addRisk(out, "red", "thumbnail", "MPF secondary image", `${seg.length} bytes`, "Multi-Picture metadata can reference or embed secondary images with GPS or serial data.");
    } else if (marker === 0xec) {
      addRisk(out, "red", "app", ascii(seg, 0, 6) === "Ducky\0" ? "APP12/Ducky metadata" : "JPEG APP12 metadata", previewBytes(seg), "Private JPEG APP12 data can reveal camera serials, owners or GPS.");
    } else if (marker === 0xfe) {
      addRisk(out, "red", "comment", "JPEG comment", cleanAscii(ascii(seg, 0, seg.length)), "Comments can reveal names, places or workflow notes.");
    } else if (marker >= 0xe0 && marker <= 0xef) {
      addRisk(out, "red", "app", `JPEG APP${marker - 0xe0} metadata`, previewBytes(seg), "Unknown APP segments may contain hidden photo metadata.");
    } else if (isSof(marker) && seg.length >= 5) {
      out.width = be16(seg, 3); out.height = be16(seg, 1);
    }
}

function previewBytes(seg) {
  const s = cleanAscii(ascii(seg, 0, Math.min(seg.length, 80))).replace(/[^\x20-\x7e]+/g, " ");
  return s || `${seg.length} bytes`;
}

function findJpegEoi(bytes, p) {
  for (let i = p; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 0xff) continue;
    let j = i + 1;
    while (bytes[j] === 0xff) j++;
    const marker = bytes[j];
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) { i = j; continue; }
    if (marker === 0xd9) return j + 1;
    i = j;
  }
  return -1;
}

function parseJfif(seg) {
  if (seg.length < 14 || ascii(seg, 0, 5) !== "JFIF\0") return null;
  const xThumb = seg[12], yThumb = seg[13];
  return { xThumb, yThumb, thumbnailBytes: xThumb * yThumb * 3 };
}

function sanitizedJfif(seg) {
  const jfif = parseJfif(seg);
  if (!jfif) return null;
  if (!jfif.thumbnailBytes) return seg;
  const out = new Uint8Array(seg.subarray(0, 14));
  out[12] = 0; out[13] = 0;
  return out;
}

function isValidIccProfile(seg) {
  return seg.length > 14 && ascii(seg, 0, 12) === "ICC_PROFILE\0" && seg[12] > 0 && seg[13] > 0 && seg[12] <= seg[13];
}

function isSof(marker) {
  return ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf));
}

function isAllowedJpegSegment(marker) {
  return marker === 0xdb || marker === 0xc4 || marker === 0xdd || isSof(marker);
}

function jpegSegment(marker, data) {
  const out = new Uint8Array(4 + data.length);
  out[0] = 0xff; out[1] = marker;
  const len = data.length + 2;
  out[2] = len >> 8; out[3] = len & 255;
  out.set(data, 4);
  return out;
}

function summarizeXml(x) {
  const s = x.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, 160) || "XMP packet present";
}

export function parsePng(bytes, options = {}) {
  const out = { format: "png", risks: [], safe: [], warnings: [], chunks: [] };
  let p = 8;
  while (p + 12 <= bytes.length) {
    const len = be32(bytes, p); const type = ascii(bytes, p + 4, 4); const start = p + 8; const end = start + len;
    if (end + 4 > bytes.length) break;
    const data = bytes.subarray(start, end); out.chunks.push({ type, length: len });
    classifyPngChunk(out, type, data, options);
    if (type === "iCCP") addSafe(out, "Color profile", "PNG iCCP profile");
    if (type === "IEND") {
      const after = end + 4;
      if (after < bytes.length) {
        out.afterIend = bytes.length - after;
        addRisk(out, "red", "trailing", "PNG data after IEND", `${out.afterIend} bytes`, "Bytes after the terminal PNG chunk can hide text, files or tracking data.");
        parsePngTrailingChunks(out, bytes, after, options);
      }
      break;
    }
    p = end + 4;
  }
  return rank(out);
}

function classifyPngChunk(out, type, data, options, prefix = "PNG") {
  if (type === "eXIf") { const t = parseTiff(data); mergeTiff(out, t); out.exif = t; }
  if (type === "tEXt") {
    const nul = data.indexOf(0); if (nul >= 0) addRisk(out, "red", "comment", `${prefix} text: ${ascii(data,0,nul)}`, text(data.subarray(nul+1)), "PNG text chunks can reveal authors and comments.");
  }
  if (type === "iTXt") {
    const nul = data.indexOf(0); const key = nul >= 0 ? ascii(data, 0, nul) : "iTXt";
    let off = nul + 1; const compressed = data[off++] === 1; off++; // method
    const langEnd = data.indexOf(0, off); off = (langEnd < 0 ? off : langEnd + 1);
    const trEnd = data.indexOf(0, off); off = (trEnd < 0 ? off : trEnd + 1);
    addRisk(out, "red", "comment", `${prefix} iTXt: ${key}`, compressed ? "compressed international text" : text(data.subarray(off)), "International text metadata can reveal comments or authors.");
  }
  if (type === "zTXt") {
    const nul = data.indexOf(0); const key = nul >= 0 ? ascii(data, 0, nul) : "zTXt";
    let value = "compressed text present";
    if (options.inflateSync && nul >= 0) value = text(options.inflateSync(data.subarray(nul + 2)));
    addRisk(out, "red", "comment", `${prefix} zTXt: ${key}`, value, "Compressed text metadata can reveal comments or authors.");
  }
}

function parsePngTrailingChunks(out, bytes, p, options) {
  while (p + 12 <= bytes.length) {
    const len = be32(bytes, p); const type = ascii(bytes, p + 4, 4); const start = p + 8; const end = start + len;
    if (!/^[A-Za-z]{4}$/.test(type) || end + 4 > bytes.length) break;
    classifyPngChunk(out, type, bytes.subarray(start, end), options, "PNG trailing");
    p = end + 4;
  }
}

export function parseWebp(bytes) {
  const out = { format: "webp", risks: [], safe: [], warnings: [], chunks: [] };
  const riffEnd = Math.min(bytes.length, 8 + be32le(bytes, 4));
  for (let p = 12; p + 8 <= riffEnd;) {
    const type = ascii(bytes, p, 4); const len = be32le(bytes, p + 4); const start = p + 8; const end = start + len;
    if (end > riffEnd) break;
    const data = bytes.subarray(start, end); out.chunks.push({ type, length: len });
    if (type === "EXIF") { const t = parseTiff(data); mergeTiff(out, t); out.exif = t; }
    if (type === "XMP ") addRisk(out, "red", "xmp", "WebP XMP metadata", summarizeXml(text(data)), "XMP can include edit history and identifying names.");
    if (type === "ICCP") addSafe(out, "Color profile", "WebP ICC profile");
    p = end + (len & 1);
  }
  if (riffEnd < bytes.length) addRisk(out, "red", "trailing", "WebP data after RIFF", `${bytes.length - riffEnd} bytes`, "Bytes after the WebP container can hide appended private data.");
  return rank(out);
}

function rank(out) {
  const order = { gps: 0, serial: 1, owner: 2, thumbnail: 3, trailing: 4, app: 5, datetime: 6, device: 7, software: 8, xmp: 9, comment: 10, iptc: 11 };
  out.risks.sort((a, b) => (order[a.kind] ?? 50) - (order[b.kind] ?? 50));
  if (out.orientation) addSafe(out, "Orientation", String(out.orientation));
  return out;
}

function mergeTiff(out, t) {
  out.orientation = t.orientation || out.orientation || 1;
  if (t.orientation) addSafe(out, "Orientation", String(t.orientation));
  if (t.gpsDecimal) addRisk(out, "red", "gps", "GPS location", `${t.gpsDecimal.lat.toFixed(6)}, ${t.gpsDecimal.lon.toFixed(6)}`, "≈ city-level precision. No map or geocoding service is called.");
  if (t.make || t.model || t.lensModel) addRisk(out, "red", "device", "Camera/device", [t.make, t.model, t.lensModel].filter(Boolean).join(" · "), "Device metadata can identify the camera or phone used.");
  if (t.bodySerial || t.lensSerial) addRisk(out, "red", "serial", "Camera/lens serial number", [t.bodySerial, t.lensSerial].filter(Boolean).join(" · "), "Serial numbers can uniquely identify equipment.");
  if (t.artist || t.copyright) addRisk(out, "red", "owner", "Owner/artist/copyright", [t.artist, t.copyright].filter(Boolean).join(" · "), "Names embedded by camera or editing software.");
  if (t.software) addRisk(out, "red", "software", "Software", t.software, "Editing software metadata can reveal workflow.");
  if (t.dateTimeOriginal) addRisk(out, "red", "datetime", "Date/time taken", `${t.dateTimeOriginal}${t.offsetTimeOriginal ? " " + t.offsetTimeOriginal : ""}`, "Capture time can reveal routines or travel.");
  if (t.makerNote) addRisk(out, "red", "makernote", "MakerNote present", `${t.makerNote} bytes`, "Maker-specific metadata may include hidden camera details.");
  if (t.thumbnail?.length) { out.thumbnail = t.thumbnail; addRisk(out, "red", "thumbnail", "Embedded thumbnail", `${t.thumbnail.length} bytes`, "Can reveal the original un-cropped image."); }
}

function be32le(bytes, p) { return (bytes[p] | (bytes[p+1] << 8) | (bytes[p+2] << 16) | (bytes[p+3] << 24)) >>> 0; }

export function parseTiff(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endian = ascii(bytes, 0, 2);
  const le = endian === "II";
  if (!(le || endian === "MM")) return {};
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  if (u16(2) !== 42) return {};
  const tags = {};
  const readIFD = (off, depth = 0) => {
    if (!off || off + 2 > bytes.length || depth > 4) return { entries: {}, next: 0 };
    const n = u16(off); const entries = {};
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12; if (e + 12 > bytes.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = typeSize(type) * count; const valueOff = size <= 4 ? e + 8 : u32(e + 8);
      entries[tag] = readValue(type, count, valueOff, size);
    }
    const nextPos = off + 2 + n * 12;
    return { entries, next: nextPos + 4 <= bytes.length ? u32(nextPos) : 0 };
  };
  const readValue = (type, count, off, size) => {
    if (off < 0 || off + size > bytes.length) return null;
    if (type === 2) return cleanAscii(ascii(bytes, off, count));
    if (type === 7 || type === 1) return bytes.subarray(off, off + count);
    const vals = [];
    for (let i = 0; i < count; i++) {
      const p = off + i * typeSize(type);
      if (type === 3) vals.push(u16(p)); else if (type === 4) vals.push(u32(p));
      else if (type === 5) vals.push({ num: u32(p), den: u32(p + 4) || 1 });
      else if (type === 9) vals.push(dv.getInt32(p, le));
      else if (type === 10) vals.push({ num: dv.getInt32(p, le), den: dv.getInt32(p + 4, le) || 1 });
    }
    return count === 1 ? vals[0] : vals;
  };
  const ifd0 = readIFD(u32(4)); tags.ifd0 = ifd0.entries;
  if (ifd0.entries[0x8769]) tags.exif = readIFD(ifd0.entries[0x8769], 1).entries;
  if (ifd0.entries[0x8825]) tags.gps = readIFD(ifd0.entries[0x8825], 1).entries;
  if (ifd0.next) tags.ifd1 = readIFD(ifd0.next, 1).entries;
  const t = { tags, orientation: ifd0.entries[0x0112], make: ifd0.entries[0x010f], model: ifd0.entries[0x0110],
    software: ifd0.entries[0x0131], artist: ifd0.entries[0x013b], copyright: ifd0.entries[0x8298] };
  const ex = tags.exif || {}; Object.assign(t, { dateTimeOriginal: ex[0x9003], offsetTimeOriginal: ex[0x9011], bodySerial: ex[0xa431],
    lensSerial: ex[0xa435], lensModel: ex[0xa434], makerNote: ex[0x927c]?.length });
  const gps = tags.gps || {};
  if (gps[1] && gps[2] && gps[3] && gps[4]) t.gpsDecimal = { lat: gpsCoord(gps[2], gps[1]), lon: gpsCoord(gps[4], gps[3]) };
  const ifd1 = tags.ifd1 || {}; const thOff = ifd1[0x0201], thLen = ifd1[0x0202];
  if (thOff && thLen && thOff + thLen <= bytes.length) t.thumbnail = bytes.subarray(thOff, thOff + thLen);
  return t;
}
function typeSize(t) { return ({ 1:1, 2:1, 3:2, 4:4, 5:8, 7:1, 9:4, 10:8 })[t] || 1; }
function gpsCoord(v, ref) {
  const arr = Array.isArray(v) ? v : [v];
  const n = (r) => typeof r === "number" ? r : r.num / (r.den || 1);
  let d = n(arr[0]) + n(arr[1]) / 60 + n(arr[2]) / 3600;
  if (/^[SW]$/i.test(ref)) d *= -1;
  return d;
}

function parseIptc(seg) {
  const out = [];
  let p = 0;
  while (p + 14 < seg.length) {
    const idx = findBytes(seg, [0x1c, 2], p);
    if (idx < 0 || idx + 5 > seg.length) break;
    const dataset = seg[idx + 2], len = be16(seg, idx + 3), start = idx + 5;
    const val = cleanAscii(ascii(seg, start, Math.min(len, seg.length - start)));
    const labels = { 80: "IPTC byline", 116: "IPTC copyright", 120: "IPTC caption", 25: "IPTC keyword" };
    if (val && labels[dataset]) out.push({ label: labels[dataset], value: val });
    p = start + len;
  }
  return out;
}
function findBytes(buf, seq, from = 0) {
  outer: for (let i = from; i <= buf.length - seq.length; i++) { for (let j = 0; j < seq.length; j++) if (buf[i+j] !== seq[j]) continue outer; return i; }
  return -1;
}

export function stripJpegMetadata(input, { keepIcc = true } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("not a JPEG");
  const chunks = [bytes.subarray(0, 2)]; let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) { p++; continue; }
    let mpos = p; while (bytes[mpos] === 0xff) mpos++;
    const marker = bytes[mpos];
    if (marker === 0xda) {
      const lenPos = mpos + 1; const len = be16(bytes, lenPos); const scanStart = lenPos + len;
      if (len < 2 || scanStart > bytes.length) break;
      const eoiEnd = findJpegEoi(bytes, scanStart);
      chunks.push(bytes.subarray(p, eoiEnd >= 0 ? eoiEnd : bytes.length));
      break;
    }
    if (marker === 0xd9) { chunks.push(bytes.subarray(p, mpos + 1)); break; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { chunks.push(bytes.subarray(p, mpos + 1)); p = mpos + 1; continue; }
    const lenPos = mpos + 1; const len = be16(bytes, lenPos); const end = lenPos + len;
    if (len < 2 || end > bytes.length) break;
    const seg = bytes.subarray(lenPos + 2, end);
    if (marker === 0xe0) {
      const jfif = sanitizedJfif(seg);
      if (jfif) chunks.push(jpegSegment(marker, jfif));
    } else if (marker === 0xe2 && keepIcc && isValidIccProfile(seg)) {
      chunks.push(bytes.subarray(p, end));
    } else if (isAllowedJpegSegment(marker)) {
      chunks.push(bytes.subarray(p, end));
    }
    p = end;
  }
  const total = chunks.reduce((n, c) => n + c.length, 0); const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function makePngChunk(type, data) {
  const name = enc.encode(type); const out = new Uint8Array(12 + data.length);
  out[0] = (data.length >>> 24) & 255; out[1] = (data.length >>> 16) & 255; out[2] = (data.length >>> 8) & 255; out[3] = data.length & 255;
  out.set(name, 4); out.set(data, 8); const crc = crc32(out.subarray(4, 8 + data.length));
  out[8 + data.length] = (crc >>> 24) & 255; out[9 + data.length] = (crc >>> 16) & 255; out[10 + data.length] = (crc >>> 8) & 255; out[11 + data.length] = crc & 255;
  return out;
}
export function injectPngChunks(png, chunks) {
  const bytes = png instanceof Uint8Array ? png : new Uint8Array(png);
  if (!isPng(bytes)) throw new Error("not a PNG");
  const ihdrEnd = 8 + 12 + be32(bytes, 8);
  return concat([bytes.subarray(0, ihdrEnd), ...chunks, bytes.subarray(ihdrEnd)]);
}

export function createExifTiff(meta = {}, { littleEndian = true } = {}) {
  const le = littleEndian;
  const put16 = (b, o, v) => le ? new DataView(b.buffer).setUint16(o, v, true) : new DataView(b.buffer).setUint16(o, v, false);
  const put32 = (b, o, v) => le ? new DataView(b.buffer).setUint32(o, v >>> 0, true) : new DataView(b.buffer).setUint32(o, v >>> 0, false);
  const val = (type, count, data) => ({ type, count, data });
  const asciiVal = (s) => val(2, enc.encode(String(s) + "\0").length, enc.encode(String(s) + "\0"));
  const shortVal = (n) => { const b = new Uint8Array(2); put16(b, 0, n); return val(3, 1, b); };
  const longVal = (n) => { const b = new Uint8Array(4); put32(b, 0, n); return val(4, 1, b); };
  const rat = (nums) => { const b = new Uint8Array(nums.length * 8); nums.forEach(([n,d], i) => { put32(b, i*8, n); put32(b, i*8+4, d); }); return val(5, nums.length, b); };
  const bytesVal = (arr) => val(7, arr.length, arr instanceof Uint8Array ? arr : new Uint8Array(arr));
  const degRat = (x) => { x = Math.abs(x); const d = Math.floor(x), mfloat = (x-d)*60, m = Math.floor(mfloat), s = Math.round((mfloat-m)*600000); return [[d,1],[m,1],[s,10000]]; };
  const ifdLen = (entries) => 2 + entries.length * 12 + 4 + entries.reduce((n, e) => n + (e.v.data.length > 4 ? even(e.v.data.length) : 0), 0);
  const ifd0 = [];
  if (meta.make) ifd0.push({ tag:0x010f, v:asciiVal(meta.make) });
  if (meta.model) ifd0.push({ tag:0x0110, v:asciiVal(meta.model) });
  ifd0.push({ tag:0x0112, v:shortVal(meta.orientation || 1) });
  if (meta.software) ifd0.push({ tag:0x0131, v:asciiVal(meta.software) });
  if (meta.artist) ifd0.push({ tag:0x013b, v:asciiVal(meta.artist) });
  if (meta.copyright) ifd0.push({ tag:0x8298, v:asciiVal(meta.copyright) });
  const exif = [];
  if (meta.dateTimeOriginal) exif.push({ tag:0x9003, v:asciiVal(meta.dateTimeOriginal) });
  if (meta.offsetTimeOriginal) exif.push({ tag:0x9011, v:asciiVal(meta.offsetTimeOriginal) });
  if (meta.bodySerial) exif.push({ tag:0xa431, v:asciiVal(meta.bodySerial) });
  if (meta.lensModel) exif.push({ tag:0xa434, v:asciiVal(meta.lensModel) });
  if (meta.lensSerial) exif.push({ tag:0xa435, v:asciiVal(meta.lensSerial) });
  if (meta.makerNote) exif.push({ tag:0x927c, v:bytesVal(enc.encode(meta.makerNote)) });
  const gps = [];
  if (meta.gps) { gps.push({ tag:1, v:asciiVal(meta.gps.lat < 0 ? "S" : "N") }, { tag:2, v:rat(degRat(meta.gps.lat)) }, { tag:3, v:asciiVal(meta.gps.lon < 0 ? "W" : "E") }, { tag:4, v:rat(degRat(meta.gps.lon)) }); }
  let cursor = 8; let exifOffset = 0, gpsOffset = 0, ifd1Offset = 0, thumbOffset = 0;
  const ifd0Pre = [...ifd0]; if (exif.length) ifd0Pre.push({ tag:0x8769, v:longVal(0) }); if (gps.length) ifd0Pre.push({ tag:0x8825, v:longVal(0) });
  exifOffset = cursor + ifdLen(ifd0Pre); gpsOffset = exifOffset + (exif.length ? ifdLen(exif) : 0);
  if (exif.length) ifd0.push({ tag:0x8769, v:longVal(exifOffset) });
  if (gps.length) ifd0.push({ tag:0x8825, v:longVal(gpsOffset) });
  ifd1Offset = gpsOffset + (gps.length ? ifdLen(gps) : 0);
  const ifd1 = [];
  if (meta.thumbnail?.length) { thumbOffset = ifd1Offset + ifdLen([{ tag:0x0201, v:longVal(0) }, { tag:0x0202, v:longVal(meta.thumbnail.length) }]); ifd1.push({ tag:0x0201, v:longVal(thumbOffset) }, { tag:0x0202, v:longVal(meta.thumbnail.length) }); }
  const total = (meta.thumbnail?.length ? thumbOffset + meta.thumbnail.length : ifd1Offset);
  const out = new Uint8Array(total); out[0] = le ? 0x49 : 0x4d; out[1] = out[0]; put16(out, 2, 42); put32(out, 4, 8);
  cursor = writeIfd(out, 8, ifd0, meta.thumbnail?.length ? ifd1Offset : 0, le);
  if (exif.length) cursor = writeIfd(out, exifOffset, exif, 0, le);
  if (gps.length) cursor = writeIfd(out, gpsOffset, gps, 0, le);
  if (ifd1.length) { writeIfd(out, ifd1Offset, ifd1, 0, le); out.set(meta.thumbnail, thumbOffset); }
  return out;
}
function writeIfd(out, off, entries, next, le) {
  const dv = new DataView(out.buffer); const put16 = (o,v)=>dv.setUint16(o,v,le), put32=(o,v)=>dv.setUint32(o,v>>>0,le);
  entries = [...entries].sort((a,b)=>a.tag-b.tag); put16(off, entries.length); let extra = off + 2 + entries.length * 12 + 4;
  entries.forEach((e, i) => { const p = off + 2 + i*12; put16(p, e.tag); put16(p+2, e.v.type); put32(p+4, e.v.count);
    if (e.v.data.length <= 4) out.set(e.v.data, p+8); else { put32(p+8, extra); out.set(e.v.data, extra); extra += even(e.v.data.length); } });
  put32(off + 2 + entries.length * 12, next); return extra;
}
const even = (n) => n + (n & 1);
export function exifApp1(tiff) { return concat([enc.encode("Exif\0\0"), tiff]); }
export function xmpApp1(xml) { return concat([enc.encode("http://ns.adobe.com/xap/1.0/\0"), enc.encode(xml)]); }
export function injectJpegSegments(jpeg, segments) {
  const bytes = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("not a JPEG");
  const chunks = [bytes.subarray(0,2)];
  for (const s of segments) { const seg = new Uint8Array(4 + s.data.length); seg[0]=0xff; seg[1]=s.marker; const len=s.data.length+2; seg[2]=len>>8; seg[3]=len&255; seg.set(s.data,4); chunks.push(seg); }
  chunks.push(bytes.subarray(2)); return concat(chunks);
}
export function concat(chunks) { const total = chunks.reduce((n,c)=>n+c.length,0); const out = new Uint8Array(total); let p=0; for (const c of chunks) { out.set(c,p); p += c.length; } return out; }
