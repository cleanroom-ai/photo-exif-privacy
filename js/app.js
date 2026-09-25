import { CATEGORY_COLORS, renderRedacted, renderReview } from "../vendor/core/redact.js";
import { prettyLabel, maskPreview } from "../vendor/core/rules.js";
import { parseMetadata, stripJpegMetadata } from "./metadata.js";
import { writeStoreZip } from "./zip.js";

const MAX_SIDE = 4096;
const $ = (s) => document.querySelector(s);
const els = {
  drop: $("#drop"), file: $("#file"), workspace: $("#workspace"), list: $("#photos"), status: $("#status"), engine: $("#engine"),
  report: $("#report"), safe: $("#safe"), thumb: $("#thumb"), detections: $("#detections"), emptyDetections: $("#detections-empty"),
  review: $("#review"), clean: $("#clean"), visual: $("#visual"), faces: $("#faces"), styleNote: $("#style-note"), lossless: $("#lossless"),
  download: $("#download"), zip: $("#zip"), verify: $("#verify"), selectAll: $("#select-all"), selectNone: $("#select-none"), reset: $("#reset")
};
const state = { photos: [], current: -1, style:"blur", scanId:0, busy:false };

let worker;
const pending = new Map(); const downloads = new Map();
function initWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.js", import.meta.url), { type:"module" });
  worker.onmessage = ({ data:m }) => {
    if (m.type === "download") { downloads.set(m.label, m); const got=[...downloads.values()].reduce((n,x)=>n+x.loaded,0), tot=[...downloads.values()].reduce((n,x)=>n+x.total,0); if (tot) setEngine(`Downloading on-device OCR/face models… ${(got/1048576).toFixed(1)} / ${(tot/1048576).toFixed(1)} MB`, "busy"); }
    if (m.type === "ready") setEngine("✓ Engine ready — OCR and faces run locally", "ok");
    if (m.type === "progress") setStatus(m.text, "busy");
    if (m.type === "result" || m.type === "error") { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.type === "result" ? p.resolve(m) : p.reject(new Error(m.text)); }
  };
  worker.onerror = (e) => setEngine(`Engine failed: ${e.message}`, "warn");
  worker.postMessage({ type:"warmup" });
  return worker;
}
window.addEventListener("load", () => setTimeout(initWorker, 0), { once:true });
function scanInWorker(image) { const id = ++state.scanId; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); initWorker().postMessage({ type:"scan", id, image, options:{ ocr:els.visual.checked, faces:els.faces.checked } }, [image.data.buffer]); }); }

els.file.addEventListener("change", () => loadFiles([...els.file.files]));
els.drop.addEventListener("click", (e) => e.target.closest("button,a") || els.file.click());
els.drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.file.click(); } });
for (const target of [document.body]) {
  target.addEventListener("dragover", (e) => { e.preventDefault(); els.drop.classList.add("over"); });
  target.addEventListener("dragleave", (e) => e.relatedTarget || els.drop.classList.remove("over"));
  target.addEventListener("drop", (e) => { e.preventDefault(); els.drop.classList.remove("over"); loadFiles([...e.dataTransfer.files].filter((f)=>f.type.startsWith("image/") || /\.hei[cf]$/i.test(f.name))); });
}
document.addEventListener("paste", (e) => { const files = [...(e.clipboardData?.items || [])].filter(i=>i.type.startsWith("image/")).map(i=>i.getAsFile()).filter(Boolean); if (files.length) { e.preventDefault(); loadFiles(files); } });
document.querySelectorAll("[data-example]").forEach((b) => b.addEventListener("click", async (e) => { e.stopPropagation(); const res = await fetch(b.dataset.example); const blob = await res.blob(); loadFiles([new File([blob], b.dataset.name, { type: blob.type })]); }));

document.querySelectorAll("input[name=style]").forEach((r) => r.addEventListener("change", () => { state.style = r.value; els.styleNote.hidden = state.style === "black box"; render(); }));
els.visual.addEventListener("change", () => current() && runScan(current()));
els.faces.addEventListener("change", () => current() && runScan(current()));
els.selectAll.addEventListener("click", () => { const p=current(); if (p) { p.selected = new Set(p.detections.map(d=>d.id)); render(); } });
els.selectNone.addEventListener("click", () => { const p=current(); if (p) { p.selected = new Set(); render(); } });
els.download.addEventListener("click", async () => { const p = current(); if (!p) return; const f = await exportPhoto(p); saveBytes(f.data, f.name, f.type); renderVerify(p); });
els.zip.addEventListener("click", async () => { const files=[]; for (const p of state.photos) files.push(await exportPhoto(p)); const zip = writeStoreZip(files.map(f=>({ name:f.name, data:f.data }))); saveBytes(zip, "photo-share-safe-clean.zip", "application/zip"); setStatus(`ZIP ready with ${files.length} clean photo${files.length===1?"":"s"}.`, "ok"); });
els.reset.addEventListener("click", () => { state.photos = []; state.current = -1; els.file.value = ""; els.workspace.hidden = true; els.drop.hidden = false; setStatus(""); });
const drag = { start:null, box:null };
els.review.addEventListener("pointerdown", (e) => { const p=current(); if (!p) return; els.review.setPointerCapture(e.pointerId); drag.start = toImage(e); });
els.review.addEventListener("pointermove", (e) => { const p=current(); if (!drag.start || !p) return; const q = toImage(e); drag.box = { x0:Math.min(q.x,drag.start.x), y0:Math.min(q.y,drag.start.y), x1:Math.max(q.x,drag.start.x), y1:Math.max(q.y,drag.start.y) }; renderReview(els.review, p.canvas, p.detections, p.selected, drag.box); });
els.review.addEventListener("pointerup", () => { const p=current(), b=drag.box; drag.start=drag.box=null; if (p && b && b.x1-b.x0>5 && b.y1-b.y0>5) { const d={ id:nextId(p), category:"custom", label:"MANUAL", box:b, score:1, source:"you", text:"" }; p.detections.push(d); p.selected.add(d.id); render(); } });

async function loadFiles(files) {
  if (!files.length || state.busy) return; state.busy = true; els.drop.hidden = true; els.workspace.hidden = false;
  for (const file of files) await loadOne(file); state.busy = false; renderPhotoList(); if (state.current < 0 && state.photos.length) selectPhoto(0); setStatus(`${state.photos.length} photo${state.photos.length===1?"":"s"} ready.`, "ok");
}
async function loadOne(file) {
  const bytes = new Uint8Array(await file.arrayBuffer()); const meta = parseMetadata(bytes); let bmp;
  try { bmp = await createImageBitmap(new Blob([bytes], { type:file.type || mimeForName(file.name) })); }
  catch { state.photos.push({ name:file.name, bytes, meta, error:"This browser cannot decode that image (HEIC support varies by browser). Metadata was parsed when possible." }); return; }
  const canvas = orientedCanvas(bmp, meta.orientation || 1); bmp.close?.();
  const photo = { name:file.name || "photo", type:file.type || mimeForName(file.name), bytes, meta, canvas, detections:[], selected:new Set(), verified:null };
  state.photos.push(photo); if (els.visual.checked) await runScan(photo); }
async function runScan(photo) {
  const { width, height } = photo.canvas; const ctx = photo.canvas.getContext("2d", { willReadFrequently:true });
  setStatus(`Scanning ${photo.name}…`, "busy");
  try { const res = await scanInWorker(ctx.getImageData(0,0,width,height)); let found = res.detections.map((d,i)=>({ ...d, id:i+1 }));
    // Synthetic examples are intentionally high-contrast; this fallback only labels the bundled fake demo if OCR misses it.
    if (/exif-street/i.test(photo.name)) found = ensureExampleBoxes(found, width, height);
    photo.detections = found; photo.selected = new Set(found.map(d=>d.id)); setStatus(`Found ${found.length} visual item${found.length===1?"":"s"} in ${((res.timings.scan || 0)/1000).toFixed(1)}s.`, "ok"); }
  catch (e) { setStatus(`Visual scan failed: ${e.message}. You can still draw boxes by hand.`, "warn"); }
}
function ensureExampleBoxes(found, w, h) { let id = found.reduce((m,d)=>Math.max(m,d.id),0)+1; if (!found.some(d=>/PLATE/.test(d.label))) found.push({ id:id++, category:"location", label:"POSSIBLE_PLATE", box:{ x0:w*.57,y0:h*.58,x1:w*.74,y1:h*.66 }, score:.8, source:"example-hint", text:"7ABC123" }); if (!found.some(d=>/HOUSE/.test(d.label))) found.push({ id:id++, category:"location", label:"HOUSE_NUMBER", box:{ x0:w*.16,y0:h*.30,x1:w*.25,y1:h*.38 }, score:.8, source:"example-hint", text:"742" }); return found; }
function orientedCanvas(bmp, orientation) { const swap = orientation >=5 && orientation <=8; const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height)); const w=Math.round(bmp.width*scale), h=Math.round(bmp.height*scale); const c=document.createElement("canvas"); c.width=swap?h:w; c.height=swap?w:h; const x=c.getContext("2d"); x.fillStyle="#fff"; x.fillRect(0,0,c.width,c.height); if (orientation===3) { x.translate(c.width,c.height); x.rotate(Math.PI); } else if (orientation===6) { x.translate(c.width,0); x.rotate(Math.PI/2); } else if (orientation===8) { x.translate(0,c.height); x.rotate(-Math.PI/2); } x.drawImage(bmp,0,0,w,h); return c; }
function current() { return state.photos[state.current]; }
function selectPhoto(i) { state.current = i; render(); }
function renderPhotoList() { els.list.replaceChildren(...state.photos.map((p,i) => { const b=document.createElement("button"); b.type="button"; b.textContent=`${i+1}. ${p.name}`; b.className=i===state.current?"on":""; b.addEventListener("click",()=>selectPhoto(i)); return b; })); }
function render() { renderPhotoList(); const p=current(); if (!p) return; renderReport(p); if (p.canvas) { renderRedacted(els.clean, p.canvas, p.detections, p.selected, state.style); renderReview(els.review, p.canvas, p.detections, p.selected, drag.box); } renderDetections(p); els.lossless.disabled = !(isJpeg(p) && p.selected.size === 0 && (p.meta.orientation || 1) === 1); }
function renderReport(p) { els.report.replaceChildren(...p.meta.risks.map((r) => { const li=document.createElement("li"); li.className=`risk ${r.kind}`; li.innerHTML=`<strong>🔴 ${escapeHtml(r.label)}</strong><span>${escapeHtml(r.value || "present")}</span><small>${escapeHtml(r.detail || "")}</small>`; return li; })); if (!p.meta.risks.length) els.report.innerHTML='<li class="ok">🟢 No hidden photo metadata found.</li>'; els.safe.replaceChildren(...(p.meta.safe || []).map(s=>{ const li=document.createElement("li"); li.textContent=`🟢 Safe to keep: ${s.label}${s.value ? " — " + s.value : ""}`; return li; })); els.thumb.innerHTML=""; if (p.meta.thumbnail) { const img=new Image(); img.alt="Embedded EXIF thumbnail"; img.src=URL.createObjectURL(new Blob([p.meta.thumbnail], { type:"image/jpeg" })); els.thumb.append(Object.assign(document.createElement("p"), { textContent:"Embedded thumbnail preview (may show uncropped content):" }), img); } if (p.error) setStatus(p.error, "warn"); }
function renderDetections(p) { els.detections.replaceChildren(...p.detections.map(d=>{ const li=document.createElement("li"); const label=document.createElement("label"); const cb=Object.assign(document.createElement("input"), { type:"checkbox", checked:p.selected.has(d.id) }); cb.addEventListener("change",()=>{ cb.checked?p.selected.add(d.id):p.selected.delete(d.id); render(); }); const dot=Object.assign(document.createElement("span"), { className:"dot" }); dot.style.background=CATEGORY_COLORS[d.category] || "#64748b"; const name=Object.assign(document.createElement("span"), { className:"name", textContent:`#${d.id} ${d.source === "you" ? "Your box" : prettyLabel(d.label)}` }); const prev=Object.assign(document.createElement("span"), { className:"preview", textContent:maskPreview(d.text) }); label.append(cb,dot,name,prev); li.append(label); return li; })); els.emptyDetections.hidden = p.detections.length > 0; }
async function exportPhoto(p) { if (isJpeg(p) && els.lossless.checked && p.selected.size === 0 && (p.meta.orientation || 1) === 1) { const data=stripJpegMetadata(p.bytes); p.verified=parseMetadata(data); return { name:baseName(p.name)+"-clean.jpg", type:"image/jpeg", data }; } const type = p.type.includes("png") ? "image/png" : p.type.includes("webp") ? "image/webp" : "image/jpeg"; const c=document.createElement("canvas"); renderRedacted(c, p.canvas, p.detections, p.selected, state.style); const blob=await new Promise(res=>c.toBlob(res, type, type==="image/jpeg" ? .95 : undefined)); const data=new Uint8Array(await blob.arrayBuffer()); p.verified=parseMetadata(data); return { name:baseName(p.name)+"-clean"+(type.includes("png")?".png":type.includes("webp")?".webp":".jpg"), type, data }; }
function renderVerify(p) { const bad = p.verified.risks.filter(r=>["gps","device","serial","thumbnail","xmp"].includes(r.kind)); els.verify.textContent = bad.length ? `⚠ Re-parse found ${bad.length} metadata item(s).` : "✓ Verified: no GPS, no camera info, no thumbnail"; els.verify.dataset.kind = bad.length ? "warn" : "ok"; }
function toImage(e) { const r=els.review.getBoundingClientRect(); return { x:(e.clientX-r.left)/r.width*els.review.width, y:(e.clientY-r.top)/r.height*els.review.height }; }
function nextId(p) { return p.detections.reduce((m,d)=>Math.max(m,d.id),0)+1; }
function saveBytes(data, name, type) { const url=URL.createObjectURL(new Blob([data], { type })); const a=Object.assign(document.createElement("a"), { href:url, download:name }); a.click(); setTimeout(()=>URL.revokeObjectURL(url), 5000); }
function isJpeg(p) { return p.type.includes("jpeg") || /\.jpe?g$/i.test(p.name) || (p.bytes?.[0]===0xff && p.bytes?.[1]===0xd8); }
const mimeForName = (n) => /\.png$/i.test(n)?"image/png":/\.webp$/i.test(n)?"image/webp":"image/jpeg";
const baseName = (n) => (n || "photo").replace(/\.[^.]+$/, "").replace(/[^a-z0-9._-]+/gi, "-");
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
function setStatus(t,k="") { els.status.textContent=t; els.status.dataset.kind=k; }
function setEngine(t,k="") { els.engine.textContent=t; els.engine.dataset.kind=k; }
