import { readFile, writeFile } from 'node:fs/promises';
import { formatAnswers } from '../src/answer-sheet.js';

const [captureFile, answerFile, output] = process.argv.slice(2);
if (!captureFile || !answerFile || !output) throw new Error('Usage: node format-answers.mjs capture.json answers.json NEW-answer-sheet.md');
const [capture, answers] = await Promise.all([captureFile, answerFile].map(async file => JSON.parse(await readFile(file, 'utf8'))));
const result = formatAnswers(capture, answers);
await writeFile(output, result.markdown, { flag: 'wx' });
console.log(JSON.stringify({ ready: result.ready, pending: result.pending, output }));
