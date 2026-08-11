const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function fakePort() {
  const sent = []; let listener;
  return { name: "translation", sent, postMessage(message) { sent.push({ ...message }); }, onMessage: { addListener(fn) { listener = fn; } }, onDisconnect: { addListener() {} }, emit(message) { listener(message); } };
}

function settle() { return new Promise((resolve) => setImmediate(resolve)); }

function cssStyleDeclaration() {
  const values = {}, order = [];
  return new Proxy({}, {
    get(_target, property) {
      if (property === "length") return order.length;
      if (typeof property === "string" && /^\d+$/.test(property)) return order[Number(property)]?.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
      return values[property] ?? "";
    },
    set(_target, property, value) {
      if (typeof property === "string" && /^\d+$/.test(property)) return true;
      if (!Object.hasOwn(values, property)) order.push(property);
      values[property] = value;
      return true;
    },
    ownKeys() { return order.map((_, index) => String(index)); },
    getOwnPropertyDescriptor(_target, property) {
      return typeof property === "string" && /^\d+$/.test(property) && Number(property) < order.length
        ? { configurable: true, enumerable: true }
        : undefined;
    },
  });
}

function createContentVm(port, href = "https://x/", { clock = performance, imageCount = 1, decode = async () => {}, measureText = (element) => ({ width: element.clientWidth, height: element.clientHeight }), realStyle = false } = {}) {
  let nextId = 0, rect = { left: 0, top: 0, right: 500, bottom: 800, width: 500, height: 800 }, intersectionObservers = 0, runtimeListener, storageChanged;
  const images = Array.from({ length: imageCount }, (_, index) => ({ src: `https://x/${String.fromCharCode(65 + index)}.jpg`, currentSrc: "", complete: true, naturalWidth: 1000, naturalHeight: 1600, isConnected: true, baseURI: "https://x/", parentElement: null, getAttribute: () => "", getBoundingClientRect: () => rect, getClientRects: () => [rect] }));
  const image = images[0];
  const rendered = [], runtimeMessages = [];
  const createElement = (tagName) => {
    const element = {
      tagName: String(tagName).toUpperCase(), className: "", textContent: "", style: realStyle ? cssStyleDeclaration() : {}, children: [], appendCalls: [], removed: false, parentElement: null,
      appendChild(child) { if (child.parentElement?.children) child.parentElement.children = child.parentElement.children.filter((item) => item !== child); child.parentElement = this; this.children.push(child); this.appendCalls.push(child); return child; },
      remove() { this.removed = true; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; this.children.forEach((child) => child.remove()); },
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
  const context = { Promise, Map, WeakMap, Set, URL, console, location: new URL(href), crypto: { randomUUID: () => "id-" + ++nextId }, queueMicrotask, performance: clock, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, requestAnimationFrame: (callback) => (callback(), 1), document: { body, documentElement: {}, querySelectorAll: () => images, createElement }, window: { addEventListener() {} }, MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { constructor() { intersectionObservers++; } observe() {} disconnect() {} }, chrome: { storage: { local: { get: async () => ({ srcLang: "ja", dstLang: "vi" }) }, onChanged: { addListener(listener) { storageChanged = listener; } } }, runtime: { connect: () => port, sendMessage: async (message) => (runtimeMessages.push(message), { ok: true }), onMessage: { addListener(listener) { runtimeListener = listener; } } } } };
  vm.createContext(context); vm.runInContext(fs.readFileSync("extension/srcset.js", "utf8"), context); vm.runInContext(fs.readFileSync("extension/content.js", "utf8"), context);
  return { context, port, image, images, runtimeMessages, receive: (message) => runtimeListener(message, {}, () => {}), storageChanged: (changes) => storageChanged(changes), liveOverlays: () => rendered.filter((element) => !element.removed), liveBlocks: () => rendered.filter((element) => !element.removed).flatMap((element) => element.children), liveTexts: () => rendered.filter((element) => !element.removed).flatMap((element) => element.children).flatMap((element) => element.children.filter((child) => child.className === "mt-translated-text")), resize: (next) => { rect = next; }, moveOffscreen: () => { rect = { left: 900, top: 0, right: 1400, bottom: 800, width: 500, height: 800 }; }, moveOnscreen: () => { rect = { left: 0, top: 0, right: 500, bottom: 800, width: 500, height: 800 }; }, intersectionObserverCount: () => intersectionObservers };
}

function event(start, text) { return { type: "translation", request_id: start.request_id, job_id: start.jobs[0].job_id, page_artifact_key: "page-1", render_artifact_key: "render-1", block_id: "b1", bbox: [1, 2, 30, 40], src_text: "hola", trans_text: text, image_w: 1000, image_h: 1600, patch_id: "patch-b1", patch_rgba: "AAAA", patch_mime: "image/png", patch_bbox: [1, 2, 30, 40], fit_bbox: [1, 2, 30, 40], vertical: false, layout_fit_version: "dom-fit-10px-v1", layout_hint: null }; }
function start(app) { app.context.translatePage("visible"); return app.port.sent.findLast((message) => message.type === "start_scope"); }
function done(app, request) { app.port.emit({ type: "scope_done", request_id: request.request_id, images: 1, translated: 1, failed: 0 }); }

(async () => {
  const direction = createContentVm(fakePort());
  await Promise.resolve();
  const rtl = start(direction);
  assert.strictEqual(rtl.reading_direction, "rtl");
  direction.storageChanged({ readingDirection: { newValue: "ltr" } });
  const ltr = start(direction);
  assert.strictEqual(rtl.reading_direction, "rtl");
  assert.strictEqual(ltr.reading_direction, "ltr");
  done(direction, ltr);

  const explicitDirection = createContentVm(fakePort());
  await Promise.resolve();
  explicitDirection.receive({ type: "translatePage", scope: "visible", srcLang: "ja", dstLang: "vi", readingDirection: "ltr" });
  const explicitLtr = explicitDirection.port.sent.findLast((message) => message.type === "start_scope");
  assert.strictEqual(explicitLtr.reading_direction, "ltr");
  done(explicitDirection, explicitLtr);

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
  await settle();
  const container = app.liveOverlays()[0];
  // Mutation caught: replacing page-space scaling with source bbox pixels shifts the visible atomic wrapper.
  assert.strictEqual(app.liveBlocks()[0].style.left, "0.5px");
  app.port.emit({ ...event(first, "resized"), image_w: 500, image_h: 800 });
  await settle();
  assert.strictEqual(app.liveBlocks()[0].style.left, "1px");
  done(app, first);

  const replay = start(app);
  app.port.emit(event(replay, "replayed"));
  await settle();
  // Mutation caught: appending replay output without replacing the same block duplicates visible patch+text commits.
  assert.strictEqual(app.liveOverlays().length, 1);
  assert.strictEqual(app.liveBlocks().length, 1);
  assert.strictEqual(app.liveOverlays()[0], container);
  assert.strictEqual(app.liveTexts()[0].textContent, "replayed");
  done(app, replay);

  app.moveOffscreen(); app.context.repositionOverlays();
  assert.strictEqual(app.liveOverlays().length, 1);
  assert.strictEqual(app.intersectionObserverCount(), 0);
  app.moveOnscreen(); app.image.src = "https://x/B.jpg"; app.context.pruneOverlays();
  assert.strictEqual(app.liveOverlays().length, 0);

  const disconnected = start(app);
  app.port.emit(event(disconnected, "fresh"));
  await settle();
  assert.strictEqual(app.liveOverlays().length, 1);
  app.image.isConnected = false; app.context.pruneOverlays();
  assert.strictEqual(app.liveOverlays().length, 0);

  const widthFit = createContentVm(fakePort(), "https://x/", {
    realStyle: true,
    measureText: (element) => ({ width: element.clientWidth === 7.5 && Number.parseFloat(element.style.fontSize) <= 12 ? element.clientWidth : element.clientWidth + 1, height: element.clientHeight }),
  });
  const widthFitStart = start(widthFit);
  widthFit.resize({ left: 0, top: 0, right: 250, bottom: 400, width: 250, height: 400 });
  widthFit.port.emit({ ...event(widthFitStart, "width constrained"), layout_hint: { font_px: 18, line_height: 1.2 } });
  await settle();
  // Mutation caught: measuring disconnected text, copying CSSStyleDeclaration as a plain object, trusting cached 18px, or omitting scrollWidth revalidation paints overflow.
  assert.strictEqual(widthFit.liveTexts().length, 1, "a valid 12px fit must commit after connected measurement");
  assert.strictEqual(widthFit.liveTexts()[0].style.fontSize, "12px");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(widthFit.port.sent.find((message) => message.type === "render_metric").layout_profile)), { font_px: 12, line_height: 1.2 });

  const heightFit = createContentVm(fakePort(), "https://x/", {
    measureText: (element) => ({ width: element.clientWidth, height: Number.parseFloat(element.style.fontSize) <= 12 ? element.clientHeight : element.clientHeight + 1 }),
  });
  const heightFitStart = start(heightFit);
  heightFit.port.emit(event(heightFitStart, "height constrained"));
  await settle();
  // Mutation caught: omitting scrollHeight accepts a profile whose last line is clipped vertically.
  assert.strictEqual(heightFit.liveTexts()[0].style.fontSize, "12px");

  const fitFailed = createContentVm(fakePort(), "https://x/", {
    measureText: (element) => ({ width: element.clientWidth + 1, height: element.clientHeight + 1 }),
  });
  const fitFailedStart = start(fitFailed);
  fitFailed.port.emit(event(fitFailedStart, "never fits"));
  await settle();
  // Mutation caught: mounting at the 10px floor or posting a capability reason makes an unpainted block look ready.
  assert.strictEqual(fitFailed.liveBlocks().length, 0);
  assert.deepStrictEqual(fitFailed.port.sent.find((message) => message.type === "render_metric"), {
    type: "render_metric", request_id: fitFailedStart.request_id, job_id: fitFailedStart.jobs[0].job_id,
    page_artifact_key: "page-1", render_artifact_key: "render-1", layout_fit_version: "dom-fit-10px-v1",
    block_id: "b1", painted: false, reason: "fit_failed", layout_profile: null,
  });

  let resizedFits = true;
  const resizeFailure = createContentVm(fakePort(), "https://x/", {
    measureText: (element) => resizedFits ? { width: element.clientWidth, height: element.clientHeight } : { width: element.clientWidth + 1, height: element.clientHeight + 1 },
  });
  const resizeFailureStart = start(resizeFailure);
  resizeFailure.port.emit(event(resizeFailureStart, "fits before resize"));
  await settle();
  resizedFits = false;
  resizeFailure.context.repositionOverlays();
  // Mutation caught: ignoring a null re-fit leaves the already-mounted 10px text overflowing after viewport changes.
  assert.strictEqual(resizeFailure.liveBlocks().length, 0);
  assert.deepStrictEqual(resizeFailure.port.sent.filter((message) => message.type === "render_metric").at(-1), {
    type: "render_metric", request_id: resizeFailureStart.request_id, job_id: resizeFailureStart.jobs[0].job_id,
    page_artifact_key: "page-1", render_artifact_key: "render-1", layout_fit_version: "dom-fit-10px-v1",
    block_id: "b1", painted: false, reason: "fit_failed", layout_profile: null,
  });

  let tick = 0;
  const perJob = createContentVm(fakePort(), "https://x/", { clock: { now: () => tick }, imageCount: 2 });
  const result = perJob.context.translatePage("loaded");
  const request = perJob.port.sent.findLast((message) => message.type === "start_scope");
  perJob.port.emit({ ...event(request, "A first"), job_id: request.jobs[0].job_id });
  await settle();
  tick = 25; perJob.port.emit({ ...event(request, "B first"), job_id: request.jobs[1].job_id });
  await settle();
  tick = 30; perJob.port.emit({ ...event(request, "B second"), job_id: request.jobs[1].job_id, block_id: "b2", patch_id: "patch-b2" });
  await settle();
  const renderMetrics = perJob.port.sent.filter((message) => message.type === "render_metric");
  // Mutation caught: dropping per-block outcomes or measuring before append loses collector identity and per-job first-overlay timing.
  assert.deepEqual(renderMetrics.map((row) => [row.job_id, row.block_id, Number.isFinite(row.first_overlay_ms)]), [
    [request.jobs[0].job_id, "b1", true],
    [request.jobs[1].job_id, "b1", true],
    [request.jobs[1].job_id, "b2", false],
  ]);
  assert.ok(renderMetrics[0].first_overlay_ms < renderMetrics[1].first_overlay_ms);
  perJob.port.emit({ type: "scope_done", request_id: request.request_id, images: 2, translated: 2, failed: 0, metrics: { first_overlay_ms: 20 }, page_metrics: request.jobs.map((job) => ({ job_id: job.job_id, first_overlay_ms: null })) });
  const perJobResult = await result;
  assert.strictEqual(perJobResult.metrics.first_overlay_ms, 0);
  assert.deepEqual(perJobResult.page_metrics.map((row) => row.first_overlay_ms), [0, 25]);
  console.log("content-progressive.test.js OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
