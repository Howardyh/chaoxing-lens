// Pure planning for the observed answering/preview DOM. No browser, network,
// credentials, hidden inputs or guessed endpoints are consulted here.
const finite = n => typeof n === 'number' && Number.isFinite(n);
const rectOK = r => r && [r.x, r.y, r.width, r.height].every(finite) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0;

export function planPageRead(capture, { mode = 'screenshots', padding = 6, maxPixels = 24000000, maxHeight = 8000, expectedCount } = {}) {
  if (capture?.schema !== 'chaoxing-visible-questions/v3' || !capture.captureId) throw new Error('A current v3 capture is required');
  if (!['screenshots', 'originals'].includes(mode) || !finite(padding) || padding < 0 || padding > 128 || !Number.isInteger(maxPixels) || maxPixels < 10000 || !Number.isInteger(maxHeight) || maxHeight < 100) throw new Error('Invalid reading budget');
  if (expectedCount !== undefined && (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || expectedCount > 10000)) throw new Error('Expected count must be observed and bounded');
  const total = expectedCount ?? capture.page?.expectedCount ?? null;
  const numbers = new Set(capture.questions.map(q => q.questionNumber).filter(Number.isSafeInteger));
  const missingNumbers = total === null ? [] : Array.from({ length: total }, (_, i) => i + 1).filter(n => !numbers.has(n));
  const tasks = [...(capture.ocrQueue || []), ...(capture.visualQueue || [])];
  const wanted = new Set(tasks.map(a => a.assetId));
  const assets = capture.assets.filter(a => wanted.has(a.assetId) && !['review', 'current-answer'].includes(a.owner));
  const knownAssets = new Set(capture.assets.map(a => a.assetId));
  const frames = new Map(capture.frames.map(f => [f.frame, f]));
  const screenshots = [];
  const fallbacks = [...wanted].filter(id => !knownAssets.has(id)).map(assetId => ({ assetId, reason: 'queue-asset-missing' }));
  for (const asset of assets) {
    const frame = frames.get(asset.frame), bounds = asset.bounds;
    const reason = asset.frame !== 'top' ? 'frame-tool-required' : !frame || !rectOK(bounds) ? 'geometry-unavailable' : asset.loaded === false ? 'image-unloaded' : asset.unsupportedTransform ? 'unsupported-transform' : null;
    if (reason) { fallbacks.push({ assetId: asset.assetId, reason }); continue; }
    if (mode === 'originals') { fallbacks.push({ assetId: asset.assetId, reason: 'originals-requested' }); continue; }
    const size = frame.documentSize, dpr = Math.max(1, finite(frame.devicePixelRatio) ? frame.devicePixelRatio : 1);
    if (!size || ![size.width, size.height].every(n => finite(n) && n > 0) || bounds.x + bounds.width > size.width + 1 || bounds.y + bounds.height > size.height + 1) { fallbacks.push({ assetId: asset.assetId, reason: 'outside-captured-document' }); continue; }
    const clip = { x: Math.max(0, Math.floor(bounds.x - padding)), y: Math.max(0, Math.floor(bounds.y - padding)) };
    clip.width = Math.ceil(Math.min(size.width, bounds.x + bounds.width + padding)) - clip.x;
    clip.height = Math.ceil(Math.min(size.height, bounds.y + bounds.height + padding)) - clip.y;
    if (clip.height > maxHeight || clip.width * clip.height * dpr * dpr > maxPixels) { fallbacks.push({ assetId: asset.assetId, reason: 'asset-exceeds-screenshot-budget' }); continue; }
    screenshots.push({ frame: asset.frame, clip, dpr, assetIds: [asset.assetId] });
  }
  screenshots.sort((a, b) => a.clip.y - b.clip.y || a.clip.x - b.clip.x);
  const bands = [];
  for (const shot of screenshots) {
    const previous = bands.at(-1), a = previous?.clip, b = shot.clip;
    const merged = a && { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x), height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) };
    if (previous && merged.height <= maxHeight && merged.width * merged.height * shot.dpr * shot.dpr <= maxPixels) {
      previous.clip = merged; previous.assetIds.push(...shot.assetIds);
    } else bands.push(shot);
  }
  const waiting = new Set(tasks.flatMap(t => [t.questionKey, ...(t.questionKeys || [])]));
  const readyContexts = new Set(capture.contexts.filter(c => c.assetIds.every(id => knownAssets.has(id) && !wanted.has(id))).map(c => c.id));
  const sourceReadyQuestionKeys = capture.questions.filter(q => q.prompt?.trim() && q.type !== 'unknown' && !waiting.has(q.key)
    && q.contextIds.every(id => readyContexts.has(id))
    && [...q.assetIds, ...q.options.flatMap(o => o.assetIds || [])].every(id => knownAssets.has(id) && !wanted.has(id))).map(q => q.key);
  return {
    schema: 'chaoxing-page-read-plan/v1', captureId: capture.captureId,
    strategy: bands.length ? 'screenshots-first' : fallbacks.length ? 'originals-or-frame-tools' : 'source-only',
    expectedCount: total, readCount: capture.count, missingNumbers,
    expectedCountEvidence: expectedCount !== undefined ? 'caller-observed-visible-total' : capture.page?.countEvidence || 'unavailable',
    sourceReadyQuestionKeys, screenshots: bands.map((b, i) => ({ ...b, id: `band-${i + 1}` })), fallbacks,
    counts: { missingAssets: assets.length + fallbacks.filter(f => f.reason === 'queue-asset-missing').length, screenshotCalls: bands.length, originalFallbackAssets: fallbacks.length },
    note: 'Screenshots and OCR remain unverified; inspect all pending evidence before answering dependent questions.'
  };
}

export function planExamRead(capture, options) {
  return { ...planPageRead(capture, options), schema: 'chaoxing-exam-read-plan/v1' };
}
