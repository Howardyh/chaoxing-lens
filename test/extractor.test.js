import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVisibleQuestions } from '../src/extractor.js';
import { fixtureDom, assetsFor, tasksFor } from './dom-helper.js';

function capture(name, options) { const dom = fixtureDom(name); const before = dom.window.document.body.innerHTML; const data = extractVisibleQuestions(dom.window.document, options); assert.equal(dom.window.document.body.innerHTML, before); return { data, dom }; }
function byNumber(c, n) { return c.questions.find(q => q.questionNumber === n); }

test('source-first: preserves every question and source structure without hidden data', () => {
  const { data: c, dom } = capture('source');
  assert.equal(c.schema, 'chaoxing-visible-questions/v3'); assert.equal(c.count, 8);
  assert.equal(c.frames.length, 1); assert.equal(c.frames[0].frame, 'top');
  assert.ok(c.frames[0].viewport.width > 0);
  assert.deepEqual(c.questions.map(q => q.questionNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
  const serialized = JSON.stringify(c);
  for (const token of ['SOURCE_HIDDEN_ANSWER_SECRET', 'SOURCE_HIDDEN_TEXT_SECRET', 'SOURCE_INVISIBLE_TEXT_SECRET', 'SOURCE_HOSTILE_SCRIPT_SENTINEL', 'DO_NOT_EXPORT', '[Circular]']) assert.ok(!serialized.includes(token), token);
  assert.match(byNumber(c, 1).prompt, /x\^\{2\}/); assert.match(byNumber(c, 1).prompt, /H_\{2\}O/);
  assert.ok(assetsFor(c, byNumber(c, 2)).some(a => a.sourceText.includes('\\frac{-b')));
  assert.equal(tasksFor(c, byNumber(c, 2)).length, 0);
  assert.ok(tasksFor(c, byNumber(c, 3)).length > 0);
  assert.equal(tasksFor(c, byNumber(c, 4)).length, 0);
  assert.ok(assetsFor(c, byNumber(c, 4)).some(a => a.sourceText.includes('F=ma')));
  assert.equal(assetsFor(c, byNumber(c, 5)).filter(a => a.kind === 'math').length, 1);
  assert.ok(tasksFor(c, byNumber(c, 6), 'visualQueue').length > 0);
  assert.equal(tasksFor(c, byNumber(c, 6)).length, 0);
  assert.ok(assetsFor(c, byNumber(c, 7)).some(a => a.kind === 'background-image'));
  assert.ok(tasksFor(c, byNumber(c, 7)).length > 0);
  const custom = byNumber(c, 8); assert.equal(custom.options.length, 5);
  assert.deepEqual(custom.options.map(o => o.selected), [true, false, true, false, true]);
  assert.equal(new Set(custom.options.map(o => o.groupLocator)).size, 2);
  assert.match(custom.visibleReview.join(' '), /SOURCE_VISIBLE_REVIEW_SENTINEL/);
  assert.ok(!custom.prompt.includes('SOURCE_VISIBLE_REVIEW_SENTINEL'));
  dom.window.close();
});

test('normalized output has one asset table and resolvable references', () => {
  const { data: c, dom } = capture('source');
  const ids = new Set(c.assets.map(a => a.assetId)); assert.equal(ids.size, c.assets.length);
  for (const q of c.questions) { assert.equal(q.images, undefined); assert.equal(q.math, undefined); assert.equal(q.assets, undefined); assert.equal(q.fullText, undefined); for (const id of q.assetIds) assert.ok(ids.has(id)); }
  for (const t of [...c.ocrQueue, ...c.visualQueue]) { assert.ok(ids.has(t.assetId)); assert.ok(c.questions.some(q => q.key === t.questionKey)); }
  const diagnostic = extractVisibleQuestions(dom.window.document, { diagnostics: true, instrument: true });
  assert.ok(diagnostic.questions.every(q => typeof q.fullText === 'string'));
  assert.ok(diagnostic.metrics || diagnostic.timings);
  dom.window.close();
});

test('legacy types, iframe, shared material and selected controls survive normalization', () => {
  const { data: c, dom } = capture('legacy'); assert.equal(c.count, 9);
  const one = suffix => c.questions.find(q => String(q.sourceId).endsWith(suffix));
  assert.equal(one('101').options.find(o => o.label === 'B').selected, true);
  assert.equal(one('102').controls.filter(t => t.kind === 'checkbox').length, 3);
  assert.equal(one('104').controls.filter(t => t.kind === 'text').length, 2);
  assert.ok(!one('104').controls.some(t => t.kind === 'contenteditable'));
  assert.match(one('104').prompt, /SENTINEL_NONEDITABLE_STEM/);
  assert.ok(one('105').controls.some(t => t.kind === 'contenteditable'));
  assert.notEqual(one('201').frame, 'top');
  assert.equal(c.frames.length, 2);
  const qa = one('110'), qb = one('111'); assert.ok(qa.contextIds.length); assert.deepEqual(qa.contextIds, qb.contextIds);
  assert.equal(c.contexts.filter(ctx => ctx.text.includes('GROUP_CONTEXT_SENTINEL')).length, 1);
  assert.ok(c.ocrQueue.concat(c.visualQueue).some(t => t.questionKeys?.includes(qa.key) && t.questionKeys?.includes(qb.key)));
  const serialized = JSON.stringify(c);
  for (const t of ['HIDDEN_QUESTION_SENTINEL', 'HIDDEN_ANSWER_SECRET_DO_NOT_EXPORT', 'UNTRUSTED_SCRIPT_SENTINEL', 'INVISIBLE_QUESTION_SENTINEL']) assert.ok(!serialized.includes(t));
  dom.window.close();
});

test('semantic edges: fraction conflict, unsupported structure, hidden selection and review controls', () => {
  const { data: c, dom } = capture('edge'); assert.equal(c.count, 5);
  assert.ok(tasksFor(c, byNumber(c, 1)).length);
  assert.ok(assetsFor(c, byNumber(c, 1)).some(a => a.sourceStatus === 'conflicting'));
  assert.ok(tasksFor(c, byNumber(c, 2)).length);
  assert.deepEqual(byNumber(c, 3).options.map(o => o.selected), [false, true]);
  assert.equal(byNumber(c, 4).controls.length, 1); assert.equal(byNumber(c, 4).controls[0].readOnly, true);
  assert.ok(!byNumber(c, 4).controls.some(c => /REFERENCE/.test(c.currentText)));
  assert.equal(byNumber(c, 5).questionNumber, 5);
  dom.window.close();
});

test('stable question and asset identity survives unrelated preceding media', () => {
  const dom = fixtureDom('source'); const doc = dom.window.document;
  const first = extractVisibleQuestions(doc);
  const q3 = byNumber(first, 3); const q3ids = q3.assetIds;
  const img = doc.createElement('img'); img.alt = 'extra'; img.src = 'data:image/png;base64,AA=='; doc.querySelector('#question301').append(img);
  const second = extractVisibleQuestions(doc);
  assert.equal(byNumber(second, 3).key, q3.key); assert.deepEqual(byNumber(second, 3).assetIds, q3ids);
  assert.ok(!q3.key.includes('nth-of-type')); dom.window.close();
});

test('hidden descendants cannot leak through SVG labels or MathML presentation', () => {
  const dom = fixtureDom('source'),doc = dom.window.document;
  doc.querySelector('#question303').insertAdjacentHTML('beforeend','<svg><text>VISIBLE<tspan style="display:none">HIDDEN_SVG_SENTINEL</tspan></text></svg><math><mrow><mi>x</mi><mtext style="display:none">HIDDEN_MATH_SENTINEL</mtext></mrow></math>');
  const c = extractVisibleQuestions(doc),serialized=JSON.stringify(c);
  assert.ok(!serialized.includes('HIDDEN_SVG_SENTINEL'));assert.ok(!serialized.includes('HIDDEN_MATH_SENTINEL'));
  const ml=assetsFor(c,byNumber(c,3)).find(a=>a.kind==='math');assert.notEqual(ml.sourceStatus,'canonical');assert.equal(ml.requiresOCR,true);dom.window.close();
});

test('explicit MathML attribute is parsed without requiring a detached XML window',()=>{
  const dom=fixtureDom('source'),doc=dom.window.document;
  doc.querySelector('#question303 img').setAttribute('data-mathml','<math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mn>1</mn><mn>2</mn></mfrac></math>');
  const c=extractVisibleQuestions(doc),image=assetsFor(c,byNumber(c,3)).find(a=>a.kind==='image');assert.equal(image.sourceStatus,'canonical');assert.equal(image.requiresOCR,false);dom.window.close();
});
