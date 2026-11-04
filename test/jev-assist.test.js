import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJevRequest, runJevCheck } from '../src/jev-assist.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'); // Header-only mock: no decoder or live call.
const response = answers => async () => ({ ok: true, json: async () => ({ model: 'fixture-model', answers, usage: { input_tokens: 100, output_tokens: 10 } }) });

test('Jev state contains only scrubbed excerpt and chosen crop, never exam identifiers or arbitrary instructions', () => {
  const request = buildJevRequest({ text: '姓名：测试同学\n学号：123456789012\n以下哪个不正确？ https://example.test/private?token=secret', checks: ['polarity', 'type'] });
  const text = JSON.stringify(request);
  for (const secret of ['测试同学', '123456789012', 'token=secret']) assert.ok(!text.includes(secret));
  assert.equal(request.questions.negative_instruction.type, 'noul'); assert.equal(request.questions.question_type.type, 'choice');
  assert.throws(() => buildJevRequest({ checks: ['solve'] }));
});

test('choice needs readability, existence and high confidence; cannot verify a mathematical answer', async () => {
  const request = buildJevRequest({ image: { bytes: png, format: 'png' }, checks: ['transcription'], candidates: ['-x', '+x'] });
  const base = { readable: { noul: 0.99 }, candidate_exists: { noul: 0.01 }, transcription: { choice: 'candidate_1', confidence: 0.99, probabilities: { candidate_1: 0.995, candidate_2: 0.005 } } };
  const failed = await runJevCheck(request, { apiKey: 'fixture-key', fetchImpl: response(base) });
  assert.equal(failed.checks.transcription.outcome, 'inconclusive'); assert.equal(failed.verified, false);
  const passed = await runJevCheck(request, { apiKey: 'fixture-key', fetchImpl: response({ ...base, candidate_exists: { noul: 0.99 } }) });
  assert.equal(passed.checks.transcription.outcome, 'supported'); assert.equal(passed.model, 'fixture-model'); assert.equal(passed.estimatedCostUSD, null); assert.deepEqual(passed.usage, { input_tokens: 100, output_tokens: 10 });
});

test('timeouts, provider errors, missing credentials and malformed response fall back without a false judgment', async () => {
  const request = buildJevRequest({ text: '哪个不正确？' });
  assert.equal((await runJevCheck(request, { apiKey: '' })).status, 'unavailable');
  const timeout = await runJevCheck(request, { apiKey: 'fixture', timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
  assert.equal(timeout.reason, 'timeout'); assert.deepEqual(timeout.checks, {});
  const error = await runJevCheck(request, { apiKey: 'fixture', fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.equal(error.reason, 'http-429'); assert.equal(error.fallback, 'Codex');
  const malformed = await runJevCheck(request, { apiKey: 'fixture', fetchImpl: response({ negative_instruction: { noul: 'yes' } }) });
  assert.equal(malformed.checks.negative_instruction.outcome, 'inconclusive');
});

test('transport does not retry, enables images explicitly and never logs authentication', async () => {
  let calls = 0;
  const request = buildJevRequest({ image: { bytes: png, format: 'png' }, checks: ['readability'] });
  const result = await runJevCheck(request, { apiKey: 'fixture-secret', fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(options.headers['TypeSafe-Danger-Zone-Images'], 'true'); assert.equal(options.redirect, 'error');
    throw new Error('provider included fixture-secret');
  } });
  assert.equal(calls, 1); assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  await assert.rejects(runJevCheck(request, { endpoint: 'https://example.test' }));
});
