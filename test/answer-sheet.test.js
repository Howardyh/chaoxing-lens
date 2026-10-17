import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAnswers, formatAnswers } from '../src/answer-sheet.js';
import { extractVisibleQuestions } from '../src/extractor.js';
import { fixtureDom } from './dom-helper.js';

function fixture(name = 'legacy') {
  const dom = fixtureDom(name), capture = extractVisibleQuestions(dom.window.document);
  dom.window.close(); return capture;
}
function solved(capture) {
  const { template, packet } = prepareAnswers(capture);
  for (const [i, a] of template.answers.entries()) {
    const q = packet.questions[i];
    a.status = 'ready';
    // Synthetic test data only; never mark actual review this way.
    a.reviewedAssetIds = q.reviewAssetIds; a.reviewedWarnings = q.warnings;
    if ('choices' in a) a.choices = [q.options[0].label || q.options[0].text];
    else if ('blanks' in a) a.blanks = q.controls.filter(c => ['text', 'textarea', 'contenteditable'].includes(c.kind)).map((_, i) => String(i + 1));
    else a.text = '合成答案';
  }
  return template;
}

test('reasoning packet preserves full semantics and shared content without mutating capture', () => {
  for (const name of ['legacy', 'source', 'edge']) {
    const c = fixture(name), before = JSON.stringify(c), { packet } = prepareAnswers(c);
    assert.equal(JSON.stringify(c), before); assert.equal(packet.questions.length, c.questions.length);
    for (const [i, q] of c.questions.entries()) {
      const p = packet.questions[i]; assert.equal(p.prompt, q.prompt);
      assert.deepEqual(p.options.map(o => [o.label, o.text, o.assetIds, o.selected]), q.options.map(o => [o.label, o.text, o.assetIds, o.selected]));
      for (const field of ['contextIds', 'visibleReview', 'warnings']) assert.deepEqual(p[field], q[field]);
      assert.equal(p.locator, undefined); assert.equal(p.bounds, undefined);
      assert.deepEqual(p.controls.map(x => x.currentText), q.controls.map(x => x.currentText));
    }
    for (const [i, a] of c.assets.entries()) {
      for (const field of ['assetId', 'sources', 'sourceText', 'sourceStatus', 'sourceConflict', 'unsupportedMath', 'requiresVisualReview', 'requiresOCR']) assert.deepEqual(packet.assets[i][field], a[field]);
    }
    assert.deepEqual(packet.contexts.map(x => x.text), c.contexts.map(x => x.text));
    assert.deepEqual(packet.warnings, c.warnings);
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) < Buffer.byteLength(before));
  }
});

test('shared asset is queued once and required for all consumers', () => {
  const { packet } = prepareAnswers(fixture()), task = packet.reviewTasks.find(t => t.questionKeys.length > 1);
  assert.deepEqual(task.modes, ['ocr', 'visual']);
  assert.equal(packet.reviewTasks.filter(t => t.assetId === task.assetId).length, 1);
  for (const key of task.questionKeys) assert.ok(packet.questions.find(q => q.key === key).reviewAssetIds.includes(task.assetId));
});

test('mixed questions use original order, separated multi-choice and literal judgment text', () => {
  const c = fixture(), answers = solved(c);
  answers.answers[1].choices = ['C', 'A']; answers.answers[2].choices = [c.questions[2].options[1].text]; answers.answers[3].blanks = ['2', '4'];
  answers.answers.reverse();
  const sheet = formatAnswers(c, answers);
  assert.equal(sheet.ready, 9); assert.deepEqual(sheet.rows.map(r => r.label), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.equal(sheet.rows[1].answer, 'A、C'); assert.equal(sheet.rows[2].answer, c.questions[2].options[1].text);
  assert.match(sheet.rows[2].answer, /错误/); assert.deepEqual(sheet.rows[3].blocks.map(x => x.value), ['2', '4']);
});

test('missing, draft, invalid options and missing blanks remain explicitly pending', () => {
  const c = fixture(), answers = solved(c);
  answers.answers[0].choices = ['Z']; answers.answers[1].status = 'review'; answers.answers[1].note = '否定条件需核对';
  answers.answers[2].choices.push(c.questions[2].options[1].label); answers.answers[3].blanks = ['2']; answers.answers.pop();
  const sheet = formatAnswers(c, answers);
  for (const i of [0, 1, 2, 3, 8]) { assert.equal(sheet.rows[i].status, 'review'); assert.equal(sheet.rows[i].answer, null); }
  assert.equal(sheet.pending, 5); assert.ok(!sheet.markdown.includes('| 1 | Z |'));
});

test('visual review cannot be inferred from OCR, ready status or another question', () => {
  const c = fixture(), answers = solved(c), { packet } = prepareAnswers(c);
  for (const a of answers.answers) a.reviewedAssetIds = [];
  const sheet = formatAnswers(c, answers);
  for (const q of packet.questions.filter(q => q.reviewAssetIds.length)) assert.equal(sheet.rows.find(r => r.questionKey === q.key).status, 'review');
  assert.ok(sheet.ready > 0);
});

test('capture binding rejects old captures and changed option order or material', () => {
  const c = fixture(), answers = solved(c);
  for (const mutate of [x => { x.captureId += 'new'; }, x => { x.questions[0].options.reverse(); }, x => { x.contexts[0].text += ' changed'; }, x => { x.assets[0].sourceText += ' changed'; }]) {
    const changed = structuredClone(c); mutate(changed);
    assert.throws(() => formatAnswers(changed, answers), /different or changed capture/);
  }
});

test('unknown or duplicated answer keys fail; duplicated or missing numbers are disambiguated', () => {
  const c = fixture(), answers = solved(c); answers.answers.push({ ...answers.answers[0] });
  assert.throws(() => formatAnswers(c, answers), /duplicate questionKey/);
  answers.answers.at(-1).questionKey = 'other-question'; assert.throws(() => formatAnswers(c, answers), /Unknown answer/);
  c.questions[1].questionNumber = 1; c.questions[2].questionNumber = null;
  const sheet = formatAnswers(c, solved(c));
  assert.deepEqual(sheet.rows.slice(0, 3).map(r => r.label), ['1（页面第1题）', '1（页面第2题）', '无题号（页面第3题）']);
  assert.ok(sheet.rows[0].details.includes('题干：'));
});

test('warnings and incomplete scope survive formatting; no zero-question completion claim', () => {
  const c = fixture(); c.warnings.push({ frame: 'frame-2', reason: 'frame-inaccessible' }); c.questions[0].warnings.push('empty-prompt: inspect DOM/screenshot');
  const answers = solved(c); answers.answers[0].reviewedWarnings = [];
  const sheet = formatAnswers(c, answers); assert.equal(sheet.rows[0].status, 'review');
  assert.match(sheet.markdown, /frame-inaccessible/); assert.match(sheet.markdown, /本次已读取范围/);
  const empty = { ...c, count: 0, questions: [], contexts: [], assets: [], ocrQueue: [], visualQueue: [] };
  assert.equal(formatAnswers(empty, prepareAnswers(empty).template).ready, 0);
});

test('copy blocks preserve formula, units, newlines and embedded code fences exactly', () => {
  const c = fixture(), answers = solved(c), value = 'x = \\frac{1}{2} m/s\n```\n(a < b) & c';
  answers.answers[4].text = value; answers.answers[3].blanks = ['m/s', 'A|B'];
  const sheet = formatAnswers(c, answers); assert.equal(sheet.rows[4].blocks[0].value, value);
  assert.ok(sheet.markdown.includes('````text\n' + value + '\n````')); assert.ok(sheet.markdown.includes('```text\nA|B\n```'));
});

test('ambiguous choice labels and duplicate choices cannot become fill-ready', () => {
  const c = fixture(); c.questions[0].options[1].label = c.questions[0].options[0].label;
  const answers = solved(c); answers.answers[1].choices = ['A', 'A'];
  const sheet = formatAnswers(c, answers); assert.equal(sheet.rows[0].status, 'review'); assert.equal(sheet.rows[1].status, 'review');
});

test('dangling references and inconsistent counts cannot silently omit material', () => {
  for (const mutate of [c => { c.questions[0].contextIds.push('missing'); }, c => { c.questions[0].assetIds.push('missing'); }, c => { c.count++; }, c => { c.ocrQueue[0].questionKeys.push('missing'); }]) {
    const c = fixture(); mutate(c); assert.throws(() => prepareAnswers(c));
  }
});
