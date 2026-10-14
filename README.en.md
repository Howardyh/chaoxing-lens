# Chaoxing Lens

Source-first reading tools for visible Chaoxing questions, formulas and diagrams, with a Codex skill. [中文](README.md)

The read-only extractor produces normalized v3 JSON: questions reference one asset table and shared contexts. It preserves selection state, MathML/TeX sources and explicit OCR/visual-review tasks. The local pipeline prefers images already observed by the browser, otherwise validates frame-local screenshot coordinates and crop provenance. Windows OCR supports content/configuration caching, batch reuse, deadlines and stage timings.

## Setup

Node.js 24+ is required. Windows OCR/cropping helpers use Windows PowerShell 5.1.

```sh
npm ci --ignore-scripts
npm run check
npm run install:skill
```

The installer backs up an existing `chaoxing-study` skill before copying verified files. Use `$chaoxing-study` in Codex to read the current question page. Browser APIs must follow the documentation supplied by the current session.

See [the workflow](skill/references/browser-workflow.md) for original-image acquisition, screenshot descriptors, crop planning and local OCR. Runtime captures, images and credentials belong in ignored `local/`, never in the public repository.

Tests use synthetic questions and deterministic jsdom geometry; they do not prove native screenshot layout. Benchmark results describe synthetic DOM work, not end-to-end browser or recognition latency. Formula transcription and diagram relationships require visual verification. This package does not bundle formula-model weights, call hidden answer APIs, inspect cookies or submit work by itself.
