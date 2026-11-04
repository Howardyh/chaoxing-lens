import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractVisibleQuestions } from '../src/extractor.js';
import { fixtureDom } from './dom-helper.js';
const root = fileURLToPath(new URL('../', import.meta.url));
function run(script, args) {
  const output = spawnSync(process.execPath, [path.join(root, 'skill/scripts', script), ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(output.status, 0, output.stderr); return output;
}

test('built skill CLIs run independently and keep evaluation references out of the solve packet', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chaoxing-portable-test-'));
  try {
    const dom = fixtureDom('legacy'), c = extractVisibleQuestions(dom.window.document); dom.window.close();
    const capture = path.join(directory, 'capture.json'), output = path.join(directory, 'run');
    writeFileSync(capture, JSON.stringify(c, null, 2));
    run('prepare-answers.mjs', [capture, output]);
    const packet = JSON.parse(readFileSync(path.join(output, 'solve-packet.json')));
    assert.equal(packet.schema, 'chaoxing-solve-packet/v2'); assert.equal(packet.questions[0].visibleReview, undefined);
    assert.ok(readFileSync(path.join(output, 'evaluation-reference.json'), 'utf8').includes('SENTINEL_REVIEW_LIST'));
    const sheet = path.join(directory, 'sheet.md');
    run('format-answers.mjs', [capture, path.join(output, 'answers.json'), sheet]);
    assert.match(readFileSync(sheet, 'utf8'), /题号 \| 答案 \| 简短对照/);
    const input = path.join(directory, 'jev.json'), preview = path.join(directory, 'preview.json');
    writeFileSync(input, JSON.stringify({ text: '以下哪个不正确？', checks: ['polarity'] }));
    run('check-jev.mjs', [input, preview]);
    assert.equal(JSON.parse(readFileSync(preview)).schema, 'chaoxing-jev-preview/v1');
  } finally {
    if (!path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(directory).startsWith('chaoxing-portable-test-')) throw new Error('Unsafe temporary cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
