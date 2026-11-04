const modes = ['baseline', 'improved', 'improved+jev'];
const stages = ['extractionMs', 'toolWaitMs', 'imageMs', 'reasoningMs', 'outputMs', 'totalMs'];
const normalize = value => typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim() : Array.isArray(value) ? value.map(normalize) : value;
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;

// References enter only this evaluator, after a blind solve. Do not concatenate
// this dataset into the solver prompt or infer accuracy from a graded replay.
export function evaluateRuns(dataset, runs) {
  if (dataset.schema !== 'chaoxing-evaluation-set/v1' || !Array.isArray(dataset.cases) || !dataset.cases.length) throw new Error('Expected a nonempty independent evaluation set');
  const cases = new Map(dataset.cases.map(c => [c.id, c]));
  if (cases.size !== dataset.cases.length || dataset.cases.some(c => !c.id || !c.expected?.length || new Set(c.expected.map(q => q.questionKey)).size !== c.expected.length)) throw new Error('Duplicate or empty evaluation identity');
  const records = new Map(), trials = new Set();
  for (const r of runs) {
    if (!cases.has(r.caseId) || !modes.includes(r.mode) || !Number.isInteger(r.trial) || r.trial < 0) throw new Error('Unknown evaluation case/mode/trial');
    const key = JSON.stringify([r.mode, r.trial, r.caseId]);
    if (records.has(key)) throw new Error('Duplicate run');
    if (!Array.isArray(r.answers) || new Set(r.answers.map(a => a.questionKey)).size !== r.answers.length || r.answers.some(a => !cases.get(r.caseId).expected.some(q => q.questionKey === a.questionKey))) throw new Error('Unknown or duplicated evaluated answer');
    if (Object.values(r.timings || {}).some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid timing');
    records.set(key, r); trials.add(r.trial);
  }
  if (!trials.size) trials.add(0);
  return { schema: 'chaoxing-evaluation-report/v1', blindRequired: true, modes: modes.map(mode => {
    let expected = 0, attempted = 0, correct = 0, missingRuns = 0;
    const timings = Object.fromEntries(stages.map(k => [k, []]));
    for (const trial of trials) for (const c of cases.values()) {
      const run = records.get(JSON.stringify([mode, trial, c.id]));
      expected += c.expected.length;
      if (!run) { missingRuns++; continue; }
      for (const q of c.expected) {
        const a = run.answers.find(a => a.questionKey === q.questionKey);
        if (a?.status !== 'ready' || a.value === undefined || a.value === null || a.value === '' || Array.isArray(a.value) && !a.value.length) continue;
        attempted++;
        const canonical = v => JSON.stringify(q.unordered && Array.isArray(v) ? normalize(v).sort() : normalize(v));
        if (canonical(a.value) === canonical(q.value)) correct++;
      }
      for (const k of stages) if (run.timings?.[k] !== undefined) timings[k].push(run.timings[k]);
    }
    return { mode, expected, attempted, correct, missingRuns, accuracy: attempted ? correct / attempted : null, coverage: attempted / expected, overallCorrectRate: correct / expected, timings: Object.fromEntries(stages.map(k => [k, { samples: timings[k].length, p50: percentile(timings[k], 0.5), p95: percentile(timings[k], 0.95) }])) };
  }), note: 'Timings require measured runs; missing samples remain null. Exact canonical agreement does not replace subject-matter review.' };
}
