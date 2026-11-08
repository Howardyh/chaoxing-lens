import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { planExamRead } from './exam-speed.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const identity = capture => JSON.stringify({ page: capture.page?.url, questions: capture.questions.map(q => ({ key: q.key, prompt: q.prompt, options: q.options.map(o => ({ label: o.label, text: o.text })), contextIds: q.contextIds, bounds: q.bounds })), contexts: capture.contexts, assets: capture.assets.map(a => ({ assetId: a.assetId, source: a.source, sourceText: a.sourceText, sourceStatus: a.sourceStatus, bounds: a.bounds })) });

// Run inside cua_repl with the already-bound tab and documented screenshot API.
// This does not discover/claim tabs, navigate, click answers, download URLs or
// call page APIs. One tool invocation can capture, plan and save all bands.
export async function captureExamFast(tab, { extractorSource, outputDirectory, observedExpectedCount, maxPixels, maxHeight } = {}) {
  if (typeof extractorSource !== 'string' || !extractorSource.trim() || typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory) || outputDirectory.startsWith('\\\\') || outputDirectory.startsWith('//')) throw new Error('Reviewed extractor source and a new absolute local directory are required');
  await mkdir(outputDirectory); // Never overwrite a previous run.
  const started = performance.now(), capture = await tab.playwright.evaluate(extractorSource);
  const extractedAt = performance.now();
  const captureBytes = Buffer.from(JSON.stringify(capture)), captureHash = digest(captureBytes);
  await writeFile(path.join(outputDirectory, 'capture.json'), captureBytes, { flag: 'wx' });
  const plan = planExamRead(capture, { expectedCount: observedExpectedCount, ...(maxPixels === undefined ? {} : { maxPixels }), ...(maxHeight === undefined ? {} : { maxHeight }) });
  const screenshots = [], failures = [], coveredAssets = new Set();
  for (const band of plan.screenshots) {
    const shotStart = performance.now();
    try {
      const bytes = Buffer.from(await tab.screenshot({ fullPage: true, clip: band.clip }));
      const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR';
      const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!png && !jpeg) throw new Error('Unsupported screenshot encoding');
      const pixelSize = png ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
      if (pixelSize) {
        const sx = pixelSize.width / band.clip.width, sy = pixelSize.height / band.clip.height;
        if (!sx || !sy || Math.abs(sx - sy) > 0.02 * Math.max(sx, sy)) throw new Error('Screenshot aspect ratio does not match the requested band');
      }
      const filename = path.join(outputDirectory, `${band.id}.${png ? 'png' : 'jpg'}`);
      await writeFile(filename, bytes, { flag: 'wx' });
      screenshots.push({ path: filename, sha256: digest(bytes), frame: band.frame, capturedAt: new Date().toISOString(), coordinateSpace: 'frame-document', cssBounds: band.clip, pixelSize, assetIds: band.assetIds, contentType: png ? 'image/png' : 'image/jpeg', needsNormalization: !png, ready: png, elapsedMs: +(performance.now() - shotStart).toFixed(2) });
      band.assetIds.forEach(id => coveredAssets.add(id));
    } catch { failures.push({ bandId: band.id, assetIds: band.assetIds, reason: 'screenshot-failed-or-invalid', retry: false }); }
  }
  let changed = false;
  if (screenshots.length) {
    try { changed = identity(capture) !== identity(await tab.playwright.evaluate(extractorSource)); }
    catch { changed = true; }
  }
  if (changed) {
    screenshots.forEach(shot => { shot.ready = false; shot.discarded = true; });
    failures.push({ reason: 'page-changed-during-capture', retry: false });
    coveredAssets.clear();
  }
  const result = { schema: 'chaoxing-exam-fast-capture/v1', captureHash, plan, screenshots, failures, verified: false, fallbackAssetIds: [...new Set([...plan.fallbacks.map(f => f.assetId), ...plan.screenshots.flatMap(b => b.assetIds).filter(id => !coveredAssets.has(id))])], timings: { extractionMs: +(extractedAt - started).toFixed(2), acquisitionAndLocalWriteMs: +(performance.now() - extractedAt).toFixed(2), totalMs: +(performance.now() - started).toFixed(2) } };
  await writeFile(path.join(outputDirectory, 'screenshots.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  return { directory: outputDirectory, readCount: capture.count, expectedCount: plan.expectedCount, missingNumbers: plan.missingNumbers, strategy: plan.strategy, screenshotCount: screenshots.length, readyScreenshotCount: screenshots.filter(s => s.ready).length, pendingNormalizationCount: screenshots.filter(s => s.needsNormalization && !s.discarded).length, fallbackAssetIds: result.fallbackAssetIds, pageChanged: changed, timings: result.timings, verified: false };
}
