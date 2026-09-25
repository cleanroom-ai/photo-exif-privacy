const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const u16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; };
const u32 = (b, o, v) => { u16(b, o, v); u16(b, o + 2, v >>> 16); };
const dosTime = (date = new Date()) => {
  const y = Math.max(1980, date.getFullYear());
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
};

export function writeStoreZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const stamp = dosTime();
  for (const f of files) {
    const name = enc.encode(f.name.replaceAll("\\", "/"));
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    u32(local, 0, 0x04034b50); u16(local, 4, 20); u16(local, 6, 0); u16(local, 8, 0);
    u16(local, 10, stamp.time); u16(local, 12, stamp.date); u32(local, 14, crc);
    u32(local, 18, data.length); u32(local, 22, data.length); u16(local, 26, name.length); u16(local, 28, 0);
    local.set(name, 30); chunks.push(local, data);
    const cd = new Uint8Array(46 + name.length);
    u32(cd, 0, 0x02014b50); u16(cd, 4, 20); u16(cd, 6, 20); u16(cd, 8, 0); u16(cd, 10, 0);
    u16(cd, 12, stamp.time); u16(cd, 14, stamp.date); u32(cd, 16, crc);
    u32(cd, 20, data.length); u32(cd, 24, data.length); u16(cd, 28, name.length); u16(cd, 30, 0); u16(cd, 32, 0);
    u16(cd, 34, 0); u16(cd, 36, 0); u32(cd, 38, 0); u32(cd, 42, offset); cd.set(name, 46);
    central.push(cd); offset += local.length + data.length;
  }
  const centralOffset = offset;
  for (const cd of central) { chunks.push(cd); offset += cd.length; }
  const end = new Uint8Array(22);
  u32(end, 0, 0x06054b50); u16(end, 8, files.length); u16(end, 10, files.length);
  u32(end, 12, offset - centralOffset); u32(end, 16, centralOffset); u16(end, 20, 0); chunks.push(end);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total); let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

export function readStoreZip(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dec = new TextDecoder();
  const files = [];
  for (let p = 0; p + 30 <= bytes.length;) {
    const sig = bytes[p] | (bytes[p+1] << 8) | (bytes[p+2] << 16) | (bytes[p+3] << 24);
    if (sig !== 0x04034b50) break;
    const method = bytes[p+8] | (bytes[p+9] << 8);
    if (method !== 0) throw new Error("only STORE zip entries are supported");
    const crc = (bytes[p+14] | (bytes[p+15]<<8) | (bytes[p+16]<<16) | (bytes[p+17]<<24)) >>> 0;
    const size = bytes[p+18] | (bytes[p+19]<<8) | (bytes[p+20]<<16) | (bytes[p+21]<<24);
    const nlen = bytes[p+26] | (bytes[p+27] << 8), xlen = bytes[p+28] | (bytes[p+29] << 8);
    const name = dec.decode(bytes.subarray(p + 30, p + 30 + nlen));
    const start = p + 30 + nlen + xlen;
    const data = bytes.subarray(start, start + size);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    files.push({ name, data }); p = start + size;
  }
  return files;
}
