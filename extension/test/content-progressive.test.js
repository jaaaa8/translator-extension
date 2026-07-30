const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function fakePort() {
  const sent = []; let listener; let last;
  return { name: "translation", sent, postMessage(message) { sent.push({ ...message }); }, onMessage: { addListener(fn) { listener = fn; } }, onDisconnect: { addListener() {} }, emit(message) { last = message; listener(message); }, lastEmitted() { return last; } };
}

function createContentVm(port) {
  let nextId = 0;
  let rect = { left: 0, top: 0, right: 500, bottom: 800, width: 500, height: 800 };
  const image = { src: "https://x/A.jpg", currentSrc: "", complete: true, naturalWidth: 1000, naturalHeight: 1600, isConnected: true, baseURI: "https://x/", parentElement: null, getAttribute: () => "", getBoundingClientRect: () => rect, getClientRects: () => [rect] };
  const rendered = []; let intersectionObservers = 0;
  const context = { Promise, Map, WeakMap, Set, URL, console, crypto: { randomUUID: () => "id-" + ++nextId }, queueMicrotask, performance, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, requestAnimationFrame: (callback) => (callback(), 1), document: { body: { appendChild: (element) => rendered.push(element) }, documentElement: {}, querySelectorAll: () => [image], createElement: () => ({ style: {}, children: [], removed: false, appendChild(child) { this.children.push(child); }, remove() { this.removed = true; } }) }, window: { addEventListener() {} }, MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { constructor() { intersectionObservers++; } observe() {} disconnect() {} }, chrome: { storage: { local: { get: async () => ({ srcLang: "ja", dstLang: "vi" }) }, onChanged: { addListener() {} } }, runtime: { connect: () => port, sendMessage: async () => ({ ok: true }), onMessage: { addListener() {} } } } };
  vm.createContext(context); vm.runInContext(fs.readFileSync("extension/srcset.js", "utf8"), context); vm.runInContext(fs.readFileSync("extension/content.js", "utf8"), context);
  return { context, port, image, lastTranslation: () => port.lastEmitted(), liveOverlays: () => rendered.filter((e) => !e.removed), liveBubbles: () => rendered.filter((e) => !e.removed).flatMap((e) => e.children), moveOffscreen: () => { rect = { left: 900, top: 0, right: 1400, bottom: 800, width: 500, height: 800 }; }, moveOnscreen: () => { rect = { left: 0, top: 0, right: 500, bottom: 800, width: 500, height: 800 }; }, swapSource: (source) => { image.src = source; }, intersectionObserverCount: () => intersectionObservers };
}

(async () => {
  const app = createContentVm(fakePort());
  const pending = app.context.translatePage("visible");
  const start = app.port.sent.find((message) => message.type === "start_scope");
  const job = start.jobs[0];
  app.port.emit({ type: "translation", request_id: start.request_id, job_id: job.job_id, block_id: "b1", bbox: [1, 2, 30, 40], src_text: "hola", trans_text: "xin chao", image_w: 1000, image_h: 1600 });
  app.port.emit({ ...app.lastTranslation(), trans_text: "xin chao moi" });
  assert.strictEqual(app.liveBubbles().length, 1);
  assert.strictEqual(app.liveBubbles()[0].textContent, "xin chao moi");
  assert.strictEqual(app.liveBubbles()[0].style.left, "0.5px");
  app.port.emit({ ...app.lastTranslation(), image_w: 500, image_h: 800 });
  assert.strictEqual(app.liveBubbles()[0].style.left, "1px");
  app.moveOffscreen(); app.context.repositionOverlays();
  assert.strictEqual(app.liveOverlays().length, 1);
  assert.strictEqual(app.intersectionObserverCount(), 0);
  app.swapSource("https://x/B.jpg"); app.context.pruneOverlays();
  assert.strictEqual(app.liveOverlays().length, 0);
  app.port.emit({ type: "scope_done", request_id: start.request_id, images: 1, translated: 1, failed: 0 });
  assert.strictEqual((await pending).blocks, 1);
  app.swapSource("https://x/A.jpg");
  app.moveOnscreen();
  const replay = app.context.translatePage("visible");
  const replayStart = app.port.sent.at(-1);
  app.port.emit({ type: "translation", request_id: replayStart.request_id, job_id: replayStart.jobs[0].job_id, block_id: "b1", bbox: [1, 2, 30, 40], trans_text: "replayed", image_w: 1000, image_h: 1600 });
  assert.strictEqual(app.liveOverlays().length, 1);
  assert.strictEqual(app.liveBubbles().length, 1);
  assert.strictEqual(app.liveBubbles()[0].textContent, "replayed");
  app.port.emit({ type: "scope_done", request_id: replayStart.request_id, images: 1, translated: 1, failed: 0 });
  await replay;
  console.log("content-progressive.test.js OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
