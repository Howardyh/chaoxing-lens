import { createHash } from 'node:crypto';

export const contentHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normal = value => String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const stripNumber = value => normal(value).replace(/^\d+[.．、]\s*/, '');
export const optionContent = option => normal(option.text).replace(option.label ? new RegExp('^' + option.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[.、．:：)）\\s]+') : /$^/, '');

// Only verified, nonempty transcriptions or conflict-free canonical sources can
// replace internal asset tokens. OCR confidence/cache hits are insufficient.
export function resolveText(value, capture, readings = []) {
  let text = String(value ?? '');
  const unresolved = [];
  for (const asset of capture.assets || []) {
    const token = '[[' + asset.assetId + (asset.sourceText ? ': ' + asset.sourceText : '') + ']]';
    if (!text.includes(token)) continue;
    const reading = readings.find(r => r.assetId === asset.assetId && r.verified === true && typeof r.text === 'string' && r.text.trim());
    const replacement = asset.sourceStatus === 'canonical' && !asset.sourceConflict ? asset.sourceText : reading?.text;
    if (replacement) text = text.split(token).join(replacement);
    else unresolved.push(asset.assetId);
  }
  return { text, unresolved };
}

export function fingerprintQuestion(capture, question, { readings = [], assetContent = [] } = {}) {
  const used = new Set([...question.assetIds, ...question.options.flatMap(o => o.assetIds || [])]);
  const contexts = question.contextIds.map(id => {
    const context = capture.contexts.find(c => c.id === id);
    if (!context) throw new Error('Unknown shared material');
    context.assetIds.forEach(id => used.add(id));
    return context.text;
  });
  const incomplete = [], visual = [];
  for (const id of used) {
    const asset = capture.assets.find(a => a.assetId === id);
    if (!asset || ['review', 'current-answer'].includes(asset.owner)) continue;
    const sha256 = assetContent.find(a => a.assetId === id)?.sha256 || asset.sha256;
    const reading = readings.find(r => r.assetId === id && r.verified === true && r.text?.trim());
    if (asset.sourceStatus === 'canonical' && !asset.sourceConflict && !asset.requiresVisualReview) continue;
    if (!/^[a-f\d]{64}$/i.test(sha256 || '') || !reading || reading.sourceSha256 !== sha256) incomplete.push(id);
    else visual.push(sha256.toLowerCase());
  }
  const resolve = value => {
    let bound = String(value);
    for (const id of used) {
      const asset = capture.assets.find(a => a.assetId === id);
      if (!asset || asset.sourceStatus === 'canonical' && !asset.sourceConflict && !asset.requiresVisualReview) continue;
      const sha256 = assetContent.find(a => a.assetId === id)?.sha256 || asset.sha256;
      const reading = readings.find(r => r.assetId === id && r.verified && r.sourceSha256 === sha256 && r.text?.trim());
      const token = '[[' + id + (asset.sourceText ? ': ' + asset.sourceText : '') + ']]';
      if (reading && /^[a-f\d]{64}$/i.test(sha256 || '')) bound = bound.split(token).join(`[visual:${sha256.toLowerCase()}:${normal(reading.text)}]`);
    }
    const r = resolveText(bound, capture, readings);
    incomplete.push(...r.unresolved);
    return normal(r.text);
  };
  const options = question.options.map(o => resolve(optionContent(o)));
  const body = { version: 1, type: question.type, prompt: stripNumber(resolve(question.prompt)), contexts: contexts.map(resolve), assets: visual.sort() };
  const stemFingerprint = contentHash(body);
  const reusable = !incomplete.length && question.type !== 'unknown' && !question.warnings.some(w => /empty-prompt|image-not-loaded/.test(w));
  return { stemFingerprint, fingerprint: contentHash({ ...body, options: [...options].sort() }), optionFingerprints: options.map(contentHash), reusable, unresolvedAssetIds: [...new Set(incomplete)] };
}

export function planQuestionReuse(capture, options) {
  const groups = new Map(), questions = [];
  for (const question of capture.questions) {
    const identity = fingerprintQuestion(capture, question, options);
    const first = identity.reusable ? groups.get(identity.fingerprint) : null;
    if (identity.reusable && !first) groups.set(identity.fingerprint, question.key);
    questions.push({ questionKey: question.key, ...identity, reuseFrom: first || null });
  }
  return { schema: 'chaoxing-question-reuse/v1', uniqueReasoningTasks: questions.filter(q => !q.reuseFrom).length, questions };
}

// Return a candidate only. Each destination still needs its own reading and
// mapping checks; numeric/semantic verification cannot be inherited as letters.
export function remapChoiceAnswer(capture, fromKey, toKey, choices, options) {
  const from = capture.questions.find(q => q.key === fromKey), to = capture.questions.find(q => q.key === toKey);
  if (!from || !to) throw new Error('Unknown reuse question');
  const a = fingerprintQuestion(capture, from, options), b = fingerprintQuestion(capture, to, options);
  if (!a.reusable || !b.reusable || a.fingerprint !== b.fingerprint) return { status: 'review', reason: 'content-differs-or-incomplete' };
  if (!Array.isArray(choices) || !choices.length || new Set(choices).size !== choices.length || from.type !== 'multiple-choice' && choices.length !== 1) return { status: 'review', reason: 'invalid-source-choices' };
  const selected = choices.map(label => from.options.findIndex(o => (o.label || o.text) === label));
  const mapped = [];
  for (const index of selected) {
    const matches = b.optionFingerprints.map((fp, i) => fp === a.optionFingerprints[index] ? i : -1).filter(i => i >= 0);
    if (index < 0 || matches.length !== 1 || a.optionFingerprints.filter(fp => fp === a.optionFingerprints[index]).length !== 1) return { status: 'review', reason: 'ambiguous-option-content' };
    const option = to.options[matches[0]];
    mapped.push(option.label || option.text);
  }
  return { status: 'candidate', choices: mapped, fromKey, toKey, requiresMappingCheck: true };
}

// A local failure cache suppresses immediate retries without turning a failure
// into a successful reading. Keys must include engine/configuration identity.
export function readingCacheKey(sha256, config) {
  if (!/^[a-f\d]{64}$/i.test(sha256) || !config?.engine || !config?.version) throw new Error('Content hash and engine/version required');
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
  return contentHash({ schema: 'chaoxing-reading-cache/v1', sha256: sha256.toLowerCase(), config: stable(config) });
}
export function cacheReading(result, now = Date.now(), failureTtlMs = 60000) {
  if (!Number.isFinite(now) || !Number.isFinite(failureTtlMs) || failureTtlMs < 0 || failureTtlMs > 300000) throw new Error('Invalid failure cache budget');
  const success = result.status === 'recognized' && Boolean(result.text?.trim());
  return { schema: 'chaoxing-reading-cache-entry/v1', createdAt: now, expiresAt: success ? null : now + failureTtlMs, result: { ...result, verified: false }, retrySuppressed: !success };
}
export function lookupReading(entry, now = Date.now()) {
  if (!entry || entry.schema !== 'chaoxing-reading-cache-entry/v1' || entry.expiresAt !== null && now >= entry.expiresAt) return null;
  return { ...entry.result, verified: false, cacheHit: true, retrySuppressed: entry.retrySuppressed };
}
