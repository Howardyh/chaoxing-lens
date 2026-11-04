import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildJevRequest, runJevCheck } from './jev-assist.mjs';

const [input, output, action] = process.argv.slice(2);
if (!input || !output || action && action !== '--send') throw new Error('Usage: node check-jev.mjs local/minimal-check.json NEW-result.json [--send]');
const job = JSON.parse(await readFile(input, 'utf8'));
if (job.imagePath) job.image = { format: job.imageFormat || 'png', bytes: await readFile(path.resolve(path.dirname(input), job.imagePath)) };
const request = buildJevRequest(job);
// Preview is the default. Inspect the sanitized local payload and consent to
// the intended data, maximum calls and spending before using --send.
const result = action === '--send' ? await runJevCheck(request, { timeoutMs: job.timeoutMs || 5000, threshold: job.threshold ?? 0.9 }) : { schema: 'chaoxing-jev-preview/v1', maxRequests: 1, request };
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: result.status || 'preview-only', output, latencyMs: result.latencyMs, usage: result.usage }));
