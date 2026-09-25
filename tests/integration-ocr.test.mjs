import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as ort from "onnxruntime-node";
import { OCR } from "../vendor/core/ocr.js";
import { readPng } from "@cleanroom-ai/core/testing/png.mjs";
import { detectionsFromOcrLines } from "../js/heuristics.js";

const models = join(process.cwd(), "models");
const loadBytes = async (f) => readFileSync(join(models, f));
const loadJson = async (f) => JSON.parse(readFileSync(join(models, f), "utf8"));

test("shared OCR flags plate and house number on the synthetic street example", async () => {
  const ocr = await OCR.create(ort, loadBytes, loadJson, { executionProviders:["cpu"] });
  const img = readPng(join(process.cwd(), "examples", "png-note.png"));
  const lines = await ocr.run(img);
  const detections = detectionsFromOcrLines(lines);
  const labels = detections.map(d => d.label);
  assert.ok(labels.includes("POSSIBLE_PLATE"), `OCR lines: ${lines.map(l=>l.text).join(" | ")}`);
  assert.ok(labels.includes("HOUSE_NUMBER"), `OCR lines: ${lines.map(l=>l.text).join(" | ")}`);
});
