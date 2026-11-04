import { readFile, writeFile } from 'node:fs/promises';
import { evaluateRuns } from '../src/evaluation.js';
const [dataset, runs, output] = process.argv.slice(2);
if (!dataset || !runs || !output) throw new Error('Usage: node evaluate-runs.mjs local/blind-reference.json local/runs.json NEW-report.json');
const load = async file => JSON.parse(await readFile(file, 'utf8'));
const report = evaluateRuns(await load(dataset), await load(runs));
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
