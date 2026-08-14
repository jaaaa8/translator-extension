const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function image(rect = { left: 0, top: 0, right: 600, bottom: 500, width: 600, height: 500 }, style = { objectFit: "fill", objectPosition: "50% 50%" }) {
  const attrs = {};
  return { src: "https://x/a.jpg", currentSrc: "", complete: true, naturalWidth: 1000, naturalHeight: 1600, isConnected: true, baseURI: "https://x/", parentElement: null, style, getAttribute(name) { return attrs[name] || ""; }, setAttribute(name, value) { attrs[name] = value; }, getBoundingClientRect: () => rect, getClientRects: () => [rect] };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function settle() { return new Promise((resolve) => setImmediate(resolve)); }

function createApp(images = [image()], { decode = async () => {}, measureText = (element) => ({ width: element.clientWidth, height: element.clientHeight }), logger = console } = {}) {
  let nextId = 0, disconnect, storageChanged;
  const messages = [], operations = [], rendered = [], ports = [];
  const makePort = () => { let listener; const p = { sent: [], postMessage(m) { this.sent.push({ ...m }); messages.push({ ...m }); operations.push({ type: "message", message: { ...m } }); }, onMessage: { addListener(fn) { listener = fn; } }, onDisconnect: { addListener(fn) { disconnect = fn; } }, emit(m) { listener(m); } }; ports.push(p); return p; };
  const createElement = (tagName) => {
    const element = {
      tagName: String(tagName).toUpperCase(), className: "", textContent: "", style: {}, children: [], appendCalls: [], appendSnapshots: [], removed: false, parentElement: null,
      appendChild(child) {
        if (child.parentElement?.children) child.parentElement.children = child.parentElement.children.filter((item) => item !== child);
        child.parentElement = this;
        this.children.push(child);
        this.appendCalls.push(child);
        this.appendSnapshots.push({ className: child.className, style: { ...child.style }, childClasses: child.children.map((item) => item.className), childStyles: child.children.map((item) => ({ ...item.style })) });
        if (this.className === "mt-overlay") operations.push({ type: "visible_append", child });
        return child;
      },
      remove() {
        this.removed = true;
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
        this.parentElement = null;
        this.children.forEach((child) => child.remove());
      },
    };
    Object.defineProperties(element, {
      isConnected: { get() { return this.parentElement?.isConnected === true; } },
      clientWidth: { get() { return this.isConnected ? Number.parseFloat(this.style.width) || 0 : 0; } },
      clientHeight: { get() { return this.isConnected ? Number.parseFloat(this.style.height) || 0 : 0; } },
      scrollWidth: { get() { return !this.isConnected ? 0 : this.className === "mt-translated-text" ? measureText(this).width : this.clientWidth; } },
      scrollHeight: { get() { return !this.isConnected ? 0 : this.className === "mt-translated-text" ? measureText(this).height : this.clientHeight; } },
    });
    if (element.tagName === "IMG") element.decode = () => decode(element);
    return element;
  };
  const body = { isConnected: true, children: [], appendChild(element) { element.parentElement = this; this.children.push(element); rendered.push(element); } };
  const context = { Promise, Map, WeakMap, Set, URL, performance, queueMicrotask, crypto: { randomUUID: () => `id-${++nextId}` }, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, getComputedStyle: (element) => element.style, requestAnimationFrame: (fn) => (fn(), 1), console: logger, document: { body, documentElement: {}, querySelectorAll: () => images, createElement }, window: { addEventListener() {} }, MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} disconnect() {} }, chrome: { storage: { local: { get: async () => ({ srcLang: "ja", dstLang: "vi" }) }, onChanged: { addListener(fn) { storageChanged = fn; } } }, runtime: { connect: makePort, sendMessage: async (m) => { messages.push({ ...m }); return { ok: true }; }, onMessage: { addListener() {} } } } };
  vm.createContext(context); vm.runInContext(fs.readFileSync("extension/srcset.js", "utf8"), context); vm.runInContext(fs.readFileSync("extension/content.js", "utf8"), context);
  return { context, images, messages, operations, rendered, ports: () => ports, disconnect: () => disconnect(), storageChanged: (changes) => storageChanged(changes), live: () => rendered.filter((element) => !element.removed), blocks: () => rendered.filter((element) => !element.removed).flatMap((element) => element.children), texts: () => rendered.filter((element) => !element.removed).flatMap((element) => element.children).flatMap((element) => element.children).filter((element) => element.className === "mt-translated-text") };
}

function translation(start, text = "live") { return { type: "translation", request_id: start.request_id, job_id: start.jobs[0].job_id, page_artifact_key: "page-1", render_artifact_key: "render-1", block_id: "b1", bbox: [1, 2, 30, 40], src_text: "hola", trans_text: text, image_w: 1000, image_h: 1600, patch_id: "patch-b1", patch_rgba: "AAAA", patch_mime: "image/png", patch_bbox: [1, 2, 30, 40], fit_bbox: [2, 4, 26, 32], vertical: false, layout_fit_version: "dom-fit-10px-v1", layout_hint: null }; }

async function seeded() {
  const app = createApp();
  const pending = app.context.translatePage("visible");
  const start = app.ports()[0].sent[0];
  app.ports()[0].emit(translation(start));
  await settle();
  return { app, pending, start, event: translation(start, "stale") };
}

async function unchanged(app, event) {
  const containers = app.live().slice(), blocks = app.blocks().slice(), text = app.texts().map((element) => element.textContent);
  app.ports()[0].emit(event);
  await settle();
  assert.deepStrictEqual(app.live(), containers);
  assert.deepStrictEqual(app.blocks(), blocks);
  assert.deepStrictEqual(app.texts().map((element) => element.textContent), text);
}

(async () => {
  const overlayCss = fs.readFileSync("extension/overlay.css", "utf8");
  assert.match(overlayCss, /\.mt-translated-text\s*\{[^}]*color\s*:\s*#111\s*;/s);
  assert.match(overlayCss, /\.mt-translated-text\s*\{[^}]*font-family\s*:\s*"Segoe UI",\s*Arial,\s*sans-serif\s*;/s);

  const decodeGate = deferred();
  const atomic = createApp([image()], { decode: () => decodeGate.promise });
  atomic.context.translatePage("visible");
  const atomicStart = atomic.ports()[0].sent[0];
  atomic.ports()[0].emit({ ...translation(atomicStart, "atomic"), vertical: true });
  // Mutation caught: appending a visible block before patch decode resolves exposes text without its clean patch.
  assert.strictEqual(atomic.blocks().length, 0, "wrapper must stay detached until patch decode resolves");
  assert.strictEqual(atomic.messages.some((message) => message.type === "render_metric"), false);
  decodeGate.resolve();
  await settle();
  const atomicRoot = atomic.live()[0];
  const atomicBlock = atomicRoot.children[0];
  assert.strictEqual(atomicRoot.appendCalls.length, 1);
  assert.strictEqual(atomicBlock.className, "mt-render-block");
  assert.deepStrictEqual(atomicBlock.children.map((child) => child.className), ["mt-clean-patch", "mt-translated-text"]);
  assert.strictEqual(atomicBlock.children[0].src, "data:image/png;base64,AAAA");
  assert.strictEqual(atomicBlock.children[1].textContent, "atomic");
  assert.strictEqual(atomicBlock.children[1].style.writingMode, "vertical-rl");
  assert.deepStrictEqual(atomicRoot.appendSnapshots[0].childClasses, ["mt-clean-patch", "mt-translated-text"]);
  assert.deepStrictEqual(atomicRoot.appendSnapshots[0].style, { left: "0.6px", top: "0.625px", width: "18px", height: "12.5px" });
  assert.deepStrictEqual(atomicRoot.appendSnapshots[0].childStyles, [
    { left: "0px", top: "0px", width: "18px", height: "12.5px" },
    { left: "0.6px", top: "0.625px", width: "15.6px", height: "10px", writingMode: "vertical-rl", fontSize: "18px", lineHeight: "1.2" },
  ]);
  const atomicMetric = atomic.messages.find((message) => message.type === "render_metric");
  assert.deepStrictEqual(JSON.parse(JSON.stringify({ ...atomicMetric, first_overlay_ms: Number.isFinite(atomicMetric.first_overlay_ms) })), {
    type: "render_metric", request_id: atomicStart.request_id, job_id: atomicStart.jobs[0].job_id,
    page_artifact_key: "page-1", render_artifact_key: "render-1", layout_fit_version: "dom-fit-10px-v1",
    block_id: "b1", painted: true, reason: null, layout_profile: { font_px: 18, line_height: 1.2 }, first_overlay_ms: true,
  });
  assert.ok(atomic.operations.findIndex((operation) => operation.type === "visible_append") < atomic.operations.findIndex((operation) => operation.message?.type === "render_metric"));

  const slowDecode = deferred();
  const slow = createApp([image()], { decode: () => slowDecode.promise });
  const slowPending = slow.context.translatePage("visible");
  const slowStart = slow.ports()[0].sent[0];
  slow.ports()[0].emit(translation(slowStart, "slow but current"));
  slow.ports()[0].emit({ ...translation(slowStart, "second slow block"), render_artifact_key: "render-2", block_id: "b2", patch_id: "patch-b2" });
  slow.ports()[0].emit({ type: "scope_done", request_id: slowStart.request_id, images: 1, translated: 2, failed: 0 });
  await slowPending;
  slowDecode.resolve();
  await settle();
  // Mutation caught: treating terminal producer accounting as stale UI identity drops a valid late decode and its collector outcome.
  assert.strictEqual(slow.blocks().length, 2);
  assert.deepStrictEqual(slow.blocks()[0].children.map((child) => child.className), ["mt-clean-patch", "mt-translated-text"]);
  assert.strictEqual(slow.live()[0].appendCalls.length, 2);
  const slowMetrics = slow.messages.filter((message) => message.type === "render_metric");
  assert.strictEqual(slowMetrics.filter((message) => Number.isFinite(message.first_overlay_ms)).length, 1, "late render must retain exactly one first-overlay sample per job");
  assert.deepStrictEqual(JSON.parse(JSON.stringify({ ...slowMetrics.find((message) => message.block_id === "b1"), first_overlay_ms: Number.isFinite(slowMetrics.find((message) => message.block_id === "b1").first_overlay_ms) })), {
    type: "render_metric", request_id: slowStart.request_id, job_id: slowStart.jobs[0].job_id,
    page_artifact_key: "page-1", render_artifact_key: "render-1", layout_fit_version: "dom-fit-10px-v1",
    block_id: "b1", painted: true, reason: null, layout_profile: { font_px: 18, line_height: 1.2 }, first_overlay_ms: true,
  });
  assert.strictEqual(Object.hasOwn(slowMetrics.find((message) => message.block_id === "b2"), "first_overlay_ms"), false);

  const staleDecode = deferred();
  const staleAsync = createApp([image()], { decode: () => staleDecode.promise });
  const stalePending = staleAsync.context.translatePage("visible");
  const staleStart = staleAsync.ports()[0].sent[0];
  staleAsync.ports()[0].emit(translation(staleStart, "stale async"));
  staleAsync.ports()[0].emit({ type: "scope_done", request_id: staleStart.request_id, images: 1, translated: 1, failed: 0 });
  await stalePending;
  staleAsync.images[0].currentSrc = "https://x/rebound.jpg";
  staleDecode.resolve();
  await settle();
  // Mutation caught: omitting the final post-decode binding check mounts a block for an obsolete image source.
  assert.strictEqual(staleAsync.blocks().length, 0);
  assert.strictEqual(staleAsync.messages.some((message) => message.type === "render_metric"), false);

  const erroredDecode = deferred();
  const errored = createApp([image()], { decode: () => erroredDecode.promise });
  const erroredPending = errored.context.translatePage("visible");
  const erroredStart = errored.ports()[0].sent[0];
  errored.ports()[0].emit(translation(erroredStart, "terminal error"));
  errored.ports()[0].emit({ type: "scope_error", request_id: erroredStart.request_id, code: "server_error" });
  await erroredPending;
  erroredDecode.resolve();
  await settle();
  // Mutation caught: allowing captured bindings after scope_error revives output from a failed request.
  assert.strictEqual(errored.blocks().length, 0);
  assert.strictEqual(errored.messages.some((message) => message.type === "render_metric"), false);

  const renderErrors = [];
  const logger = { ...console, error(...args) { renderErrors.push(args); } };
  const decodeRejected = createApp([image()], { decode: async () => { throw new Error("bad patch"); }, logger });
  decodeRejected.context.translatePage("visible");
  const rejectedStart = decodeRejected.ports()[0].sent[0];
  decodeRejected.ports()[0].emit(translation(rejectedStart, "rejected"));
  await settle();
  // Mutation caught: coercing decode rejection into a permanent render outcome would complete Task 11's collector incorrectly.
  assert.strictEqual(decodeRejected.live().length, 0, "decode rejection must not leave an empty overlay root");
  assert.strictEqual(decodeRejected.blocks().length, 0);
  assert.strictEqual(decodeRejected.messages.some((message) => message.type === "render_metric"), false);
  assert.strictEqual(renderErrors.length, 0, "patch decode rejection must remain a silent transient outcome");

  const unexpected = createApp([image()], { logger });
  unexpected.context.translatePage("visible");
  const unexpectedStart = unexpected.ports()[0].sent[0];
  unexpected.ports()[0].emit({ ...translation(unexpectedStart, "invalid geometry"), patch_bbox: null });
  await settle();
  // Mutation caught: a blanket terminal catch silently hides unexpected post-decode renderer defects.
  assert.strictEqual(unexpected.blocks().length, 0);
  assert.strictEqual(unexpected.messages.some((message) => message.type === "render_metric"), false);
  assert.strictEqual(renderErrors.length, 1);
  const [label, errorContext, error] = renderErrors[0];
  assert.match(label, /render/i);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(errorContext)), {
    request_id: unexpectedStart.request_id, job_id: unexpectedStart.jobs[0].job_id, block_id: "b1",
  });
  assert.strictEqual(typeof error?.message, "string");

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
    // Mutation caught: weakening any request/job/source/language binding guard lets stale async output replace live UI.
    await unchanged(state.app, change(state));
  }

  const coordinates = await seeded();
  coordinates.app.ports()[0].emit({ ...translation(coordinates.start, "resized"), image_w: 500, image_h: 800 });
  await settle();
  // Mutation caught: scaling from stale page dimensions places the committed patch at the old coordinate.
  assert.strictEqual(coordinates.app.blocks()[0].style.left, "1.2px");

  const contained = image(
    { left: 100, top: 50, right: 1300, bottom: 650, width: 1200, height: 600 },
    { objectFit: "contain", objectPosition: "50% 50%" }
  );
  contained.naturalWidth = 800;
  contained.naturalHeight = 1200;
  const containedApp = createApp([contained]);
  const containedPending = containedApp.context.translatePage("loaded");
  const containedStart = containedApp.ports()[0].sent[0];
  containedApp.ports()[0].emit({ ...translation(containedStart), bbox: [200, 100, 100, 200], patch_bbox: [200, 100, 100, 200], fit_bbox: [210, 120, 80, 160], image_w: 800, image_h: 1200 });
  await settle();
  // Mutation caught: scaling patch and fit boxes independently loses their shared page-space origin under object-fit contain.
  assert.deepStrictEqual(containedApp.live()[0].style, { left: "500px", top: "50px", width: "400px", height: "600px" });
  assert.deepStrictEqual(containedApp.blocks()[0].style, { left: "100px", top: "50px", width: "50px", height: "100px" });
  assert.deepStrictEqual(containedApp.blocks()[0].children[0].style, { left: "0px", top: "0px", width: "50px", height: "100px" });
  assert.deepStrictEqual(containedApp.texts()[0].style, { left: "5px", top: "10px", width: "40px", height: "80px", writingMode: "horizontal-tb", fontSize: "18px", lineHeight: "1.2" });
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
