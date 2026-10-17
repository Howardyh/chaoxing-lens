import { createHash } from 'node:crypto';

// Keep the complete capture locally. Only presentation/automation metadata is
// omitted from the reasoning view; no question text is shortened or rewritten.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const unique = values => [...new Set(values)];
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const cell = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/\\/g, '&#92;').replace(/`/g, '&#96;').replace(/\*/g, '&#42;').replace(/_/g, '&#95;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/\r?\n/g, '<br>');
const isChoice = type => ['single-choice', 'multiple-choice', 'true-false'].includes(type);
const choiceToken = option => nonempty(option.label) ? option.label : option.text;

function indexed(values, field) {
  const result = new Map();
  for (const value of values) {
    if (!nonempty(value[field]) || result.has(value[field])) throw new Error(`Missing or duplicate ${field}`);
    result.set(value[field], value);
  }
  return result;
}

export function prepareAnswers(capture) {
  if (capture.schema !== 'chaoxing-visible-questions/v3' || !nonempty(capture.captureId)) throw new Error('Expected a v3 capture with captureId');
  const questions = indexed(capture.questions, 'key');
  const assets = indexed(capture.assets, 'assetId');
  const contexts = indexed(capture.contexts, 'id');
  if (capture.count !== questions.size) throw new Error('Capture count mismatch');
  const review = new Map([...questions.keys()].map(key => [key, new Set()]));
  const tasks = new Map();
  for (const [mode, queue] of [['ocr', capture.ocrQueue], ['visual', capture.visualQueue]]) {
    for (const task of queue || []) {
      if (!assets.has(task.assetId)) throw new Error('Unknown queued asset');
      const entry = tasks.get(task.assetId) || { assetId: task.assetId, questionKeys: [], modes: [], reasons: [] };
      entry.modes = unique([...entry.modes, mode]);
      entry.reasons = unique([...entry.reasons, task.reason].filter(Boolean));
      for (const key of unique([task.questionKey, ...(task.questionKeys || [])].filter(Boolean))) {
        if (!questions.has(key)) throw new Error('Unknown queued question');
        entry.questionKeys = unique([...entry.questionKeys, key]);
        review.get(key).add(task.assetId);
      }
      tasks.set(task.assetId, entry);
    }
  }
  for (const q of questions.values()) {
    const ids = [...q.assetIds, ...q.options.flatMap(o => o.assetIds || [])];
    for (const id of q.contextIds) {
      if (!contexts.has(id)) throw new Error('Unknown question context');
      ids.push(...contexts.get(id).assetIds);
    }
    for (const id of unique(ids)) {
      const asset = assets.get(id);
      if (!asset) throw new Error('Unknown question asset');
      if (asset.requiresOCR || asset.requiresVisualReview || asset.loaded === false || ['conflicting', 'unparsed'].includes(asset.sourceStatus)) review.get(q.key).add(id);
    }
  }
  const captureHash = hash(capture);
  const packet = {
    schema: 'chaoxing-solve-packet/v1', captureId: capture.captureId, captureHash,
    page: { title: capture.page?.title }, scope: capture.scope, count: capture.count,
    questions: capture.questions.map(q => ({
      ...without(q, ['sourceId', 'locator', 'bounds', 'fullText']),
      options: q.options.map(o => without(o, ['locator', 'groupLocator', 'selectedSource'])),
      controls: q.controls.map((c, i) => ({ ...without(c, ['locator']), slot: i + 1 })),
      reviewAssetIds: [...review.get(q.key)]
    })),
    contexts: capture.contexts.map(c => without(c, ['locator', 'bounds'])),
    assets: capture.assets.map(a => without(a, ['locator', 'bounds', 'source', 'naturalWidth', 'naturalHeight', 'naturalSize', 'unsupportedTransform'])),
    reviewTasks: [...tasks.values()], warnings: capture.warnings || []
  };
  const template = {
    schema: 'chaoxing-answers/v1', captureId: capture.captureId, captureHash,
    answers: packet.questions.map(q => ({
      questionKey: q.key, status: 'review',
      ...(isChoice(q.type) ? { choices: [] } : q.type === 'fill-in' ? { blanks: [] } : { text: '' }),
      reviewedAssetIds: [], reviewedWarnings: [], note: ''
    }))
  };
  return { packet, template };
}

// "ready" records the solver's judgment, not a proof of correctness. The
// formatter checks identity, answer shape and outstanding visual checks only.
export function formatAnswers(capture, answers) {
  const { packet } = prepareAnswers(capture);
  if (answers.schema !== 'chaoxing-answers/v1' || answers.captureId !== packet.captureId || answers.captureHash !== packet.captureHash) throw new Error('Answers belong to a different or changed capture; solve against this capture again');
  const entries = indexed(answers.answers, 'questionKey');
  const known = new Set(packet.questions.map(q => q.key));
  if ([...entries.keys()].some(key => !known.has(key))) throw new Error('Unknown answer questionKey');
  const counts = new Map();
  for (const q of packet.questions) if (q.questionNumber != null) counts.set(q.questionNumber, (counts.get(q.questionNumber) || 0) + 1);
  const rows = packet.questions.map((q, i) => {
    const number = q.questionNumber;
    const ambiguous = number == null || counts.get(number) !== 1;
    const label = ambiguous ? `${number == null ? '无题号' : number}（页面第${i + 1}题）` : String(number);
    const a = entries.get(q.key);
    const issues = [];
    let answer = '', details = '', blocks = [];
    if (!a || a.status !== 'ready') issues.push(a?.note || '尚未解答或核验');
    if (a?.status === 'ready') {
      const reviewed = a.reviewedAssetIds || [];
      if (!Array.isArray(reviewed) || q.reviewAssetIds.some(id => !reviewed.includes(id))) issues.push('图片或公式尚未核验');
      const otherWarnings = q.warnings.filter(w => !/^(source-incomplete:|visual-content:|context-visual-content:)/.test(w));
      if (!Array.isArray(a.reviewedWarnings || []) || otherWarnings.some(w => !a.reviewedWarnings?.includes(w))) issues.push('题目读取警告尚未核验');
      if (isChoice(q.type)) {
        const labels = q.options.map(choiceToken);
        const choices = a.choices;
        if (labels.some(l => !nonempty(l)) || new Set(labels).size !== labels.length) issues.push('选项标记不唯一，需要核对原题');
        if (!Array.isArray(choices) || !choices.length || choices.some(v => !labels.includes(v)) || new Set(choices).size !== choices.length || (q.type !== 'multiple-choice' && choices.length !== 1)) {
          issues.push('选项数量或标记不符合原题');
        } else {
          const selected = q.options.filter(o => choices.includes(choiceToken(o)));
          answer = selected.map(choiceToken).join('、');
          details = selected.map(o => o.text).join('；');
          if (q.type === 'true-false') answer = details;
        }
      } else if (q.type === 'fill-in') {
        const slots = q.controls.filter(c => ['text', 'textarea', 'contenteditable'].includes(c.kind));
        if (!slots.length || !Array.isArray(a.blanks) || a.blanks.length !== slots.length || a.blanks.some(v => !nonempty(v))) issues.push('填空数量或内容不符合原题');
        else { answer = a.blanks.map((v, index) => `第${index + 1}空：${v}`).join('\n'); blocks = a.blanks.map((value, index) => ({ label: `第${index + 1}空`, value })); }
      } else if (q.type === 'free-text') {
        if (!nonempty(a.text)) issues.push('缺少可填写的正文');
        else { answer = a.text; blocks = [{ label: '答案', value: a.text }]; }
      } else issues.push('题型尚未确认');
    }
    if (ambiguous) details = `题干：${q.prompt.replace(/\s+/g, ' ').slice(0, 80)}${details ? '；' + details : ''}`;
    return { questionKey: q.key, label, type: q.type, status: issues.length ? 'review' : 'ready', answer: issues.length ? null : answer, details, blocks: issues.length ? [] : blocks, issues, note: a?.note || '' };
  });
  const ready = rows.filter(r => r.status === 'ready').length;
  const lines = [`当前已读取 ${rows.length} 题：可填写 ${ready} 题，待确认 ${rows.length - ready} 题。`, '', '以下仅覆盖本次已读取范围。'];
  if (packet.warnings.length) lines.push('', '页面读取警告：' + packet.warnings.map(w => cell(typeof w === 'string' ? w : w.reason || JSON.stringify(w))).join('；'));
  lines.push('', '| 题号 | 填写内容 | 对照 / 说明 |', '| --- | --- | --- |');
  for (const row of rows) {
    const value = row.status === 'review' ? '待确认' : row.blocks.length ? '见下方可复制内容' : row.answer;
    lines.push(`| ${cell(row.label)} | ${cell(value)} | ${cell(row.status === 'review' ? row.issues.join('；') : row.details)} |`);
  }
  for (const row of rows.filter(r => r.blocks.length)) {
    for (const block of row.blocks) {
      const longest = Math.max(0, ...(block.value.match(/`+/g) || []).map(s => s.length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      lines.push('', `**${cell(row.label)} · ${block.label}**`, '', fence + 'text', block.value, fence);
    }
  }
  const notes = rows.filter(r => r.status === 'ready' && r.note);
  if (notes.length) lines.push('', '必要说明：', '', ...notes.map(r => `- ${cell(r.label)}：${cell(r.note)}`));
  return { schema: 'chaoxing-answer-sheet/v1', captureId: packet.captureId, ready, pending: rows.length - ready, rows, markdown: lines.join('\n') + '\n' };
}
