import assert from "node:assert/strict";
import { test } from "node:test";
import { orientedSize, orientationTransform } from "../js/orientation.js";

test("all EXIF orientation transforms cover the output canvas", () => {
  const src = { width:80, height:40 };
  for (let orientation = 1; orientation <= 8; orientation++) {
    const size = orientedSize(src.width, src.height, orientation);
    if (orientation >= 5) assert.deepEqual([size.width, size.height], [40, 80]);
    else assert.deepEqual([size.width, size.height], [80, 40]);
    const pts = [[0,0], [size.drawWidth,0], [0,size.drawHeight], [size.drawWidth,size.drawHeight]]
      .map(([x, y]) => map(orientationTransform(orientation, size.drawWidth, size.drawHeight), x, y));
    assert.equal(Math.min(...pts.map(p => p[0])), 0, `orientation ${orientation} min x`);
    assert.equal(Math.min(...pts.map(p => p[1])), 0, `orientation ${orientation} min y`);
    assert.equal(Math.max(...pts.map(p => p[0])), size.width, `orientation ${orientation} max x`);
    assert.equal(Math.max(...pts.map(p => p[1])), size.height, `orientation ${orientation} max y`);
  }
});

test("mirrored EXIF orientations flip the expected axis", () => {
  assert.deepEqual(map(orientationTransform(2, 80, 40), 0, 20), [80, 20]);
  assert.deepEqual(map(orientationTransform(4, 80, 40), 40, 0), [40, 40]);
  assert.deepEqual(map(orientationTransform(5, 80, 40), 80, 0), [0, 80]);
  assert.deepEqual(map(orientationTransform(7, 80, 40), 0, 0), [40, 80]);
});

function map([a, b, c, d, e, f], x, y) {
  return [a * x + c * y + e, b * x + d * y + f];
}
