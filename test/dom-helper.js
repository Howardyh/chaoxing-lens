import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

export function fixtureDom(name) {
  const html = readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.test/questions?enc=DO_NOT_EXPORT', pretendToBeVisual: true });
  installLayout(dom.window);
  for (const frame of dom.window.document.querySelectorAll('iframe[srcdoc]')) {
    const doc = frame.contentDocument;
    doc.open(); doc.write(frame.getAttribute('srcdoc')); doc.close();
    installLayout(doc.defaultView);
  }
  return dom;
}

// jsdom does not render. These deterministic geometry stubs test DOM contracts,
// not real screenshots/DPR/iframe layout. Browser smoke tests remain separate.
export function installLayout(w) {
  const nativeStyle = w.getComputedStyle.bind(w);
  w.getComputedStyle = el => {
    let style;
    try { style = nativeStyle(el); }
    catch (error) {
      if (el.namespaceURI !== 'http://www.w3.org/1998/Math/MathML') throw error;
      const substitute = w.document.createElement('span');
      for (const attribute of ['style', 'class']) if (el.hasAttribute(attribute)) substitute.setAttribute(attribute, el.getAttribute(attribute));
      style = nativeStyle(substitute);
    }
    return new Proxy(style, { get(t, key) { if (key === 'opacity') return t.opacity || '1'; return Reflect.get(t, key); } });
  };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  w.Element.prototype.getBoundingClientRect = function () {
    const width = Number(this.getAttribute('width')) || 600, height = Number(this.getAttribute('height')) || 40;
    return { x: 10, y: 20, left: 10, top: 20, right: 10 + width, bottom: 20 + height, width, height, toJSON() { return { x: 10, y: 20, width, height }; } };
  };
  for (const img of w.document.querySelectorAll('img')) {
    Object.defineProperties(img, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: Number(img.getAttribute('width')) || 160 }, naturalHeight: { configurable: true, value: Number(img.getAttribute('height')) || 60 } });
  }
  w.CSS ||= {};
  w.CSS.escape ||= value => String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch.codePointAt(0).toString(16)} `);
}

export function assetsFor(capture, question) {
  const ids = new Set(question.assetIds || []);
  for (const id of question.contextIds || []) {
    const context = capture.contexts.find(c => c.id === id);
    for (const aid of context?.assetIds || []) ids.add(aid);
  }
  return capture.assets.filter(a => ids.has(a.assetId));
}

export function tasksFor(capture, question, key = 'ocrQueue') {
  return capture[key].filter(t => t.questionKey === question.key || t.questionKeys?.includes(question.key));
}
