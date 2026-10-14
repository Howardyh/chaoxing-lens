import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { associateOcrResults } from '../src/ocr-results.js';
const args=process.argv.slice(2);
if(args.length!==4)throw new Error('Usage: node scripts/associate-ocr.mjs capture.json ocr-images.json ocr-result.json NEW-output.json');
const bytes=await readFile(args[0]),capture=JSON.parse(bytes),manifest=JSON.parse((await readFile(args[1],'utf8')).replace(/^\uFEFF/,'')),recognition=JSON.parse((await readFile(args[2],'utf8')).replace(/^\uFEFF/,''));
const result=associateOcrResults(capture,manifest,recognition,{captureHash:createHash('sha256').update(bytes).digest('hex')});
await writeFile(args[3],JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({readings:result.readings.length,rejected:result.rejections.length,unresolved:result.unresolved.length,verified:false}));
