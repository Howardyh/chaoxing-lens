import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { planExamRead, planPageRead } from './exam-speed.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

function screenshotGeometry(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Size lives in a start-of-frame segment before the scan payload.
    for (let i = 2; i + 4 <= bytes.length;) {
      if (bytes[i++] !== 0xff) break;
      while (bytes[i] === 0xff) i++;
      if (i + 3 > bytes.length) break;
      const marker = bytes[i++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
        return { format: 'jpeg', width: bytes.readUInt16BE(i + 5), height: bytes.readUInt16BE(i + 3) };
      }
      i += length;
    }
  }
  throw new Error('Unsupported screenshot encoding or missing dimensions');
}

function identity(capture) {
  // Capture-local IDs change on every extraction even when the same page is
  // still displayed. Compare their relative identities and the visible content.
  const stable = value => typeof value === 'string' ? value
    .replaceAll('capture-local:' + capture.captureId + ':', 'capture-local:<current>:')
    .replaceAll('::duplicate:' + capture.captureId + ':', '::duplicate:<current>:') : value;
  return JSON.stringify({
    page: { url: capture.page?.url, title: capture.page?.title, state: capture.page?.state, expectedCount: capture.page?.expectedCount },
    frames: capture.frames.map(({ frame, documentSize, viewport, devicePixelRatio }) => ({ frame, documentSize, viewport, devicePixelRatio })),
    questions: capture.questions.map(q => ({ key: q.key, number: q.questionNumber, type: q.type, prompt: q.prompt, options: q.options.map(o => ({ label: o.label, text: o.text })), contextIds: q.contextIds, bounds: q.bounds })),
    contexts: capture.contexts,
    assets: capture.assets.map(({ assetId, source, sourceText, sourceStatus, bounds, loaded, naturalSize }) => ({ assetId, source, sourceText, sourceStatus, bounds, loaded, naturalSize }))
  }, (_, value) => stable(value));
}

// Run inside cua_repl with the already-bound tab and documented screenshot API.
// This does not discover/claim tabs, navigate, click answers, download URLs or
// call page APIs. One tool invocation can capture, plan and save all bands.
async function captureFast(tab, {
  extractorSource, outputDirectory, observedExpectedCount, maxPixels, maxHeight, mode, capture: observedCapture
} = {}, { planner, schema }) {
  if (typeof extractorSource !== 'string' || !extractorSource.trim() || typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory) || outputDirectory.startsWith('\\\\') || outputDirectory.startsWith('//')) throw new Error('Reviewed extractor source and a new absolute local directory are required');
  await mkdir(outputDirectory); // Never overwrite a previous run.
  const started = performance.now(), capture = observedCapture ?? await tab.playwright.evaluate(extractorSource);
  const extractedAt = performance.now();
  const plan = planner(capture, { expectedCount: observedExpectedCount, maxPixels, maxHeight, mode });
  let changed = false;
  if (observedCapture && plan.screenshots.length) {
    try { changed = identity(capture) !== identity(await tab.playwright.evaluate(extractorSource)); }
    catch { changed = true; }
  }
  const captureBytes = Buffer.from(JSON.stringify(capture)), captureHash = digest(captureBytes);
  await writeFile(path.join(outputDirectory, 'capture.json'), captureBytes, { flag: 'wx' });
  const screenshots = [], failures = [], coveredAssets = new Set();
  for (const band of changed ? [] : plan.screenshots) {
    const shotStart = performance.now();
    try {
      const bytes = Buffer.from(await tab.screenshot({ fullPage: true, clip: band.clip }));
      const { format, width, height } = screenshotGeometry(bytes);
      const png = format === 'png';
      const pixelSize = { width, height };
      const sx = width / band.clip.width, sy = height / band.clip.height;
      if (!sx || !sy || width * height > (maxPixels ?? 24000000) || Math.abs(sx - sy) > 0.02 * Math.max(sx, sy)) throw new Error('Screenshot geometry does not match the requested band or budget');
      const filename = path.join(outputDirectory, `${band.id}.${png ? 'png' : 'jpg'}`);
      await writeFile(filename, bytes, { flag: 'wx' });
      screenshots.push({ path: filename, sha256: digest(bytes), frame: band.frame, capturedAt: new Date().toISOString(), coordinateSpace: 'frame-document', cssBounds: band.clip, pixelSize, assetIds: band.assetIds, contentType: png ? 'image/png' : 'image/jpeg', needsNormalization: !png, ready: png, elapsedMs: +(performance.now() - shotStart).toFixed(2) });
      band.assetIds.forEach(id => coveredAssets.add(id));
    } catch { failures.push({ bandId: band.id, assetIds: band.assetIds, reason: 'screenshot-failed-or-invalid', retry: false }); }
  }
  if (screenshots.length) {
    try { changed = identity(capture) !== identity(await tab.playwright.evaluate(extractorSource)); }
    catch { changed = true; }
  }
  if (changed) {
    screenshots.forEach(shot => { shot.ready = false; shot.discarded = true; });
    failures.push({ reason: 'page-changed-during-capture', retry: false });
    coveredAssets.clear();
  }
  const result = { schema, captureHash, plan, screenshots, failures, verified: false, fallbackAssetIds: [...new Set([...plan.fallbacks.map(f => f.assetId), ...plan.screenshots.flatMap(b => b.assetIds).filter(id => !coveredAssets.has(id))])], timings: { extractionMs: observedCapture ? null : +(extractedAt - started).toFixed(2), acquisitionAndLocalWriteMs: +(performance.now() - extractedAt).toFixed(2), totalMs: +(performance.now() - started).toFixed(2) } };
  await writeFile(path.join(outputDirectory, 'screenshots.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  return { directory: outputDirectory, readCount: capture.count, expectedCount: plan.expectedCount, missingNumbers: plan.missingNumbers, sourceReadyQuestionKeys: changed ? [] : plan.sourceReadyQuestionKeys, strategy: plan.strategy, screenshotCount: screenshots.length, readyScreenshotCount: screenshots.filter(s => s.ready).length, pendingNormalizationCount: screenshots.filter(s => s.needsNormalization && !s.discarded).length, fallbackAssetIds: result.fallbackAssetIds, pageChanged: changed, timings: result.timings, verified: false };
}

export function capturePageFast(tab, options) {
  return captureFast(tab, options, { planner: planPageRead, schema: 'chaoxing-page-fast-capture/v1' });
}

export function captureExamFast(tab, options) {
  return captureFast(tab, options, { planner: planExamRead, schema: 'chaoxing-exam-fast-capture/v1' });
}
