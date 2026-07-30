const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function createApp() {
  let nextId = 0, messages = [], disconnect;
  const image = { src: "https://x/a.jpg", currentSrc: "", complete: true, naturalWidth: 1000, naturalHeight: 1600, isConnected: true, baseURI: "https://x/", parentElement: null, getAttribute: () => "", getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 500, width: 600, height: 500 }), getClientRects: () => [{}] };
  const makePort = () => { let listener; const p = { sent: [], postMessage(m) { this.sent.push(m); messages.push(m); }, onMessage: { addListener(fn) { listener = fn; } }, onDisconnect: { addListener(fn) { disconnect = fn; } }, emit(m) { listener(m); } }; return p; };
  let ports = [];
  const context = { Promise, Map, WeakMap, Set, URL, performance, queueMicrotask, crypto: { randomUUID: () => `id-${++nextId}` }, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, requestAnimationFrame: (fn) => (fn(), 1), console, document: { body: { appendChild() {} }, documentElement: {}, querySelectorAll: () => [image], createElement: () => ({ style: {}, children: [], appendChild(c) { this.children.push(c); }, remove() {} }) }, window: { addEventListener() {} }, MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} disconnect() {} }, chrome: { storage: { local: { get: async () => ({ srcLang: "ja", dstLang: "vi" }) }, onChanged: { addListener() {} } }, runtime: { connect: () => { const p = makePort(); ports.push(p); return p; }, sendMessage: async (m) => { messages.push(m); return { ok: true }; }, onMessage: { addListener() {} } } } };
  vm.createContext(context); vm.runInContext(fs.readFileSync("extension/srcset.js", "utf8"), context); vm.runInContext(fs.readFileSync("extension/content.js", "utf8"), context);
  return { context, image, ports: () => ports, messages, disconnect: () => disconnect() };
}

(async () => {
  const a = createApp();
  const old = a.context.translatePage("visible");
  const oldStart = a.ports()[0].sent[0];
  const newest = a.context.translatePage("loaded");
  const newStart = a.ports()[0].sent[1];
  assert.strictEqual((await Promise.race([old, Promise.resolve({ ok: false, error: "pending" })])).error, "superseded");
  assert.strictEqual(newStart.replaces_request_id, oldStart.request_id);
  a.ports()[0].emit({ type: "scope_done", request_id: oldStart.request_id, images: 1, translated: 1, failed: 0 });
  a.ports()[0].emit({ type: "scope_done", request_id: newStart.request_id, images: 1, translated: 0, failed: 0 });
  assert.strictEqual((await newest).ok, true);

  const zero = createApp();
  const oldPage = zero.context.translatePage("loaded");
  const oldPageStart = zero.ports()[0].sent[0];
  zero.image.complete = false;
  const emptyPage = zero.context.translatePage("loaded");
  const emptyStart = zero.ports()[0].sent[1];
  assert.strictEqual(emptyStart.jobs.length, 0);
  assert.strictEqual(emptyStart.replaces_request_id, oldPageStart.request_id);
  assert.strictEqual((await Promise.race([oldPage, Promise.resolve({ error: "pending" })])).error, "superseded");
  zero.ports()[0].emit({ type: "translation", request_id: oldPageStart.request_id, job_id: oldPageStart.jobs[0].job_id, block_id: "old", bbox: [0, 0, 1, 1], trans_text: "old", image_w: 1, image_h: 1 });
  zero.ports()[0].emit({ type: "scope_done", request_id: emptyStart.request_id, images: 0, translated: 0, failed: 0 });
  assert.strictEqual((await emptyPage).ok, true);

  const b = createApp();
  const pending = b.context.translatePage("loaded");
  const active = b.ports()[0].sent[0];
  b.disconnect();
  const successor = b.context.translatePage("visible");
  await Promise.resolve();
  assert.strictEqual(b.ports().length, 2);
  assert.strictEqual(b.ports()[1].sent.length, 1);
  assert.strictEqual(b.ports()[1].sent[0].request_id, b.messages.at(-1).request_id);
  assert.strictEqual((await Promise.race([pending, Promise.resolve({ ok: false, error: "pending" })])).error, "superseded");
  b.ports()[1].emit({ type: "scope_error", request_id: b.ports()[1].sent[0].request_id, code: "broken" });
  assert.strictEqual((await successor).error, "broken");

  const c = createApp();
  await c.context.prewarmPage("es");
  const prewarm = c.messages.find((m) => m.type === "prewarmJob");
  assert.strictEqual(prewarm.src_lang, "es");
  assert.strictEqual(c.messages.some((m) => m.type === "ocrImage" || m.type === "translateTexts"), false);
  console.log("content.test.js OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
