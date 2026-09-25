---
title: Photo Share-Safe
emoji: 🧼
colorFrom: gray
colorTo: indigo
sdk: static
app_file: index.html
license: apache-2.0
short_description: Strip photo GPS/EXIF, blur faces & plates, in-browser
thumbnail: https://huggingface.co/spaces/cleanroom-ai/photo-exif-privacy/resolve/main/assets/social-preview.png
models:
  - PaddlePaddle/PP-OCRv6_tiny_det
  - PaddlePaddle/PP-OCRv6_tiny_rec
  - opencv/face_detection_yunet
tags:
  - exif
  - metadata
  - exif-remover
  - gps
  - photo-privacy
  - face-blur
  - license-plate
  - privacy
  - anonymization
  - image-privacy
  - gdpr
  - ocr
  - onnx
  - in-browser
---

# Photo Share-Safe

<p align="center"><img src="assets/icon.svg" width="112" height="112" alt="Photo Share-Safe logo"></p>

[![CI](https://github.com/paragpsawant/photo-exif-privacy/actions/workflows/ci.yml/badge.svg)](https://github.com/paragpsawant/photo-exif-privacy/actions/workflows/ci.yml)
[Hugging Face demo](https://huggingface.co/spaces/cleanroom-ai/photo-exif-privacy)

**Strip GPS & hidden metadata, blur faces and plates — before you post. Runs 100% in your browser.**

## Why

Real photos often carry precise GPS coordinates that can reveal a home, school, workplace, or travel routine. Cropped photos can also contain embedded thumbnails that still show the original uncropped scene. Photo Share-Safe reports those risks before sharing and exports a verified clean copy.

## Features

- Parses JPEG EXIF/XMP/IPTC/ICC/thumbnail data, PNG text/eXIf chunks, and WebP EXIF/XMP metadata locally.
- Ranks GPS, serial numbers, owner/copyright, capture time, comments, thumbnails, and XMP edit history.
- Uses bundled cleanroom-ai OCR + YuNet face detection in a Web Worker.
- Flags short plate-like OCR text and standalone digit strings such as house numbers.
- Lets you untick or manually draw boxes, then blur, pixelate, or black-box them.
- Exports a clean copy or STORE-only ZIP; re-parses output to verify GPS/camera/thumbnail data is gone.
- Optional JPEG lossless metadata strip keeps original pixels when no visual redactions are selected.

## How it works

```
photo bytes ─► metadata parsers ─► privacy report
canvas pixels ─► PP-OCRv6 + YuNet ─► review boxes ─► redacted canvas / lossless strip ─► verified export
```

No CDN, analytics, external fonts, map, or geocoding service is used. A strict CSP and browser E2E test check that photos are never uploaded.

## Run locally

```bash
npm ci
npm run vendor
npm run examples
npm test
node node_modules/@cleanroom-ai/core/scripts/serve.mjs .
```

Then open <http://127.0.0.1:8090/> (or the port printed by the server).

## CI/CD

CI runs unit tests, vendors the shared engine, launches a real browser, checks no uploads/third-party requests, and uploads screenshots. Deployment to Hugging Face Spaces is optional and only runs when `HF_TOKEN` is configured.

## Limitations

- HEIC display depends on browser decoding support.
- OCR can miss tiny, stylized, blurry, or low-contrast text; always review manually.
- The app does not reverse geocode GPS coordinates and intentionally avoids map services.
- Lossless JPEG stripping cannot rotate pixels; photos with EXIF orientation are re-encoded on export.

## Author

Built by **Parag Sawant** [@paragpsawant](https://github.com/paragpsawant) · [parags.dev](https://parags.dev) · [LinkedIn](https://www.linkedin.com/in/paragsawant/)

## Credits & licenses

Part of **cleanroom-ai**. Apache-2.0. Uses [@cleanroom-ai/core](https://github.com/paragpsawant/cleanroom-core), PP-OCRv6 tiny, YuNet, and ONNX Runtime Web. License texts are copied by `npm run vendor` into `licenses/` and model license files into `models/LICENSES/`.
