import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planExamRead, planPageRead } from '../src/exam-speed.js';
import { captureExamFast, capturePageFast } from '../src/exam-capture.js';
import { extractVisibleQuestions } from '../src/extractor.js';
import { fixtureDom, installLayout } from './dom-helper.js';

const source = '/* reviewed test-only extractor placeholder */';
const shape = (frame = 'top') => ({ schema: 'chaoxing-visible-questions/v3', captureId: 'fixture', capturedAt: new Date().toISOString(), count: 2, page: { url: 'https://example.test/exam-ans/mooc2/exam/preview' }, questions: [{ key: 'q1', prompt: '1. Synthetic', questionNumber: 1, options: [], contextIds: [], assetIds: ['a'] }, { key: 'q2', prompt: '2. Synthetic', questionNumber: 2, options: [], contextIds: [], assetIds: ['b'] }], contexts: [], frames: [{ frame, devicePixelRatio: 1.25, documentSize: { width: 1200, height: 5000 } }], assets: [{ assetId: 'a', frame, kind: 'image', bounds: { x: 100.25, y: 40.5, width: 210, height: 42 } }, { assetId: 'b', frame, kind: 'image', bounds: { x: 200, y: 500, width: 400, height: 100 } }], ocrQueue: [{ assetId: 'a' }, { assetId: 'b' }], visualQueue: [] });

test('exam preview reads observed total and minute/second ticks without exporting header identity', () => {
  const dom = fixtureDom('legacy'); dom.reconfigure({ url: 'https://example.test/exam-ans/mooc2/exam/preview' });
  dom.window.document.title = '整卷预览';
  dom.window.document.body.innerHTML = `<div class="tabMarkingLeft"><h2>第五章网测</h2><span>118' 52''</span><span>姓名: HEADER_IDENTITY_SENTINEL</span><span>题量: 2</span></div><h2>单选题（共 2 题）</h2><div class="questionLi" id="question1"><h3>1.（单选题）合成题</h3><ul class="Zy_ulTop"><li>A. 一</li><li>B. 二</li></ul></div><div class="questionLi" id="question2"><h3>2.（单选题）合成题</h3><ul class="Zy_ulTop"><li>A. 三</li><li>B. 四</li></ul></div>`;
  installLayout(dom.window); const c = extractVisibleQuestions(dom.window.document); dom.window.close();
  assert.equal(c.page.template, 'exam-preview'); assert.equal(c.page.expectedCount, 2); assert.equal(c.page.remainingSeconds, 7132); assert.equal(c.page.coverage, 'complete');
  assert.ok(!JSON.stringify(c).includes('HEADER_IDENTITY_SENTINEL'));
});

test('many missing assets share bounded screenshots without omitting any consumer', () => {
  const c = shape(); const plan = planExamRead(c, { expectedCount: 3 });
  assert.equal(plan.strategy, 'screenshots-first'); assert.equal(plan.screenshots.length, 1); assert.deepEqual(plan.missingNumbers, [3]);
  assert.deepEqual(plan.screenshots[0].assetIds, ['a', 'b']);
  const clip = plan.screenshots[0].clip;
  for (const a of c.assets) { assert.ok(clip.x <= a.bounds.x && clip.y <= a.bounds.y); assert.ok(clip.x + clip.width >= a.bounds.x + a.bounds.width && clip.y + clip.height >= a.bounds.y + a.bounds.height); }
});

test('option selection badges do not become formula tasks while actual SVG question diagrams remain queued', () => {
  const dom = fixtureDom('legacy'), doc = dom.window.document;
  doc.body.innerHTML = `<div class="questionLi" id="question1"><h3>1.（单选题）辨认图形<svg width="36" height="37"><path d="M0 0L20 20"/></svg></h3><ul class="Zy_ulTop"><li><span class="check_answer">A<svg width="36" height="37"><path d="M0 0L20 20"/></svg></span>一</li><li><span class="num_option">B<svg width="36" height="37"><path d="M0 0L20 20"/></svg></span>二</li></ul></div>`;
  installLayout(dom.window); const c = extractVisibleQuestions(doc); dom.window.close();
  assert.equal(c.assets.length, 1); assert.equal(c.assets[0].owner, 'prompt'); assert.equal(c.ocrQueue.length, 1); assert.equal(c.questions[0].options[0].selected, true); assert.equal(c.questions[0].options[1].selected, false);
});

test('bands split to respect pixel budgets; unreadable geometry and iframe coordinates go to explicit fallback', () => {
  assert.equal(planExamRead(shape(), { maxHeight: 200 }).screenshots.length, 2);
  const child = planExamRead(shape('top / iframe'));
  assert.equal(child.screenshots.length, 0); assert.equal(child.fallbacks.length, 2); assert.equal(child.fallbacks[0].reason, 'frame-tool-required');
  const bad = shape(); bad.assets[0].bounds.width = 0; bad.assets[1].loaded = false;
  assert.deepEqual(planExamRead(bad).fallbacks.map(f => f.reason), ['geometry-unavailable', 'image-unloaded']);
});

test('source-only and explicitly selected originals do not issue unnecessary screenshot work', () => {
  const c = shape(); c.ocrQueue = [];
  assert.equal(planExamRead(c).strategy, 'source-only'); assert.equal(planExamRead(c).screenshots.length, 0);
  assert.deepEqual(planExamRead(c).sourceReadyQuestionKeys, ['q1', 'q2']);
  assert.equal(planExamRead(shape(), { mode: 'originals' }).fallbacks.length, 2);
});

test('homework starts source-complete questions while preserving option and shared-image dependencies', () => {
  const c = shape(); c.page.family = 'assignment';
  c.questions[0].assetIds = [];
  c.questions[0].options = [{ assetIds: ['a'] }];
  c.questions[1].assetIds = [];
  c.questions[1].contextIds = ['material'];
  c.contexts = [{ id: 'material', assetIds: ['b'] }];
  c.questions.push({ key: 'q3', questionNumber: 3, prompt: '3. Text only', options: [], assetIds: [], contextIds: [] });
  c.count++;
  const plan = planPageRead(c);
  assert.equal(plan.schema, 'chaoxing-page-read-plan/v1');
  assert.deepEqual(plan.sourceReadyQuestionKeys, ['q3']);
  assert.equal(plan.screenshots.length, 1);
  assert.deepEqual(plan.screenshots[0].assetIds, ['a', 'b']);
  c.assets.pop();
  assert.deepEqual(planPageRead(c).fallbacks, [{ assetId: 'b', reason: 'queue-asset-missing' }]);
});

test('visible assignment total takes precedence over counts for individual sections', () => {
  const dom = fixtureDom('legacy');
  dom.reconfigure({ url: 'https://example.test/mooc-ans/mooc2/work/dowork' });
  dom.window.document.body.innerHTML = '<h1>题量：3 满分：100</h1><h2>单选题（共 2 题）</h2><h2>判断题（共 1 题）</h2>'
    + [1, 2, 3].map(n => `<div class="questionLi" id="question${n}"><h3>${n}.（单选题）合成题</h3><ul class="Zy_ulTop"><li>A. 甲</li><li>B. 乙</li></ul></div>`).join('');
  installLayout(dom.window);
  const capture = extractVisibleQuestions(dom.window.document);
  dom.window.close();
  assert.equal(capture.page.expectedCount, 3);
  assert.equal(capture.page.coverage, 'complete');
});

async function isolated(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'chaoxing-exam-test-'));
  try { await run(path.join(directory, 'run')); }
  finally {
    if (!path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(directory).startsWith('chaoxing-exam-test-')) throw new Error('Unsafe temporary cleanup');
    await rm(directory, { recursive: true, force: true });
  }
}
function pngHeader(width, height) { const bytes = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes; }
function jpegHeader(width, height) {
  const bytes = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 255, 217]);
  bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9);
  return bytes;
}

test('capture helper batches source and screenshots, verifies page identity and emits crop-compatible descriptors', async () => isolated(async outputDirectory => {
  let reads = 0, shots = 0;
  const c = shape(), tab = { playwright: { evaluate: async s => { assert.equal(s, source); reads++; return structuredClone(c); } }, screenshot: async options => { shots++; assert.equal(options.fullPage, true); return pngHeader(options.clip.width, options.clip.height); } };
  const result = await captureExamFast(tab, { extractorSource: source, outputDirectory });
  assert.equal(reads, 2); assert.equal(shots, 1); assert.equal(result.screenshotCount, 1); assert.equal(result.pageChanged, false); assert.equal(result.verified, false);
  const descriptor = JSON.parse(await readFile(path.join(outputDirectory, 'screenshots.json')));
  assert.equal(descriptor.captureHash.length, 64); assert.equal(descriptor.screenshots[0].coordinateSpace, 'frame-document'); assert.deepEqual(descriptor.fallbackAssetIds, []);
  await assert.rejects(captureExamFast(tab, { extractorSource: source, outputDirectory }), /EEXIST/);
}));

test('changed page, screenshot failure or ignored clip cannot become ready visual evidence', async () => {
  for (const kind of ['changed', 'failure', 'ignored-clip', 'ignored-clip-jpeg']) await isolated(async outputDirectory => {
    let reads = 0;
    const tab = { playwright: { evaluate: async () => { const c = shape(); if (++reads > 1 && kind === 'changed') c.questions[0].prompt = 'Different problem'; return c; } }, screenshot: async ({ clip }) => {
      if (kind === 'failure') throw new Error('No capture');
      if (kind === 'ignored-clip-jpeg') return jpegHeader(1200, 5000);
      return kind === 'ignored-clip' ? pngHeader(1200, 5000) : pngHeader(clip.width, clip.height);
    } };
    const result = await captureExamFast(tab, { extractorSource: source, outputDirectory });
    assert.deepEqual(result.fallbackAssetIds, ['a', 'b']);
    const saved = JSON.parse(await readFile(path.join(outputDirectory, 'screenshots.json')));
    if (kind === 'changed') { assert.equal(result.pageChanged, true); assert.ok(saved.screenshots.every(s => s.ready === false)); }
    assert.ok(saved.failures.length);
  });
});

test('observed JPEG screenshots are saved as pending normalization, never mislabelled as verified PNG', async () => isolated(async outputDirectory => {
  const tab = { playwright: { evaluate: async () => shape() }, screenshot: async ({ clip }) => jpegHeader(clip.width, clip.height) };
  const result = await captureExamFast(tab, { extractorSource: source, outputDirectory });
  assert.equal(result.screenshotCount, 1); assert.equal(result.readyScreenshotCount, 0); assert.equal(result.pendingNormalizationCount, 1); assert.deepEqual(result.fallbackAssetIds, []);
  const saved = JSON.parse(await readFile(path.join(outputDirectory, 'screenshots.json')));
  assert.equal(saved.screenshots[0].contentType, 'image/jpeg'); assert.equal(saved.screenshots[0].pixelSize.width, saved.screenshots[0].cssBounds.width); assert.equal(saved.screenshots[0].ready, false); assert.ok(saved.screenshots[0].path.endsWith('.jpg'));
}));

test('capture-local question and image IDs stay comparable across fresh extractions', async () => isolated(async outputDirectory => {
  const dom = fixtureDom('legacy');
  dom.reconfigure({ url: 'https://example.test/mooc-ans/mooc2/work/dowork' });
  dom.window.document.body.innerHTML = '<div class="questionLi"><h3>1.（单选题）图示<img src="https://example.test/formula.png" width="120" height="22"></h3><ul class="Zy_ulTop"><li>A. 甲</li><li>B. 乙</li></ul></div>';
  installLayout(dom.window);
  let reads = 0;
  const tab = { playwright: { evaluate: async () => extractVisibleQuestions(dom.window.document, { captureId: 'local-' + ++reads }) },
    screenshot: async ({ clip }) => pngHeader(clip.width, clip.height) };
  try {
    const result = await capturePageFast(tab, { extractorSource: source, outputDirectory });
    assert.equal(reads, 2);
    assert.equal(result.readyScreenshotCount, 1);
    assert.equal(result.pageChanged, false);
    assert.equal(result.fallbackAssetIds.length, 0);
    const saved = JSON.parse(await readFile(path.join(outputDirectory, 'screenshots.json')));
    assert.equal(saved.schema, 'chaoxing-page-fast-capture/v1');
  } finally { dom.window.close(); }
}));

test('a stale homework capture cannot acquire screenshots from a different page', async () => isolated(async outputDirectory => {
  const capture = shape(), different = shape();
  different.questions[0].prompt = 'Different problem';
  let shots = 0;
  const tab = { playwright: { evaluate: async () => different }, screenshot: async () => { shots++; } };
  const result = await capturePageFast(tab, { extractorSource: source, outputDirectory, capture });
  assert.equal(shots, 0);
  assert.equal(result.pageChanged, true);
  assert.deepEqual(result.sourceReadyQuestionKeys, []);
  assert.deepEqual(result.fallbackAssetIds, ['a', 'b']);
}));
