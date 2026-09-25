import assert from "node:assert/strict";
import { inflateSync, deflateSync } from "node:zlib";
import { test } from "node:test";
import { createExifTiff, exifApp1, injectJpegSegments, injectPngChunks, makePngChunk, parseMetadata, stripJpegMetadata, xmpApp1 } from "../js/metadata.js";

const enc = new TextEncoder();
const minimalJpeg = new Uint8Array([0xff,0xd8,0xff,0xe0,0,4,0x4a,0x46,0xff,0xda,0,8,1,2,3,4,5,6,0x11,0x22,0x33,0xff,0xd9]);
const iptc = new Uint8Array([0x50,0x68,0x6f,0x74,0x6f,0x73,0x68,0x6f,0x70,0x20,0x33,0x2e,0x30,0,0x1c,2,80,0,8,...enc.encode("Jane Doe")]);

test("JPEG EXIF parser handles little and big endian GPS, serials and thumbnails", () => {
  for (const littleEndian of [true, false]) {
    const thumb = new Uint8Array([0xff,0xd8,1,2,3,0xff,0xd9]);
    const tiff = createExifTiff({ gps:{ lat:47.6205, lon:-122.3493 }, make:"FauxCam", model:"ShareSafe", bodySerial:"BODY123", lensSerial:"LENS456", artist:"Jane Doe", software:"Editor", dateTimeOriginal:"2026:09:25 15:00:00", offsetTimeOriginal:"-07:00", makerNote:"maker", thumbnail:thumb }, { littleEndian });
    const jpg = injectJpegSegments(minimalJpeg, [{ marker:0xe1, data:exifApp1(tiff) }]);
    const m = parseMetadata(jpg);
    assert.equal(m.exif.make, "FauxCam");
    assert.equal(m.exif.bodySerial, "BODY123");
    assert.ok(Math.abs(m.exif.gpsDecimal.lat - 47.6205) < 1e-5);
    assert.ok(Math.abs(m.exif.gpsDecimal.lon + 122.3493) < 1e-5);
    assert.deepEqual([...m.thumbnail], [...thumb]);
    assert.ok(m.risks.some(r => r.kind === "gps"));
    assert.ok(m.risks.some(r => r.kind === "thumbnail"));
  }
});

test("JPEG XMP, IPTC, ICC and comments are classified", () => {
  const jpg = injectJpegSegments(minimalJpeg, [
    { marker:0xe2, data:enc.encode("ICC_PROFILE\0\x01\x01fake") },
    { marker:0xe1, data:xmpApp1("<xmp>History by Jane Doe</xmp>") },
    { marker:0xed, data:iptc },
    { marker:0xfe, data:enc.encode("private comment") }
  ]);
  const m = parseMetadata(jpg);
  assert.ok(m.safe.some(s => s.label === "Color profile"));
  assert.ok(m.risks.some(r => r.kind === "xmp"));
  assert.ok(m.risks.some(r => r.label === "IPTC byline"));
  assert.ok(m.risks.some(r => r.kind === "comment"));
});

test("lossless JPEG metadata strip removes APP1/APP13/COM but preserves scan bytes", () => {
  const exif = exifApp1(createExifTiff({ make:"A", gps:{ lat:1, lon:2 } }));
  const jpg = injectJpegSegments(minimalJpeg, [{ marker:0xe1, data:exif }, { marker:0xed, data:iptc }, { marker:0xfe, data:enc.encode("c") }]);
  const stripped = stripJpegMetadata(jpg);
  assert.equal(stripped[0], 0xff); assert.equal(stripped[1], 0xd8); assert.equal(stripped.at(-2), 0xff); assert.equal(stripped.at(-1), 0xd9);
  assert.equal(stripped.includes(0xe1), false);
  const scanIn = jpg.subarray(jpg.indexOf(0xda));
  const scanOut = stripped.subarray(stripped.indexOf(0xda));
  assert.deepEqual([...scanOut], [...scanIn]);
  assert.equal(parseMetadata(stripped).risks.some(r => ["gps","device","thumbnail"].includes(r.kind)), false);
});

test("PNG tEXt, iTXt, zTXt and eXIf chunks are parsed", () => {
  const sig = new Uint8Array([137,80,78,71,13,10,26,10]);
  const ihdr = makePngChunk("IHDR", new Uint8Array([0,0,0,1,0,0,0,1,8,6,0,0,0]));
  const iend = makePngChunk("IEND", new Uint8Array());
  const base = new Uint8Array([...sig, ...ihdr, ...iend]);
  const png = injectPngChunks(base, [
    makePngChunk("tEXt", enc.encode("Author\0Jane Doe")),
    makePngChunk("iTXt", enc.encode("Comment\0\0\0en\0Comment\0hello")),
    makePngChunk("zTXt", new Uint8Array([...enc.encode("Compressed\0\0"), ...deflateSync(Buffer.from("secret note"))])),
    makePngChunk("eXIf", createExifTiff({ gps:{ lat:3, lon:4 }, make:"PNGCam" }))
  ]);
  const m = parseMetadata(png, { inflateSync });
  assert.equal(m.format, "png");
  assert.ok(m.risks.some(r => r.label === "PNG text: Author"));
  assert.ok(m.risks.some(r => r.value === "secret note"));
  assert.ok(m.risks.some(r => r.kind === "gps"));
});

test("WebP EXIF and XMP chunks are parsed", () => {
  const exif = createExifTiff({ gps:{ lat:5, lon:-6 }, make:"WebPCam" });
  const xmp = enc.encode("<xmp>edit history</xmp>");
  const chunk = (name, data) => { const b = new Uint8Array(8 + data.length + (data.length & 1)); b.set(enc.encode(name),0); new DataView(b.buffer).setUint32(4, data.length, true); b.set(data,8); return b; };
  const body = new Uint8Array([...enc.encode("WEBP"), ...chunk("VP8X", new Uint8Array(10)), ...chunk("EXIF", exif), ...chunk("XMP ", xmp)]);
  const riff = new Uint8Array(8 + body.length); riff.set(enc.encode("RIFF"),0); new DataView(riff.buffer).setUint32(4, body.length, true); riff.set(body,8);
  const m = parseMetadata(riff);
  assert.equal(m.format, "webp");
  assert.ok(m.risks.some(r => r.kind === "gps"));
  assert.ok(m.risks.some(r => r.kind === "xmp"));
});
