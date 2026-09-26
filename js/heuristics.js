const LETTER_PLATE_DENY = new Set(["HELLO", "PINEST", "STREET", "PHOTO", "IMAGE", "CAMERA", "PRIVATE", "LICENSE"]);

export function classifyOcrLine(text, box = null) {
  const raw = (text || "").trim();
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^\d{2,}$/.test(raw.replace(/\s/g, ""))) return { label: "HOUSE_NUMBER", category: "location", reason: "Digits standing alone can be a house or unit number." };
  const hasLetter = /[A-Z]/.test(compact), hasDigit = /\d/.test(compact);
  const plateShape = /^[A-Z0-9][A-Z0-9 -]{3,10}[A-Z0-9]$/i.test(raw) && compact.length >= 5 && compact.length <= 8;
  if (plateShape && hasLetter && hasDigit && !/^(?:IMG|DSC|PHOTO)\d+/i.test(compact)) {
    return { label: "POSSIBLE_PLATE", category: "location", reason: "Short mixed letters/digits look like a license plate." };
  }
  if (plateShape && /^[A-Z]{5,8}$/.test(compact) && !LETTER_PLATE_DENY.has(compact) && plateLikeBox(box)) {
    return { label: "POSSIBLE_PLATE", category: "location", reason: "Short all-letter text in a plate-shaped box can be a vanity plate." };
  }
  return null;
}

export function detectionsFromOcrLines(lines, startId = 1) {
  const out = [];
  for (const line of lines || []) {
    const h = classifyOcrLine(line.text, line.box);
    if (!h || !line.box) continue;
    out.push({ id: startId + out.length, category: h.category, label: h.label, box: padBox(line.box), score: line.score ?? 0.8,
      source: "ocr-heuristic", text: line.text, reason: h.reason });
  }
  return out;
}

function plateLikeBox(box) {
  if (!box) return true;
  const w = Math.max(1, box.x1 - box.x0), h = Math.max(1, box.y1 - box.y0);
  const aspect = w / h;
  return aspect >= 1.8 && aspect <= 6.5;
}

function padBox(b) {
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  return { x0: Math.max(0, b.x0 - w * 0.08), y0: Math.max(0, b.y0 - h * 0.18), x1: b.x1 + w * 0.08, y1: b.y1 + h * 0.18 };
}
