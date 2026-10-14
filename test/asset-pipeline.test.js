import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planAssetAcquisition, planCrops, prepareAssetMappings, createOcrManifest, cacheKey } from '../src/asset-pipeline.js';

const hash = createHash('sha256').update('fixture screenshot bytes').digest('hex');
const capturedAt = '2026-10-15T00:00:00.000Z';
const asset = (overrides = {}) => ({ assetId: 'image-1', kind: 'image', frame: 'top', locator: '#q1 img', bounds: { x: 10.25, y: 220.125, width: 17.5, height: 15.25 }, loaded: true, naturalSize: { width: 70, height: 61 }, source: 'https://example.test/formula.png', ...overrides });
const capture = (assets = [asset()]) => ({ capturedAt, assets, questions: [{ key: 'q1', assetIds: assets.map(item => item.assetId) }, { key: 'q2', assetIds: assets.map(item => item.assetId) }], ocrQueue: assets.map(item => ({ assetId: item.assetId, questionKey: 'q1', questionKeys: ['q1','q2'], owner: 'prompt' })), visualQueue: [] });
const shot = (overrides = {}) => ({ path: 'work/screenshot.png', sha256: hash, capturedAt: '2026-10-15T00:00:01.000Z', frame: 'top', coordinateSpace: 'frame-document', cssBounds: { x: 0, y: 200, width: 500, height: 400 }, pixelSize: { width: 1000, height: 800 }, padding: 0, ...overrides });
const inventory = (assets = [{ id: 'observed-9', kind: 'image', url: 'https://example.test/formula.png?token=one', sources: [] }]) => ({ id: 'inventory-fixture', assets, summary: { image: assets.length } });

test('acquisition uses only an observed pageAssets ID, preserves fanout, and stays pending', () => {
  const input = capture(), observed = inventory();
  const before = JSON.stringify([input,observed]);
  const output = planAssetAcquisition(input,observed);
  assert.equal(output.rejections.length,0);
  assert.equal(output.plans[0].pageAssetId,'observed-9');
  assert.equal(output.plans[0].inventoryId,'inventory-fixture');
  assert.equal(output.plans[0].status,'pending-original');
  assert.deepEqual(output.plans[0].questionKeys,['q1','q2']);
  assert.equal(JSON.stringify([input,observed]),before);
  assert.equal('url' in output.plans[0],false);
});

test('redacted URL path ambiguity fails closed for unequal query URLs or IDs', () => {
  const ambiguous = inventory([{id:'one',kind:'image',url:'https://example.test/formula.png?answer=A'},{id:'two',kind:'image',url:'https://example.test/formula.png?answer=B'}]);
  const output = planAssetAcquisition(capture(),ambiguous);
  assert.equal(output.plans.length,0);
  assert.equal(output.rejections[0].code,'ambiguous-observed-original');
  const sameIDConflict = inventory(ambiguous.assets.map(item => ({...item,id:'one'})));
  assert.equal(planAssetAcquisition(capture(),sameIDConflict).plans.length,0);
});

test('a fresh frame/locator association disambiguates equal redacted paths', () => {
  const observed = inventory([{id:'one',kind:'image',url:'https://example.test/formula.png?a=1',frame:'top',locator:'#q1 img'},{id:'two',kind:'image',url:'https://example.test/formula.png?a=2',frame:'top',locator:'#q2 img'}]);
  assert.equal(planAssetAcquisition(capture(),observed).plans[0].pageAssetId,'one');
  assert.equal(planAssetAcquisition(capture(),observed).plans[0].matchedBy,'observed-frame-locator');
});

test('no inventory or unobserved identifiers never produce an acquisition ID', () => {
  assert.equal(planAssetAcquisition(capture(),{}).rejections[0].code,'original-not-observed');
  assert.equal(planAssetAcquisition(capture(),inventory([{id:'invented',kind:'svg',url:'https://example.test/formula.png'}])).plans.length,0);
  assert.equal(planAssetAcquisition(capture([asset({source:'[data]'})]),inventory()).plans.length,0);
});

test('an explicit inventory association cannot contradict the frame or observed source path', () => {
  const wrongFrame = inventory([{id:'observed',kind:'image',assetId:'image-1',frame:'top / #child',url:'https://example.test/formula.png'}]);
  assert.equal(planAssetAcquisition(capture(),wrongFrame).plans.length,0);
  const changedPath = inventory([{id:'observed',kind:'image',assetId:'image-1',frame:'top',url:'https://example.test/replaced.png'}]);
  assert.equal(planAssetAcquisition(capture(),changedPath).rejections[0].code,'observed-source-mismatch');
});

test('fractional bounds at DPR2 use outward rounding and scroll origin, with screenshot provenance', () => {
  const output = planCrops(capture(),shot());
  assert.equal(output.rejections.length,0);
  const plan = output.plans[0];
  assert.deepEqual(plan.pixelBounds,{x:20,y:40,width:36,height:31});
  assert.deepEqual(plan.scales,{x:2,y:2});
  assert.deepEqual(plan.cropOrigin,{x:20,y:40});
  assert.equal(plan.screenshotHash,hash);
  assert.deepEqual(plan.screenshotCssBounds,{x:0,y:200,width:500,height:400});
  assert.deepEqual(plan.questionKeys,['q1','q2']);
});

test('padding clamps to screenshot edges without cropping away asset content', () => {
  const edge = capture([asset({bounds:{x:0,y:200,width:10,height:10}})]);
  const output = planCrops(edge,shot({padding:2}));
  assert.deepEqual(output.plans[0].pixelBounds,{x:0,y:0,width:24,height:24});
  assert.equal(output.plans[0].paddingClamped,true);
  assert.equal(output.warnings[0].code,'crop-padding-clamped');
  const partial = capture([asset({bounds:{x:-1,y:200,width:10,height:10}})]);
  assert.equal(planCrops(partial,shot()).rejections[0].code,'asset-not-fully-covered');
});

test('frame-local screenshots handle nested document scroll but reject a top-frame substitute', () => {
  const child = 'top / #outer / #inner';
  const input = capture([asset({frame:child,bounds:{x:30,y:550,width:40,height:20}})]);
  assert.equal(planCrops(input,shot()).rejections[0].code,'frame-mismatch');
  const descriptor = shot({frame:child,cssBounds:{x:20,y:500,width:300,height:200},pixelSize:{width:600,height:400}});
  assert.deepEqual(planCrops(input,descriptor).plans[0].pixelBounds,{x:20,y:100,width:80,height:40});
});

test('malformed, unsupported, stale and unready inputs are rejected explicitly', () => {
  for (const [override, code] of [
    [{path:'https://example.test/screenshot.png'},'screenshot-path-not-local'],
    [{path:'//server/share/screenshot.png'},'screenshot-path-not-local'],
    [{sha256:'not-a-hash'},'screenshot-hash-missing'],
    [{capturedAt:'invalid'},'screenshot-time-missing'],
    [{capturedAt:'2026-10-14T23:59:59Z'},'screenshot-older-than-capture'],
    [{frameReady:false},'screenshot-unready'],
    [{coordinateSpace:'viewport'},'unsupported-coordinate-space'],
    [{transform:'rotate(5deg)'},'unsupported-screenshot-transform'],
    [{pixelSize:{width:0,height:800}},'invalid-screenshot-dimensions'],
    [{cssBounds:{x:0,y:0,width:NaN,height:400}},'invalid-screenshot-dimensions'],
    [{padding:Infinity},'invalid-crop-padding'],
  ]) assert.equal(planCrops(capture(),shot(override)).rejections[0].code,code);
  assert.equal(planCrops(capture([asset({loaded:false})]),shot()).rejections[0].code,'asset-unready');
  assert.equal(planCrops(capture([asset({naturalSize:{width:0,height:0}})]),shot()).rejections[0].code,'asset-unready');
  assert.equal(planCrops(capture([asset({bounds:{x:0,y:200,width:0,height:5}})]),shot()).rejections[0].code,'invalid-asset-bounds');
  assert.equal(planCrops(capture([asset({transform:'matrix(0,1,-1,0,0,0)'})]),shot()).rejections[0].code,'unsupported-asset-transform');
});

test('global duplicate IDs and queues referring to absent assets fail explicitly', () => {
  assert.equal(planCrops(capture([asset(),asset()]),shot()).rejections[0].code,'duplicate-asset-id');
  const input = {...capture(),ocrQueue:[{assetId:'unknown',questionKey:'q1'}]};
  assert.equal(planCrops(input,shot()).rejections[0].code,'queue-asset-missing');
});

test('source-only assets with empty OCR/visual queues do not acquire or crop', () => {
  const input = {...capture(),ocrQueue:[],visualQueue:[]};
  assert.equal(planAssetAcquisition(input,inventory()).plans.length,0);
  assert.equal(planCrops(input,shot()).plans.length,0);
});

test('visual-only SVG remains mapped for review and never becomes an OCR job', () => {
  const svg = asset({assetId:'svg-1',kind:'svg',naturalSize:null,source:null,requiresOCR:false,requiresVisualReview:true});
  const input = {...capture([svg]),ocrQueue:[],visualQueue:[{assetId:'svg-1',questionKey:'q1',questionKeys:['q1','q2'],mode:'visual'}]};
  const result = prepareAssetMappings(input,{screenshots:[shot()]});
  assert.equal(result.mappings.length,1);
  assert.equal(result.mappings[0].needsOCR,false);
  assert.equal(result.mappings[0].needsVisualReview,true);
  const completed = {...result.mappings[0],status:'ready',path:'work/svg-review.png',sha256:hash};
  const manifest = createOcrManifest([completed]);
  assert.equal(manifest.images.length,0);
  assert.equal(manifest.rejections.length,0);
  assert.equal(result.mappings.length,1);
});

test('two OCR and three visual tasks yield three review mappings but only two OCR entries', () => {
  const assets = [asset({assetId:'png-1'}),asset({assetId:'background-1',kind:'background-image',naturalSize:null}),asset({assetId:'svg-1',kind:'svg',naturalSize:null})];
  const input = capture(assets);
  input.ocrQueue = input.ocrQueue.slice(0,2);
  input.visualQueue = assets.map(item => ({assetId:item.assetId,questionKey:'q1',questionKeys:['q1','q2'],mode:'visual'}));
  const result = prepareAssetMappings(input,{screenshots:[shot()]});
  assert.equal(result.mappings.length,3);
  assert.deepEqual(result.mappings.map(item => item.needsOCR),[true,true,false]);
  const completed = result.mappings.map((item,index) => ({...item,status:'ready',path:`work/crop-${index}.png`,sha256:hash}));
  const manifest = createOcrManifest(completed);
  assert.equal(manifest.images.length,input.ocrQueue.length);
  assert.equal(result.mappings.filter(item => item.needsVisualReview).length,input.visualQueue.length);
  assert.deepEqual(manifest.images.map(item => item.assetId),['png-1','background-1']);
});

test('confirmed observed originals take precedence over screenshots; unknown originals do not', () => {
  const original = {pageAssetId:'observed-9',path:'work/original.png',sha256:hash,pixelSize:{width:70,height:61}};
  const ready = prepareAssetMappings(capture(),{inventory:inventory(),originals:[original],screenshots:[shot()]});
  assert.equal(ready.rejections.length,0);
  assert.equal(ready.mappings[0].acquisition,'observed-original');
  assert.equal(ready.mappings[0].path,'work/original.png');
  const unknown = prepareAssetMappings(capture(),{inventory:inventory(),originals:[{...original,pageAssetId:'not-observed'}],screenshots:[shot()]});
  assert.equal(unknown.mappings[0].acquisition,'screenshot-crop');
  const missing = prepareAssetMappings(capture(),{originals:[original]});
  assert.equal(missing.mappings.length,0);
  assert.equal(missing.rejections[0].code,'no-original-or-frame-screenshot');
});

test('ambiguous originals or mismatched content hashes fall back to a verified screenshot', () => {
  const original = {pageAssetId:'observed-9',path:'work/original.png',sha256:hash,pixelSize:{width:70,height:61}};
  const ambiguous = prepareAssetMappings(capture(),{inventory:inventory(),originals:[original,{...original,path:'work/other.png',sha256:'b'.repeat(64)}],screenshots:[shot()]});
  assert.equal(ambiguous.mappings[0].acquisition,'screenshot-crop');
  assert.equal(ambiguous.warnings[0].code,'ambiguous-original-files');
  const mismatch = prepareAssetMappings(capture(),{inventory:inventory(),originals:[{...original,buffer:Buffer.from('changed content')}],screenshots:[shot()]});
  assert.equal(mismatch.mappings[0].acquisition,'screenshot-crop');
  assert.equal(mismatch.warnings[0].code,'original-content-hash-mismatch');
});

test('ambiguous screenshots in one frame are rejected rather than chosen by array order', () => {
  const output = prepareAssetMappings(capture(),{screenshots:[shot(),shot({path:'work/second.png',sha256:'c'.repeat(64)})]});
  assert.equal(output.mappings.length,0);
  assert.equal(output.rejections[0].code,'ambiguous-frame-screenshots');
});

test('OCR manifest preserves all question refs and crop provenance without trusting an unfinished plan', () => {
  const plan = planCrops(capture(),shot()).plans[0];
  assert.equal(createOcrManifest([plan]).rejections[0].code,'mapping-not-ready');
  assert.equal(createOcrManifest([{...plan,path:'work/unfinished.png',sha256:hash}]).rejections[0].code,'mapping-not-ready');
  const output = createOcrManifest([{...plan,path:'work/crop.png',sha256:hash,status:'ready'}]);
  assert.equal(output.rejections.length,0);
  assert.equal(output.images[0].imageKey,'image-1');
  assert.deepEqual(output.images[0].questionKeys,['q1','q2']);
  assert.equal(output.images[0].screenshotHash,hash);
  assert.deepEqual(output.images[0].scales,{x:2,y:2});
});

test('optional queues and screenshot metadata remain immutable during mapping preparation', () => {
  const input = {capturedAt,assets:[asset()],questions:[{key:'q1',assetIds:['image-1']}]};
  const descriptor = shot();
  const before = JSON.stringify([input,descriptor]);
  const output = prepareAssetMappings(input,{screenshots:[descriptor]});
  assert.equal(output.mappings.length,1);
  assert.equal(output.mappings[0].questionKey,'q1');
  assert.equal(JSON.stringify([input,descriptor]),before);
});

test('manifest duplicate asset mappings fan out only when the actual local path/hash agree', () => {
  const first = {assetId:'physical-1',path:'work/one.png',sha256:hash,questionKey:'q1',questionKeys:['q1']};
  const shared = createOcrManifest([first,{...first,questionKey:'q2',questionKeys:['q2']}]);
  assert.equal(shared.images.length,1);
  assert.deepEqual(shared.images[0].questionKeys,['q1','q2']);
  const conflict = createOcrManifest([first,{...first,sha256:'d'.repeat(64)}]);
  assert.equal(conflict.images.length,0);
  assert.equal(conflict.rejections[0].code,'conflicting-asset-mapping');
});

test('different assets with unknown equal redacted URLs are never merged', () => {
  const input = capture([asset(),asset({assetId:'image-2',locator:'#q2 img'})]);
  const plans = planCrops(input,shot()).plans;
  assert.equal(plans.length,2);
  assert.deepEqual(plans.map(item => item.assetId),['image-1','image-2']);
});

test('cache key uses image content, language, engine, preprocessing and stable config order', () => {
  const bytes = Buffer.from('fixture PNG pixel bytes'), config = {language:'zh-Hans-CN',engine:{name:'Windows.Media.Ocr',version:'fixture-v1'},preprocess:{padding:2,scale:2}};
  const key = cacheKey(bytes,config);
  assert.match(key,/^[a-f\d]{64}$/);
  assert.equal(key,cacheKey(Buffer.from(bytes),{preprocess:{scale:2,padding:2},engine:{version:'fixture-v1',name:'Windows.Media.Ocr'},language:'zh-Hans-CN'}));
  assert.notEqual(key,cacheKey(Buffer.from('changed pixels'),config));
  assert.notEqual(key,cacheKey(bytes,{...config,language:'en-US'}));
  assert.notEqual(key,cacheKey(bytes,{...config,engine:{...config.engine,version:'fixture-v2'}}));
  assert.notEqual(key,cacheKey(bytes,{...config,preprocess:{padding:2,scale:3}}));
});

test('cache rejects incomplete, empty, cyclic and nonfinite configuration inputs', () => {
  assert.throws(()=>cacheKey(Buffer.alloc(0),{language:'zh',engine:'fixture'}),TypeError);
  assert.throws(()=>cacheKey(Buffer.from('x'),{}),TypeError);
  assert.throws(()=>cacheKey(Buffer.from('x'),{language:'zh',engine:{}}),TypeError);
  assert.throws(()=>cacheKey(Buffer.from('x'),{language:'zh',engine:'fixture',preprocess:{scale:Infinity}}),TypeError);
  const config={language:'zh',engine:'fixture'};config.preprocess=config;
  assert.throws(()=>cacheKey(Buffer.from('x'),config),TypeError);
});
