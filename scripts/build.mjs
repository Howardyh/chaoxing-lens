import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractVisibleQuestions } from '../src/extractor.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const digest = createHash('sha256').update((await readFile(path.join(root, 'src/extractor.js'), 'utf8')).replace(/\r\n/g, '\n')).digest('hex');
const header = `/* Chaoxing Lens ${pkg.version}; source-sha256=${digest}\n * Read-only DOM extraction. No network, storage, page JS or UI writes. */\n`;
await mkdir(path.join(root, 'skill/scripts'), { recursive: true });
for (const [filename, diagnostics] of [['extract-questions.js', false], ['extract-questions-diagnostic.js', true]]) {
  const expression = `${header}(${extractVisibleQuestions.toString().replace(/\r\n/g, '\n')})(document, ${JSON.stringify({ diagnostics, instrument: true })})\n`;
  await writeFile(path.join(root, 'skill/scripts', filename), expression, 'utf8');
}
for (const [from, to, replacements] of [
  ['src/asset-pipeline.js','asset-pipeline.mjs',[]],
  ['src/ocr-results.js','ocr-results.mjs',[]],
  ['src/answer-sheet.js','answer-sheet.mjs',[]],
  ['scripts/prepare-assets.mjs','prepare-assets.mjs',[["'../src/asset-pipeline.js'","'./asset-pipeline.mjs'"]]],
  ['scripts/associate-ocr.mjs','associate-ocr.mjs',[["'../src/ocr-results.js'","'./ocr-results.mjs'"]]],
  ['scripts/prepare-answers.mjs','prepare-answers.mjs',[["'../src/answer-sheet.js'","'./answer-sheet.mjs'"]]],
  ['scripts/format-answers.mjs','format-answers.mjs',[["'../src/answer-sheet.js'","'./answer-sheet.mjs'"]]]
]) {
  let text = (await readFile(path.join(root,from),'utf8')).replace(/\r\n/g,'\n');
  for(const [a,b] of replacements) text=text.replace(a,b);
  await writeFile(path.join(root,'skill/scripts',to),text);
}
await writeFile(path.join(root, 'skill/build.json'), JSON.stringify({ project: pkg.name, version: pkg.version, sourceSha256: digest, schema: 'chaoxing-visible-questions/v3' }, null, 2) + '\n');
await mkdir(path.join(root, 'dist'), { recursive: true });
await cp(path.join(root, 'skill'), path.join(root, 'dist/chaoxing-study'), { recursive: true });
console.log(`Built ${pkg.name} ${pkg.version}: compact + diagnostic expressions and portable skill`);
