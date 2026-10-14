import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { planAssetAcquisition, prepareAssetMappings, createOcrManifest } from '../src/asset-pipeline.js';

const args = process.argv.slice(2), opts = {};
for (let i = 0; i < args.length; i += 2) { if (!args[i].startsWith('--') || !args[i + 1]) throw new Error('Expected --capture/--inventory/--bundle/--screenshots/--mappings/--out value pairs'); opts[args[i].slice(2)] = args[i + 1]; }
if (!opts.capture || !opts.out) throw new Error('Required: --capture capture.json --out NEW-directory');
const local = p => { if (/^[a-z][a-z\d+.-]*:\/\//i.test(p) || p.startsWith('\\\\')) throw new Error('Explicit local files only'); return path.resolve(p); };
const load = async p => JSON.parse((await readFile(local(p), 'utf8')).replace(/^\uFEFF/, ''));
const digest = b => createHash('sha256').update(b).digest('hex');
const capture = await load(opts.capture), captureHash = digest(await readFile(local(opts.capture)));
if (capture.schema !== 'chaoxing-visible-questions/v3') throw new Error('A fresh v3 capture is required');
const out = local(opts.out); await mkdir(out, { recursive: true });
let result;
if (opts.mappings) {
  result = await load(opts.mappings);
  if (result.captureHash !== captureHash) throw new Error('Crop mappings belong to a different capture');
  for (const m of result.mappings || []) {
    if (m.status !== 'ready') continue;
    const bytes = await readFile(local(m.path));
    if (digest(bytes) !== m.sha256) throw new Error('Prepared image hash changed');
  }
} else {
  const inventory = opts.inventory ? await load(opts.inventory) : { assets: [] };
  const acquisition = planAssetAcquisition(capture, inventory);
  const originals = [], originalFailures = [];
  if (opts.bundle) {
    const bundle = await load(opts.bundle);
    for (const item of bundle.assets || []) {
      try {
        if (!acquisition.plans.some(p => p.pageAssetId === item.id)) continue;
        const filename = local(item.path), bytes = await readFile(filename);
        if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii',12,16) !== 'IHDR') throw new Error('Original is not a PNG; use screenshot fallback');
        originals.push({ id: item.id, path: filename, sha256: digest(bytes), pixelSize: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } });
      } catch (error) { originalFailures.push({ pageAssetId: item.id, code: 'original-unusable', reason: error.message }); }
    }
  }
  const input = opts.screenshots ? await load(opts.screenshots) : [];
  const screenshots = Array.isArray(input) ? input : input.screenshots || [input];
  for (const shot of screenshots) {
    const bytes = await readFile(local(shot.path));
    if (digest(bytes) !== shot.sha256) throw new Error('Screenshot hash changed');
    if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Screenshot must be PNG');
    if (bytes.readUInt32BE(16) !== shot.pixelSize.width || bytes.readUInt32BE(20) !== shot.pixelSize.height) throw new Error('Screenshot dimensions disagree with descriptor');
  }
  result = { schema: 'chaoxing-asset-mappings/v1', captureHash, ...prepareAssetMappings(capture, { inventory, originals, screenshots }), originalFailures };
  await writeFile(path.join(out,'acquisition-plan.json'), JSON.stringify(acquisition,null,2), { flag:'wx' });
}
await writeFile(path.join(out,'asset-mappings.json'), JSON.stringify(result,null,2), { flag:'wx' });
const manifest = { schema:'chaoxing-ocr-input/v1', captureHash, ...createOcrManifest(result) };
await writeFile(path.join(out,'ocr-images.json'), JSON.stringify(manifest,null,2), { flag:'wx' });
console.log(JSON.stringify({ ready:manifest.images.length, pendingCrop:(result.mappings||[]).filter(m=>m.status==='pending-crop').length, rejected:result.rejections?.length||0, directory:out }));
