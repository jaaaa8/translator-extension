const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const { webcrypto } = require("crypto");

const versions = {
  detector: "d1", dedupe: "dd1", prep: "p1",
  recognizers: { ja: "ja1", es: "es1" },
  translator_model: "g1", prompt: "p1", policy: "batch1", page_schema: "page-v1",
};

function eventTarget() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, emit(...values) { for (const fn of listeners) fn(...values); } };
}

function portPair() {
  const trace = [];
  let active = true;
  const pair = { toBackground: structuredClone, toContent: structuredClone };
  const disconnected = eventTarget();
  const leftMessages = eventTarget();
  const rightMessages = eventTarget();
  const left = { name: "translation", onMessage: leftMessages, onDisconnect: disconnected,
    postMessage(message) { if (!active) return; trace.push(["content", structuredClone(message)]); queueMicrotask(() => { if (active) rightMessages.emit(pair.toBackground(message)); }); } };
  const right = { name: "translation", onMessage: rightMessages, onDisconnect: disconnected,
    postMessage(message) { if (!active) return; trace.push(["background", structuredClone(message)]); queueMicrotask(() => { if (active) leftMessages.emit(pair.toContent(message)); }); } };
  return Object.assign(pair, {
    content: left, background: right, trace,
    disconnect: () => disconnected.emit(),
    kill() { active = false; disconnected.emit(); },
  });
}

function storageSession(seed = {}) {
  const rows = { ...seed };
  return {
    rows,
    async get(key) {
      if (key === null) return { ...rows };
      if (typeof key === "string") return key in rows ? { [key]: rows[key] } : {};
      return Object.fromEntries(key.filter((name) => name in rows).map((name) => [name, rows[name]]));
    },
    async set(values) { Object.assign(rows, structuredClone(values)); },
    async remove(keys) { for (const key of [].concat(keys)) delete rows[key]; },
    async getBytesInUse() { return new TextEncoder().encode(JSON.stringify(rows)).byteLength; },
  };
}

function ndjson(rows) {
  const bytes = new TextEncoder().encode(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { ok: true, status: 200, body: { async *[Symbol.asyncIterator]() { yield bytes; } } };
}

function createServer() {
  const calls = { source: 0, ocrStream: 0, translate: 0, activeSource: 0, peakSource: 0 };
  const held = new Map();
  const heldSource = new Map();
  const heldTranslation = new Map();
  const faults = { source: new Set(), ocr: new Set(), translation: new Set() };
  const server = {
    calls,
    clone: structuredClone,
    async fetch(url, options = {}) {
      if (url.endsWith("/health")) return { ok: true, json: async () => server.clone({ versions }) };
      if (url.endsWith("/ocr-stream")) {
        calls.ocrStream++;
        const source = options.body.get("image") ? await options.body.get("image").text() : "A.jpg";
        const name = /\/([A-D])\.jpg/.exec(source)?.[1] || "A";
        if (held.has(name)) await held.get(name).promise;
        if (faults.ocr.has(name)) return ndjson([
          { type: "analysis_ready", image_w: 1000, image_h: 1600, analysis_ms: 7 },
          { type: "ocr_block_error", block_id: `${name}-bad`, stage: "ocr", code: "injected_ocr" },
          { type: "image_done" },
        ]);
        return ndjson([
          { type: "analysis_ready", image_w: 1000, image_h: 1600, analysis_ms: 7 },
          { type: "ocr_block", block_id: `${name}-b1`, bbox: [10, 20, 100, 40], src_text: name },
          { type: "image_done" },
        ]);
      }
      if (url.endsWith("/translate-items")) {
        calls.translate++;
        const body = JSON.parse(options.body);
        const translationName = body.items[0]?.text;
        if (heldTranslation.has(translationName)) await heldTranslation.get(translationName).promise;
        if (body.items.some((item) => faults.translation.has(item.text))) {
          return { ok: false, status: 500, json: async () => server.clone({ error: "injected translation failure" }) };
        }
        return { ok: true, json: async () => server.clone({ items: body.items.map((item) => ({ id: item.id, translation: `${item.text} translated` })) }) };
      }
      if (url.endsWith("/ocr")) {
        return { ok: true, json: async () => server.clone({ image_w: 1000, image_h: 1600, blocks: [] }) };
      }
      calls.source++;
      calls.activeSource++;
      calls.peakSource = Math.max(calls.peakSource, calls.activeSource);
      const name = /\/([A-D])\.jpg/.exec(url)?.[1];
      if (heldSource.has(name)) await heldSource.get(name).promise;
      calls.activeSource--;
      if (faults.source.has(name)) return { ok: false, status: 500 };
      return { ok: true, blob: async () => new Blob([url]) };
    },
    hold(name) {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      held.set(name, { promise, resolve });
    },
    holdSource(name) {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      heldSource.set(name, { promise, resolve });
    },
    holdTranslation(name) {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      heldTranslation.set(name, { promise, resolve });
    },
    finishPage(name) { held.get(name)?.resolve(); held.delete(name); },
    finishSource(name) { heldSource.get(name)?.resolve(); heldSource.delete(name); },
    finishTranslation(name) { heldTranslation.get(name)?.resolve(); heldTranslation.delete(name); },
    fail(stage, name) { faults[stage].add(name); },
  };
  return server;
}

async function eventually(predicate, label) {
  for (let i = 0; i < 100; i++) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out: ${label}`);
}

function createIntegration({ server = createServer(), session = storageSession(), clock = performance, pages = [{ name: "A", rect: { left: 0, top: 0, right: 500, bottom: 600, width: 500, height: 600 } }] } = {}) {
  const pair = portPair();
  let workerAlive = true;
  const runtimeMessages = eventTarget();
  const connects = eventTarget();
  const background = {
    console, URL, Blob, FormData, TextEncoder, TextDecoder, AbortController, performance: clock,
    crypto: { subtle: { digest: (algorithm, bytes) => webcrypto.subtle.digest(algorithm, Buffer.from(bytes)) } },
    structuredClone, queueMicrotask,
    setTimeout, clearTimeout,
    fetch: async (...args) => {
      const response = await server.fetch(...args);
      if (!workerAlive) throw new Error("service worker terminated");
      return response;
    },
    chrome: {
      storage: { session: Object.fromEntries(["get", "set", "remove", "getBytesInUse"].map((method) => [
        method, (...args) => workerAlive ? session[method](...args) : Promise.resolve(method === "getBytesInUse" ? 0 : {}),
      ])) }, action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
      runtime: { onMessage: runtimeMessages, onConnect: connects },
    },
  };
  vm.createContext(background);
  background.__wire = {};
  pair.toBackground = (message) => {
    background.__wire.json = JSON.stringify(message);
    return vm.runInContext("JSON.parse(__wire.json)", background);
  };
  server.clone = pair.toBackground;
  vm.runInContext(fs.readFileSync("extension/page-cache.js", "utf8"), background);
  vm.runInContext(fs.readFileSync("extension/background.js", "utf8"), background);
  connects.emit(pair.background);

  let id = 0;
  const images = pages.map((page) => ({ src: `https://reader/${page.name}.jpg`, currentSrc: "", complete: true,
    naturalWidth: 1000, naturalHeight: 1600, isConnected: true, baseURI: "https://reader/", parentElement: null,
    rect: page.rect, getAttribute: () => "", getBoundingClientRect() { return this.rect; }, getClientRects() { return [this.rect]; } }));
  const rendered = [];
  const content = {
    console, URL, Promise, Map, WeakMap, Set, performance: clock, queueMicrotask,
    crypto: { randomUUID: () => `id-${++id}` }, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    requestAnimationFrame(fn) { fn(); return 1; },
    document: {
      body: { appendChild(node) { rendered.push(node); } }, documentElement: {}, querySelectorAll: () => images,
      createElement: () => ({ style: {}, children: [], appendChild(node) { this.children.push(node); }, remove() { this.removed = true; } }),
    },
    window: { addEventListener() {} }, MutationObserver: class { observe() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    chrome: {
      storage: { local: { get: async () => ({ srcLang: "ja", dstLang: "vi" }) }, onChanged: eventTarget() },
      runtime: { connect: () => pair.content, sendMessage: async () => ({}), onMessage: eventTarget() },
    },
  };
  vm.createContext(content);
  content.__wire = {};
  pair.toContent = (message) => {
    content.__wire.json = JSON.stringify(message);
    return vm.runInContext("JSON.parse(__wire.json)", content);
  };
  vm.runInContext(fs.readFileSync("extension/srcset.js", "utf8"), content);
  vm.runInContext(fs.readFileSync("extension/content.js", "utf8"), content);
  return {
    server,
    session,
    trace: pair.trace,
    disconnect: pair.disconnect,
    killWorker() { workerAlive = false; pair.kill(); },
    click: () => content.translatePage("visible", "ja", "vi"),
    clickLoaded: () => content.translatePage("loaded", "ja", "vi"),
    navigate(source, nextRect = images[0].rect) { images[0].src = `https://reader/${source}.jpg`; images[0].rect = nextRect; content.pruneOverlays(); },
    text: () => rendered.flatMap((node) => node.children).filter((node) => !node.removed).map((node) => node.textContent).join(" "),
    summary: () => new Promise((resolve) => runtimeMessages.emit({ type: "benchmarkSummary" }, {}, resolve)),
    pageStatus: () => new Promise((resolve) => runtimeMessages.emit({ type: "pageStatus" }, {}, resolve)),
    legacyOcr(name) { return new Promise((resolve) => runtimeMessages.emit({ type: "ocrImage", url: `https://reader/${name}.jpg`, srcLang: "ja" }, {}, resolve)); },
    sendRenderMetric(requestId, value) { pair.content.postMessage({ type: "render_metric", request_id: requestId, first_overlay_ms: value }); },
  };
}

(async () => {
  const app = createIntegration();
  const result = await app.click();
  const coldRequestId = app.trace.find(([side, event]) => side === "content" && event.type === "start_scope")[1].request_id;
  assert.strictEqual(app.text(), "A translated");
  assert.ok(Number.isFinite(result.first_overlay_ms));
  assert.strictEqual(result.firstOverlayMs, undefined);
  assert.deepStrictEqual(Object.keys(result.metrics).sort(), [
    "analysis_ms", "fetch_ms", "final_translation_ms", "first_ocr_ms", "first_translation_ms", "ocr_done_ms", "queue_wait_ms", "total_ms",
  ]);
  assert.ok(Object.values(result.metrics).every((value) => value === null || Number.isFinite(value)));

  const summary = await app.summary();
  assert.deepStrictEqual(Object.keys(summary).sort(), [
    "cancel_latency_ms", "counters", "first_overlay_ms", "first_translation_ms", "total_ms",
  ]);
  assert.ok(Number.isFinite(summary.first_overlay_ms.p50));
  assert.ok(summary.counters.translation_calls <= 100);
  assert.strictEqual(JSON.stringify(summary).includes("reader/A.jpg"), false);
  assert.strictEqual(JSON.stringify(summary).includes("A translated"), false);

  const beforeReplay = { ...app.server.calls };
  const replay = await app.click();
  assert.deepStrictEqual(app.server.calls, beforeReplay);
  assert.strictEqual(replay.cacheHit, true);
  assert.strictEqual(app.text(), "A translated");

  for (let index = 0; index < 100; index++) await app.click();
  const warmSummary = await app.summary();
  assert.strictEqual(warmSummary.counters.translation_calls, 0);
  assert.ok(Number.isFinite(warmSummary.first_overlay_ms.p50));
  assert.ok(Number.isFinite(warmSummary.first_overlay_ms.p95));
  app.sendRenderMetric(coldRequestId, 999999);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepStrictEqual(await app.summary(), warmSummary);

  app.navigate("A", { left: 0, top: -200, right: 500, bottom: 600, width: 500, height: 800 });
  await app.click();
  assert.ok(app.server.calls.ocrStream > beforeReplay.ocrStream);

  const delayedServer = createServer();
  delayedServer.hold("A");
  const stale = createIntegration({ server: delayedServer });
  const oldRequest = stale.click();
  await eventually(() => delayedServer.calls.ocrStream === 1, "held A OCR");
  stale.navigate("B");
  const newRequest = stale.click();
  delayedServer.finishPage("A");
  assert.strictEqual((await oldRequest).ok, false);
  await newRequest;
  assert.strictEqual(stale.text(), "B translated");

  const replacementServer = createServer();
  replacementServer.holdSource("A");
  replacementServer.hold("A");
  replacementServer.holdTranslation("A");
  const replacement = createIntegration({ server: replacementServer });
  const replaced = replacement.click();
  await eventually(() => replacementServer.calls.source === 1, "deferred source fetch");
  const latest = replacement.click();
  assert.strictEqual((await replaced).ok, false);
  const statusBefore = await replacement.pageStatus();
  const statusAfterReopen = await replacement.pageStatus();
  assert.ok(statusBefore.background >= 1);
  assert.deepStrictEqual(statusAfterReopen, statusBefore);
  replacementServer.finishSource("A");
  await eventually(() => replacementServer.calls.ocrStream === 1, "deferred OCR stream");
  replacementServer.finishPage("A");
  await eventually(() => replacementServer.calls.translate === 1, "deferred translation batch");
  assert.strictEqual(replacement.text(), "");
  replacementServer.finishTranslation("A");
  await latest;
  assert.strictEqual(replacement.text(), "A translated");
  const replacementSummary = await replacement.summary();
  assert.ok(Number.isFinite(replacementSummary.cancel_latency_ms.p50));

  const cancelledServer = createServer();
  cancelledServer.holdSource("A");
  const cancelled = createIntegration({ server: cancelledServer });
  const cancelledLoaded = cancelled.clickLoaded();
  await eventually(() => cancelledServer.calls.source === 1, "loaded source before cancellation");
  cancelled.navigate("B");
  const replacementVisible = cancelled.click();
  assert.strictEqual((await cancelledLoaded).ok, false);
  await replacementVisible;
  assert.ok((await cancelled.summary()).counters.stale_work >= 1);

  let tick = 0;
  const agedServer = createServer();
  agedServer.holdSource("A");
  const aged = createIntegration({ server: agedServer, clock: { now: () => tick } });
  const agedLoaded = aged.clickLoaded();
  await eventually(() => agedServer.calls.source === 1, "aged request source");
  tick = 5000;
  aged.navigate("B");
  const agedReplacement = aged.click();
  await agedLoaded;
  await agedReplacement;
  assert.strictEqual((await aged.summary()).cancel_latency_ms.p50, 0);

  const restartServer = createServer();
  restartServer.holdTranslation("A");
  const sharedSession = storageSession();
  const beforeRestart = createIntegration({ server: restartServer, session: sharedSession });
  void beforeRestart.click();
  await eventually(() => restartServer.calls.translate === 1, "translation before worker restart");
  beforeRestart.killWorker();
  const afterRestart = createIntegration({ server: restartServer, session: sharedSession });
  const resumed = afterRestart.click();
  await eventually(() => restartServer.calls.translate >= 2, "translation resumed by restarted worker");
  restartServer.finishTranslation("A");
  await resumed;
  assert.strictEqual(beforeRestart.text(), "");
  assert.strictEqual(afterRestart.text(), "A translated");
  assert.strictEqual(afterRestart.trace.filter(([side, event]) => side === "background" && event.type === "translation").length, 1);

  const orderedServer = createServer();
  orderedServer.hold("B");
  const loaded = createIntegration({ server: orderedServer, pages: [
    { name: "A", rect: { left: 0, top: 0, right: 500, bottom: 600, width: 500, height: 600 } },
    { name: "B", rect: { left: 0, top: 1200, right: 500, bottom: 1800, width: 500, height: 600 } },
  ] });
  const loadedRequest = loaded.clickLoaded();
  await eventually(() => loaded.text() === "A translated", "near loaded image first");
  assert.strictEqual(loaded.trace.filter(([side, event]) => side === "background" && event.type === "translation").length, 1);
  orderedServer.finishPage("B");
  const loadedResult = await loadedRequest;
  assert.deepStrictEqual({ images: loadedResult.images, blocks: loadedResult.blocks }, { images: 2, blocks: 2 });
  assert.strictEqual(loaded.text(), "A translated B translated");

  const faultServer = createServer();
  faultServer.fail("ocr", "B");
  faultServer.fail("source", "C");
  faultServer.fail("translation", "D");
  const sameRect = { left: 0, top: 0, right: 500, bottom: 600, width: 500, height: 600 };
  const faults = createIntegration({ server: faultServer, pages: ["A", "B", "C", "D"].map((name) => ({ name, rect: sameRect })) });
  const partial = await faults.click();
  assert.deepStrictEqual({ blocks: partial.blocks, failed: partial.failed }, { blocks: 1, failed: 3 });
  assert.strictEqual(faults.text(), "A translated");
  const validPageCalls = { ...faultServer.calls };
  await faults.click();
  assert.ok(faultServer.calls.ocrStream >= validPageCalls.ocrStream);
  assert.strictEqual(faults.text(), "A translated");

  const duplicateServer = createServer();
  const duplicate = createIntegration({ server: duplicateServer, pages: [
    { name: "A", rect: sameRect }, { name: "A", rect: sameRect },
  ] });
  const duplicateResult = await duplicate.clickLoaded();
  assert.deepStrictEqual({ images: duplicateResult.images, blocks: duplicateResult.blocks }, { images: 2, blocks: 2 });
  assert.strictEqual(duplicateServer.calls.translate, 1);
  assert.strictEqual((await duplicate.summary()).counters.translation_calls, 1);

  const mixedServer = createServer();
  for (const name of ["A", "B", "C", "D"]) mixedServer.holdSource(name);
  const mixed = createIntegration({ server: mixedServer, pages: [
    { name: "A", rect: sameRect }, { name: "B", rect: sameRect },
  ] });
  const progressiveMixed = mixed.clickLoaded();
  await eventually(() => mixedServer.calls.source === 2, "progressive slots occupied");
  const legacyMixed = [mixed.legacyOcr("C"), mixed.legacyOcr("D")];
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(mixedServer.calls.peakSource <= 2, `mixed OCR peak ${mixedServer.calls.peakSource}`);
  for (const name of ["A", "B"]) mixedServer.finishSource(name);
  await eventually(() => mixedServer.calls.source === 4, "legacy fetches after progressive slots");
  for (const name of ["C", "D"]) mixedServer.finishSource(name);
  assert.strictEqual((await progressiveMixed).blocks, 2);
  assert.ok((await Promise.all(legacyMixed)).every((row) => row.ok));
  console.log("progressive-integration.test.js OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
