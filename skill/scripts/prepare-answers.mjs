import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareAnswers } from './answer-sheet.mjs';

const [input, out] = process.argv.slice(2);
if (!input || !out) throw new Error('Usage: node prepare-answers.mjs capture.json NEW-output-directory');
const capture = JSON.parse(await readFile(input, 'utf8'));
const { packet, template } = prepareAnswers(capture);
await mkdir(out); // Never overwrite a prior run or its answers.
await writeFile(path.join(out, 'solve-packet.json'), JSON.stringify(packet));
await writeFile(path.join(out, 'answers.json'), JSON.stringify(template, null, 2) + '\n');
console.log(JSON.stringify({ questions: packet.count, reviewAssets: packet.reviewTasks.length, captureBytes: Buffer.byteLength(JSON.stringify(capture)), packetBytes: Buffer.byteLength(JSON.stringify(packet)), directory: path.resolve(out) }));
