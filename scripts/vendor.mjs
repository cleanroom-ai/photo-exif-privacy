import { vendorCore } from "@cleanroom-ai/core/scripts/vendor.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
vendorCore({ appDir, models: ["ocr", "faces"], libs: ["ort"] });
