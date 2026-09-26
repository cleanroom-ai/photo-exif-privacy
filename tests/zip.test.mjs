import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { crc32, readStoreZip, writeStoreZip } from "../js/zip.js";

test("CRC32 known vectors", () => {
  assert.equal(crc32(new TextEncoder().encode("")), 0x00000000);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("STORE zip round-trips and can be extracted by a standard unzip tool", () => {
  const zip = writeStoreZip([{ name:"a.txt", data:new TextEncoder().encode("alpha") }, { name:"nested/b.txt", data:new TextEncoder().encode("bravo") }]);
  const entries = readStoreZip(zip);
  assert.deepEqual(entries.map(e=>e.name), ["a.txt", "nested/b.txt"]);
  assert.equal(new TextDecoder().decode(entries[1].data), "bravo");
  const dir = join(process.cwd(), ".cache", "zip-test"); rmSync(dir, { recursive:true, force:true }); mkdirSync(dir, { recursive:true });
  const path = join(dir, "test.zip"); writeFileSync(path, zip);
  // Windows' bsdtar reads ZIP; GNU tar (Linux CI) does not, so use unzip there.
  if (process.platform === "win32") execFileSync("tar", ["-xf", path, "-C", dir]);
  else execFileSync("unzip", ["-q", "-o", path, "-d", dir]);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "alpha");
  assert.equal(readFileSync(join(dir, "nested", "b.txt"), "utf8"), "bravo");
});
