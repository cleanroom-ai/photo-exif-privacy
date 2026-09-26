import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { openApp } from "@cleanroom-ai/core/testing/browser.mjs";
import { makePngChunk, parseMetadata } from "../js/metadata.js";
import { readStoreZip } from "../js/zip.js";

const base = process.argv[2] || "http://127.0.0.1:8090/";
const root = fileURLToPath(new URL("..", import.meta.url));
const shotsDir = join(root, ".cache", "e2e");
mkdirSync(shotsDir, { recursive:true });
let app;
try {
app = await openApp(base, { shotsDir });
const { page, shot, assertLogo, finish, elapsed, problems } = app;

await page.locator("#engine[data-kind=ok]").waitFor({ timeout:180_000 });
await assertLogo();
console.log(`engine ready in ${elapsed()}s`);
await page.evaluate(() => {
  const oc = URL.createObjectURL.bind(URL), or = URL.revokeObjectURL.bind(URL);
  const active = new Set(); let created = 0, revoked = 0;
  URL.createObjectURL = (o) => { const u = oc(o); active.add(u); created++; return u; };
  URL.revokeObjectURL = (u) => { if (active.delete(u)) revoked++; return or(u); };
  window.__blobStats = () => ({ created, revoked, active:active.size });
});

await page.locator('[data-name="exif-street.jpg"]').evaluate((b) => b.click());
await page.locator("#status[data-kind=ok], #status[data-kind=warn]").waitFor({ timeout:300_000 });
const report = await page.locator("#report").innerText();
console.log("report lines: " + report.split("\n").slice(0,8).join(" | "));
assert.match(report, /GPS location/);
assert.match(report, /Camera\/lens serial number/);
assert.match(report, /Embedded thumbnail/);
assert.ok(await page.locator("#thumb img").evaluate(img => img.complete && img.naturalWidth > 0));
for (let i = 0; i < 4; i++) await page.locator(i % 2 ? "#select-all" : "#select-none").evaluate((b) => b.click());
assert.equal((await page.evaluate(() => window.__blobStats())).active, 1, "thumbnail blob URL should be replaced, not leaked");
const detections = await page.locator("#detections li .name").allInnerTexts();
console.log("visual boxes: " + detections.join(" | "));
assert.ok(detections.some(t => /Possible Plate/.test(t)), "plate box shown");
assert.ok(detections.some(t => /House Number/.test(t)), "house number box shown");
await shot("exif-report");

const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
await page.locator("#download").evaluate((b) => b.click());
const download = await downloadPromise;
const clean = new Uint8Array(readFileSync(await download.path()));
const meta = parseMetadata(clean);
console.log(`download: ${download.suggestedFilename()} ${clean.length} bytes`);
assert.ok(clean[0] === 0xff && clean[1] === 0xd8 || clean[0] === 137 || clean.subarray(0,4).toString?.() === "RIFF");
assert.equal(meta.risks.some(r => ["gps", "device", "serial", "thumbnail", "xmp"].includes(r.kind)), false, JSON.stringify(meta.risks));
await page.locator("#verify[data-kind=ok]").waitFor({ timeout:5000 });
console.log(await page.locator("#verify").innerText());
await download.delete();

await page.locator("#reset").evaluate((b) => b.click());
await page.locator("#drop:not([hidden])").waitFor({ timeout:30_000 });
await page.locator("#visual").evaluate((b) => { b.checked = false; b.dispatchEvent(new Event("change", { bubbles:true })); });
await page.locator("#faces").evaluate((b) => { b.checked = false; b.dispatchEvent(new Event("change", { bubbles:true })); });
await page.locator("#file").setInputFiles({ name:"alpha.png", mimeType:"image/png", buffer:Buffer.from(alphaPng()) });
await page.locator("#workspace:not([hidden])").waitFor({ timeout:60_000 });
const alphaPromise = page.waitForEvent("download", { timeout:60_000 });
await page.locator("#download").evaluate((b) => b.click());
const alphaDownload = await alphaPromise;
const alphaBytes = new Uint8Array(readFileSync(await alphaDownload.path()));
const alphaPixel = await page.evaluate(async (arr) => {
  const bmp = await createImageBitmap(new Blob([new Uint8Array(arr)], { type:"image/png" }));
  const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext("2d"); x.drawImage(bmp, 0, 0);
  return [...x.getImageData(0, 0, 1, 1).data];
}, [...alphaBytes]);
assert.deepEqual(alphaPixel, [0, 0, 0, 0], "PNG export should preserve transparent pixels");
await alphaDownload.delete();
await page.locator("#reset").evaluate((b) => b.click());
await page.locator("#drop:not([hidden])").waitFor({ timeout:30_000 });
await page.locator("#file").setInputFiles([join(root, "examples", "exif-street.jpg"), join(root, "examples", "png-note.png"), join(root, "examples", "clean-control.webp")]);
await page.locator("#photos button").nth(2).waitFor({ timeout:300_000 });
const zipPromise = page.waitForEvent("download", { timeout: 60_000 });
await page.locator("#zip").evaluate((b) => b.click());
const zipDownload = await zipPromise;
const zipBytes = new Uint8Array(readFileSync(await zipDownload.path()));
const entries = readStoreZip(zipBytes);
console.log(`zip: ${zipDownload.suggestedFilename()} entries=${entries.map(e=>e.name).join(",")}`);
assert.equal(entries.length, 3);
for (const e of entries) assert.equal(parseMetadata(e.data).risks.some(r => ["gps", "device", "serial", "thumbnail", "xmp"].includes(r.kind)), false, e.name);
await zipDownload.delete();
await shot("zip-batch");
if (problems.length) console.log("console problems:\n" + problems.join("\n"));
await finish();
} finally {
  const browser = app?.browser;
  const proc = browser?.process?.();
  if (browser) {
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
function alphaPng() {
  const sig = new Uint8Array([137,80,78,71,13,10,26,10]);
  const ihdr = makePngChunk("IHDR", new Uint8Array([0,0,0,2,0,0,0,2,8,6,0,0,0]));
  const rows = new Uint8Array([0, 0,0,0,0, 255,0,0,255, 0, 255,0,0,255, 255,0,0,255]);
  return new Uint8Array([...sig, ...ihdr, ...makePngChunk("IDAT", deflateSync(rows)), ...makePngChunk("IEND", new Uint8Array())]);
}

process.exit(0);
