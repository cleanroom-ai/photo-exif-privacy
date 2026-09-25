import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOcrLine, detectionsFromOcrLines } from "../js/heuristics.js";

test("plate and house-number heuristics flag positives", () => {
  assert.equal(classifyOcrLine("7ABC123").label, "POSSIBLE_PLATE");
  assert.equal(classifyOcrLine("AB-1234").label, "POSSIBLE_PLATE");
  assert.equal(classifyOcrLine("742").label, "HOUSE_NUMBER");
  assert.equal(classifyOcrLine("12").label, "HOUSE_NUMBER");
});

test("plate heuristics avoid common negatives", () => {
  assert.equal(classifyOcrLine("PINE ST"), null);
  assert.equal(classifyOcrLine("HELLO"), null);
  assert.equal(classifyOcrLine("IMG12345"), null);
  assert.equal(classifyOcrLine("2026-09-25")?.label, undefined);
});

test("OCR lines become padded detections", () => {
  const d = detectionsFromOcrLines([{ text:"7ABC123", score:.9, box:{x0:10,y0:20,x1:110,y1:60} }]);
  assert.equal(d[0].label, "POSSIBLE_PLATE");
  assert.ok(d[0].box.x0 < 10 && d[0].box.y0 < 20);
});
