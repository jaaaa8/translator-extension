const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function fakePort() {
  const sent = []; let listener;
  return { name: "translation", sent, postMessage(message) { sent.push({ ...message }); }, onMessage: { addListener(fn) { listener = fn; } }, onDisconnect: { addListener() {} }, emit(message) { listener(message); } };
}

function createContentVm(port, href = "https://x/") {
  let nextId = 0, rect = { left: 0, top: 0, right: 500, bottom: 800, width: 500, height: 800 }, intersectionObservers = 0;
  const image = { src: "https://x/A.jpg", currentSrc: "", complete: true, naturalWidth: 1000, naturalHeight: 1600, isConnected: true, baseURI: "https://x/", parentElement: null, getAttribute: () => "", getBoundingClientRect: () => rect, getClientRects: () => [rect] };
  const rendered = [], runtimeMessages = [];
  const context = { Promise, Map, WeakMap, Set, URL, console, location: new URL(href), crypto: { randomUUID: () => "id-" + ++nextId }, queueMicrotask, performance, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, requestAnimationFrame: (callback) => (callback(), 1), document: { body: { appendChild: (element) => rendered.push(element) }, documentElement: {}, querySelectorAll: () => [image], createElement: () => ({ style: {}, children: [], removed: false, appendChild(child) { this.children.push(child); }, remove() { this.removed = true; } }) }, window: { addEventListener() {} }, MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { constructor() { intersectionObservers++; } observe() {} disconnect() {} }, chrome: { storage: { local: { get: async () => ({ srcLang: "ja", dstLang: "vi" }) }, onChanged: { addListener() {} } }, runtime: { connect: () => port, sendMessage: async (message) => (runtimeMessages.push(message), { ok: true }), onMessage: { addListener() {} } } } };
  vm.createContext(context); vm.runInContext(fs.readFileSync("extension/srcset.js", "utf8"), context); vm.runInContext(fs.readFileSync("extension/content.js", "utf8"), context);
  return { context, port, image, runtimeMessages, liveOverlays: () => rendered.filter((element) => !element.removed), liveBubbles: () => rendered.filter((element) => !element.removed).flatMap((element) => element.children), moveOffscreen: () => { rect = { left: 900, top: 0, right: 1400, bottom: 800, width: 500, height: 800 }; }, moveOnscreen: () => { rect = { left: 0, top: 0, right: 500, bottom: 800, width: 500, height: 800 }; }, intersectionObserverCount: () => intersectionObservers };
}

function event(start, text) { return { type: "translation", request_id: start.request_id, job_id: start.jobs[0].job_id, block_id: "b1", bbox: [1, 2, 30, 40], src_text: "hola", trans_text: text, image_w: 1000, image_h: 1600 }; }
function start(app) { app.context.translatePage("visible"); return app.port.sent.findLast((message) => message.type === "start_scope"); }
function done(app, request) { app.port.emit({ type: "scope_done", request_id: request.request_id, images: 1, translated: 1, failed: 0 }); }

(async () => {
  const fixture = createContentVm(fakePort(), "http://127.0.0.1:8910/?acceptance=loaded");
  await fixture.context.prewarmPage("ja");
  assert.strictEqual(fixture.runtimeMessages.length, 0);

  const localhostFixture = createContentVm(fakePort(), "http://localhost:8910/?acceptance=loaded");
  await localhostFixture.context.prewarmPage("ja");
  assert.strictEqual(localhostFixture.runtimeMessages.length, 0);

  const other127Port = createContentVm(fakePort(), "http://127.0.0.1:8911/?acceptance=loaded");
  await other127Port.context.prewarmPage("ja");
  assert.strictEqual(other127Port.runtimeMessages.length, 1);

  const otherLocalhostPort = createContentVm(fakePort(), "http://localhost:8911/?acceptance=loaded");
  await otherLocalhostPort.context.prewarmPage("ja");
  assert.strictEqual(otherLocalhostPort.runtimeMessages.length, 1);

  const missingAcceptance = createContentVm(fakePort(), "http://127.0.0.1:8910/");
  await missingAcceptance.context.prewarmPage("ja");
  assert.strictEqual(missingAcceptance.runtimeMessages.length, 1);

  const normal = createContentVm(fakePort(), "https://example.test/?acceptance=loaded");
  await normal.context.prewarmPage("ja");
  assert.strictEqual(normal.runtimeMessages.filter((message) => message.type === "prewarmJob").length, 1);

  const app = createContentVm(fakePort());
  const first = start(app);
  app.port.emit(event(first, "first"));
  const container = app.liveOverlays()[0], bubble = app.liveBubbles()[0];
  assert.strictEqual(bubble.style.left, "0.5px");
  app.port.emit({ ...event(first, "resized"), image_w: 500, image_h: 800 });
  assert.strictEqual(bubble.style.left, "1px");
  done(app, first);

  const replay = start(app);
  app.port.emit(event(replay, "replayed"));
  assert.strictEqual(app.liveOverlays().length, 1);
  assert.strictEqual(app.liveBubbles().length, 1);
  assert.strictEqual(app.liveOverlays()[0], container);
  assert.strictEqual(app.liveBubbles()[0], bubble);
  assert.strictEqual(bubble.textContent, "replayed");
  done(app, replay);

  app.moveOffscreen(); app.context.repositionOverlays();
  assert.strictEqual(app.liveOverlays().length, 1);
  assert.strictEqual(app.intersectionObserverCount(), 0);
  app.moveOnscreen(); app.image.src = "https://x/B.jpg"; app.context.pruneOverlays();
  assert.strictEqual(app.liveOverlays().length, 0);

  const disconnected = start(app);
  app.port.emit(event(disconnected, "fresh"));
  assert.strictEqual(app.liveOverlays().length, 1);
  app.image.isConnected = false; app.context.pruneOverlays();
  assert.strictEqual(app.liveOverlays().length, 0);
  console.log("content-progressive.test.js OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
