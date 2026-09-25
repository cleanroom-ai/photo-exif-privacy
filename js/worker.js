import * as ort from "../vendor/ort/ort.wasm.min.mjs";
import { OCR } from "../vendor/core/ocr.js";
import { FaceDetector } from "../vendor/core/faces.js";
import { configureOrt } from "../vendor/core/engines.js";
import { detectionsFromOcrLines } from "./heuristics.js";

configureOrt(ort, new URL("../vendor/ort/", import.meta.url).href);
const BASE = new URL("../", import.meta.url);
const post = (m) => self.postMessage(m);
async function fetchBytes(path, label) {
  const res = await fetch(new URL(path, BASE));
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader(); const chunks = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; post({ type:"download", label, loaded:got, total }); }
  const out = new Uint8Array(got); let p = 0; for (const c of chunks) { out.set(c,p); p += c.length; } return out;
}
const loadBytes = (f) => fetchBytes(`models/${f}`, f);
const loadJson = async (f) => JSON.parse(new TextDecoder().decode(await fetchBytes(`models/${f}`, f)));
let engine;
async function loadEngine() {
  engine ??= Promise.all([OCR.create(ort, loadBytes, loadJson), FaceDetector.create(ort, loadBytes)]).then(([ocr, faces]) => ({ ocr, faces }));
  return engine;
}
self.onmessage = async ({ data:m }) => {
  try {
    if (m.type === "warmup") { await loadEngine(); post({ type:"ready" }); return; }
    if (m.type === "scan") {
      const { ocr, faces } = await loadEngine();
      post({ type:"progress", text:"Reading visible text…" });
      const t0 = performance.now();
      const [lines, faceBoxes] = await Promise.all([m.options.ocr ? ocr.run(m.image) : [], m.options.faces ? faces.detect(m.image) : []]);
      let id = 1;
      const textDetections = detectionsFromOcrLines(lines, id); id += textDetections.length;
      const faceDetections = faceBoxes.map((f) => ({ id:id++, category:"faces", label:"FACE", box:{x0:f.x0,y0:f.y0,x1:f.x1,y1:f.y1}, score:f.score, source:"yunet", text:"" }));
      post({ type:"result", id:m.id, detections:[...textDetections, ...faceDetections], lines: lines.map(({ text, score, box }) => ({ text, score, box })), timings:{ scan: performance.now() - t0 } });
    }
  } catch (e) { post({ type:"error", id:m.id, text:e?.message || String(e) }); }
};
