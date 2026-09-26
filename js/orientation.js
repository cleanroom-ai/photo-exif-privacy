const MAX_SIDE = 4096;

export function orientedSize(width, height, orientation, maxSide = MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.round(width * scale), h = Math.round(height * scale);
  return orientation >= 5 && orientation <= 8 ? { width:h, height:w, drawWidth:w, drawHeight:h } : { width:w, height:h, drawWidth:w, drawHeight:h };
}

export function orientationTransform(orientation, w, h) {
  switch (orientation) {
    case 2: return [-1, 0, 0, 1, w, 0];
    case 3: return [-1, 0, 0, -1, w, h];
    case 4: return [1, 0, 0, -1, 0, h];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, h, 0];
    case 7: return [0, -1, -1, 0, h, w];
    case 8: return [0, -1, 1, 0, 0, w];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

export function drawOrientedBitmap(document, bmp, orientation = 1, { fill = "transparent", maxSide = MAX_SIDE } = {}) {
  const size = orientedSize(bmp.width, bmp.height, orientation, maxSide);
  const c = document.createElement("canvas"); c.width = size.width; c.height = size.height;
  const x = c.getContext("2d");
  if (fill && fill !== "transparent") { x.fillStyle = fill; x.fillRect(0, 0, c.width, c.height); }
  x.setTransform(...orientationTransform(orientation, size.drawWidth, size.drawHeight));
  x.drawImage(bmp, 0, 0, size.drawWidth, size.drawHeight);
  x.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}
