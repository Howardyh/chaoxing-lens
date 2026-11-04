import { createHash } from 'node:crypto';

const probability = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const noul = instructions => ({ type: 'noul', instructions });
const scrub = value => String(value || '').replace(/https?:\/\/\S+/gi, '[URL removed]').replace(/[\w.+-]+@[\w.-]+\.[a-z]+/gi, '[email removed]').replace(/(?:姓名|学号|学生姓名|student\s*id)\s*[:：][^\n]*/gi, '[identity removed]').replace(/\b\d{12,}\b/g, '[identifier removed]').trim();

// Fixed, atomic reading questions. This adapter never asks Jev to solve a subject
// question, calculate a value, choose an exam answer, or mark a record verified.
export function buildJevRequest({ text = '', image, checks = ['polarity'], candidates = [], model = 'jev-latest' } = {}) {
  if (!Array.isArray(checks) || !checks.length || new Set(checks).size !== checks.length || checks.some(c => !['polarity', 'type', 'readability', 'transcription'].includes(c))) throw new Error('Unsupported or repeated Jev check');
  if (typeof text !== 'string' || text.length > 6000 || typeof model !== 'string' || !/^[\w.:-]{1,100}$/.test(model)) throw new Error('Use one minimal excerpt and an explicit model ID');
  const excerpt = scrub(text), questions = {};
  const state = { excerpt };
  let assets;
  if (checks.some(c => ['readability', 'transcription'].includes(c))) {
    if (!image || !['png', 'jpg', 'jpeg'].includes(image.format) || !(image.bytes instanceof Uint8Array) || !image.bytes.length || image.bytes.length > 4 * 1024 * 1024) throw new Error('A local crop of at most 4 MiB is required');
    const bytes = Buffer.from(image.bytes);
    if (image.format === 'png' ? !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Image format does not match bytes');
    state.image = 'lens_crop';
    assets = { lens_crop: { type: 'image', format: image.format, data_base64: bytes.toString('base64') } };
    questions.readable = noul('Are all mathematical symbols and text in this crop visually legible, without clipping or overlap? Judge only image readability, not subject correctness.');
  }
  if (checks.includes('polarity')) {
    if (!excerpt) throw new Error('An explicit stem excerpt is required');
    questions.negative_instruction = noul('Does the excerpt explicitly ask for a false, incorrect, excluded or NOT satisfying item? Report the instruction polarity, not whether a statement is true.');
  }
  if (checks.includes('type')) {
    if (!excerpt) throw new Error('An explicit format excerpt is required');
    questions.type_explicit = noul('Does this excerpt explicitly specify the answer format as single-choice, multiple-choice, true-false, fill-in, or written response?');
    questions.question_type = { type: 'choice', instructions: 'Which answer format is explicitly stated?', criteria: { single: 'Select exactly one option', multiple: 'Select all applicable options', judgment: 'True or false', blanks: 'Fill ordered blank slots', written: 'Provide a written explanation or calculation' } };
  }
  if (checks.includes('transcription')) {
    if (candidates.length < 2 || candidates.length > 8 || candidates.some(s => typeof s !== 'string' || !s.trim() || s.length > 1000) || new Set(candidates).size !== candidates.length) throw new Error('Supply 2-8 distinct literal transcription candidates');
    state.candidates = Object.fromEntries(candidates.map((s, i) => ['candidate_' + (i + 1), scrub(s)]));
    questions.candidate_exists = noul('Does at least one supplied candidate reproduce every visible symbol in the crop exactly, including signs, denominators, exponents and units? If none does, answer no.');
    questions.transcription = { type: 'choice', instructions: 'Which literal transcription best matches the crop? Do not repair, simplify, solve or infer omitted content.', criteria: state.candidates };
  }
  return { model, state, questions, ...(assets ? { assets } : {}) };
}

export async function runJevCheck(request, { apiKey = process.env.TYPESAFE_API_KEY, fetchImpl = globalThis.fetch, timeoutMs = 5000, threshold = 0.9, prices, endpoint = 'https://api.typesafe.ai/v1/systemone' } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !probability(threshold) || threshold < 0.5) throw new Error('Invalid Jev timeout/threshold');
  const url = new URL(endpoint);
  if (url.origin !== 'https://api.typesafe.ai' || url.pathname !== '/v1/systemone' || url.search || url.username || url.password) throw new Error('Unexpected Jev endpoint');
  const body = JSON.stringify(request), start = performance.now();
  const record = { schema: 'chaoxing-jev-check/v1', payloadVersion: 1, requestHash: createHash('sha256').update(body).digest('hex'), payloadBytes: Buffer.byteLength(body), model: request.model, threshold, verified: false, latencyMs: 0, usage: null, estimatedCostUSD: null, checks: {}, fallback: 'Codex' };
  if (!apiKey) return { ...record, status: 'unavailable', reason: 'missing-api-key' };
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, timeoutMs); });
    // One request and no automatic retry. The caller chooses whether another
    // paid call is justified. The deadline covers body decoding as well.
    const result = await Promise.race([deadline, (async () => {
      const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(request.assets ? { 'TypeSafe-Danger-Zone-Images': 'true' } : {}) }, body, signal: controller.signal });
      if (!response.ok) throw new Error(`http-${response.status}`);
      return response.json();
    })()]);
    record.model = result.model || request.model;
    if (result.usage && ['input_tokens', 'output_tokens'].every(k => Number.isFinite(result.usage[k]) && result.usage[k] >= 0)) record.usage = { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens };
    if (record.usage && prices && ['inputPerMillionUSD', 'outputPerMillionUSD'].every(k => Number.isFinite(prices[k]) && prices[k] >= 0)) record.estimatedCostUSD = (record.usage.input_tokens * prices.inputPerMillionUSD + record.usage.output_tokens * prices.outputPerMillionUSD) / 1e6;
    for (const [key, q] of Object.entries(request.questions)) {
      const a = result.answers?.[key];
      if (q.type === 'noul') {
        record.checks[key] = { probability: probability(a?.noul) ? a.noul : null, outcome: !probability(a?.noul) ? 'inconclusive' : a.noul >= threshold ? 'supported' : a.noul <= 1 - threshold ? 'rejected' : 'inconclusive' };
      } else if (q.type === 'choice') {
        const keys = Object.keys(q.criteria), probabilities = a?.probabilities;
        const valid = keys.includes(a?.choice) && probability(a?.confidence) && probabilities && Object.keys(probabilities).length === keys.length && keys.every(k => probability(probabilities[k])) && Math.abs(Object.values(probabilities).reduce((n, p) => n + p, 0) - 1) < 0.01 && keys.every(k => probabilities[a.choice] >= probabilities[k]);
        const gate = key === 'transcription' ? ['candidate_exists', 'readable'] : ['type_explicit'];
        record.checks[key] = { candidate: valid ? a.choice : null, confidence: valid ? a.confidence : null, probabilities: valid ? probabilities : null, outcome: valid && a.confidence >= threshold && gate.every(g => record.checks[g]?.outcome === 'supported') ? 'supported' : 'inconclusive' };
      }
    }
    record.status = Object.values(record.checks).some(c => c.outcome === 'inconclusive') ? 'inconclusive' : 'completed';
  } catch (error) {
    record.status = 'fallback';
    // Never print arbitrary provider error bodies, auth headers or request data.
    record.reason = controller.signal.aborted ? 'timeout' : /^http-\d{3}$/.test(error.message) ? error.message : 'transport-or-response-error';
  } finally { clearTimeout(timer); record.latencyMs = +(performance.now() - start).toFixed(2); }
  return record;
}
