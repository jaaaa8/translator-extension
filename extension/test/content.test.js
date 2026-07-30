const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function image(rect = { left: 0, top: 0, right: 600, bottom: 500, width: 600, height: 500 }, style = { objectFit: "fill", objectPosition: "50% 50%" }) {
  const attrs = {};
  return { src: "https://x/a.jpg", currentSrc: "", complete: true, naturalWidth: 1000, naturalHeight: 1600, isConnected: true, baseURI: "https://x/", parentElement: null, style, getAttribute(name) { return attrs[name] || ""; }, setAttribute(name, value) { attrs[name] = value; }, getBoundingClientRect: () => rect, getClientRects: () => [rect] };
}

function createApp(images = [image()]) {
  let nextId = 0, disconnect, storageChanged;
  const messages = [], rendered = [], ports = [];
  const makePort = () => { let listener; const p = { sent: [], postMessage(m) { this.sent.push({ ...m }); messages.push({ ...m }); }, onMessage: { addListener(fn) { listener = fn; } }, onDisconnect: { addListener(fn) { disconnect = fn; } }, emit(m) { listener(m); } }; ports.push(p); return p; };
  const context = { Promise, Map, WeakMap, Set, URL, performance, queueMicrotask, crypto: { randomUUID: () => `id-${++nextId}` }, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, getComputedStyle: (element) => element.style, requestAnimationFrame: (fn) => (fn(), 1), console, document: { body: { appendChild(element) { rendered.push(element); } }, documentElement: {}, querySelectorAll: () => images, createElement: () => ({ style: {}, children: [], removed: false, appendChild(child) { this.children.push(child); }, remove() { this.removed = true; this.children.forEach((child) => child.remove()); } }) }, window: { addEventListener() {} }, MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} disconnect() {} }, chrome: { storage: { local: { get: async () => ({ srcLang: "ja", dstLang: "vi" }) }, onChanged: { addListener(fn) { storageChanged = fn; } } }, runtime: { connect: makePort, sendMessage: async (m) => { messages.push({ ...m }); return { ok: true }; }, onMessage: { addListener() {} } } } };
  vm.createContext(context); vm.runInContext(fs.readFileSync("extension/srcset.js", "utf8"), context); vm.runInContext(fs.readFileSync("extension/content.js", "utf8"), context);
  return { context, images, messages, rendered, ports: () => ports, disconnect: () => disconnect(), storageChanged: (changes) => storageChanged(changes), live: () => rendered.filter((element) => !element.removed), bubbles: () => rendered.filter((element) => !element.removed).flatMap((element) => element.children) };
}

function translation(start, text = "live") { return { type: "translation", request_id: start.request_id, job_id: start.jobs[0].job_id, block_id: "b1", bbox: [1, 2, 30, 40], src_text: "hola", trans_text: text, image_w: 1000, image_h: 1600 }; }

async function seeded() {
  const app = createApp();
  const pending = app.context.translatePage("visible");
  const start = app.ports()[0].sent[0];
  app.ports()[0].emit(translation(start));
  return { app, pending, start, event: translation(start, "stale") };
}

function unchanged(app, event) {
  const containers = app.live().slice(), bubbles = app.bubbles().slice(), text = bubbles.map((bubble) => bubble.textContent);
  app.ports()[0].emit(event);
  assert.deepStrictEqual(app.live(), containers);
  assert.deepStrictEqual(app.bubbles(), bubbles);
  assert.deepStrictEqual(app.bubbles().map((bubble) => bubble.textContent), text);
}

(async () => {
  for (const change of [
    ({ event }) => ({ ...event, request_id: "wrong-request" }),
    ({ event }) => ({ ...event, job_id: "wrong-job" }),
    ({ app, event }) => (app.context.snapshotJobs("visible", "other-request", "ja", "vi"), event),
    ({ app, event }) => (app.images[0].isConnected = false, event),
    ({ app, event }) => (app.images[0].currentSrc = "https://x/selected.jpg", event),
    ({ app, event }) => (app.images[0].setAttribute("srcset", "a.jpg 1x"), event),
    ({ app, event }) => (app.storageChanged({ srcLang: { newValue: "en" } }), event),
  ]) {
    const state = await seeded();
    unchanged(state.app, change(state));
  }

  const coordinates = await seeded();
  coordinates.app.ports()[0].emit({ ...translation(coordinates.start, "resized"), image_w: 500, image_h: 800 });
  assert.strictEqual(coordinates.app.bubbles()[0].style.left, "1.2px");

  const contained = image(
    { left: 100, top: 50, right: 1300, bottom: 650, width: 1200, height: 600 },
    { objectFit: "contain", objectPosition: "50% 50%" }
  );
  contained.naturalWidth = 800;
  contained.naturalHeight = 1200;
  const containedApp = createApp([contained]);
  const containedPending = containedApp.context.translatePage("loaded");
  const containedStart = containedApp.ports()[0].sent[0];
  containedApp.ports()[0].emit({ ...translation(containedStart), bbox: [200, 100, 100, 200], image_w: 800, image_h: 1200 });
  assert.deepStrictEqual(containedApp.live()[0].style, { left: "500px", top: "50px", width: "400px", height: "600px" });
  assert.deepStrictEqual(containedApp.bubbles()[0].style, { left: "100px", top: "50px", width: "50px", height: "100px", fontSize: "18px" });
  containedApp.ports()[0].emit({ type: "scope_done", request_id: containedStart.request_id, images: 1, translated: 1, failed: 0 });
  await containedPending;

  const zero = createApp();
  const old = zero.context.translatePage("loaded");
  const oldStart = zero.ports()[0].sent[0];
  zero.images[0].complete = false;
  const empty = zero.context.translatePage("loaded");
  const emptyStart = zero.ports()[0].sent[1];
  assert.strictEqual(emptyStart.jobs.length, 0);
  assert.strictEqual(emptyStart.replaces_request_id, oldStart.request_id);
  assert.strictEqual((await Promise.race([old, Promise.resolve({ error: "pending" })])).error, "superseded");
  zero.ports()[0].emit({ type: "scope_done", request_id: emptyStart.request_id, images: 0, translated: 0, failed: 0 });
  assert.strictEqual((await empty).ok, true);

  const reconnect = createApp();
  const reconnectPending = reconnect.context.translatePage("loaded");
  const reconnectStart = reconnect.ports()[0].sent[0];
  reconnect.disconnect();
  await Promise.resolve();
  assert.strictEqual(reconnect.ports().length, 2);
  assert.strictEqual(reconnect.ports()[1].sent.length, 1);
  assert.strictEqual(reconnect.ports()[1].sent[0].request_id, reconnectStart.request_id);
  assert.strictEqual(reconnect.ports()[1].sent[0].replaces_request_id, null);
  reconnect.ports()[1].emit({ type: "scope_done", request_id: reconnectStart.request_id, images: 1, translated: 1, failed: 0 });
  assert.strictEqual((await reconnectPending).ok, true);
  reconnect.disconnect();
  await Promise.resolve();
  assert.strictEqual(reconnect.ports().length, 2);

  const successor = createApp();
  const oldPending = successor.context.translatePage("loaded");
  const successorOldStart = successor.ports()[0].sent[0];
  successor.disconnect();
  const newPending = successor.context.translatePage("visible");
  const newStart = successor.ports()[1].sent[0];
  await Promise.resolve();
  assert.strictEqual(successor.ports().length, 2);
  assert.strictEqual(successor.ports()[1].sent.length, 1);
  assert.strictEqual(newStart.replaces_request_id, successorOldStart.request_id);
  assert.strictEqual((await Promise.race([oldPending, Promise.resolve({ error: "pending" })])).error, "superseded");
  successor.ports()[1].emit({ type: "scope_error", request_id: newStart.request_id, code: "broken" });
  assert.strictEqual((await newPending).error, "broken");
  successor.disconnect();
  await Promise.resolve();
  assert.strictEqual(successor.ports().length, 2);

  const small = image({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 });
  const large = image({ left: 0, top: 0, right: 700, bottom: 500, width: 700, height: 500 });
  large.src = "https://x/larger.jpg";
  const prewarm = createApp([small, large]);
  await prewarm.context.prewarmPage("es");
  const prewarmJobs = prewarm.messages.filter((message) => message.type === "prewarmJob");
  assert.strictEqual(prewarmJobs.length, 1);
  assert.strictEqual(prewarmJobs[0].source_url, large.src);
  assert.strictEqual(prewarm.ports().length, 0);
  assert.strictEqual(prewarm.messages.some((message) => message.type === "start_scope"), false);
  console.log("content.test.js OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
