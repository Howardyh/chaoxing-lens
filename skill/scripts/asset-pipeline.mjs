import { createHash } from 'node:crypto';

// These functions plan work using supplied, observed metadata. They never fetch,
// open files, inspect browser state, crop pixels, or recognize text themselves.
const list = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const hashPattern = /^[a-f\d]{64}$/i;
const isLocal = value => text(value) && !/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^(?:data|javascript|blob):/i.test(value) && !value.startsWith('\\\\') && !value.startsWith('//');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const rejection = (asset, code, detail) => ({ assetId: asset?.assetId ?? null, frame: asset?.frame ?? null, code, ...(detail ? { detail } : {}) });

function redactedURL(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname : null;
  } catch { return null; }
}

function referencesFor(capture, asset) {
  const references = [];
  const add = (key, source = {}) => {
    if (!text(key)) return;
    const ref = { questionKey: key, contextId: source.contextId ?? asset.contextId ?? null, owner: source.owner ?? asset.owner ?? null, ownerIndex: source.ownerIndex ?? null, optionLabel: source.optionLabel ?? null };
    if (!references.some(old => JSON.stringify(old) === JSON.stringify(ref))) references.push(ref);
  };
  for (const task of [...list(capture.ocrQueue), ...list(capture.visualQueue)]) {
    if (!task || task.assetId !== asset.assetId) continue;
    const keys = [...list(task.questionKeys), task.questionKey, task.qkey].filter(Boolean);
    keys.forEach(key => add(key, task));
  }
  for (const question of list(capture.questions)) {
    if (list(question?.assetIds).includes(asset.assetId)) {
      const key = question.key ?? question.questionKey ?? question.qkey;
      if (!references.some(ref => ref.questionKey === key)) add(key);
    }
  }
  list(asset.questionKeys).forEach(key => add(key));
  add(asset.questionKey);
  return references;
}

function shared(capture, asset) {
  const references = referencesFor(capture, asset);
  const questionKeys = [...new Set(references.map(ref => ref.questionKey))];
  const needsOCR = Array.isArray(capture.ocrQueue) ? capture.ocrQueue.some(task => task?.assetId === asset.assetId) : typeof asset.requiresOCR === 'boolean' ? asset.requiresOCR : null;
  const needsVisualReview = Array.isArray(capture.visualQueue) ? capture.visualQueue.some(task => task?.assetId === asset.assetId) : typeof asset.requiresVisualReview === 'boolean' ? asset.requiresVisualReview : null;
  return { assetId: asset.assetId, kind: asset.kind, frame: asset.frame, locator: asset.locator ?? null, questionKey: questionKeys[0] ?? null, questionKeys, contextId: asset.contextId ?? references.find(ref => ref.contextId)?.contextId ?? null, references, needsOCR, needsVisualReview };
}

function activeAssets(capture) {
  if (!capture || !Array.isArray(capture.assets)) return { assets: [], rejections: [rejection(null, 'invalid-capture', 'capture.assets must be an array')] };
  const queueProvided = Array.isArray(capture.ocrQueue) || Array.isArray(capture.visualQueue);
  const queue = [...list(capture.ocrQueue), ...list(capture.visualQueue)];
  const wanted = new Set(queue.map(task => task?.assetId).filter(Boolean));
  const selected = capture.assets.filter(asset => !queueProvided || wanted.has(asset?.assetId));
  const counts = new Map();
  capture.assets.forEach(asset => counts.set(asset?.assetId, (counts.get(asset?.assetId) || 0) + 1));
  const assets = [], rejections = [];
  for (const asset of selected) {
    if (!asset || !text(asset.assetId)) { rejections.push(rejection(asset, 'invalid-asset-id')); continue; }
    if (counts.get(asset.assetId) > 1) {
      if (!rejections.some(item => item.assetId === asset.assetId)) rejections.push(rejection(asset, 'duplicate-asset-id'));
      continue;
    }
    assets.push(asset);
  }
  for (const id of wanted) if (!capture.assets.some(asset => asset?.assetId === id)) rejections.push(rejection({ assetId: id }, 'queue-asset-missing'));
  return { assets, rejections };
}

function observedImages(inventory) {
  const values = list(inventory?.assets ?? inventory?.pageAssets);
  return values.filter(item => item && item.kind === 'image' && text(item.id ?? item.pageAssetId));
}

function observationURLs(item) {
  return [...new Set([item.url, ...list(item.sources).map(source => typeof source === 'string' ? source : source?.url)].filter(value => redactedURL(value)))];
}

function uniqueCandidates(candidates) {
  const ids = [...new Set(candidates.map(item => item.id ?? item.pageAssetId))];
  // Repeated records with the same ID but conflicting URLs are also ambiguous.
  if (ids.length !== 1) return null;
  const urls = [...new Set(candidates.flatMap(observationURLs))];
  return urls.length <= 1 ? candidates[0] : null;
}

/** Match only IDs actually present in a pageAssets inventory. URLs never identify
 * pixels, and two full query URLs collapsed to one redacted path are ambiguous. */
export function planAssetAcquisition(capture, inventory = {}) {
  const selected = activeAssets(capture);
  const result = { plans: [], rejections: [...selected.rejections], warnings: [] };
  const images = observedImages(inventory);
  for (const asset of selected.assets) {
    if (asset.kind !== 'image') { result.rejections.push(rejection(asset, 'unsupported-original-kind')); continue; }
    if (!text(asset.frame)) { result.rejections.push(rejection(asset, 'asset-frame-missing')); continue; }
    if (asset.loaded === false || asset.ready === false) { result.rejections.push(rejection(asset, 'asset-unready')); continue; }
    let candidates = images.filter(item => (item.assetId === asset.assetId || list(item.assetIds).includes(asset.assetId)) && (!item.frame || item.frame === asset.frame));
    let matchedBy = 'observed-asset-id';
    if (!candidates.length && asset.locator) {
      candidates = images.filter(item => item.frame === asset.frame && item.locator === asset.locator);
      matchedBy = 'observed-frame-locator';
    }
    if (!candidates.length) {
      const source = redactedURL(asset.redactedURL ?? asset.source ?? asset.url);
      candidates = source ? images.filter(item => observationURLs(item).some(url => redactedURL(url) === source) && (!item.frame || item.frame === asset.frame)) : [];
      matchedBy = 'single-observed-url-path';
    }
    if (!candidates.length) { result.rejections.push(rejection(asset, 'original-not-observed')); continue; }
    const observed = uniqueCandidates(candidates);
    if (!observed) { result.rejections.push(rejection(asset, 'ambiguous-observed-original', 'Multiple observed IDs or full URLs share this match; use a fresh element-to-inventory association or a screenshot.')); continue; }
    const source = redactedURL(asset.redactedURL ?? asset.source ?? asset.url);
    const urls = observationURLs(observed);
    if (source && urls.length && urls.every(url => redactedURL(url) !== source)) { result.rejections.push(rejection(asset, 'observed-source-mismatch')); continue; }
    result.plans.push({ ...shared(capture, asset), inventoryId: inventory.id ?? null, pageAssetId: observed.id ?? observed.pageAssetId, matchedBy, status: 'pending-original', acquisition: 'pageAssets', naturalSize: asset.naturalSize ?? null });
  }
  return result;
}

function validRect(rect) { return rect && finite(rect.x) && finite(rect.y) && positive(rect.width) && positive(rect.height) && finite(rect.x + rect.width) && finite(rect.y + rect.height); }
function validPixelSize(size) { return size && Number.isSafeInteger(size.width) && size.width > 0 && Number.isSafeInteger(size.height) && size.height > 0; }
function unsupportedTransform(value) { return value !== undefined && value !== null && value !== false && value !== '' && value !== 'none'; }

function screenshotProblem(capture, screenshot) {
  if (!screenshot || typeof screenshot !== 'object') return 'invalid-screenshot';
  if (!isLocal(screenshot.path)) return 'screenshot-path-not-local';
  if (!hashPattern.test(screenshot.sha256 || '')) return 'screenshot-hash-missing';
  if (!text(screenshot.frame)) return 'screenshot-frame-missing';
  if (screenshot.ready === false || screenshot.frameReady === false || screenshot.status && !['ready','captured'].includes(screenshot.status)) return 'screenshot-unready';
  if (screenshot.coordinateSpace && screenshot.coordinateSpace !== 'frame-document') return 'unsupported-coordinate-space';
  if (unsupportedTransform(screenshot.transform) || screenshot.unsupportedTransform === true || screenshot.rotation && screenshot.rotation !== 0) return 'unsupported-screenshot-transform';
  if (!validRect(screenshot.cssBounds) || !validPixelSize(screenshot.pixelSize)) return 'invalid-screenshot-dimensions';
  const at = Date.parse(screenshot.capturedAt);
  if (!Number.isFinite(at)) return 'screenshot-time-missing';
  const captureAt = Date.parse(capture?.capturedAt);
  if (Number.isFinite(captureAt) && at < captureAt) return 'screenshot-older-than-capture';
  return null;
}

/** Frame-local CSS document coordinates -> screenshot pixels. Padding is in CSS
 * pixels. Only padding may be clipped; an incompletely captured asset is rejected. */
export function planCrops(capture, screenshotDescriptor = {}) {
  const selected = activeAssets(capture);
  const result = { plans: [], rejections: [...selected.rejections], warnings: [] };
  const problem = screenshotProblem(capture, screenshotDescriptor);
  if (problem) {
    result.rejections.push(...selected.assets.map(asset => rejection(asset, problem)));
    if (!selected.assets.length && !selected.rejections.length) result.rejections.push(rejection(null, problem));
    return result;
  }
  const screenshot = screenshotDescriptor;
  const padding = screenshot.padding ?? 2;
  if (!finite(padding) || padding < 0 || padding > 128) {
    result.rejections.push(...selected.assets.map(asset => rejection(asset, 'invalid-crop-padding')));
    return result;
  }
  const css = screenshot.cssBounds, pixel = screenshot.pixelSize;
  const scales = { x: pixel.width / css.width, y: pixel.height / css.height };
  if (!positive(scales.x) || !positive(scales.y)) {
    result.rejections.push(...selected.assets.map(asset => rejection(asset, 'invalid-screenshot-scale')));
    return result;
  }
  for (const asset of selected.assets) {
    if (!text(asset.frame) || asset.frame !== screenshot.frame) { result.rejections.push(rejection(asset, 'frame-mismatch')); continue; }
    if (asset.ready === false || asset.loaded === false || asset.naturalSize && (!positive(asset.naturalSize.width) || !positive(asset.naturalSize.height))) { result.rejections.push(rejection(asset, 'asset-unready')); continue; }
    if (unsupportedTransform(asset.transform) || asset.unsupportedTransform === true) { result.rejections.push(rejection(asset, 'unsupported-asset-transform')); continue; }
    const bounds = asset.bounds;
    if (!validRect(bounds)) { result.rejections.push(rejection(asset, 'invalid-asset-bounds')); continue; }
    const right = bounds.x + bounds.width, bottom = bounds.y + bounds.height;
    if (![right,bottom].every(Number.isFinite)) { result.rejections.push(rejection(asset, 'invalid-asset-bounds')); continue; }
    const cssRight = css.x + css.width, cssBottom = css.y + css.height;
    if (bounds.x < css.x || bounds.y < css.y || right > cssRight || bottom > cssBottom) { result.rejections.push(rejection(asset, 'asset-not-fully-covered')); continue; }
    const raw = { x: Math.floor((bounds.x - css.x - padding) * scales.x), y: Math.floor((bounds.y - css.y - padding) * scales.y), right: Math.ceil((right - css.x + padding) * scales.x), bottom: Math.ceil((bottom - css.y + padding) * scales.y) };
    if (!Object.values(raw).every(Number.isSafeInteger)) { result.rejections.push(rejection(asset, 'invalid-pixel-bounds')); continue; }
    const x = Math.max(0, raw.x), y = Math.max(0, raw.y), cropRight = Math.min(pixel.width,raw.right), cropBottom = Math.min(pixel.height,raw.bottom);
    const pixelBounds = { x, y, width: cropRight - x, height: cropBottom - y };
    if (!positive(pixelBounds.width) || !positive(pixelBounds.height)) { result.rejections.push(rejection(asset, 'empty-crop')); continue; }
    const paddingClamped = x !== raw.x || y !== raw.y || cropRight !== raw.right || cropBottom !== raw.bottom;
    if (paddingClamped) result.warnings.push({ assetId: asset.assetId, code: 'crop-padding-clamped' });
    result.plans.push({ ...shared(capture, asset), status: 'pending-crop', acquisition: 'screenshot-crop', screenshotPath: screenshot.path, screenshotHash: screenshot.sha256.toLowerCase(), capturedAt: screenshot.capturedAt, coordinateSpace: 'frame-document', cssBounds: { ...bounds }, screenshotCssBounds: { ...css }, screenshotPixelSize: { ...pixel }, pixelBounds, cropOrigin: { x, y }, scales, padding, paddingClamped });
  }
  return result;
}

/** Plan originals first, with crop fallback. An original must be linked to an
 * observed pageAsset ID; a URL or arbitrary original path never creates that link.
 * options.originals may be an array or a bundle with assets/originals arrays. */
export function prepareAssetMappings(capture, options = {}) {
  const acquisition = planAssetAcquisition(capture, options.inventory);
  const records = list(options.originals?.assets ?? options.originals?.originals ?? options.originals);
  const screenshots = list(options.screenshots ?? (options.screenshot ? [options.screenshot] : []));
  const mappings = [], rejections = [], warnings = [];
  const selected = activeAssets(capture);
  rejections.push(...selected.rejections);
  for (const asset of selected.assets) {
    const originalPlan = acquisition.plans.find(plan => plan.assetId === asset.assetId);
    const matches = originalPlan ? records.filter(record => record && (record.pageAssetId ?? record.id) === originalPlan.pageAssetId && (!record.assetId || record.assetId === asset.assetId)) : [];
    const valid = matches.filter(record => isLocal(record.path) && hashPattern.test(record.sha256 || '') && validPixelSize(record.pixelSize) && record.ready !== false && record.status !== 'failed');
    const identities = new Set(valid.map(record => JSON.stringify([record.path, record.sha256.toLowerCase(), record.pixelSize])));
    if (valid.length && identities.size === 1) {
      const original = valid[0];
      if (original.buffer && (!(original.buffer instanceof Uint8Array) || sha256(original.buffer) !== original.sha256.toLowerCase())) {
        warnings.push({ assetId: asset.assetId, code: 'original-content-hash-mismatch' });
      } else {
        mappings.push({ ...originalPlan, status: 'ready', path: original.path, sha256: original.sha256.toLowerCase(), pixelSize: { ...original.pixelSize }, acquisition: 'observed-original' });
        continue;
      }
    } else if (matches.length) warnings.push({ assetId: asset.assetId, code: valid.length ? 'ambiguous-original-files' : 'invalid-original-file-metadata' });
    const descriptors = screenshots.filter(screenshot => screenshot?.frame === asset.frame);
    const localCapture = { ...capture, assets: [asset] };
    if (Array.isArray(capture.ocrQueue)) localCapture.ocrQueue = capture.ocrQueue.filter(task => task?.assetId === asset.assetId);
    if (Array.isArray(capture.visualQueue)) localCapture.visualQueue = capture.visualQueue.filter(task => task?.assetId === asset.assetId);
    const candidates = descriptors.map(screenshot => planCrops(localCapture, { ...screenshot, ...(options.padding === undefined ? {} : { padding: options.padding }) }));
    const successful = candidates.filter(candidate => candidate.plans.length);
    if (successful.length === 1) {
      mappings.push(successful[0].plans[0]);
      warnings.push(...successful[0].warnings);
      continue;
    }
    const acquisitionFailure = acquisition.rejections.find(item => item.assetId === asset.assetId)?.code;
    if (successful.length > 1) rejections.push(rejection(asset, 'ambiguous-frame-screenshots'));
    else rejections.push(rejection(asset, candidates[0]?.rejections[0]?.code ?? 'no-original-or-frame-screenshot', acquisitionFailure));
  }
  return { mappings, rejections, warnings };
}

/** Preserve fanout metadata when producing the local OCR helper's images array.
 * A ready local path is required; pending crop plans must first receive their
 * actual output path/hash from the caller that performs and verifies the crop. */
export function createOcrManifest(mapping) {
  const mappings = Array.isArray(mapping) ? mapping : list(mapping?.mappings ?? mapping?.plans);
  const result = { images: [], rejections: [], warnings: [] };
  const seen = new Map();
  for (const item of mappings) {
    if (!item || !text(item.assetId)) { result.rejections.push(rejection(item,'invalid-asset-id')); continue; }
    if (item.needsOCR === false) continue;
    if (item.status && !['ready','cached'].includes(item.status)) { result.rejections.push(rejection(item,'mapping-not-ready')); continue; }
    if (!isLocal(item.path)) { result.rejections.push(rejection(item,'mapping-path-not-local')); continue; }
    if (!hashPattern.test(item.sha256 || '')) { result.rejections.push(rejection(item,'mapping-content-hash-missing')); continue; }
    const existing = seen.get(item.assetId);
    if (existing) {
      if (existing.path !== item.path || existing.sha256 !== item.sha256.toLowerCase()) result.rejections.push(rejection(item,'conflicting-asset-mapping'));
      else {
        existing.questionKeys = [...new Set([...existing.questionKeys, ...list(item.questionKeys), item.questionKey].filter(Boolean))];
        existing.references = [...existing.references, ...list(item.references)].filter((ref,index,all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(ref)) === index);
      }
      continue;
    }
    const questionKeys = [...new Set([...list(item.questionKeys), item.questionKey].filter(value => text(value)))];
    if (!questionKeys.length) { result.rejections.push(rejection(item,'mapping-question-reference-missing')); continue; }
    const image = { path: item.path, questionKey: item.questionKey ?? questionKeys[0], questionKeys, imageKey: item.assetId, assetId: item.assetId, sha256: item.sha256.toLowerCase(), frame: item.frame ?? null, contextId: item.contextId ?? null, references: list(item.references).map(ref => ({ ...ref })), acquisition: item.acquisition ?? null };
    for (const key of ['needsOCR','needsVisualReview','screenshotHash','capturedAt','pixelBounds','cropOrigin','scales','cssBounds','screenshotCssBounds','screenshotPixelSize','pixelSize','pageAssetId','inventoryId']) if (item[key] !== undefined) image[key] = typeof item[key] === 'object' && item[key] !== null ? { ...item[key] } : item[key];
    result.images.push(image);
    seen.set(item.assetId,image);
  }
  // Conflicting duplicate mappings cannot leave an arbitrary usable first path.
  const conflicts = new Set(result.rejections.filter(item => item.code === 'conflicting-asset-mapping').map(item => item.assetId));
  result.images = result.images.filter(item => !conflicts.has(item.assetId));
  return result;
}

function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('Cache configuration numbers must be finite.'); return JSON.stringify(value); }
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('Cache configuration must be acyclic JSON data.');
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) throw new TypeError('Cache configuration must contain plain JSON objects.');
  seen.add(value);
  const output = Array.isArray(value) ? '[' + value.map(item => canonical(item,seen)).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key],seen)).join(',') + '}';
  seen.delete(value);
  return output;
}

/** Cache by exact supplied image bytes and explicit recognition configuration,
 * never by redacted URL, page location, question index, or asset ID. */
export function cacheKey(buffer, config) {
  if (!(buffer instanceof Uint8Array) || !buffer.byteLength) throw new TypeError('Cache input must contain image bytes.');
  if (!config || !text(config.language) || !(text(config.engine) || config.engine && typeof config.engine === 'object' && !Array.isArray(config.engine) && Object.keys(config.engine).length)) throw new TypeError('Cache configuration needs language and engine identity/version.');
  const configuration = canonical({ ...config, preprocess: config.preprocess ?? {} });
  return createHash('sha256').update('chaoxing-ocr-cache/v1\0').update(String(configuration.length)).update('\0').update(configuration).update('\0').update(buffer).digest('hex');
}
