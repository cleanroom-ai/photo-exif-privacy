import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { createExifTiff, exifApp1, injectJpegSegments, injectPngChunks, makePngChunk, xmpApp1 } from "../js/metadata.js";

const appDir = resolve(new URL("..", import.meta.url).pathname.slice(process.platform === "win32" ? 1 : 0));
const outDir = join(appDir, "examples");
mkdirSync(outDir, { recursive: true });
const channel = process.env.E2E_BROWSER || "msedge";
const browser = await chromium.launch(channel === "chromium" ? {} : { channel });
let page;
try {
page = await browser.newPage();
async function canvasBytes(type, quality, drawKind = "street") {
  return await page.evaluate(async ({ type, quality, drawKind }) => {
    const c = document.createElement("canvas"); c.width = 1200; c.height = 800;
    const x = c.getContext("2d");
    x.fillStyle = "#dbeafe"; x.fillRect(0,0,c.width,c.height);
    x.fillStyle = "#bfdbfe"; x.fillRect(0,0,1200,300);
    x.fillStyle = "#16a34a"; x.fillRect(0,300,1200,120);
    x.fillStyle = "#475569"; x.fillRect(0,420,1200,380);
    x.fillStyle = "#f8fafc"; x.fillRect(82,205,285,250); x.fillStyle = "#7c2d12"; x.fillRect(180,330,75,125);
    x.fillStyle = "#111827"; x.font = "bold 64px Arial"; x.fillText("742", 135, 303);
    x.fillStyle = "#fef08a"; x.fillRect(490,155,275,78); x.strokeStyle="#0f172a"; x.lineWidth=5; x.strokeRect(490,155,275,78); x.fillStyle="#111827"; x.font="bold 44px Arial"; x.fillText("PINE ST", 525, 207);
    x.fillStyle = "#2563eb"; round(x, 650, 470, 315, 105, 24); x.fill(); x.fillStyle="#0f172a"; x.beginPath(); x.arc(715,580,34,0,Math.PI*2); x.arc(900,580,34,0,Math.PI*2); x.fill();
    x.fillStyle="#f8fafc"; x.fillRect(710,515,180,48); x.fillStyle="#111827"; x.font="bold 43px Arial"; x.fillText("7ABC123", 718, 554);
    x.fillStyle="#fde68a"; x.beginPath(); x.arc(96,96,46,0,Math.PI*2); x.fill();
    if (drawKind === "thumb") { x.fillStyle="rgba(239,68,68,.88)"; x.fillRect(70,600,620,110); x.fillStyle="#fff"; x.font="bold 48px Arial"; x.fillText("UNCROPPED THUMBNAIL", 95, 670); }
    const blob = await new Promise(r => c.toBlob(r, type, quality));
    return [...new Uint8Array(await blob.arrayBuffer())];
    function round(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
  }, { type, quality, drawKind });
}
const jpeg = new Uint8Array(await canvasBytes("image/jpeg", 0.94, "street"));
const thumb = new Uint8Array(await canvasBytes("image/jpeg", 0.7, "thumb"));
const tiff = createExifTiff({ gps:{ lat:47.6205, lon:-122.3493 }, make:"FauxCam", model:"ShareSafe 1", bodySerial:"BODY-FAKE-12345", lensSerial:"LENS-FAKE-67890", lensModel:"Synthetic 35mm", artist:"Jane Doe", copyright:"Copyright Jane Doe", software:"Cleanroom Example Generator", dateTimeOriginal:"2026:09:25 15:00:00", offsetTimeOriginal:"-07:00", makerNote:"fake maker note", thumbnail: thumb }, { littleEndian:true });
const xmp = `<?xpacket begin="﻿"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmpMM:History="cropped from original by Jane Doe"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
writeFileSync(join(outDir, "exif-street.jpg"), injectJpegSegments(jpeg, [{ marker:0xe1, data:exifApp1(tiff) }, { marker:0xe1, data:xmpApp1(xmp) }]));
const png = new Uint8Array(await canvasBytes("image/png", 1, "street"));
const pngTiff = createExifTiff({ make:"PNGCam", model:"Chunky", artist:"Jane Doe", gps:{ lat:47.6205, lon:-122.3493 } });
const textChunk = makePngChunk("tEXt", new TextEncoder().encode("Author\0Jane Doe"));
const commentChunk = makePngChunk("iTXt", new TextEncoder().encode("Comment\0\0\0en\0Comment\0Fake PNG comment with private note"));
writeFileSync(join(outDir, "png-note.png"), injectPngChunks(png, [textChunk, commentChunk, makePngChunk("eXIf", pngTiff)]));
writeFileSync(join(outDir, "clean-control.webp"), new Uint8Array(await canvasBytes("image/webp", 0.92, "street")));
console.log(`wrote examples to ${outDir}`);
} finally {
  const proc = browser.process?.();
  const profile = browserProfileDir(browser);
  let closed = false;
  await Promise.race([
    browser.close().then(() => { closed = true; }).catch(() => {}),
    new Promise((r) => setTimeout(r, 15_000)),
  ]);
  if (!closed && proc?.pid) {
    try { process.kill(proc.pid, "SIGKILL"); } catch {}
  }
  stopProfileProcesses(profile);
}
function browserProfileDir(browser) {
  const args = browser?.process?.()?.spawnargs || [];
  const arg = args.find((a) => a.startsWith("--user-data-dir"));
  return arg?.includes("=") ? arg.slice(arg.indexOf("=") + 1).replace(/^"|"$/g, "") : null;
}
function stopProfileProcesses(profile) {
  if (!profile || process.platform !== "win32") return;
  const needle = profile.replaceAll("'", "''");
  const command = `$needle='${needle}'; Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$needle*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  try { execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "ignore" }); } catch {}
}
process.exit(0);


