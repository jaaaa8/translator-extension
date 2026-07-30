const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function port() { let listener; const sent = []; return { sent, postMessage: (m) => sent.push(m), onMessage: { addListener: (fn) => { listener = fn; } }, onDisconnect: { addListener() {} }, emit: (m) => listener(m) }; }
function app(images) {
  let id = 0; const p = port();
  const ctx = { Promise, Map, WeakMap, Set, URL, performance, queueMicrotask, crypto: { randomUUID: () => `r-${++id}` }, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, requestAnimationFrame: (f) => (f(), 1), console, document: { body: { appendChild() {} }, documentElement: {}, querySelectorAll: () => images, createElement: () => ({ style: {}, children: [], appendChild(c) { this.children.push(c); }, remove() {} }) }, window: { addEventListener() {} }, MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} disconnect() {} }, chrome: { storage: { local: { get: async () => ({ srcLang: "ja", dstLang: "vi" }) }, onChanged: { addListener() {} } }, runtime: { connect: () => p, sendMessage: async (m) => { p.prewarm = m; return { ok: true }; }, onMessage: { addListener() {} } } } };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync("extension/srcset.js", "utf8"), ctx); vm.runInContext(fs.readFileSync("extension/content.js", "utf8"), ctx); return { ctx, p };
}
const image = (src, rect) => ({ src, currentSrc: "", complete: true, naturalWidth: 1000, naturalHeight: 1600, isConnected: true, baseURI: "https://x/", parentElement: null, getAttribute: () => "", getBoundingClientRect: () => rect, getClientRects: () => [rect] });
(async () => {
  const first = image("https://x/first.jpg", { left: 0, top: 0, right: 400, bottom: 500, width: 400, height: 500 });
  const second = image("https://x/second.jpg", { left: 0, top: 0, right: 600, bottom: 500, width: 600, height: 500 });
  const a = app([]); const zero = a.ctx.translatePage("loaded");
  assert.strictEqual(a.p.sent.length, 1); assert.strictEqual(a.p.sent[0].jobs.length, 0);
  a.p.emit({ type: "scope_done", request_id: a.p.sent[0].request_id, images: 0, translated: 0, failed: 0 }); await zero;
  const b = app([first]); const old = b.ctx.translatePage("visible"), oldStart = b.p.sent.at(-1); const newest = b.ctx.translatePage("loaded"), newStart = b.p.sent.at(-1);
  b.p.emit({ type: "translation", request_id: oldStart.request_id, job_id: oldStart.jobs[0].job_id, block_id: "old", bbox: [0, 0, 1, 1], trans_text: "old", image_w: 1, image_h: 1 });
  b.p.emit({ type: "scope_done", request_id: newStart.request_id, images: 1, translated: 0, failed: 0 }); b.p.emit({ type: "scope_done", request_id: oldStart.request_id, images: 1, translated: 0, failed: 0 }); await Promise.all([old, newest]);
  const c = app([first, second]); await c.ctx.prewarmPage("es"); assert.strictEqual(c.p.prewarm.type, "prewarmJob"); assert.strictEqual(c.p.prewarm.source_url, second.src);
  console.log("content.test.js OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
