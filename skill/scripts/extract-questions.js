/* Chaoxing Lens 0.3.0; source-sha256=5981143175f90dad280fb11cfdf7493d16c29cd93a5ad74472ef397da57dda0d
 * Read-only DOM extraction. No network, storage, page JS or UI writes. */
(function extractVisibleQuestions(rootDocument, options = {}) {
  const VERSION = "0.3.0";
  const started = Date.now();
  const capturedAt = new Date(started).toISOString();
  const captureId = String(options.captureId || capturedAt + ":" + Math.random().toString(36).slice(2, 9));
  const diagnostic = Boolean(options.diagnostics);
  const instrument = Boolean(options.instrument || options.instrumentation);
  const configured = options.selectors || {};
  const QUESTION = configured.question || '.TiMu, .mark_item, .questionLi, .question-item, .question_item, [id^="question"], [id^="sigleQuestionDiv_"], [data-question-id]';
  const OPTION = configured.option || '.Zy_ulTop > li, .Zy_ulBottom > li, .answerList > li, li.answerBg, div.answerBg, .option, [role="radio"], [role="checkbox"]';
  const REVIEW = configured.review || '.mark_answer, .analysis, .answer-analysis, .reference-answer';
  const MATH = configured.math || 'math, .katex, .MathJax, mjx-container, [role="math"]';
  const SKIP = configured.skip || 'script, style, noscript, template, button, .nextDiv, .asFlagBtn';
  const counters = { nodeVisits: 0, styleReads: 0, visibilityChecks: 0, pathBuilds: 0, formulaRoots: 0, questionRoots: 0, contextRoots: 0 };
  const styles = new Map();
  const visibility = new Map();
  const paths = new Map();
  const siblingOrdinals = new Map();
  const assetNodes = new Map();
  const visitedDocuments = new Set();
  const usedQuestionKeys = new Set();
  const contextConsumers = new Map();
  const questions = [];
  const assets = [];
  const contexts = [];
  const frames = [];
  const warnings = [];
  let ephemeralQuestion = 0;
  let ephemeralContext = 0;
  const clean = value => String(value ?? "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const lowerTag = el => String(el.tagName || "").toLowerCase();

  function styleOf(el) {
    if (!styles.has(el)) {
      counters.styleReads++;
      styles.set(el, el.ownerDocument.defaultView.getComputedStyle(el));
    }
    return styles.get(el);
  }

  function visibleText(node) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 || !visible(node) || node.matches(SKIP)) return '';
    return [...node.childNodes].map(visibleText).join('');
  }

  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (visibility.has(el)) return visibility.get(el);
    counters.visibilityChecks++;
    const s = styleOf(el);
    const own = !el.hidden && s.display !== "none" && s.visibility !== "hidden" && s.visibility !== "collapse" && s.contentVisibility !== "hidden" && Number(s.opacity) !== 0;
    const ancestors = !el.parentElement || visible(el.parentElement);
    const rendered = own && ancestors && (s.display === "contents" || el.getClientRects().length > 0);
    visibility.set(el, rendered);
    return rendered;
  }

  function cssEscape(value, doc) {
    const native = doc.defaultView?.CSS?.escape;
    if (typeof native === "function") return native(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]|^[0-9]/g, ch => "\\" + ch.codePointAt(0).toString(16) + " ");
  }

  function pathOf(el) {
    if (paths.has(el)) return paths.get(el);
    counters.pathBuilds++;
    let path;
    if (el.id) path = "#" + cssEscape(el.id, el.ownerDocument);
    else {
      const parent = el.parentElement;
      if (parent && !siblingOrdinals.has(parent)) {
        const byTag = new Map();
        const byElement = new Map();
        for (const child of parent.children) {
          const tag = lowerTag(child);
          const ordinal = (byTag.get(tag) || 0) + 1;
          byTag.set(tag, ordinal);
          byElement.set(child, ordinal);
        }
        siblingOrdinals.set(parent, byElement);
      }
      const own = lowerTag(el) + ":nth-of-type(" + (parent ? siblingOrdinals.get(parent).get(el) : 1) + ")";
      path = parent ? pathOf(parent) + " > " + own : own;
    }
    paths.set(el, path);
    return path;
  }

  function bounds(el) {
    const r = el.getBoundingClientRect();
    const w = el.ownerDocument.defaultView;
    return { x: r.x + (w.scrollX || 0), y: r.y + (w.scrollY || 0), width: r.width, height: r.height };
  }

  function redactedURL(raw, doc) {
    if (!raw) return "";
    try {
      const url = new URL(raw, doc.baseURI);
      return /^https?:$/.test(url.protocol) ? url.origin + url.pathname : "[" + url.protocol.replace(":", "") + "]";
    } catch { return "[invalid-url]"; }
  }

  function sourceIdOf(el) {
    for (let p = el; p; p = p.parentElement) {
      if (/^question\d+$/.test(p.id) || /^sigleQuestionDiv_\d+$/.test(p.id)) return p.id;
      const dataId = p.getAttribute("data-question-id");
      if (dataId) return dataId;
    }
    return null;
  }

  function isEditor(el) {
    if (!el.hasAttribute("contenteditable")) return false;
    return ["", "true", "plaintext-only"].includes((el.getAttribute("contenteditable") || "").toLowerCase());
  }

  function metadata(el) {
    const result = [];
    for (const [origin, format] of [["data-latex", "tex"], ["data-tex", "tex"], ["data-mathml", "mathml"], ["aria-label", "text"], ["alt", "text"], ["title", "text"]]) {
      const text = clean(el.getAttribute(origin));
      if (!text || text.length > 20000) continue;
      if (/^(?:图(?:片)?|公式|插图|image|img|math|formula|equation)[\s\d.:：_-]*$/i.test(text) || /^[^\\/\s]+\.(png|jpe?g|gif|svg|webp)$/i.test(text)) continue;
      result.push({ origin, format, text });
    }
    return result;
  }

  function plausibleTex(text) {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === "{") depth++;
      if (text[i] === "}" && --depth < 0) return false;
    }
    return depth === 0;
  }

  // Read semantic children only, not KaTeX's duplicate visual representation.
  function mathTree(root) {
    const unsupported = new Set();
    const annotations = [];
    function read(node) {
      if (node.nodeType === 3) return clean(node.nodeValue);
      if (node.nodeType !== 1) return "";
      const tag = lowerTag(node);
      const children = [...node.children];
      const at = i => children[i] ? read(children[i]) : "";
      if (tag === "annotation") {
        const encoding = node.getAttribute("encoding") || "";
        if (/^(application\/x-tex|application\/x-latex|text\/(?:x-)?tex)$/i.test(encoding)) {
          const text = clean(node.textContent);
          if (text && text.length <= 20000) annotations.push({ origin: "mathml-annotation", format: "tex", text });
        }
        return "";
      }
      if (["annotation-xml", "script", "style"].includes(tag)) return "";
      const ownStyle = node.ownerDocument.defaultView ? styleOf(node) : { opacity: '1' };
      if (node.hidden || ownStyle.display === 'none' || ['hidden','collapse'].includes(ownStyle.visibility) || Number(ownStyle.opacity) === 0) {
        unsupported.add('hidden-presentation');
        return '';
      }
      if (tag === "semantics") {
        const value = at(0);
        for (const child of children.slice(1)) if (lowerTag(child) === "annotation") read(child);
        return value;
      }
      const arities = { mfrac: 2, msup: 2, msub: 2, msubsup: 3, mroot: 2, mover: 2, munder: 2, munderover: 3 };
      if (arities[tag] && children.length !== arities[tag]) unsupported.add(tag + ":invalid-arity");
      if (tag === "mfrac") return "(" + at(0) + ")/(" + at(1) + ")";
      if (tag === "msup") return "(" + at(0) + ")^(" + at(1) + ")";
      if (tag === "msub") return "(" + at(0) + ")_(" + at(1) + ")";
      if (tag === "msubsup") return "(" + at(0) + ")_(" + at(1) + ")^(" + at(2) + ")";
      if (tag === "msqrt") return "sqrt(" + [...node.childNodes].map(read).join(" ") + ")";
      if (tag === "mroot") return "root(" + at(1) + ", " + at(0) + ")";
      if (tag === "mover") return "over(" + at(0) + ", " + at(1) + ")";
      if (tag === "munder") return "under(" + at(0) + ", " + at(1) + ")";
      if (tag === "munderover") return "under-over(" + at(0) + ", " + at(1) + ", " + at(2) + ")";
      if (tag === "mfenced") {
        const open = node.hasAttribute("open") ? node.getAttribute("open") : "(";
        const close = node.hasAttribute("close") ? node.getAttribute("close") : ")";
        const separators = [...(node.hasAttribute("separators") ? node.getAttribute("separators") : ",")].filter(c => !/\s/.test(c));
        let text = "";
        children.forEach((child, i) => {
          if (i && separators.length) text += separators[Math.min(i - 1, separators.length - 1)];
          text += read(child);
        });
        return open + text + close;
      }
      if (tag === "mtable") return "matrix[" + children.map(read).join("; ") + "]";
      if (tag === "mtr" || tag === "mlabeledtr") return children.map(read).join(", ");
      const supported = ["math", "mrow", "mi", "mo", "mn", "mtext", "mspace", "mtd"];
      if (!supported.includes(tag)) unsupported.add(tag);
      return clean([...node.childNodes].map(read).join(" "));
    }
    const text = read(root);
    return { text, annotations, unsupported: [...unsupported] };
  }

  function parseMathML(text, doc) {
    try {
      const Parser = doc.defaultView?.DOMParser;
      if (typeof Parser !== "function") return null;
      const parsed = new Parser().parseFromString(text, "application/xml");
      if (parsed.querySelector("parsererror")) return null;
      const root = lowerTag(parsed.documentElement) === "math" ? parsed.documentElement : null;
      return root ? mathTree(root) : null;
    } catch { return null; }
  }

  function visualKind(el) {
    if (el.matches(MATH)) return "math";
    const tag = lowerTag(el);
    if (["img", "svg", "canvas"].includes(tag)) return tag === "img" ? "image" : tag;
    return /url\(/i.test(styleOf(el).backgroundImage || "") ? "background-image" : null;
  }

  function unsupportedTransform(el) {
    for (let p = el; p; p = p.parentElement) {
      const value = styleOf(p).transform || "none";
      if (value === "none") continue;
      const two = value.match(/^matrix\(([^)]+)\)$/);
      if (two) {
        const n = two[1].split(",").map(Number);
        if (n.length !== 6 || n.some(x => !Number.isFinite(x)) || Math.abs(n[1]) > 1e-8 || Math.abs(n[2]) > 1e-8) return true;
        continue;
      }
      const three = value.match(/^matrix3d\(([^)]+)\)$/);
      if (three) {
        const n = three[1].split(",").map(Number);
        if (n.length !== 16 || n.some(x => !Number.isFinite(x)) || [1, 2, 3, 4, 6, 7, 8, 9, 11].some(i => Math.abs(n[i]) > 1e-8)) return true;
        continue;
      }
      if (!/^(?:\s*(?:translate(?:X|Y|Z|3d)?|scale(?:X|Y|Z|3d)?)\([^)]*\)\s*)+$/.test(value)) return true;
    }
    return false;
  }

  function describeAsset(el, kind) {
    const sources = metadata(el);
    const canonical = [];
    const unsupportedMath = [];
    let unparsed = false;
    for (const source of sources) {
      if (source.format === "tex") {
        if (plausibleTex(source.text)) canonical.push(source);
        else unparsed = true;
      } else if (source.format === "mathml") {
        const parsed = parseMathML(source.text, el.ownerDocument);
        if (parsed && parsed.text && !parsed.unsupported.length) canonical.push({ ...source, parsedText: parsed.text });
        else unparsed = true;
      }
    }
    if (kind === "math") {
      counters.formulaRoots++;
      const math = lowerTag(el) === "math" ? el : el.querySelector("math");
      if (math) {
        const parsed = mathTree(math);
        unsupportedMath.push(...parsed.unsupported);
        for (const source of parsed.annotations) {
          sources.push(source);
          if (plausibleTex(source.text)) canonical.push(source);
          else unparsed = true;
        }
        if (parsed.text && !parsed.unsupported.length) {
          const source = { origin: "mathml-structure", format: "linear-math", text: parsed.text };
          sources.push(source);
          canonical.push(source);
        } else unparsed = true;
      }
    }
    const normalize = text => text.replace(/\s+/g, "");
    const texTexts = new Set(canonical.filter(s => s.format === "tex").map(s => normalize(s.text)));
    const mlTexts = new Set(canonical.filter(s => s.format === "mathml" || s.format === "linear-math").map(s => normalize(s.parsedText || s.text)));
    // Different representations are retained. Raw TeX and spoken labels are not
    // treated as contradictory merely because their strings have different syntax.
    const sourceConflict = texTexts.size > 1 || mlTexts.size > 1;
    const preferred = canonical.find(s => s.format === "tex") || canonical.find(s => s.format === "mathml") || canonical.find(s => s.format === "linear-math");
    let sourceText = preferred ? preferred.parsedText || preferred.text : sources.find(s => s.format === "text")?.text || "";
    let sourceStatus = sourceConflict ? "conflicting" : preferred ? "canonical" : unparsed ? "unparsed" : sourceText ? "label-only" : "unparsed";
    let requiresOCR = sourceStatus !== "canonical";
    let requiresVisualReview = sourceConflict || ["svg", "canvas", "background-image"].includes(kind) || sourceStatus !== "canonical";
    const result = {
      kind, locator: pathOf(el), bounds: bounds(el), sources, sourceText,
      sourceStatus, sourceAvailable: Boolean(sourceText), sourceConflict,
      requiresOCR, requiresVisualReview
    };
    result.unsupportedTransform = unsupportedTransform(el);
    if (kind === "math") result.unsupportedMath = [...new Set(unsupportedMath)];
    if (kind === "image") {
      result.alt = el.getAttribute("alt") || "";
      result.source = redactedURL(el.currentSrc || el.getAttribute("src"), el.ownerDocument);
      result.loaded = Boolean(el.complete && el.naturalWidth);
      result.naturalWidth = Number(el.naturalWidth || 0);
      result.naturalHeight = Number(el.naturalHeight || 0);
      result.naturalSize = { width: result.naturalWidth, height: result.naturalHeight };
    }
    if (kind === "svg") {
      result.visibleLabels = [...el.querySelectorAll("text")].filter(visible).map(node => clean(visibleText(node))).filter(Boolean);
      if (!preferred && result.visibleLabels.length) {
        result.sourceText = result.visibleLabels.join(" ");
        result.sourceStatus = "label-only";
        result.sourceAvailable = true;
        result.sources.push({ origin: "svg-text", format: "text", text: result.sourceText });
        result.requiresOCR = false;
      }
      result.requiresVisualReview = true;
    }
    return result;
  }

  function makeBucket(owner, ownerIndex, el) {
    return { owner, ownerIndex, el, pieces: [], assetOrdinal: 0, assetIds: [], nativeChoices: [], roles: [], selectedMarker: false, ordinaryMarker: false, markerLabels: [] };
  }

  function controlRecord(el, kind) {
    const result = { kind, locator: pathOf(el), disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true", readOnly: Boolean(el.readOnly) || el.hasAttribute("readonly") || el.getAttribute("aria-readonly") === "true", label: clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || "") };
    if (kind === "radio" || kind === "checkbox") result.selected = Boolean(el.checked);
    else if (kind === "select") result.currentText = [...el.selectedOptions].map(option => clean(option.textContent)).join("; ");
    else if (kind !== "contenteditable") result.currentText = String(el.value || "");
    return result;
  }

  function isOptionRoot(el) {
    if (el.matches(OPTION)) return true;
    if (lowerTag(el) === "label") {
      const associated = el.control;
      return associated && /^(radio|checkbox)$/.test(associated.type) && el.contains(associated);
    }
    return false;
  }

  // A single partition traversal emits each region's prompt, choices, reviews,
  // controls and visual assets together. Shared context regions are scanned once.
  function scanRegion(root, frame, key, excludedRoots, isContext) {
    const prompt = makeBucket(isContext ? "context" : "prompt", null, root);
    const optionBuckets = [];
    const reviewBuckets = [];
    const controls = [];
    const ownAssetIds = [];
    const headings = [];
    const fullPieces = [];
    const editorControls = [];
    const editorBuckets = [];
    function emit(bucket, text) {
      bucket.pieces.push(text);
      if (diagnostic) fullPieces.push(text);
    }
    function registerAsset(el, kind, bucket) {
      let asset = assetNodes.get(el);
      if (!asset) {
        const ordinal = ++bucket.assetOrdinal;
        const suffix = bucket.owner + (bucket.ownerIndex == null ? "" : ":" + bucket.ownerIndex) + ":" + ordinal;
        asset = { assetId: key + "::" + suffix, ...describeAsset(el, kind), frame, owner: bucket.owner, ownerIndex: bucket.ownerIndex, optionLabel: null };
        if (isContext) asset.contextId = key;
        else asset.questionKey = key;
        addAsset(asset);
        assetNodes.set(el, asset);
      }
      bucket.assetIds.push(asset.assetId);
      ownAssetIds.push(asset.assetId);
      emit(bucket, "[[" + asset.assetId + (asset.sourceText ? ": " + asset.sourceText : "") + "]]");
    }
    function walk(node, parentBucket, editor = null) {
      counters.nodeVisits++;
      if (node.nodeType === 3) { emit(parentBucket, node.nodeValue || ""); return; }
      if (node.nodeType !== 1 || (node !== root && excludedRoots.has(node))) return;
      const el = node;
      const tag = lowerTag(el);
      if (el.matches(SKIP)) return;
      const nativeInput = tag === "input";
      const inputKind = nativeInput ? String(el.type || "text").toLowerCase() : null;
      if (nativeInput && ["hidden", "password", "file", "submit", "button", "reset", "image"].includes(inputKind)) return;
      const choice = nativeInput && (inputKind === "radio" || inputKind === "checkbox");
      // Styled native radios may be visually hidden; their rendered option label
      // is the scope. Other hidden controls and hidden text are never read.
      const rendered = visible(el);
      if (!rendered && !(choice && parentBucket.owner === "option")) return;
      let bucket = parentBucket;
      if (!isContext && parentBucket.owner !== "review" && el.matches(REVIEW)) {
        bucket = makeBucket("review", reviewBuckets.length + 1, el);
        reviewBuckets.push(bucket);
      } else if (isContext && (el.matches(REVIEW) || isEditor(el))) return;
      else if (!isContext && parentBucket.owner === "prompt" && isOptionRoot(el)) {
        bucket = makeBucket("option", optionBuckets.length + 1, el);
        optionBuckets.push(bucket);
      }
      if (!isContext && !editor && isEditor(el) && bucket.owner !== "review") {
        emit(bucket, "[输入框]");
        const result = controlRecord(el, "contenteditable");
        controls.push(result);
        editorControls.push(result);
        bucket = makeBucket("current-answer", editorBuckets.length + 1, el);
        editorBuckets.push(bucket);
        editor = result;
      }
      if (nativeInput || tag === "textarea" || tag === "select") {
        if (choice) {
          if (bucket.owner === "option") bucket.nativeChoices.push({ kind: inputKind, selected: Boolean(el.checked) });
        }
        if (!isContext && bucket.owner !== "review") controls.push(controlRecord(el, nativeInput ? inputKind : tag));
        if (!choice && rendered) emit(bucket, "[输入框" + (el.getAttribute("aria-label") ? ": " + el.getAttribute("aria-label") : "") + "]");
        return;
      }
      if (rendered && bucket.owner === "option") {
        const role = el.getAttribute("role");
        if (role === "radio" || role === "checkbox") bucket.roles.push({ kind: role, selected: el.hasAttribute("aria-checked") ? el.getAttribute("aria-checked") === "true" : null });
        if (el.matches(".check_answer,.check_answer_dx")) bucket.selectedMarker = true;
        if (el.matches(".num_option,.num_option_dx")) {
          bucket.ordinaryMarker = true;
          const label = clean(el.getAttribute("aria-label") || visibleText(el));
          if (/^[A-Z]$/.test(label)) bucket.markerLabels.push(label);
        }
      }
      const kind = visualKind(el);
      if (kind) {
        registerAsset(el, kind, bucket);
        if (kind !== "background-image") return;
      }
      const headingStart = tag === "h3" && bucket.owner === "prompt" ? bucket.pieces.length : null;
      if (tag === "br") { emit(bucket, "\n"); return; }
      if (tag === "sup" || tag === "sub") {
        emit(bucket, tag === "sup" ? "^{" : "_{");
        for (const child of el.childNodes) walk(child, bucket, editor);
        emit(bucket, "}");
        return;
      }
      const block = /^(block|flex|grid|table|list-item)/.test(styleOf(el).display);
      if (block) emit(bucket, "\n");
      for (const child of el.childNodes) walk(child, bucket, editor);
      if (block) emit(bucket, "\n");
      if (headingStart != null) headings.push(clean(bucket.pieces.slice(headingStart).join("")));
    }
    walk(root, prompt);
    editorBuckets.forEach((bucket, i) => { editorControls[i].currentText = clean(bucket.pieces.join("")); });
    const choices = optionBuckets.map((bucket, i) => {
      const text = clean(bucket.pieces.join(""));
      const direct = clean(bucket.el.getAttribute("aria-label"));
      const match = text.match(/^\s*([A-Z])(?:[.、．:：)）\s]|$)/);
      const label = bucket.markerLabels[0] || (/^[A-Z]$/.test(direct) ? direct : match ? match[1] : null);
      const native = bucket.nativeChoices[0];
      const aria = bucket.roles.find(role => role.selected != null);
      const selected = native ? native.selected : aria ? aria.selected : bucket.selectedMarker ? true : bucket.ordinaryMarker ? false : null;
      const selectedSource = native ? "input.checked" : aria ? "aria-checked" : bucket.selectedMarker || bucket.ordinaryMarker ? "visible-selection-class" : null;
      return { index: i + 1, label, text, selected, selectedSource, locator: pathOf(bucket.el), groupLocator: bucket.el.parentElement ? pathOf(bucket.el.parentElement) : null, assetIds: bucket.assetIds, kind: native?.kind || bucket.roles[0]?.kind || null };
    });
    const byOption = new Map(choices.map(option => [option.index, option.label]));
    for (const assetId of ownAssetIds) {
      // Region assets form a contiguous suffix of the table, avoiding global scans.
      const asset = assetsById.get(assetId);
      if (asset?.owner === "option") asset.optionLabel = byOption.get(asset.ownerIndex) || null;
    }
    return {
      prompt: clean(prompt.pieces.join("")), choices, controls,
      visibleReview: reviewBuckets.map(bucket => clean(bucket.pieces.join(""))),
      assetIds: [...new Set(ownAssetIds)], headings,
      choiceKinds: optionBuckets.flatMap(bucket => bucket.nativeChoices.concat(bucket.roles).map(choice => choice.kind)),
      fullText: diagnostic ? clean(fullPieces.join("")) : null
    };
  }

  // A direct ID index is maintained as records are appended; no scan/sort/indexOf.
  const assetsById = new Map();
  function addAsset(record) {
    assetsById.set(record.assetId, record);
    assets.push(record);
  }

  function questionType(prompt, kinds, controls) {
    const explicit = prompt.match(/[（(]\s*(单选题|多选题|判断题|填空题|简答题|计算题|论述题|问答题)/)?.[1] || "";
    const text = explicit || prompt;
    if (/多选/.test(text)) return "multiple-choice";
    if (/单选/.test(text)) return "single-choice";
    if (/判断/.test(text)) return "true-false";
    if (/填空/.test(text)) return "fill-in";
    if (/简答题|计算题|论述题|问答题/.test(text)) return "free-text";
    if (kinds.includes("checkbox")) return "multiple-choice";
    if (kinds.includes("radio")) return "single-choice";
    if (controls.some(control => control.kind === "textarea" || control.kind === "contenteditable")) return "free-text";
    return "unknown";
  }

  function scanDocument(doc, frame, depth) {
    if (visitedDocuments.has(doc)) return;
    visitedDocuments.add(doc);
    try {
      const w = doc.defaultView;
      const html = doc.documentElement;
      const body = doc.body;
      frames.push({
        frame,
        documentSize: { width: Math.max(w.innerWidth || 0, html?.scrollWidth || 0, html?.clientWidth || 0, body?.scrollWidth || 0), height: Math.max(w.innerHeight || 0, html?.scrollHeight || 0, html?.clientHeight || 0, body?.scrollHeight || 0) },
        viewport: { width: w.innerWidth || html?.clientWidth || 0, height: w.innerHeight || html?.clientHeight || 0 },
        scroll: { x: w.scrollX || 0, y: w.scrollY || 0 },
        devicePixelRatio: w.devicePixelRatio || 1
      });
    } catch { warnings.push({ frame, reason: "frame-geometry-unavailable" }); }
    let wrappers, candidates;
    try {
      wrappers = [...doc.querySelectorAll(QUESTION)].filter(el => visible(el) && !el.matches(".FullfanyaMarking") && !el.closest(SKIP) && !el.closest(REVIEW));
      candidates = wrappers;
      if (!configured.question) candidates = candidates.filter(el => el.matches(".TiMu,.mark_item,.questionLi,.question-item,.question_item") || /^question\d+$/.test(el.id) || /^sigleQuestionDiv_\d+$/.test(el.id) || el.hasAttribute("data-question-id"));
    } catch {
      warnings.push({ frame, reason: "invalid-question-selector-or-unavailable-DOM" });
      return;
    }
    const wrapperSet = new Set(wrappers);
    const parents = new Map();
    const nonLeaves = new Set();
    for (const el of wrappers) {
      let ancestor = el.parentElement;
      while (ancestor && !wrapperSet.has(ancestor)) ancestor = ancestor.parentElement;
      if (ancestor) parents.set(el, ancestor);
    }
    for (const el of candidates) for (let parent = parents.get(el); parent; parent = parents.get(parent)) nonLeaves.add(parent);
    const excludedRegions = new Set([...candidates, ...nonLeaves]);
    const contextIdByRoot = new Map();
    for (const el of wrappers) {
      if (!nonLeaves.has(el)) continue;
      counters.contextRoots++;
      const directId = el.id || el.getAttribute("data-question-id");
      const id = frame + "::context:" + (directId || "capture-local:" + captureId + ":" + ++ephemeralContext);
      const region = scanRegion(el, frame, id, excludedRegions, true);
      if (!region.prompt && !region.assetIds.length) continue;
      contexts.push({ id, text: region.prompt, assetIds: region.assetIds, locator: pathOf(el), frame, bounds: bounds(el) });
      contextIdByRoot.set(el, id);
      contextConsumers.set(id, []);
    }
    for (const el of candidates) {
      if (nonLeaves.has(el)) continue;
      counters.questionRoots++;
      const sourceId = sourceIdOf(el);
      let key = frame + "::" + (sourceId || "capture-local:" + captureId + ":question:" + ++ephemeralQuestion);
      let identityStatus = sourceId ? "source-id" : "capture-local";
      const ownWarnings = [];
      if (usedQuestionKeys.has(key)) {
        key += "::duplicate:" + captureId + ":" + ++ephemeralQuestion;
        identityStatus = "capture-local";
        ownWarnings.push("duplicate-source-id: identity is capture-local");
      }
      usedQuestionKeys.add(key);
      const region = scanRegion(el, frame, key, new Set(), false);
      const heading = region.headings.find(text => /^\s*\d+[.．、]/.test(text));
      const numberText = clean(el.getAttribute("aria-label")).match(/题目\s*(\d+)/)?.[1] || heading?.match(/^\s*(\d+)[.．、]/)?.[1] || region.prompt.match(/^\s*(\d+)[.．、]/m)?.[1];
      const questionNumber = numberText ? Number(numberText) : null;
      const contextIds = [];
      for (let parent = parents.get(el); parent; parent = parents.get(parent)) {
        const id = contextIdByRoot.get(parent);
        if (id) contextIds.unshift(id);
      }
      for (const id of contextIds) contextConsumers.get(id).push(key);
      const type = questionType(region.prompt, region.choiceKinds, region.controls);
      if (!region.prompt) ownWarnings.push("empty-prompt: inspect DOM/screenshot");
      if (type === "unknown") ownWarnings.push("unknown-question-type");
      if (region.choices.some(choice => !choice.label)) ownWarnings.push("option-label-missing: preserve text; do not invent labels");
      if (region.choices.some(choice => choice.selected === null)) ownWarnings.push("option-selection-unknown: inspect visible state");
      if (region.assetIds.some(id => assetsById.get(id)?.loaded === false)) ownWarnings.push("image-not-loaded");
      const q = { key, sourceId, identityStatus, locator: pathOf(el), index: questions.length + 1, questionNumber, frame, type, prompt: region.prompt, contextIds, options: region.choices, controls: region.controls, visibleReview: region.visibleReview, assetIds: region.assetIds, bounds: bounds(el), warnings: ownWarnings };
      if (diagnostic) q.fullText = region.fullText;
      questions.push(q);
    }
    let childFrames;
    try { childFrames = doc.querySelectorAll("iframe, frame"); } catch { childFrames = []; }
    const maxDepth = Number.isFinite(options.maxFrameDepth) ? Math.max(0, Math.min(10, options.maxFrameDepth)) : 5;
    for (const iframe of childFrames) {
      if (!visible(iframe)) continue;
      const childFrame = frame + " / " + pathOf(iframe);
      if (depth >= maxDepth) { warnings.push({ frame: childFrame, reason: "frame-depth-limit" }); continue; }
      try {
        const child = iframe.contentDocument;
        if (!child || !child.documentElement) throw new Error("inaccessible");
        scanDocument(child, childFrame, depth + 1);
      } catch { warnings.push({ frame: childFrame, reason: "frame-inaccessible: use supported frame tools or screenshot" }); }
    }
  }

  if (!rootDocument || typeof rootDocument.querySelectorAll !== "function") throw new TypeError("A rendered Document is required");
  scanDocument(rootDocument, "top", 0);
  if (!questions.length) warnings.push({ reason: "no-recognized-questions: inspect DOM/screenshot; this does not mean the assignment is empty" });
  const ocrQueue = [];
  const visualQueue = [];
  const questionByKey = new Map(questions.map(q => [q.key, q]));
  const contextById = new Map(contexts.map(context => [context.id, context]));
  for (const context of contexts) context.questionKeys = contextConsumers.get(context.id) || [];
  for (const asset of assets) {
    if (asset.owner === "review" || asset.owner === "current-answer") continue;
    const questionKeys = asset.contextId ? contextConsumers.get(asset.contextId) || [] : [asset.questionKey];
    if (!questionKeys.length) continue;
    const q = questionByKey.get(questionKeys[0]);
    const reason = asset.sourceConflict ? "conflicting-formula-sources" : asset.unsupportedMath?.length && asset.sourceStatus !== "canonical" ? "unsupported-mathml" : asset.sourceStatus === "label-only" ? "label-only-source" : "no-canonical-source";
    const task = mode => ({ assetId: asset.assetId, questionKey: q.key, questionKeys: [...questionKeys], sourceId: q.sourceId, questionNumber: q.questionNumber, frame: asset.frame, owner: asset.owner, ownerIndex: asset.ownerIndex, optionLabel: asset.optionLabel, contextId: asset.contextId || null, locator: asset.locator, bounds: { ...asset.bounds }, mode, reason: mode === "visual" && !asset.sourceConflict ? "diagram-or-unverified-visual" : reason });
    if (asset.requiresOCR) ocrQueue.push(task("ocr"));
    if (asset.requiresVisualReview) visualQueue.push(task("visual"));
  }
  const ocrQuestions = new Set(ocrQueue.flatMap(task => task.questionKeys));
  const visualQuestions = new Set(visualQueue.flatMap(task => task.questionKeys));
  for (const q of questions) {
    if (ocrQuestions.has(q.key)) q.warnings.push("source-incomplete: OCR only the queued assets, then verify");
    if (visualQuestions.has(q.key)) q.warnings.push("visual-content: inspect queued images/diagrams");
    if (q.contextIds.some(id => contextById.get(id).assetIds.some(assetId => assetsById.get(assetId).requiresVisualReview))) q.warnings.push("context-visual-content: include shared material in visual review");
  }
  const result = {
    schema: "chaoxing-visible-questions/v3", version: VERSION, captureId, capturedAt,
    page: { title: rootDocument.title || "", url: redactedURL(rootDocument.location?.href, rootDocument) },
    scope: "currently rendered, CSS-visible questions; offscreen content included; hidden content, unvisited pages and inaccessible frames excluded",
    count: questions.length, questions, assets: [...assets], contexts, frames, ocrQueue, visualQueue,
    summary: { sourceOnlyQuestions: questions.filter(q => q.prompt && !ocrQuestions.has(q.key) && !visualQuestions.has(q.key)).length, ocrTasks: ocrQueue.length, visualTasks: visualQueue.length, assets: assets.length, contexts: contexts.length },
    warnings
  };
  if (instrument) result.metrics = { ...counters, captureElapsedMs: Date.now() - started };
  // Tool serializers sometimes label shared references as circular. This copy is
  // confined to final output and never reads or changes additional page material.
  return JSON.parse(JSON.stringify(result));
})(document, {"diagnostics":false,"instrument":true})
