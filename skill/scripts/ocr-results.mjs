// Associate untrusted recognition text by verified capture/asset hashes, never
// by array order. This module does not replace original source or clear review.
export function associateOcrResults(capture, manifest, recognition, { captureHash } = {}) {
  if (!captureHash || captureHash !== manifest.captureHash) throw new Error('OCR manifest belongs to another capture');
  const assets = new Map(capture.assets.map(a => [a.assetId, a]));
  const questions = new Map(capture.questions.map(q => [q.key, q]));
  const readings = [], rejections = [], seen = new Set();
  for (const result of recognition.results || []) {
    const image = manifest.images?.find(m => m.imageKey === result.imageKey);
    const reject = code => rejections.push({ assetId: result.imageKey || null, code });
    if (!image || !assets.has(image.imageKey)) { reject('unmapped-recognition-result'); continue; }
    if (seen.has(result.imageKey)) { reject('duplicate-recognition-result'); continue; }
    seen.add(result.imageKey);
    if (result.questionKey !== image.questionKey) { reject('question-reference-mismatch'); continue; }
    if (!result.sourceSha256 || result.sourceSha256 !== image.sha256) { reject('image-content-mismatch'); continue; }
    const keys = image.questionKeys || [image.questionKey];
    if (!keys.length || keys.some(key => !questions.has(key))) { reject('unknown-question-reference'); continue; }
    const tasks = (capture.ocrQueue || []).filter(t => t.assetId === image.imageKey);
    const allowed = new Set(tasks.flatMap(t => [...(t.questionKeys || []), t.questionKey]).filter(Boolean));
    if (!allowed.size || new Set(keys).size !== allowed.size || keys.some(key => !allowed.has(key))) { reject('asset-consumer-mismatch'); continue; }
    const asset = assets.get(image.imageKey);
    if (image.frame && image.frame !== asset.frame || image.contextId && image.contextId !== asset.contextId) { reject('asset-scope-mismatch'); continue; }
    if (image.needsOCR === false) { reject('visual-only-asset'); continue; }
    const references = tasks.flatMap(t => (t.questionKeys || [t.questionKey]).map(questionKey => ({questionKey,owner:t.owner,ownerIndex:t.ownerIndex,optionLabel:t.optionLabel,contextId:t.contextId})));
    readings.push({ assetId: image.imageKey, questionKeys: [...allowed], sourceSha256: result.sourceSha256, status: result.status, text: String(result.text || ''), verified: false, cacheHit: Boolean(result.cacheHit), acquisition: image.acquisition, frame: asset.frame, references, diagnostics: result.diagnostics || [] });
  }
  const completed = new Set(readings.filter(r => r.status === 'recognized' && r.text.trim()).map(r => r.assetId));
  return { schema: 'chaoxing-associated-readings/v1', captureHash, readings, rejections, unresolved: (capture.ocrQueue || []).filter(t => !completed.has(t.assetId)).map(t => ({ assetId:t.assetId,questionKey:t.questionKey })), requiresVisualVerification: true };
}
