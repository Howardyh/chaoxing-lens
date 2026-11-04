import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureDom, installLayout } from './dom-helper.js';
import { extractVisibleQuestions } from '../src/extractor.js';
import { prepareAnswers, formatAnswers } from '../src/answer-sheet.js';
import { fingerprintQuestion, planQuestionReuse, remapChoiceAnswer, readingCacheKey, cacheReading, lookupReading } from '../src/semantic-cache.js';
import { createOcrManifest } from '../src/asset-pipeline.js';
import { associateOcrResults } from '../src/ocr-results.js';
import { evaluateRuns } from '../src/evaluation.js';

function page(html, url = 'https://example.test/exam-ans/exam/test/start') {
  const dom = fixtureDom('legacy'); dom.reconfigure({ url });
  dom.window.document.body.innerHTML = html; installLayout(dom.window);
  const capture = extractVisibleQuestions(dom.window.document); dom.window.close(); return capture;
}
const question = (id, n, content = '下列哪个为偶数？', options = ['1', '2']) => `<div class="questionLi" id="question${id}"><h3>${n}.（单选题）${content}</h3><ul class="Zy_ulTop">${options.map((o, i) => `<li>${String.fromCharCode(65 + i)}. ${o}</li>`).join('')}</ul></div>`;
const checks = Object.fromEntries(['reading', 'solving', 'numeric', 'mapping'].map(k => [k, { status: 'passed', evidence: 'synthetic verification ' + k }]));

test('exam answering route exposes partial count, timer and missing numbers; login/notes are distinct', () => {
  const c = page('<div class="question-count">共 3 题</div><div role="timer">剩余 01:02:03</div>' + question(1, 2));
  assert.deepEqual([c.page.family, c.page.state, c.page.layout, c.page.coverage], ['exam', 'answering', 'single-question', 'partial']);
  assert.equal(c.page.expectedCount, 3); assert.equal(c.page.remainingSeconds, 3723); assert.deepEqual(c.page.missingNumbers, [1, 3]);
  assert.equal(page('<input type="password">').page.state, 'login');
  assert.equal(page('<div class="examnotes">考试须知</div>', 'https://example.test/exam-ans/exam/test/examcode/examnotes').page.state, 'notes');
});

test('whole assignment and ambiguous total counts never claim unwitnessed completeness', () => {
  const html = '<div class="question-count">共 2 题</div>' + question(1, 1) + question(2, 2);
  assert.equal(page(html, 'https://example.test/mooc-ans/mooc2/work/dowork').page.coverage, 'complete');
  assert.equal(page(question(1, 1)).page.coverage, 'rendered');
  assert.equal(page(html + '<div class="totalNum">共 4 题</div>').page.coverage, 'partial');
  assert.equal(page('<div class="question-count">共 2 题</div>' + question(1, 1) + question(2, 1)).page.coverage, 'partial');
});

test('graded fixtures remain separate test inputs and do not become shared material or leak into solve packets', () => {
  const c = page(`<div class="fanyaMarking" id="questionWrap"><div class="mark_title">共 1 题</div><div class="mark_answerCard">DECORATION_SECRET</div><div class="singleQuesId" id="question1"><h3>1.（单选题）2+2？</h3><ul class="mark_letter"><li>A. 4</li><li>B. 5</li></ul><div class="mark_answer">REFERENCE_ONLY_SECRET<img alt="REVIEW_IMAGE_SECRET" src="x.png"></div></div></div>`);
  assert.equal(c.count, 1); assert.equal(c.questions[0].options.length, 2); assert.equal(c.contexts.length, 0); assert.equal(c.page.state, 'graded');
  const { packet, reference } = prepareAnswers(c);
  assert.ok(!JSON.stringify(packet).includes('REFERENCE_ONLY_SECRET')); assert.ok(!JSON.stringify(packet).includes('REVIEW_IMAGE_SECRET'));
  assert.ok(JSON.stringify(reference).includes('REFERENCE_ONLY_SECRET'));
});

test('MathJax SVG child root recovers full TeX without treating subexpressions as alternatives', () => {
  const c = page(question(1, 1, '求 <svg><g data-mml-node="math" data-latex="x^{2}+1"><g data-mml-node="mi" data-latex="x"></g></g></svg>'));
  assert.equal(c.assets[0].sourceText, 'x^{2}+1'); assert.equal(c.assets[0].sourceStatus, 'canonical');
  assert.equal(c.ocrQueue.length, 0); assert.equal(c.visualQueue.length, 0);
  const conflict = page(question(1, 1, '<svg data-latex="x+2"><g data-mml-node="math" data-latex="x+1"></g></svg>'));
  assert.equal(conflict.assets[0].sourceStatus, 'conflicting'); assert.equal(conflict.ocrQueue.length, 1);
});

test('exact duplicate stems reuse reasoning with current option remapping; negation/units stay distinct', () => {
  const c = page(question(1, 1) + question(2, 2, undefined, ['2', '1']) + question(3, 3, '下列哪个不是偶数？') + question(4, 4, '速度为 2 m/s？') + question(5, 5, '速度为 2 km/s？'));
  const reuse = planQuestionReuse(c);
  assert.equal(reuse.uniqueReasoningTasks, 4); assert.equal(reuse.questions[1].reuseFrom, c.questions[0].key);
  const candidate = remapChoiceAnswer(c, c.questions[0].key, c.questions[1].key, ['B']);
  assert.deepEqual(candidate.choices, ['A']); assert.equal(candidate.status, 'candidate'); assert.equal(candidate.requiresMappingCheck, true);
  assert.equal(remapChoiceAnswer(c, c.questions[0].key, c.questions[2].key, ['B']).status, 'review');
  const changed = structuredClone(c); changed.captureId = 'other'; changed.capturedAt = 'later'; changed.questions[0].options[0].selected = true;
  assert.equal(fingerprintQuestion(c, c.questions[0]).fingerprint, fingerprintQuestion(changed, changed.questions[0]).fingerprint);
});

test('unresolved images cannot reuse answers; equal verified image bytes and shared material are required', () => {
  const c = page(question(1, 1, '<img src="same.png">') + question(2, 2, '<img src="same.png">'));
  assert.equal(planQuestionReuse(c).uniqueReasoningTasks, 2);
  const assetContent = c.assets.map(a => ({ assetId: a.assetId, sha256: 'a'.repeat(64) }));
  const readings = assetContent.map(a => ({ assetId: a.assetId, sourceSha256: a.sha256, text: 'x > 0', verified: true }));
  assert.equal(planQuestionReuse(c, { readings, assetContent }).uniqueReasoningTasks, 1);
  readings[1].text = 'x < 0';
  assert.equal(planQuestionReuse(c, { readings, assetContent }).uniqueReasoningTasks, 2);
});

test('formatter requires separate evidence, resolves verified image options and outputs scheme 3', () => {
  const c = page(question(1, 1, '选择正值', ['<img src="option.png">', '0']));
  const { template } = prepareAnswers(c); const a = template.answers[0];
  a.status = 'ready'; a.choices = ['A']; a.reviewedAssetIds = c.assets.map(x => x.assetId); a.reviewedWarnings = c.questions[0].warnings; a.checks = checks;
  assert.equal(formatAnswers(c, template).pending, 1);
  template.readings = [{ assetId: c.assets[0].assetId, verified: true, text: '1/2 m' }];
  const sheet = formatAnswers(c, template);
  assert.equal(sheet.ready, 1); assert.match(sheet.markdown, /题号 \| 答案 \| 简短对照/); assert.ok(!sheet.markdown.includes('[[')); assert.equal(sheet.rows[0].details, '1/2 m');
  delete a.checks.mapping;
  assert.equal(formatAnswers(c, template).pending, 1);
});

test('equal captions do not erase the order of distinct diagram pixels', () => {
  const c = page(question(1, 1, '<img src="a.png"><img src="b.png">') + question(2, 2, '<img src="b.png"><img src="a.png">'));
  const assetContent = c.assets.map((a, i) => ({ assetId: a.assetId, sha256: (i === 0 || i === 3 ? 'a' : 'b').repeat(64) }));
  const readings = assetContent.map(a => ({ assetId: a.assetId, sourceSha256: a.sha256, text: '示意图', verified: true }));
  assert.equal(planQuestionReuse(c, { readings, assetContent }).uniqueReasoningTasks, 2);
});

test('equal content OCR is read once and safely fans out to all asset IDs and questions', () => {
  const c = page(question(1, 1, '<img src="one.png">') + question(2, 2, '<img src="two.png">'));
  const hash = 'e'.repeat(64), captureHash = 'f'.repeat(64);
  const manifest = { captureHash, ...createOcrManifest(c.assets.map(a => ({ ...a, sha256: hash, path: 'local/image.png', questionKeys: [a.questionKey], status: 'ready' }))) };
  assert.equal(manifest.images.length, 1); assert.equal(manifest.images[0].aliases.length, 2);
  const first = manifest.images[0];
  const associated = associateOcrResults(c, manifest, { results: [{ imageKey: first.imageKey, questionKey: first.questionKey, sourceSha256: hash, status: 'recognized', text: 'x=1' }] }, { captureHash });
  assert.equal(associated.readings.length, 2); assert.equal(associated.unresolved.length, 0); assert.ok(associated.readings.every(r => r.verified === false));
});

test('failure cache expires, stays unverified and changes with recognition configuration', () => {
  const entry = cacheReading({ status: 'empty', text: '' }, 100, 50);
  assert.equal(lookupReading(entry, 149).retrySuppressed, true); assert.equal(lookupReading(entry, 150), null);
  assert.equal(lookupReading(cacheReading({ status: 'recognized', text: 'a', verified: true }, 100), 10000).verified, false);
  assert.notEqual(readingCacheKey('a'.repeat(64), { engine: 'OCR', version: 1 }), readingCacheKey('a'.repeat(64), { engine: 'OCR', version: 2 }));
});

test('blind evaluation reports accuracy alongside coverage, missing runs and measured stage percentiles', () => {
  const dataset = { schema: 'chaoxing-evaluation-set/v1', cases: [{ id: 'a', expected: [{ questionKey: '1', value: 'B' }, { questionKey: '2', value: ['A', 'C'], unordered: true }] }] };
  const report = evaluateRuns(dataset, [{ caseId: 'a', mode: 'improved', trial: 0, answers: [{ questionKey: '1', status: 'ready', value: 'B' }], timings: { totalMs: 100, extractionMs: 20 } }]);
  assert.equal(report.modes[1].accuracy, 1); assert.equal(report.modes[1].coverage, 0.5); assert.equal(report.modes[1].overallCorrectRate, 0.5);
  assert.equal(report.modes[1].timings.totalMs.p95, 100); assert.equal(report.modes[2].timings.totalMs.p50, null); assert.equal(report.modes[0].missingRuns, 1);
});
