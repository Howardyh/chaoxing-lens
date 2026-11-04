import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareAnswers } from './answer-sheet.mjs';
import { contentHash } from './semantic-cache.mjs';
import { createHash } from 'node:crypto';

const [input, out, enrichmentFile] = process.argv.slice(2);
if (!input || !out) throw new Error('Usage: node prepare-answers.mjs capture.json NEW-output-directory');
const bytes = await readFile(input), capture = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
const enrichment = enrichmentFile ? JSON.parse(await readFile(enrichmentFile, 'utf8')) : {};
if (enrichment.captureHash && ![contentHash(capture), createHash('sha256').update(bytes).digest('hex')].includes(enrichment.captureHash)) throw new Error('Enrichment belongs to another capture');
const { packet, template, reference } = prepareAnswers(capture, enrichment);
await mkdir(out); // Never overwrite a prior run or its answers.
await writeFile(path.join(out, 'solve-packet.json'), JSON.stringify(packet));
await writeFile(path.join(out, 'answers.json'), JSON.stringify(template, null, 2) + '\n');
await writeFile(path.join(out, 'evaluation-reference.json'), JSON.stringify(reference, null, 2) + '\n');
console.log(JSON.stringify({ questions: packet.count, reviewAssets: packet.reviewTasks.length, captureBytes: Buffer.byteLength(JSON.stringify(capture)), packetBytes: Buffer.byteLength(JSON.stringify(packet)), directory: path.resolve(out) }));
