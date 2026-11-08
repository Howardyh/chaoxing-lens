# Chaoxing Lens

Version 0.6.0 adds an [exam fast path](skill/references/exam-fast-path.md): retain valid browser bindings, batch source extraction and bounded screenshots for missing formulas, and fetch individual originals only when needed. Before/after page checks reject changed content, frame mismatches and invalid screenshots. Contact sheets use three columns with full-width long formulas. Actual exam count and minute/second timer formats are recognized. Acquisition changes preserve reasoning and option verification; end-to-end speedups require measured browser runs.

Version 0.5.0 defaults to **Question | Answer | Short comparison**. Assignment and exam answering pages are the production inputs; graded pages are review/regression inputs only. Page state reports observed coverage and remaining time, while unknown totals remain unknown.

New capabilities include MathJax SVG root TeX, exact-content question/asset reuse with option remapping, white-background image preparation and adaptive contact sheets, temporary OCR failure caching, separate reading/reasoning/numerical/mapping checks, and blind solve packets that exclude existing answers. Solve packets and answer files now use v2; prepare and verify old runs again.

The optional Jev REST adapter checks local readability, explicit type/polarity and transcription candidates. It never solves subject questions or auto-verifies answers. `check-jev.mjs` previews by default; sending requires an existing data/spending authorization and `TYPESAFE_API_KEY`. Transport tests use mocked responses; live accuracy, latency and costs have not been established. See [Jev and evaluation](skill/references/jev-and-evaluation.md). `evaluate-runs.mjs` compares baseline/improved/improved+jev using accuracy, coverage and measured stage P50/P95; missing runs are not fabricated.

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

Version 0.4 adds a reasoning packet that keeps complete prompts, ordered options, formulas and shared material while leaving automation coordinates and locators in the original capture. A local answer formatter outputs a numbered table, literal judgment-option text, separate fill-in blanks and copyable written answers. It checks capture identity, option labels, blank counts and recorded visual review; pending answers remain visibly pending. These checks do not prove subject-matter correctness.

```sh
node scripts/prepare-answers.mjs local/capture.json local/answer-run-1
# Solve and verify the questions, then populate the generated answers.json.
node scripts/format-answers.mjs local/capture.json local/answer-run-1/answers.json local/answer-sheet-1.md
```

Small tasks can use the same layout directly in chat without running extra helpers. See [the answer workflow](skill/references/answer-workflow.md). Benchmarks now report packet bytes and local formatting time; bytes are not tokens, and local timings do not establish end-to-end model latency or answer accuracy.

Tests use synthetic questions and deterministic jsdom geometry; they do not prove native screenshot layout. Benchmark results describe synthetic DOM work, not end-to-end browser or recognition latency. Formula transcription and diagram relationships require visual verification. This package does not bundle formula-model weights, call hidden answer APIs, inspect cookies or submit work by itself.
