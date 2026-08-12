const assert = require("assert");
const fs = require("fs");
const test = require("node:test");
const vm = require("vm");
const { createHash, webcrypto } = require("crypto");
const { TextEncoder, TextDecoder } = require("util");

function responseFrom(chunks) {
  return {
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield new TextEncoder().encode(chunk);
      },
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function sourceIdentityFor(source, bytes = Buffer.from(source)) {
  return {
    sourceContentHash: createHash("sha256").update(bytes).digest("hex"),
    blob: new Blob([bytes]),
  };
}

function translationKeyDigestBarrier() {
  const entered = deferred();
  const release = deferred();
  let held = false;
  return {
    entered: entered.promise,
    release: release.resolve,
    crypto: {
      subtle: {
        async digest(_algorithm, bytes) {
          if (!held && new TextDecoder().decode(bytes).includes('"reading_order"')) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          const value = createHash("sha256").update(Buffer.from(bytes)).digest();
          return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        },
      },
    },
  };
}

async function flush(turns = 4) {
  for (let index = 0; index < turns; index++) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitUntil(check, label) {
  for (let index = 0; index < 1000; index++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function fakeStorage(seed = {}) {
  const rows = { ...seed };
  return {
    rows,
    failWrites: false,
    async get(key) {
      let value;
      if (key === null) value = { ...rows };
      else if (typeof key === "string") value = key in rows ? { [key]: rows[key] } : {};
      else value = Object.fromEntries(key.filter((name) => name in rows).map((name) => [name, rows[name]]));
      if (this.afterGet) await this.afterGet(key, value);
      return this.cloneForRead ? this.cloneForRead(value) : value;
    },
    async set(values) {
      if (this.failWrites) throw new Error("quota");
      if (this.beforeSet) await this.beforeSet(values);
      Object.assign(rows, JSON.parse(JSON.stringify(values)));
    },
    async remove(keys) {
      if (this.beforeRemove) await this.beforeRemove(keys);
      for (const key of Array.isArray(keys) ? keys : [keys]) delete rows[key];
    },
    async getBytesInUse() {
      return Buffer.byteLength(JSON.stringify(rows));
    },
  };
}

function fakePort(name = "translation") {
  const sent = [];
  let onMessage;
  let onDisconnect;
  return {
    name,
    sent,
    postMessage(message) { sent.push(structuredClone(message)); },
    onMessage: { addListener(listener) { onMessage = listener; } },
    onDisconnect: { addListener(listener) { onDisconnect = listener; } },
    receive(message) { onMessage(message); },
    disconnect() { onDisconnect(); },
  };
}

function createFakeServer() {
  const versions = {
    detector: "d1", dedupe: "dd1", prep: "p1", region_resolver: "rr1",
    recognizers: { ja: "r-ja", es: "r-latin", pt: "r-latin" },
    translator_model: "g1", prompt: "pr1", policy: "po1", layout_order: "reading-order-v1", page_schema: "page-v2",
  };
  const patchVersions = { cleaner: "c1", render_encoding: "png-rgba-v1", render_schema: "render-v1" };
  const counts = { health: 0, source: 0, ocr: 0, coldOcr: 0, warmOcr: 0, render: 0, renderKey: 0, renderBlob: 0, translate: 0, aborted: 0 };
  const translationBatches = [];
  const translationRequests = [];
  const translationBodies = [];
  const ocrForms = [];
  const sourceGates = new Map();
  const failedSources = new Set();
  const ocrRows = new Map();
  const ocrAfterFirstGates = new Map();
  const analysisSources = new Map();
  const renderPages = new Map();
  const renderRows = new Map();
  const renderGates = new Map();
  const renderKeyMisses = new Set();
  const failedRenders = new Set();
  const renderForms = [];
  const translationGates = new Map();
  const translationResults = [];
  let beforeOcr = null;
  let online = true;
  let responseVersions = versions;
  let responsePatchVersions = patchVersions;

  async function waitForGate(gate, signal) {
    if (!gate) return;
    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("AbortError"));
      const abort = () => reject(new Error("AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      gate.promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
    });
  }

  async function fetch(url, options = {}) {
    if (url.endsWith("/health")) {
      counts.health++;
      if (!online) throw new Error("offline");
      return { ok: true, json: async () => ({ versions: responseVersions, patch_versions: responsePatchVersions }) };
    }
    if (!url.startsWith("http://127.0.0.1:8910/")) {
      counts.source++;
      const pageName = new URL(url).pathname.split("/").pop().replace(/\.[^.]+$/, "");
      try {
        await waitForGate(sourceGates.get(pageName), options.signal);
      } catch (error) {
        counts.aborted++;
        throw error;
      }
      if (failedSources.has(pageName)) return { ok: false, status: 404 };
      return { ok: true, blob: async () => new Blob([url]) };
    }
    if (url.endsWith("/ocr-stream")) {
      counts.ocr++;
      const form = options.body;
      ocrForms.push(form);
      const before = beforeOcr;
      beforeOcr = null;
      await before?.(form);
      const analysisKey = form.get("analysis_key");
      const image = form.get("image");
      if (!image && !analysisSources.has(analysisKey)) return { ok: false, status: 409, json: async () => ({ error: "analysis_missing" }) };
      if (image) {
        counts.coldOcr++;
        analysisSources.set(analysisKey, await image.text());
      } else {
        counts.warmOcr++;
      }
      const sourceUrl = analysisSources.get(analysisKey);
      const pageName = sourceUrl
        ? new URL(sourceUrl).pathname.split("/").pop().replace(/\.[^.]+$/, "")
        : null;
      if (pageName) renderPages.set(form.get("render_artifact_key"), pageName);
      const srcText = form.get("src_lang") === "es" ? "hola" : "こんにちは";
      const rows = ocrRows.get(pageName) || [
        { type: "analysis_ready", image_w: 100, image_h: 200 },
        { type: "ocr_block", block_id: "b1", bbox: [1, 2, 3, 4], src_text: srcText },
        { type: "image_done", recognized: 1, failed: 0 },
      ];
      const gate = ocrAfterFirstGates.get(pageName);
      if (!gate) return {
        ok: true,
        status: 200,
        ...responseFrom([rows.map((row) => JSON.stringify(row)).join("\n") + "\n"]),
      };
      const firstBlock = rows.findIndex((row) => row.type === "ocr_block");
      return {
        ok: true,
        status: 200,
        body: {
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode(rows.slice(0, firstBlock + 1).map((row) => JSON.stringify(row)).join("\n") + "\n");
            await waitForGate(gate, options.signal);
            yield new TextEncoder().encode(rows.slice(firstBlock + 1).map((row) => JSON.stringify(row)).join("\n") + "\n");
          },
        },
      };
    }
    if (url.endsWith("/render-artifact")) {
      counts.render++;
      const form = options.body;
      const renderKey = form.get("render_artifact_key");
      const image = form.get("image");
      if (image) counts.renderBlob++;
      else counts.renderKey++;
      let pageName = renderPages.get(renderKey);
      if (image) {
        const sourceUrl = await image.text();
        pageName = new URL(sourceUrl).pathname.split("/").pop().replace(/\.[^.]+$/, "");
        renderPages.set(renderKey, pageName);
      }
      renderForms.push(form);
      if (!image && (!pageName || renderKeyMisses.delete(pageName))) {
        return { ok: false, status: 409, json: async () => ({ error: "artifact_missing" }) };
      }
      await waitForGate(renderGates.get(pageName), options.signal);
      if (failedRenders.has(pageName)) {
        return { ok: false, status: 500, json: async () => ({ error: "clean_failed" }) };
      }
      const rows = ocrRows.get(pageName) || [
        { type: "analysis_ready", image_w: 100, image_h: 200 },
        { type: "ocr_block", block_id: "b1", bbox: [1, 2, 3, 4], src_text: "source" },
        { type: "image_done", recognized: 1, failed: 0 },
      ];
      const dimensions = rows.find((row) => row.type === "analysis_ready") || {};
      const blocks = renderRows.get(pageName) || rows.filter((row) => row.type === "ocr_block").map((row) => ({
        block_id: row.block_id,
        patch_id: `patch-${row.block_id}`,
        patch_bbox: row.bbox,
        clean_region: row.bbox,
        fit_bbox: row.bbox,
        patch_mime: "image/png",
        patch_rgba: Buffer.from(`patch:${row.block_id}`).toString("base64"),
        reason: null,
      }));
      return { ok: true, status: 200, json: async () => ({
        schema_version: "render-v1",
        render_artifact_key: renderKey,
        analysis_key: form.get("analysis_key"),
        image_w: dimensions.image_w,
        image_h: dimensions.image_h,
        blocks,
      }) };
    }
    if (url.endsWith("/translate-items")) {
      counts.translate++;
      const body = JSON.parse(options.body);
      translationBatches.push(body.items.map((item) => item.id));
      translationRequests.push({ dst_lang: body.dst_lang, ids: body.items.map((item) => item.id) });
      translationBodies.push(body);
      await waitForGate(translationGates.get(body.dst_lang), options.signal);
      if (translationResults.length) {
        const result = translationResults.shift();
        if (result instanceof Error) throw result;
        if (result.response) return result.response;
        return { ok: true, json: async () => result };
      }
      return { ok: true, json: async () => ({ items: body.items.map((item) => ({ id: item.id, kind: "text", translation: `${body.dst_lang}:${item.text}` })) }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }

  return {
    versions,
    patchVersions,
    counts,
    translationBatches,
    translationRequests,
    translationBodies,
    ocrForms,
    renderForms,
    fetch,
    setResponseVersions(value) { responseVersions = value; },
    setResponsePatchVersions(value) { responsePatchVersions = value; },
    setOnline(value) { online = value; },
    holdSource(pageName) { const gate = deferred(); sourceGates.set(pageName, gate); return gate; },
    releaseSource(pageName) { sourceGates.get(pageName)?.resolve(); sourceGates.delete(pageName); },
    failSource(pageName) { failedSources.add(pageName); },
    allowSource(pageName) { failedSources.delete(pageName); },
    setOcrRows(pageName, rows) { ocrRows.set(pageName, rows); },
    primeAnalysis(analysisKey, sourceUrl) { analysisSources.set(analysisKey, sourceUrl); },
    setRenderRows(pageName, rows) { renderRows.set(pageName, rows); },
    primeRender(renderKey, pageName) { renderPages.set(renderKey, pageName); },
    missRenderKey(pageName) { renderKeyMisses.add(pageName); },
    failRender(pageName) { failedRenders.add(pageName); },
    holdRender(pageName) { const gate = deferred(); renderGates.set(pageName, gate); return gate; },
    releaseRender(pageName) { renderGates.get(pageName)?.resolve(); renderGates.delete(pageName); },
    holdOcrAfterFirst(pageName) { const gate = deferred(); ocrAfterFirstGates.set(pageName, gate); return gate; },
    releaseOcr(pageName) { ocrAfterFirstGates.get(pageName)?.resolve(); ocrAfterFirstGates.delete(pageName); },
    holdTranslation(dstLang) { const gate = deferred(); translationGates.set(dstLang, gate); return gate; },
    releaseTranslation(dstLang) { translationGates.get(dstLang)?.resolve(); translationGates.delete(dstLang); },
    queueTranslationResult(result) { translationResults.push(result); },
    beforeNextOcr(callback) { beforeOcr = callback; },
  };
}

function createBackgroundApp({ storage = fakeStorage(), server = createFakeServer(), clock = performance, cryptoImpl = webcrypto } = {}) {
  let connectListener;
  const runtimeListeners = [];
  const context = {
    Promise, Map, Set, URL, TextEncoder, TextDecoder, Buffer, performance: clock,
    crypto: cryptoImpl, console, setTimeout, clearTimeout,
    AbortController, AbortSignal, FormData, Blob, structuredClone,
    importScripts: () => {},
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
        onConnect: { addListener(listener) { connectListener = listener; } },
      },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
      storage: { session: storage },
    },
    fetch: server.fetch,
  };
  vm.createContext(context);
  storage.cloneForRead = (value) => {
    context.__storageJson = JSON.stringify(value);
    return vm.runInContext("JSON.parse(__storageJson)", context);
  };
  server.setResponseVersions(vm.runInContext(`(${JSON.stringify(server.versions)})`, context));
  server.setResponsePatchVersions(vm.runInContext(`(${JSON.stringify(server.patchVersions)})`, context));
  vm.runInContext(fs.readFileSync("extension/page-cache.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("extension/reading-order.js", "utf8"), context);
  if (fs.existsSync("extension/source-fetch.js")) {
    vm.runInContext(fs.readFileSync("extension/source-fetch.js", "utf8"), context);
  }
  vm.runInContext(fs.readFileSync("extension/background.js", "utf8"), context);
  return {
    context,
    server,
    storage,
    async ready() { await vm.runInContext("ready", context); },
    connect() {
      const value = fakePort();
      const deliver = value.receive.bind(value);
      value.receive = (message) => {
        context.__portJson = JSON.stringify(message);
        deliver(vm.runInContext("JSON.parse(__portJson)", context));
      };
      connectListener(value);
      return value;
    },
    message(message) {
      return new Promise((resolve, reject) => {
        const handled = runtimeListeners.some((listener) => listener(message, {}, resolve) === true);
        if (!handled) reject(new Error(`unhandled runtime message ${message.type}`));
      });
    },
    job(jobId, source, extra = {}) {
      return { job_id: jobId, source_url: source, crop: null, natural_width: 100, natural_height: 200, priority: 0, distance: 0, ...extra };
    },
    startScope(requestId, scope, job, replacesRequestId) {
      return { type: "start_scope", request_id: requestId, replaces_request_id: replacesRequestId, scope, src_lang: "ja", dst_lang: "vi", reading_direction: "rtl", jobs: job ? [job] : [] };
    },
    async waitFor(type, port) {
      await waitUntil(
        () => port.sent.some((event) => event.type === type),
        `${type} event; received ${JSON.stringify(port.sent)}`
      );
      return port.sent.find((event) => event.type === type);
    },
    async keysFor(job, srcLang = "ja", dstLang = "vi", sourceIdentity = sourceIdentityFor(job.source_url)) {
      return context.buildKeys(
        { ...job, src_lang: srcLang, dst_lang: dstLang },
        sourceIdentity,
        vm.runInContext("serverVersions", context),
        vm.runInContext("serverPatchVersions", context),
      );
    },
    page(pageKey) { return storage.rows[`mt:page:${pageKey}`]; },
    storedJob(jobId) { return storage.rows[`mt:job:${jobId}`]; },
    debug() {
      return vm.runInContext(
        "({ activeTasks, queued: taskQueue.length, offline: offlineJobs.length, requests: requests.size, producers: producers.size })",
        context
      );
    },
    hotTranslationCount() { return vm.runInContext("hotTranslations.size", context); },
    producer(pageKey) {
      context.__pageKey = pageKey;
      return vm.runInContext("producers.get(__pageKey)", context);
    },
    restart() { return createBackgroundApp({ storage, server, cryptoImpl }); },
  };
}

function cachedTranslatedPage({ keys, server, job, blockId = "old", mismatchCount = 0 }) {
  const timestamp = 1700000000000;
  return {
    schema_version: "page-v2",
    versions: structuredClone(server.versions),
    patch_versions: structuredClone(server.patchVersions),
    page_artifact_key: keys.pageArtifactKey,
    analysis_key: keys.analysisKey,
    ocr_key: keys.ocrKey,
    render_artifact_key: keys.renderArtifactKey,
    source_content_hash: keys.sourceContentHash,
    source_url: job.source_url,
    crop: "full",
    natural_width: 100,
    natural_height: 200,
    src_lang: "ja",
    dst_lang: "vi",
    reading_direction: "rtl",
    state: "complete",
    analysis_known: true,
    ocr_done: true,
    image_w: 100,
    image_h: 200,
    blocks: [{
      block_id: blockId, bbox: [1, 2, 3, 4], src_text: blockId, trans_text: `vi:${blockId}`,
      kind: "text", vertical: false, reading_order: 0, state: "translated",
    }],
    manifest_ids: [blockId],
    manifest_mismatch_count: mismatchCount,
    created_at: timestamp,
    updated_at: timestamp,
    last_accessed_at: timestamp,
    last_error: null,
  };
}

function cachedIncompleteOcrPage(options) {
  const page = cachedTranslatedPage(options);
  page.state = "partial";
  page.ocr_done = false;
  page.last_error = "ocr_incomplete";
  options.server.primeAnalysis(options.keys.analysisKey, options.job.source_url);
  return page;
}

async function scenario(name, check) {
  let timer;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("scenario timed out after 5000ms")), 5000);
      }),
    ]);
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const context = {
  Promise, JSON, Map, Set, URL, TextEncoder, TextDecoder,
  crypto: webcrypto,
  console,
  setTimeout, clearTimeout,
  AbortController, AbortSignal, FormData, Blob, structuredClone,
  importScripts: () => {},
  chrome: {
    runtime: {
      onMessage: { addListener() {} },
      onConnect: { addListener() {} },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    storage: { session: {} },
  },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
};
vm.createContext(context);
vm.runInContext(fs.readFileSync("extension/reading-order.js", "utf8"), context);
if (fs.existsSync("extension/source-fetch.js")) {
  vm.runInContext(fs.readFileSync("extension/source-fetch.js", "utf8"), context);
}
vm.runInContext(fs.readFileSync("extension/background.js", "utf8"), context);

test("background progressive transport", { timeout: 30000 }, async () => {
  // The producer API is deliberately exercised through a port: changing
  // acceptScope to only retain foreground work must make this fail.
  assert.strictEqual(typeof context.acceptScope, "function");

  await scenario("start_scope defaults missing direction and rejects invalid direction once before producer creation", async () => {
    const server = createFakeServer();
    server.holdSource("default-direction");
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    const missingDirection = app.startScope("default-direction", "visible", app.job("default-direction-job", "https://x/default-direction.jpg"));
    delete missingDirection.reading_direction;
    port.receive(missingDirection);
    await waitUntil(() => server.counts.source === 1, "held source identity fetch");
    assert.strictEqual(app.storedJob("default-direction-job").descriptor.reading_direction, "rtl");
    assert.strictEqual(port.sent.some((event) => event.type === "page_job_accepted"), false);
    server.releaseSource("default-direction");
    await app.waitFor("page_job_accepted", port);
    await app.waitFor("scope_done", port);

    const beforeSource = server.counts.source;
    const invalid = app.connect();
    invalid.receive({
      ...app.startScope("invalid-direction", "visible"),
      reading_direction: "vertical",
      jobs: [
        app.job("invalid-direction-a", "https://x/invalid-direction-a.jpg"),
        app.job("invalid-direction-b", "https://x/invalid-direction-b.jpg"),
      ],
    });
    const error = await app.waitFor("scope_error", invalid);
    assert.strictEqual(error.code, "invalid_request");
    assert.match(error.error, /invalid reading_direction/);
    await flush();
    assert.strictEqual(invalid.sent.filter((event) => event.type === "scope_error").length, 1);
    assert.strictEqual(invalid.sent.some((event) => event.type === "job_error"), false);
    assert.strictEqual(invalid.sent.some((event) => event.type === "scope_done"), false);
    assert.strictEqual(server.counts.source, beforeSource);
    assert.strictEqual(app.storedJob("invalid-direction-a"), undefined);
    assert.strictEqual(app.storedJob("invalid-direction-b"), undefined);
    assert.strictEqual(app.debug().requests, 0);
    assert.strictEqual(app.debug().producers, 0);
  });

  await scenario("waits for image_done and translates one ordered full page", async () => {
    const server = createFakeServer();
    server.setOcrRows("full-page", [
      { type: "analysis_ready", image_w: 300, image_h: 500 },
      { type: "ocr_block", block_id: "left", bbox: [10, 10, 20, 20], src_text: "left" },
      { type: "ocr_block", block_id: "bottom", bbox: [40, 80, 20, 20], src_text: "bottom" },
      { type: "ocr_block", block_id: "right", bbox: [200, 10, 20, 20], src_text: "right" },
      { type: "image_done", recognized: 3, failed: 0 },
    ]);
    server.holdOcrAfterFirst("full-page");
    server.queueTranslationResult({ items: [
      { id: "bottom", kind: "text", translation: "vi:bottom" },
      { id: "left", kind: "text", translation: "vi:left" },
      { id: "right", kind: "text", translation: "vi:right" },
    ] });
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    port.receive(app.startScope(
      "full-page",
      "visible",
      app.job("full-page-job", "https://x/full-page.jpg", { natural_width: 999, natural_height: 777 })
    ));
    await waitUntil(
      () => vm.runInContext("[...producers.values()].some((producer) => producer.page.blocks.length === 1)", app.context),
      "first held OCR block"
    );
    assert.strictEqual(server.translationBodies.length, 0);
    assert.strictEqual(port.sent.some((event) => event.type === "translation"), false);

    server.releaseOcr("full-page");
    const done = await app.waitFor("scope_done", port);
    assert.deepStrictEqual(server.translationBodies, [{
      src_lang: "ja",
      dst_lang: "vi",
      items: [
        { id: "right", text: "right", reading_order: 0, bbox: [200, 10, 20, 20] },
        { id: "left", text: "left", reading_order: 1, bbox: [10, 10, 20, 20] },
        { id: "bottom", text: "bottom", reading_order: 2, bbox: [40, 80, 20, 20] },
      ],
      page_width: 300,
      page_height: 500,
      reading_direction: "rtl",
    }]);
    assert.deepStrictEqual(
      port.sent.filter((event) => event.type === "translation").map((event) => event.block_id),
      ["right", "left", "bottom"]
    );
    assert.deepStrictEqual(
      done.page_metrics[0].translation_batches.map((batch) => ({
        batch_id: batch.batch_id,
        phase: batch.phase,
        block_ids: batch.block_ids,
        status: batch.status,
      })),
      [{ batch_id: 1, phase: "full_page", block_ids: ["right", "left", "bottom"], status: "success" }]
    );
  });

  await scenario("render outcomes persist only as a full canonical manifest without patch bytes", async () => {
    const storage = fakeStorage();
    storage.cloneForRead = structuredClone;
    const server = createFakeServer();
    server.setOcrRows("render-outcomes", [
      { type: "analysis_ready", image_w: 300, image_h: 500 },
      { type: "ocr_block", block_id: "left", bbox: [10, 10, 20, 20], src_text: "left" },
      { type: "ocr_block", block_id: "right", bbox: [200, 10, 20, 20], src_text: "right" },
      { type: "image_done", recognized: 2, failed: 0 },
    ]);
    server.setRenderRows("render-outcomes", [
      {
        block_id: "left", patch_id: "patch-left", patch_bbox: [10, 10, 20, 20], clean_region: [10, 10, 20, 20],
        fit_bbox: [10, 10, 20, 20], patch_mime: "image/png", patch_rgba: Buffer.from("patch:left").toString("base64"), reason: null,
      },
      {
        block_id: "right", patch_id: "patch-right", patch_bbox: [200, 10, 20, 20], clean_region: [200, 10, 20, 20],
        fit_bbox: [200, 10, 20, 20], patch_mime: "image/png", patch_rgba: Buffer.from("patch:right").toString("base64"), reason: null,
      },
      {
        block_id: "artifact-extra", patch_id: "patch-extra", patch_bbox: [1, 1, 2, 2], clean_region: [1, 1, 2, 2],
        fit_bbox: [1, 1, 2, 2], patch_mime: "image/png", patch_rgba: Buffer.from("patch:extra").toString("base64"), reason: null,
      },
    ]);
    server.queueTranslationResult({ items: [
      { id: "left", kind: "text", translation: "vi:left" },
      { id: "right", kind: "text", translation: "vi:right" },
    ] });
    const app = createBackgroundApp({ storage, server });
    await app.ready();
    const job = app.job("render-outcomes-job", "https://x/render-outcomes.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const port = app.connect();
    port.receive(app.startScope("render-outcomes", "visible", job));
    await app.waitFor("scope_done", port);

    const events = port.sent.filter((event) => event.type === "translation");
    assert.deepStrictEqual(events.map((event) => event.block_id), ["right", "left"]);
    assert.deepStrictEqual(app.page(keys.pageArtifactKey).manifest_ids, ["right", "left"]);
    const byId = new Map(events.map((event) => [event.block_id, event]));
    const identity = byId.get("left");
    const outcome = (blockId, layoutProfile) => ({
      type: "render_metric",
      request_id: "render-outcomes",
      job_id: "render-outcomes-job",
      page_artifact_key: identity.page_artifact_key,
      render_artifact_key: identity.render_artifact_key,
      layout_fit_version: identity.layout_fit_version,
      block_id: blockId,
      painted: true,
      reason: null,
      layout_profile: layoutProfile,
    });

    port.receive({ ...outcome("left", { font_px: 90, line_height: 9 }), page_artifact_key: "stale-page" });
    port.receive({ ...outcome("left", { font_px: 90, line_height: 9 }), render_artifact_key: "stale-render" });
    port.receive({ ...outcome("left", { font_px: 90, line_height: 9 }), layout_fit_version: "stale-layout" });
    await flush();
    assert.strictEqual(app.page(keys.pageArtifactKey).render, undefined);

    port.receive(outcome("right", { font_px: 18, line_height: 1.2 }));
    port.receive(outcome("artifact-extra", { font_px: 99, line_height: 9 }));
    port.receive(outcome("right", { font_px: 88, line_height: 8 }));
    await flush();
    assert.strictEqual(app.page(keys.pageArtifactKey).render, undefined);

    let failedReadyWrites = 0;
    storage.beforeSet = async (values) => {
      const row = values[`mt:page:${keys.pageArtifactKey}`];
      if (failedReadyWrites < 2 && row?.render?.blocks?.length === 2) {
        failedReadyWrites++;
        throw new Error("transient render persistence failure");
      }
    };
    port.receive(outcome("left", { font_px: 14, line_height: 1.1 }));
    await waitUntil(() => failedReadyWrites === 2, "transient full render persistence failure");
    await flush();
    assert.strictEqual(app.page(keys.pageArtifactKey).render, undefined);

    const retry = app.connect();
    retry.receive(app.startScope(
      "render-outcomes-retry",
      "visible",
      app.job("render-outcomes-retry-job", job.source_url),
    ));
    await app.waitFor("scope_done", retry);
    await waitUntil(() => app.page(keys.pageArtifactKey).render !== undefined, "full render subrecord persistence");
    const render = app.page(keys.pageArtifactKey).render;
    assert.deepStrictEqual(render.blocks.map((block) => block.block_id), ["right", "left"]);
    assert.deepStrictEqual(render.blocks.map((block) => block.layout_profile), [
      { font_px: 18, line_height: 1.2 },
      { font_px: 14, line_height: 1.1 },
    ]);
    assert.strictEqual(render.breaker_open, false);
    assert.strictEqual(JSON.stringify(render).includes("patch_rgba"), false);
  });

  await scenario("stale render collector cannot restore an older page identity", async () => {
    const server = createFakeServer();
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("collector-race-job", "https://x/collector-race.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const oldPage = cachedTranslatedPage({ keys, server, job });
    oldPage.render_artifact_key = "old-render";
    const newerPatchVersions = { ...server.patchVersions, cleaner: "c2" };
    const newerPage = structuredClone(oldPage);
    newerPage.render_artifact_key = "new-render";
    newerPage.patch_versions = newerPatchVersions;
    newerPage.render = {
      schema_version: "render-page-v1",
      render_artifact_key: "new-render",
      patch_versions: newerPatchVersions,
      layout_fit_version: "layout-fit-v1",
      breaker_open: false,
      blocks: [{
        block_id: "old", render_mode: "in_place", patch_id: "new-patch",
        patch_bbox: [1, 2, 3, 4], fit_bbox: [1, 2, 3, 4],
        layout_profile: { font_px: 17, line_height: 1.2 }, reason: null,
      }],
    };
    const port = app.connect();
    app.context.__collectorRaceOldPage = JSON.stringify(oldPage);
    app.context.__collectorRaceArtifact = JSON.stringify({
      render_artifact_key: "old-render",
      blocks: [{ block_id: "old", patch_id: "old-patch", patch_bbox: [1, 2, 3, 4], fit_bbox: [1, 2, 3, 4], reason: null }],
    });
    app.context.__collectorRaceNewPage = JSON.stringify(newerPage);
    app.context.__collectorRacePort = port;
    await vm.runInContext(`(async () => {
      const page = JSON.parse(__collectorRaceOldPage);
      const producer = {
        pageKey: page.page_artifact_key, page, persistUntilDone: true, persistChain: Promise.resolve(),
        consumers: new Map(), jobIds: new Set(), prewarmOnly: false,
      };
      producers.set(page.page_artifact_key, producer);
      await pageCache.putPage(page);
      prepareRenderOutcomeCollector(page, JSON.parse(__collectorRaceArtifact), [
        { requestId: "collector-race", jobId: "collector-race-job", port: __collectorRacePort },
      ], producer);
    })()`, app.context);
    await vm.runInContext("pageCache.putPage(JSON.parse(__collectorRaceNewPage))", app.context);

    port.receive({
      type: "render_metric", request_id: "collector-race", job_id: "collector-race-job",
      page_artifact_key: keys.pageArtifactKey, render_artifact_key: "old-render", layout_fit_version: "layout-fit-v1",
      block_id: "old", painted: true, reason: null, layout_profile: { font_px: 14, line_height: 1.1 },
    });
    await flush();
    app.context.__collectorRacePageKey = keys.pageArtifactKey;
    await vm.runInContext("persist(producers.get(__collectorRacePageKey))", app.context);
    await flush();

    const stored = app.page(keys.pageArtifactKey);
    assert.deepStrictEqual({
      pageRenderKey: stored.render_artifact_key,
      pagePatchVersions: stored.patch_versions,
      renderKey: stored.render?.render_artifact_key,
      renderPatchVersions: stored.render?.patch_versions,
      patchId: stored.render?.blocks[0]?.patch_id,
    }, {
      pageRenderKey: "new-render",
      pagePatchVersions: newerPatchVersions,
      renderKey: "new-render",
      renderPatchVersions: newerPatchVersions,
      patchId: "new-patch",
    });
    const active = app.producer(keys.pageArtifactKey);
    assert.strictEqual(active.page.render, undefined);
  });

  await scenario("collector ready write cannot overtake a queued render identity bump", async () => {
    const storage = fakeStorage();
    const server = createFakeServer();
    const app = createBackgroundApp({ storage, server });
    await app.ready();
    const job = app.job("collector-interleave-job", "https://x/collector-interleave.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const oldPage = cachedTranslatedPage({ keys, server, job });
    oldPage.state = "running";
    oldPage.render_artifact_key = "old-render";
    const bumpedPatchVersions = { ...server.patchVersions, cleaner: "c2" };
    const layoutFitVersion = vm.runInContext("LAYOUT_FIT_VERSION", app.context);
    const port = app.connect();
    app.context.__collectorInterleaveOldPage = JSON.stringify(oldPage);
    app.context.__collectorInterleaveArtifact = JSON.stringify({
      render_artifact_key: "old-render",
      blocks: [{ block_id: "old", patch_id: "old-patch", patch_bbox: [1, 2, 3, 4], fit_bbox: [1, 2, 3, 4], reason: null }],
    });
    app.context.__collectorInterleavePort = port;
    await vm.runInContext(`(async () => {
      const page = JSON.parse(__collectorInterleaveOldPage);
      const producer = {
        pageKey: page.page_artifact_key, page, persistUntilDone: true, persistChain: Promise.resolve(),
        consumers: new Map(), jobIds: new Set(), prewarmOnly: false,
      };
      producers.set(page.page_artifact_key, producer);
      await pageCache.putPage(page);
      prepareRenderOutcomeCollector(page, JSON.parse(__collectorInterleaveArtifact), [
        { requestId: "collector-interleave", jobId: "collector-interleave-job", port: __collectorInterleavePort },
      ], producer);
    })()`, app.context);
    const oldReadyWrite = deferred();
    const releaseOldReady = deferred();
    let heldOldReady = false;
    storage.beforeSet = async (values) => {
      if (heldOldReady || !Object.values(values).some((row) => row?.render?.render_artifact_key === "old-render")) return;
      heldOldReady = true;
      oldReadyWrite.resolve();
      await releaseOldReady.promise;
    };

    app.context.__collectorInterleaveMetric = JSON.stringify({
      type: "render_metric", request_id: "collector-interleave", job_id: "collector-interleave-job",
      page_artifact_key: keys.pageArtifactKey, render_artifact_key: "old-render", layout_fit_version: layoutFitVersion,
      block_id: "old", painted: true, reason: null, layout_profile: { font_px: 14, line_height: 1.1 },
    });
    vm.runInContext("collectRenderOutcome(__collectorInterleavePort, JSON.parse(__collectorInterleaveMetric))", app.context);
    await oldReadyWrite.promise;
    app.context.__collectorInterleavePageKey = keys.pageArtifactKey;
    vm.runInContext(
      "globalThis.__collectorInterleaveOldWriteTail = pageWriteTails.get(__collectorInterleavePageKey)",
      app.context
    );
    app.context.__collectorInterleavePatchVersions = JSON.stringify(bumpedPatchVersions);
    app.context.__collectorInterleaveDescriptor = JSON.stringify({
      ...job, src_lang: "ja", dst_lang: "vi", scope: "visible", reading_direction: "rtl", source_fetch_ms: 0,
    });
    const identityBump = vm.runInContext(`(async () => {
      serverPatchVersions = JSON.parse(__collectorInterleavePatchVersions);
      const descriptor = JSON.parse(__collectorInterleaveDescriptor);
      const sourceIdentity = { sourceContentHash: ${JSON.stringify(keys.sourceContentHash)}, blob: new Blob(["collector-interleave"]) };
      const nextKeys = await buildKeys(descriptor, sourceIdentity, serverVersions, serverPatchVersions);
      globalThis.__collectorInterleaveRenderKey = nextKeys.renderArtifactKey;
      const acquisition = { release() {} };
      const request = {
        requestId: "collector-interleave-new", scope: "visible", srcLang: "ja", dstLang: "vi", port: null,
        jobsBySourceCrop: new Map(), sourceAcquisitions: new Map([[descriptor.job_id, acquisition]]),
        sourceDescriptors: new Map([[descriptor.job_id, descriptor]]), cancelledSourceJobs: new Set(), jobs: new Map(), pendingJobs: [],
      };
      await attachDescriptor(request, descriptor, {
        job_id: descriptor.job_id, request_id: request.requestId, scope: "visible", src_lang: "ja", dst_lang: "vi",
        descriptor, state: "queued", created_at: 1,
      }, sourceIdentity, acquisition);
    })()`, app.context);
    await waitUntil(
      () => vm.runInContext(
        "pageWriteTails.get(__collectorInterleavePageKey) !== globalThis.__collectorInterleaveOldWriteTail",
        app.context
      ),
      "queued render identity bump"
    );
    assert.deepStrictEqual({
      pageRenderKey: app.page(keys.pageArtifactKey).render_artifact_key,
      pagePatchVersions: app.page(keys.pageArtifactKey).patch_versions,
    }, {
      pageRenderKey: "old-render",
      pagePatchVersions: server.patchVersions,
    });
    releaseOldReady.resolve();
    await identityBump;
    await flush();

    const stored = app.page(keys.pageArtifactKey);
    const nextRenderKey = vm.runInContext("__collectorInterleaveRenderKey", app.context);
    assert.deepStrictEqual({
      pageRenderKey: stored.render_artifact_key,
      pagePatchVersions: stored.patch_versions,
      render: stored.render,
    }, {
      pageRenderKey: nextRenderKey,
      pagePatchVersions: bumpedPatchVersions,
      render: undefined,
    });
  });

  await scenario("stale mismatch producer cannot write a sentinel into a bumped page", async () => {
    const server = createFakeServer();
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("stale-mismatch-job", "https://x/stale-mismatch.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const oldPage = cachedTranslatedPage({ keys, server, job, mismatchCount: 1 });
    oldPage.state = "running";
    oldPage.render_artifact_key = "old-render";
    const bumpedPatchVersions = { ...server.patchVersions, cleaner: "c2" };
    app.context.__staleMismatchOldPage = JSON.stringify(oldPage);
    app.context.__staleMismatchPatchVersions = JSON.stringify(bumpedPatchVersions);
    app.context.__staleMismatchDescriptor = JSON.stringify({
      ...job, src_lang: "ja", dst_lang: "vi", scope: "visible", reading_direction: "rtl", source_fetch_ms: 0,
    });
    await vm.runInContext(`(async () => {
      const oldPage = JSON.parse(__staleMismatchOldPage);
      await pageCache.putPage(oldPage);
      serverPatchVersions = JSON.parse(__staleMismatchPatchVersions);
      const descriptor = JSON.parse(__staleMismatchDescriptor);
      const sourceIdentity = { sourceContentHash: ${JSON.stringify(keys.sourceContentHash)}, blob: new Blob(["stale-mismatch"]) };
      const nextKeys = await buildKeys(descriptor, sourceIdentity, serverVersions, serverPatchVersions);
      globalThis.__staleMismatchRenderKey = nextKeys.renderArtifactKey;
      const acquisition = { release() {} };
      const request = {
        requestId: "stale-mismatch-new", scope: "visible", srcLang: "ja", dstLang: "vi", port: null,
        jobsBySourceCrop: new Map(), sourceAcquisitions: new Map([[descriptor.job_id, acquisition]]),
        sourceDescriptors: new Map([[descriptor.job_id, descriptor]]), cancelledSourceJobs: new Set(), jobs: new Map(), pendingJobs: [],
      };
      await attachDescriptor(request, descriptor, {
        job_id: descriptor.job_id, request_id: request.requestId, scope: "visible", src_lang: "ja", dst_lang: "vi",
        descriptor, state: "queued", created_at: 1,
      }, sourceIdentity, acquisition);
      globalThis.__staleMismatchAction = await handleManifestMismatch({
        pageKey: oldPage.page_artifact_key,
        renderArtifactKey: oldPage.render_artifact_key,
        page: oldPage,
      });
    })()`, app.context);

    const stored = app.page(keys.pageArtifactKey);
    assert.deepStrictEqual({
      action: vm.runInContext("__staleMismatchAction", app.context),
      pageRenderKey: stored.render_artifact_key,
      pagePatchVersions: stored.patch_versions,
      render: stored.render,
      mismatchCount: stored.manifest_mismatch_count,
    }, {
      action: "stale",
      pageRenderKey: vm.runInContext("__staleMismatchRenderKey", app.context),
      pagePatchVersions: bumpedPatchVersions,
      render: undefined,
      mismatchCount: 1,
    });
  });

  await scenario("queued collector cannot overwrite a persisted mismatch sentinel", async () => {
    const storage = fakeStorage();
    const server = createFakeServer();
    const app = createBackgroundApp({ storage, server });
    await app.ready();
    const job = app.job("queued-sentinel-job", "https://x/queued-sentinel.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const page = cachedTranslatedPage({ keys, server, job, mismatchCount: 1 });
    const port = app.connect();
    app.context.__queuedSentinelPage = JSON.stringify(page);
    app.context.__queuedSentinelArtifact = JSON.stringify({
      render_artifact_key: keys.renderArtifactKey,
      blocks: [{ block_id: "old", patch_id: "old-patch", patch_bbox: [1, 2, 3, 4], fit_bbox: [1, 2, 3, 4], reason: null }],
    });
    app.context.__queuedSentinelPort = port;
    await vm.runInContext(`(async () => {
      const page = JSON.parse(__queuedSentinelPage);
      await pageCache.putPage(page);
      prepareRenderOutcomeCollector(page, JSON.parse(__queuedSentinelArtifact), [
        { requestId: "queued-sentinel", jobId: "queued-sentinel-job", port: __queuedSentinelPort },
      ]);
      globalThis.__queuedSentinelProducer = {
        pageKey: page.page_artifact_key,
        renderArtifactKey: page.render_artifact_key,
        page,
      };
    })()`, app.context);

    const mismatchReadHeld = deferred();
    const releaseMismatchRead = deferred();
    let heldMismatchRead = false;
    storage.beforeSet = async () => {
      if (heldMismatchRead) return;
      heldMismatchRead = true;
      mismatchReadHeld.resolve();
      await releaseMismatchRead.promise;
    };
    vm.runInContext("globalThis.__queuedSentinelMismatch = handleManifestMismatch(__queuedSentinelProducer)", app.context);
    await mismatchReadHeld.promise;
    app.context.__queuedSentinelPageKey = keys.pageArtifactKey;
    vm.runInContext(
      "globalThis.__queuedSentinelMismatchTail = pageWriteTails.get(__queuedSentinelPageKey)",
      app.context
    );

    port.receive({
      type: "render_metric", request_id: "queued-sentinel", job_id: "queued-sentinel-job",
      page_artifact_key: keys.pageArtifactKey, render_artifact_key: keys.renderArtifactKey,
      layout_fit_version: vm.runInContext("LAYOUT_FIT_VERSION", app.context),
      block_id: "old", painted: true, reason: null, layout_profile: { font_px: 14, line_height: 1.1 },
    });
    await waitUntil(
      () => vm.runInContext(
        "pageWriteTails.get(__queuedSentinelPageKey) !== globalThis.__queuedSentinelMismatchTail",
        app.context
      ),
      "collector queued behind mismatch sentinel"
    );
    releaseMismatchRead.resolve();
    await vm.runInContext("__queuedSentinelMismatch", app.context);
    await waitUntil(
      () => vm.runInContext("!pageWriteTails.has(__queuedSentinelPageKey)", app.context),
      "queued collector completion"
    );

    assert.deepStrictEqual(app.page(keys.pageArtifactKey).render, {
      schema_version: "render-page-v1",
      render_artifact_key: keys.renderArtifactKey,
      patch_versions: server.patchVersions,
      layout_fit_version: "dom-fit-10px-v1",
      breaker_open: true,
      blocks: [],
    });
  });

  await scenario("retire producer cannot overwrite or remove a bumped page", async () => {
    const retained = [];
    const expectedPatchVersions = { cleaner: "c2", render_encoding: "png-rgba-v1", render_schema: "render-v1" };
    for (const mode of ["useful", "empty"]) {
      const storage = fakeStorage();
      const server = createFakeServer();
      const app = createBackgroundApp({ storage, server });
      await app.ready();
      const job = app.job(`retire-stale-${mode}-job`, `https://x/retire-stale-${mode}.jpg`);
      const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
      const oldPage = cachedTranslatedPage({ keys, server, job });
      oldPage.render_artifact_key = "old-render";
      if (mode === "empty") {
        oldPage.analysis_known = false;
        oldPage.ocr_done = false;
        oldPage.image_w = null;
        oldPage.image_h = null;
        oldPage.blocks = [];
        delete oldPage.manifest_ids;
      }
      const bumpedPatchVersions = { ...expectedPatchVersions };
      const bumpedPage = cachedTranslatedPage({ keys, server, job });
      bumpedPage.render_artifact_key = "new-render";
      bumpedPage.patch_versions = bumpedPatchVersions;
      const retiredWriteDone = deferred();
      const retireJobStorageKey = `mt:job:retire-stale-${mode}-job`;
      storage.beforeRemove = async (names) => {
        if ((Array.isArray(names) ? names : [names]).includes(retireJobStorageKey)) retiredWriteDone.resolve();
      };
      const persistGate = deferred();
      app.context.__retireStaleOldPage = JSON.stringify(oldPage);
      app.context.__retireStaleGate = persistGate.promise;
      app.context.__retireStaleJobId = `retire-stale-${mode}-job`;
      vm.runInContext(`(() => {
        const page = JSON.parse(__retireStaleOldPage);
        retireProducer({
          pageKey: page.page_artifact_key,
          renderArtifactKey: page.render_artifact_key,
          page,
          persistUntilDone: true,
          persistChain: __retireStaleGate,
          counters: { stale_work: 0 },
          cancelled: false,
          retired: false,
          sourceAcquisition: null,
          ocrKey: "retire-stale-ocr",
          ocrStageKey: "retire-stale-ocr",
          analysisKey: "retire-stale-analysis",
          jobIds: new Set([__retireStaleJobId]),
        });
      })()`, app.context);
      app.context.__retireStaleBumpedPage = JSON.stringify(bumpedPage);
      await vm.runInContext("pageCache.putPage(JSON.parse(__retireStaleBumpedPage))", app.context);
      persistGate.resolve();
      await retiredWriteDone.promise;
      retained.push({
        mode,
        renderArtifactKey: app.page(keys.pageArtifactKey)?.render_artifact_key,
        patchVersions: app.page(keys.pageArtifactKey)?.patch_versions,
      });
    }
    assert.deepStrictEqual(retained, [
      {
        mode: "useful",
        renderArtifactKey: "new-render",
        patchVersions: expectedPatchVersions,
      },
      {
        mode: "empty",
        renderArtifactKey: "new-render",
        patchVersions: expectedPatchVersions,
      },
    ]);
  });

  await scenario("creation cannot overwrite a row that arrives after its null read", async () => {
    const server = createFakeServer();
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("creation-race-a", "https://x/creation-race.jpg");
    const c1Keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const firstFindHeld = deferred();
    const releaseFirstFind = deferred();
    app.context.__creationFirstFindHeld = firstFindHeld;
    app.context.__creationReleaseFirstFind = releaseFirstFind.promise;
    await vm.runInContext(`(() => {
      const originalFindPage = pageCache.findPage.bind(pageCache);
      let holdFirstFind = true;
      pageCache.findPage = async (predicate) => {
        if (holdFirstFind) {
          holdFirstFind = false;
          __creationFirstFindHeld.resolve();
          await __creationReleaseFirstFind;
        }
        return originalFindPage(predicate);
      };
    })()`, app.context);
    app.context.__creationC1PatchVersions = JSON.stringify(server.patchVersions);
    app.context.__creationADescriptor = JSON.stringify({
      ...job, src_lang: "ja", dst_lang: "vi", scope: "visible", reading_direction: "rtl", source_fetch_ms: 0,
    });
    app.context.__creationBDescriptor = JSON.stringify({
      ...job, job_id: "creation-race-b", src_lang: "ja", dst_lang: "vi", scope: "visible", reading_direction: "rtl", source_fetch_ms: 0,
    });
    const first = vm.runInContext(`(async () => {
      serverPatchVersions = JSON.parse(__creationC1PatchVersions);
      const descriptor = JSON.parse(__creationADescriptor);
      const sourceIdentity = { sourceContentHash: ${JSON.stringify(c1Keys.sourceContentHash)}, blob: new Blob([descriptor.source_url]) };
      const acquisition = { release() {} };
      const request = {
        requestId: "creation-race-a", scope: "visible", srcLang: "ja", dstLang: "vi", port: null,
        jobsBySourceCrop: new Map(), sourceAcquisitions: new Map([[descriptor.job_id, acquisition]]),
        sourceDescriptors: new Map([[descriptor.job_id, descriptor]]), cancelledSourceJobs: new Set(), jobs: new Map(), pendingJobs: [],
      };
      await attachDescriptor(request, descriptor, {
        job_id: descriptor.job_id, request_id: request.requestId, scope: "visible", src_lang: "ja", dst_lang: "vi",
        descriptor, state: "queued", created_at: 1,
      }, sourceIdentity, acquisition);
    })()`, app.context);
    await firstFindHeld.promise;
    const second = vm.runInContext(`(async () => {
      serverPatchVersions = JSON.parse(__creationC1PatchVersions);
      const descriptor = JSON.parse(__creationBDescriptor);
      const sourceIdentity = { sourceContentHash: ${JSON.stringify(c1Keys.sourceContentHash)}, blob: new Blob([descriptor.source_url]) };
      const acquisition = { release() {} };
      const request = {
        requestId: "creation-race-b", scope: "visible", srcLang: "ja", dstLang: "vi", port: null,
        jobsBySourceCrop: new Map(), sourceAcquisitions: new Map([[descriptor.job_id, acquisition]]),
        sourceDescriptors: new Map([[descriptor.job_id, descriptor]]), cancelledSourceJobs: new Set(), jobs: new Map(), pendingJobs: [],
      };
      await attachDescriptor(request, descriptor, {
        job_id: descriptor.job_id, request_id: request.requestId, scope: "visible", src_lang: "ja", dst_lang: "vi",
        descriptor, state: "queued", created_at: 1,
      }, sourceIdentity, acquisition);
    })()`, app.context);
    await second;
    const newerPage = cachedTranslatedPage({ keys: c1Keys, server, job });
    newerPage.state = "partial";
    newerPage.last_error = "newer row";
    app.context.__creationNewerPage = JSON.stringify(newerPage);
    await vm.runInContext("pageCache.putPage(JSON.parse(__creationNewerPage))", app.context);
    assert.deepStrictEqual({
      state: app.page(c1Keys.pageArtifactKey).state,
      lastError: app.page(c1Keys.pageArtifactKey).last_error,
    }, {
      state: "partial",
      lastError: "newer row",
    });
    releaseFirstFind.resolve();
    await first;
    assert.deepStrictEqual({
      state: app.page(c1Keys.pageArtifactKey).state,
      lastError: app.page(c1Keys.pageArtifactKey).last_error,
    }, {
      state: "partial",
      lastError: "newer row",
    });
  });

  await scenario("prewarm find touch cannot erase a ready render", async () => {
    const storage = fakeStorage();
    const server = createFakeServer();
    const app = createBackgroundApp({ storage, server });
    await app.ready();
    const job = app.job("prewarm-find-job", "https://x/prewarm-find.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const page = cachedTranslatedPage({ keys, server, job });
    const port = app.connect();
    app.context.__prewarmFindPage = JSON.stringify(page);
    app.context.__prewarmFindArtifact = JSON.stringify({
      render_artifact_key: keys.renderArtifactKey,
      blocks: [{ block_id: "old", patch_id: "find-ready-patch", patch_bbox: [1, 2, 3, 4], fit_bbox: [1, 2, 3, 4], reason: null }],
    });
    app.context.__prewarmFindPort = port;
    await vm.runInContext(`(async () => {
      const page = JSON.parse(__prewarmFindPage);
      await pageCache.putPage(page);
      prepareRenderOutcomeCollector(page, JSON.parse(__prewarmFindArtifact), [
        { requestId: "prewarm-find-render", jobId: "prewarm-find-render-job", port: __prewarmFindPort },
      ]);
    })()`, app.context);

    const oldReadHeld = deferred();
    const releaseOldRead = deferred();
    let heldOldRead = false;
    storage.afterGet = async (key) => {
      if (heldOldRead || key !== null) return;
      heldOldRead = true;
      oldReadHeld.resolve();
      await releaseOldRead.promise;
    };
    app.context.__prewarmFindDescriptor = JSON.stringify({
      ...job, src_lang: "ja", dst_lang: "vi", scope: "prewarm", reading_direction: "rtl", source_fetch_ms: 0,
    });
    const attached = vm.runInContext(`(async () => {
      const descriptor = JSON.parse(__prewarmFindDescriptor);
      const sourceIdentity = { sourceContentHash: ${JSON.stringify(keys.sourceContentHash)}, blob: new Blob([descriptor.source_url]) };
      const acquisition = { release() {} };
      const request = createRequest(null, {
        request_id: "prewarm-find-attach", scope: "prewarm", src_lang: "ja", dst_lang: "vi", jobs: [descriptor],
      });
      request.sourceAcquisitions.set(descriptor.job_id, acquisition);
      request.sourceDescriptors.set(descriptor.job_id, descriptor);
      await attachDescriptor(request, descriptor, {
        job_id: descriptor.job_id, request_id: request.requestId, scope: "prewarm", src_lang: "ja", dst_lang: "vi",
        descriptor, state: "queued", created_at: 1,
      }, sourceIdentity, acquisition);
    })()`, app.context);
    await oldReadHeld.promise;
    app.context.__prewarmFindMetric = JSON.stringify({
      type: "render_metric", request_id: "prewarm-find-render", job_id: "prewarm-find-render-job",
      page_artifact_key: keys.pageArtifactKey, render_artifact_key: keys.renderArtifactKey,
      layout_fit_version: vm.runInContext("LAYOUT_FIT_VERSION", app.context),
      block_id: "old", painted: true, reason: null, layout_profile: { font_px: 14, line_height: 1.1 },
    });
    vm.runInContext("collectRenderOutcome(__prewarmFindPort, JSON.parse(__prewarmFindMetric))", app.context);
    await waitUntil(() => app.page(keys.pageArtifactKey).render !== undefined, "ready render before releasing old find read");
    releaseOldRead.resolve();
    await attached;
    await flush();
    assert.strictEqual(app.page(keys.pageArtifactKey).render?.blocks[0]?.patch_id, "find-ready-patch");
  });

  await scenario("initial page touch cannot erase a ready render", async () => {
    const storage = fakeStorage();
    const server = createFakeServer();
    const app = createBackgroundApp({ storage, server });
    await app.ready();
    const job = app.job("initial-touch-job", "https://x/initial-touch.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const page = cachedTranslatedPage({ keys, server, job });
    page.state = "running";
    const port = app.connect();
    app.context.__initialTouchPage = JSON.stringify(page);
    app.context.__initialTouchArtifact = JSON.stringify({
      render_artifact_key: keys.renderArtifactKey,
      blocks: [{ block_id: "old", patch_id: "ready-patch", patch_bbox: [1, 2, 3, 4], fit_bbox: [1, 2, 3, 4], reason: null }],
    });
    app.context.__initialTouchPort = port;
    await vm.runInContext(`(async () => {
      const page = JSON.parse(__initialTouchPage);
      await pageCache.putPage(page);
      prepareRenderOutcomeCollector(page, JSON.parse(__initialTouchArtifact), [
        { requestId: "initial-touch-render", jobId: "initial-touch-render-job", port: __initialTouchPort },
      ]);
    })()`, app.context);

    const oldReadHeld = deferred();
    const releaseOldRead = deferred();
    let heldOldRead = false;
    const pageStorageKey = `mt:page:${keys.pageArtifactKey}`;
    storage.afterGet = async (key) => {
      if (heldOldRead || key !== pageStorageKey) return;
      heldOldRead = true;
      oldReadHeld.resolve();
      await releaseOldRead.promise;
    };
    app.context.__initialTouchDescriptor = JSON.stringify({
      ...job, src_lang: "ja", dst_lang: "vi", scope: "visible", reading_direction: "rtl", source_fetch_ms: 0,
    });
    const attached = vm.runInContext(`(async () => {
      const descriptor = JSON.parse(__initialTouchDescriptor);
      const sourceIdentity = { sourceContentHash: ${JSON.stringify(keys.sourceContentHash)}, blob: new Blob([descriptor.source_url]) };
      const acquisition = { release() {} };
      const request = {
        requestId: "initial-touch-attach", scope: "visible", srcLang: "ja", dstLang: "vi", port: null,
        jobsBySourceCrop: new Map(), sourceAcquisitions: new Map([[descriptor.job_id, acquisition]]),
        sourceDescriptors: new Map([[descriptor.job_id, descriptor]]), cancelledSourceJobs: new Set(), jobs: new Map(), pendingJobs: [],
      };
      await attachDescriptor(request, descriptor, {
        job_id: descriptor.job_id, request_id: request.requestId, scope: "visible", src_lang: "ja", dst_lang: "vi",
        descriptor, state: "queued", created_at: 1,
      }, sourceIdentity, acquisition);
    })()`, app.context);
    await oldReadHeld.promise;
    const initialReadSerialized = vm.runInContext(
      `pageWriteTails.has(${JSON.stringify(keys.pageArtifactKey)})`,
      app.context,
    );
    if (!initialReadSerialized) {
      releaseOldRead.resolve();
      await attached;
    }
    assert.strictEqual(initialReadSerialized, true, "initial page read must hold the page write chain");
    app.context.__initialTouchMetric = JSON.stringify({
      type: "render_metric", request_id: "initial-touch-render", job_id: "initial-touch-render-job",
      page_artifact_key: keys.pageArtifactKey, render_artifact_key: keys.renderArtifactKey,
      layout_fit_version: vm.runInContext("LAYOUT_FIT_VERSION", app.context),
      block_id: "old", painted: true, reason: null, layout_profile: { font_px: 14, line_height: 1.1 },
    });
    vm.runInContext("collectRenderOutcome(__initialTouchPort, JSON.parse(__initialTouchMetric))", app.context);
    releaseOldRead.resolve();
    await attached;
    await waitUntil(() => app.page(keys.pageArtifactKey).render !== undefined, "ready render after the serialized initial read");
    assert.strictEqual(app.page(keys.pageArtifactKey).render?.blocks[0]?.patch_id, "ready-patch");
  });

  await scenario("non-reusable producer is not joined after a non-terminal cache fallback", async () => {
    for (const fixture of [
      { name: "identity-mismatch", cancelled: false, retired: false, identityMismatch: true },
      { name: "cancelled", cancelled: true, retired: false, identityMismatch: false },
      { name: "retired", cancelled: false, retired: true, identityMismatch: false },
    ]) {
      const storage = fakeStorage();
      const server = createFakeServer();
      const app = createBackgroundApp({ storage, server });
      await app.ready();
      const job = app.job(`${fixture.name}-active-job`, `https://x/${fixture.name}-active.jpg`);
      const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
      const page = cachedTranslatedPage({ keys, server, job });
      page.state = "partial";
      app.context.__staleActivePage = JSON.stringify(page);
      app.context.__staleActiveDescriptor = JSON.stringify({
        ...job, src_lang: "ja", dst_lang: "vi", scope: "visible", reading_direction: "rtl", source_fetch_ms: 0,
      });
      app.context.__staleActiveFixture = JSON.stringify(fixture);
      app.context.__staleActiveSourceHash = keys.sourceContentHash;
      await vm.runInContext(`(async () => {
        const page = JSON.parse(__staleActivePage);
        await pageCache.putPage(page);
        const fixture = JSON.parse(__staleActiveFixture);
        const stalePage = structuredClone(page);
        if (fixture.identityMismatch) {
          stalePage.render_artifact_key = "stale-render";
          stalePage.patch_versions = { ...stalePage.patch_versions, cleaner: "stale-cleaner" };
        }
        const stale = {
          pageKey: stalePage.page_artifact_key,
          renderArtifactKey: stalePage.render_artifact_key,
          page: stalePage,
          ocrStageKey: stalePage.ocr_key,
          analysisKey: stalePage.analysis_key,
          consumers: new Map(),
          jobIds: new Set(),
          prewarmOnly: false,
          persistUntilDone: false,
          cancelled: fixture.cancelled,
          retired: fixture.retired,
          timings: { accepted: 0 },
          durations: {},
          analysisCacheHit: null,
          ocrSummary: null,
          translationBatchTrace: [],
          persistChain: Promise.resolve(),
        };
        producers.set(page.page_artifact_key, stale);
        const descriptor = JSON.parse(__staleActiveDescriptor);
        const acquisition = { released: false, release() { this.released = true; } };
        const request = createRequest(null, {
          request_id: "stale-active-" + fixture.name,
          scope: "visible", src_lang: "ja", dst_lang: "vi", jobs: [descriptor],
        });
        request.sourceAcquisitions.set(descriptor.job_id, acquisition);
        request.sourceDescriptors.set(descriptor.job_id, descriptor);
        await attachDescriptor(request, descriptor, {
          job_id: descriptor.job_id, request_id: request.requestId, scope: "visible", src_lang: "ja", dst_lang: "vi",
          descriptor, state: "queued", created_at: 1,
        }, { sourceContentHash: __staleActiveSourceHash, blob: new Blob([descriptor.source_url]) }, acquisition);
        const attached = request.jobs.get(descriptor.job_id);
        const replacedBeforeCleanup = producers.get(page.page_artifact_key) === attached && attached !== stale;
        if (fixture.name === "identity-mismatch") await finishProducer(stale, { translated: 0, failed: 0 });
        if (fixture.name === "cancelled") await failProducer(stale, new Error("stale producer failed"));
        globalThis.__staleActiveResult = JSON.stringify({
          staleConsumers: stale.consumers.size,
          attachedToStale: attached === stale,
          replacedBeforeCleanup,
          newOwnsAcquisition: attached?.sourceAcquisition === acquisition,
          acquisitionReleased: acquisition.released,
          replacementRemains: producers.get(page.page_artifact_key) === attached,
        });
      })()`, app.context);
      assert.deepStrictEqual(JSON.parse(vm.runInContext("__staleActiveResult", app.context)), {
        staleConsumers: 0,
        attachedToStale: false,
        replacedBeforeCleanup: true,
        newOwnsAcquisition: true,
        acquisitionReleased: false,
        replacementRemains: true,
      });
    }
  });

  await scenario("terminal render error cannot restore an older page identity", async () => {
    const storage = fakeStorage();
    const server = createFakeServer();
    const app = createBackgroundApp({ storage, server });
    await app.ready();
    const job = app.job("terminal-stale-error-job", "https://x/terminal-stale-error.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const oldPage = cachedTranslatedPage({ keys, server, job });
    storage.rows[`mt:page:${keys.pageArtifactKey}`] = oldPage;
    server.primeRender(keys.renderArtifactKey, "terminal-stale-error");
    server.failRender("terminal-stale-error");
    server.holdRender("terminal-stale-error");
    const port = app.connect();
    port.receive(app.startScope("terminal-stale-error", "visible", job));
    await waitUntil(() => server.counts.render === 1, "held terminal render request");

    const bumpedPatchVersions = { ...server.patchVersions, cleaner: "c2" };
    const bumpedPage = structuredClone(oldPage);
    bumpedPage.render_artifact_key = "new-render";
    bumpedPage.patch_versions = bumpedPatchVersions;
    app.context.__terminalStaleBumpedPage = JSON.stringify(bumpedPage);
    await vm.runInContext("pageCache.putPage(JSON.parse(__terminalStaleBumpedPage))", app.context);
    assert.deepStrictEqual({
      renderArtifactKey: app.page(keys.pageArtifactKey).render_artifact_key,
      patchVersions: app.page(keys.pageArtifactKey).patch_versions,
    }, {
      renderArtifactKey: "new-render",
      patchVersions: bumpedPatchVersions,
    });

    server.releaseRender("terminal-stale-error");
    await app.waitFor("scope_done", port);
    assert.deepStrictEqual({
      renderArtifactKey: app.page(keys.pageArtifactKey).render_artifact_key,
      patchVersions: app.page(keys.pageArtifactKey).patch_versions,
    }, {
      renderArtifactKey: "new-render",
      patchVersions: bumpedPatchVersions,
    });
  });

  await scenario("disconnect and supersede invalidate incomplete render collectors", async () => {
    for (const action of ["disconnect", "supersede"]) {
      const app = createBackgroundApp();
      await app.ready();
      const requestId = `collector-${action}`;
      const jobId = `collector-${action}-job`;
      const job = app.job(jobId, `https://x/collector-${action}.jpg`);
      const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
      const port = app.connect();
      port.receive(app.startScope(requestId, "visible", job));
      await app.waitFor("scope_done", port);
      const event = port.sent.find((row) => row.type === "translation" && row.request_id === requestId);

      if (action === "disconnect") {
        port.disconnect();
      } else {
        const replacementId = `${requestId}-replacement`;
        port.receive(app.startScope(replacementId, "visible", null, requestId));
        await waitUntil(
          () => port.sent.some((row) => row.type === "scope_done" && row.request_id === replacementId),
          "collector superseding scope completion"
        );
      }
      port.receive({
        type: "render_metric",
        request_id: requestId,
        job_id: jobId,
        page_artifact_key: event.page_artifact_key,
        render_artifact_key: event.render_artifact_key,
        layout_fit_version: event.layout_fit_version,
        block_id: event.block_id,
        painted: true,
        reason: null,
        layout_profile: { font_px: 16, line_height: 1.2 },
      });
      await flush();
      assert.strictEqual(app.page(keys.pageArtifactKey).render, undefined);
      assert.strictEqual(vm.runInContext("renderOutcomeCollectors.size", app.context), 0);
    }
  });

  await scenario("incomplete render collectors stay bounded", async () => {
    const app = createBackgroundApp();
    await app.ready();
    const bounded = vm.runInContext(`
      for (let index = 0; index < 129; index++) {
        prepareRenderOutcomeCollector(
          { page_artifact_key: "bounded-page-" + index, render_artifact_key: "bounded-render-" + index, manifest_ids: ["b" + index] },
          {
            render_artifact_key: "bounded-render-" + index,
            blocks: [{
              block_id: "b" + index, patch_id: "patch-" + index, patch_bbox: [1, 2, 3, 4],
              fit_bbox: [1, 2, 3, 4], reason: null,
            }],
          },
          [{ requestId: "bounded-request-" + index, jobId: "bounded-job-" + index, port: {} }]
        );
      }
      ({
        size: renderOutcomeCollectors.size,
        firstRetained: renderOutcomeCollectors.has(renderOutcomeKey("bounded-page-0", "bounded-render-0", LAYOUT_FIT_VERSION)),
      })
    `, app.context);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(bounded)), { size: 128, firstRetained: false });
  });

  await scenario("manifest recovery isolates itself from a shared OCR stage", async () => {
    const app = createBackgroundApp();
    await app.ready();
    const recovered = vm.runInContext(`
      const shared = {
        key: "shared-ocr", consumers: new Map([["recovering", {}], ["peer", {}]]),
        controller: new AbortController(), promise: null, ocrDone: true, blocks: new Map(), blockErrors: [],
      };
      ocrStages.set("shared-ocr", shared);
      const producer = {
        pageKey: "recovering", ocrKey: "shared-ocr", analysisKey: "shared-analysis",
        page: { state: "complete", analysis_known: true, ocr_done: true, image_w: 100, image_h: 200, blocks: [], manifest_ids: ["old"] },
        ocrStage: shared, analysisStage: null, translationReady: Promise.resolve(), renderReady: Promise.resolve(),
        renderArtifact: {}, cancelled: true,
      };
      resetProducerForManifestRecovery(producer);
      const recoveryStage = attachStage(ocrStages, producer.ocrStageKey || producer.ocrKey, producer);
      ({
        originalRetained: ocrStages.get("shared-ocr") === shared,
        peerRetained: shared.consumers.has("peer"),
        recoveryIsDistinct: recoveryStage !== shared,
      })
    `, app.context);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(recovered)), {
      originalRetained: true,
      peerRetained: true,
      recoveryIsDistinct: true,
    });
  });

  await scenario("every OCR stream carries the exact render key built from fetched bytes", async () => {
    // Mutation caught: omitting render_artifact_key or deriving it from translation identity.
    const server = createFakeServer();
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("render-key-job", "https://x/render-key.jpg");
    const expected = await app.keysFor({ ...job, reading_direction: "rtl" });
    const port = app.connect();
    port.receive(app.startScope("render-key", "visible", job));
    await app.waitFor("scope_done", port);

    assert.strictEqual(server.ocrForms.length, 1);
    assert.strictEqual(server.ocrForms[0].get("render_artifact_key"), expected.renderArtifactKey);
    assert.strictEqual(await server.ocrForms[0].get("image").text(), job.source_url);
    assert.strictEqual(server.counts.source, 1);
    const stored = app.page(expected.pageArtifactKey);
    assert.strictEqual(stored.source_content_hash, sourceIdentityFor(job.source_url).sourceContentHash);
    assert.strictEqual(stored.render_artifact_key, expected.renderArtifactKey);
    assert.deepStrictEqual(stored.patch_versions, server.patchVersions);
  });

  await scenario("render and translation join in either order and warm replay is one key call", async () => {
    const server = createFakeServer();
    server.holdTranslation("vi");
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("join-job", "https://x/render-join.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const first = app.connect();
    first.receive(app.startScope("join-first", "visible", job));
    await waitUntil(() => server.counts.translate === 1, "render-ready translation request");
    assert.strictEqual(first.sent.some((event) => event.type === "translation"), false);
    server.releaseTranslation("vi");
    await app.waitFor("scope_done", first);
    const coldEvent = first.sent.find((event) => event.type === "translation");
    assert.deepStrictEqual(
      {
        patch_id: coldEvent.patch_id,
        patch_rgba: coldEvent.patch_rgba,
        patch_mime: coldEvent.patch_mime,
        patch_bbox: coldEvent.patch_bbox,
        fit_bbox: coldEvent.fit_bbox,
        vertical: coldEvent.vertical,
        text: coldEvent.text,
        layout_fit_version: coldEvent.layout_fit_version,
        layout_hint: coldEvent.layout_hint,
      },
      {
        patch_id: "patch-b1",
        patch_rgba: Buffer.from("patch:b1").toString("base64"),
        patch_mime: "image/png",
        patch_bbox: [1, 2, 3, 4],
        fit_bbox: [1, 2, 3, 4],
        vertical: false,
        text: "vi:こんにちは",
        layout_fit_version: "dom-fit-10px-v1",
        layout_hint: null,
      }
    );

    app.page(keys.pageArtifactKey).render = {
      schema_version: "render-page-v1",
      render_artifact_key: keys.renderArtifactKey,
      patch_versions: server.patchVersions,
      layout_fit_version: "dom-fit-10px-v1",
      breaker_open: false,
      blocks: [{
        block_id: "b1",
        render_mode: "in_place",
        patch_id: "patch-b1",
        patch_bbox: [1, 2, 3, 4],
        fit_bbox: [1, 2, 3, 4],
        layout_profile: { font_px: 16, line_height: 1.2 },
        reason: null,
      }],
    };
    const beforeWarm = structuredClone(server.counts);
    server.holdRender("render-join");
    const warm = app.connect();
    warm.receive(app.startScope("join-warm", "visible", app.job("join-warm-job", job.source_url)));
    await waitUntil(() => server.counts.renderKey === beforeWarm.renderKey + 1, "warm render key call");
    assert.strictEqual(server.counts.translate, beforeWarm.translate);
    assert.strictEqual(warm.sent.some((event) => event.type === "translation"), false);
    server.releaseRender("render-join");
    const warmDone = await app.waitFor("scope_done", warm);
    assert.strictEqual(warmDone.cache_hit, true);
    assert.strictEqual(server.counts.renderBlob, beforeWarm.renderBlob);
    const warmEvent = warm.sent.find((event) => event.type === "translation");
    assert.deepStrictEqual(warmEvent.layout_hint, { font_px: 16, line_height: 1.2 });
  });

  await scenario("render artifact retries exactly once with source bytes on artifact_missing", async () => {
    const server = createFakeServer();
    server.missRenderKey("render-retry");
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("render-retry-job", "https://x/render-retry.jpg", {
      crop: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 },
    });
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const port = app.connect();
    port.receive(app.startScope("render-retry", "visible", job));
    await app.waitFor("scope_done", port);
    assert.deepStrictEqual(
      { render: server.counts.render, key: server.counts.renderKey, blob: server.counts.renderBlob },
      { render: 2, key: 1, blob: 1 }
    );
    assert.strictEqual(server.renderForms[0].get("image"), null);
    assert.strictEqual(await server.renderForms[1].get("image").text(), "https://x/render-retry.jpg");
    for (const form of server.renderForms) {
      assert.strictEqual(form.get("analysis_key"), keys.analysisKey);
      assert.strictEqual(form.get("render_artifact_key"), keys.renderArtifactKey);
      assert.strictEqual(form.get("source_content_hash"), sourceIdentityFor(job.source_url).sourceContentHash);
      assert.deepStrictEqual(
        ["left", "top", "right", "bottom"].map((name) => Number(form.get(`crop_${name}`))),
        [0.1, 0.2, 0.9, 0.8]
      );
    }
  });

  await scenario("strict SFX rows persist but never enter the manifest or event stream", async () => {
    const server = createFakeServer();
    server.setOcrRows("mixed-kind", [
      { type: "analysis_ready", image_w: 300, image_h: 500 },
      { type: "ocr_block", block_id: "text", bbox: [200, 10, 20, 20], src_text: "hello", vertical: false },
      { type: "ocr_block", block_id: "sfx", bbox: [10, 10, 20, 20], src_text: "boom", vertical: true },
      { type: "image_done", recognized: 2, failed: 0 },
    ]);
    server.queueTranslationResult({ items: [
      { id: "text", kind: "text", translation: "xin chao" },
      { id: "sfx", kind: "sfx", translation: null },
    ] });
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("mixed-kind-job", "https://x/mixed-kind.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const port = app.connect();
    port.receive(app.startScope("mixed-kind", "visible", job));
    await app.waitFor("scope_done", port);
    const page = app.page(keys.pageArtifactKey);
    assert.deepStrictEqual(page.manifest_ids, ["text"]);
    assert.deepStrictEqual(
      page.blocks.map((block) => ({ id: block.block_id, kind: block.kind, trans_text: block.trans_text })),
      [{ id: "text", kind: "text", trans_text: "xin chao" }, { id: "sfx", kind: "sfx", trans_text: null }]
    );
    assert.deepStrictEqual(port.sent.filter((event) => event.type === "translation").map((event) => event.block_id), ["text"]);
  });

  await scenario("all-SFX and capability-skip pages persist translations without render events", async () => {
    const sfxServer = createFakeServer();
    sfxServer.setOcrRows("all-sfx", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      { type: "ocr_block", block_id: "only-sfx", bbox: [1, 2, 3, 4], src_text: "boom" },
      { type: "image_done", recognized: 1, failed: 0 },
    ]);
    sfxServer.queueTranslationResult({ items: [{ id: "only-sfx", kind: "sfx", translation: null }] });
    const sfxApp = createBackgroundApp({ server: sfxServer });
    await sfxApp.ready();
    const sfxJob = sfxApp.job("all-sfx-job", "https://x/all-sfx.jpg");
    const sfxKeys = await sfxApp.keysFor({ ...sfxJob, reading_direction: "rtl" });
    const sfxPort = sfxApp.connect();
    sfxPort.receive(sfxApp.startScope("all-sfx", "visible", sfxJob));
    await sfxApp.waitFor("scope_done", sfxPort);
    assert.deepStrictEqual(sfxApp.page(sfxKeys.pageArtifactKey).manifest_ids, []);
    assert.strictEqual(sfxPort.sent.some((event) => event.type === "translation"), false);

    const skipServer = createFakeServer();
    skipServer.setRenderRows("capability-skip", [{
      block_id: "b1", patch_id: null, patch_bbox: null, clean_region: null,
      fit_bbox: null, patch_mime: null, patch_rgba: null, reason: "clean_failed",
    }]);
    const skipApp = createBackgroundApp({ server: skipServer });
    await skipApp.ready();
    const skipJob = skipApp.job("capability-skip-job", "https://x/capability-skip.jpg");
    const skipKeys = await skipApp.keysFor({ ...skipJob, reading_direction: "rtl" });
    const skipPort = skipApp.connect();
    skipPort.receive(skipApp.startScope("capability-skip", "visible", skipJob));
    await skipApp.waitFor("scope_done", skipPort);
    const skipped = skipApp.page(skipKeys.pageArtifactKey);
    assert.deepStrictEqual(skipped.manifest_ids, ["b1"]);
    assert.strictEqual(skipped.blocks[0].trans_text, "vi:こんにちは");
    assert.strictEqual(skipPort.sent.some((event) => event.type === "translation"), false);
  });

  await scenario("capability and content fit failures persist only a full canonical skip manifest", async () => {
    const server = createFakeServer();
    server.setOcrRows("mixed-render-skips", [
      { type: "analysis_ready", image_w: 300, image_h: 500 },
      { type: "ocr_block", block_id: "left", bbox: [10, 10, 20, 20], src_text: "left" },
      { type: "ocr_block", block_id: "invalid", bbox: [100, 10, 20, 20], src_text: "invalid" },
      { type: "ocr_block", block_id: "right", bbox: [200, 10, 20, 20], src_text: "right" },
      { type: "image_done", recognized: 3, failed: 0 },
    ]);
    server.setRenderRows("mixed-render-skips", [
      {
        block_id: "left", patch_id: null, patch_bbox: null, clean_region: null,
        fit_bbox: null, patch_mime: null, patch_rgba: null, reason: "clean_failed",
      },
      {
        block_id: "invalid", patch_id: "patch-invalid", patch_bbox: [100, 10, 0, 20], clean_region: [100, 10, 20, 20],
        fit_bbox: [100, 10, 20, 20], patch_mime: "image/png", patch_rgba: Buffer.from("patch:invalid").toString("base64"), reason: null,
      },
      {
        block_id: "right", patch_id: "patch-right", patch_bbox: [200, 10, 20, 20], clean_region: [200, 10, 20, 20],
        fit_bbox: [200, 10, 20, 20], patch_mime: "image/png", patch_rgba: Buffer.from("patch:right").toString("base64"), reason: null,
      },
    ]);
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("mixed-render-skips-job", "https://x/mixed-render-skips.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const port = app.connect();
    port.receive(app.startScope("mixed-render-skips", "visible", job));
    await app.waitFor("scope_done", port);

    const event = port.sent.find((row) => row.type === "translation");
    assert.strictEqual(event.block_id, "right");
    assert.strictEqual(app.page(keys.pageArtifactKey).render, undefined);
    port.receive({
      type: "render_metric",
      request_id: "mixed-render-skips",
      job_id: "mixed-render-skips-job",
      page_artifact_key: event.page_artifact_key,
      render_artifact_key: event.render_artifact_key,
      layout_fit_version: event.layout_fit_version,
      block_id: "right",
      painted: false,
      reason: "fit_failed",
      layout_profile: null,
    });
    await waitUntil(() => app.page(keys.pageArtifactKey).render !== undefined, "full canonical skip render");
    assert.deepStrictEqual(app.page(keys.pageArtifactKey).render.blocks, [
      {
        block_id: "right", render_mode: "skip", patch_id: null, patch_bbox: null,
        fit_bbox: [200, 10, 20, 20], layout_profile: null, reason: "fit_failed",
      },
      {
        block_id: "invalid", render_mode: "skip", patch_id: null, patch_bbox: null,
        fit_bbox: [100, 10, 20, 20], layout_profile: null, reason: "layout_failed",
      },
      {
        block_id: "left", render_mode: "skip", patch_id: null, patch_bbox: null,
        fit_bbox: null, layout_profile: null, reason: "clean_failed",
      },
    ]);
  });

  await scenario("fast render rejection cancels translation still blocked in key hashing", async () => {
    const server = createFakeServer();
    const barrier = translationKeyDigestBarrier();
    server.failRender("fast-render-rejection");
    const app = createBackgroundApp({ server, cryptoImpl: barrier.crypto });
    await app.ready();
    const job = app.job("fast-render-rejection-job", "https://x/fast-render-rejection.jpg");
    const port = app.connect();
    port.receive(app.startScope("fast-render-rejection", "visible", job));
    await barrier.entered;
    await app.waitFor("scope_done", port);
    assert.strictEqual(server.counts.translate, 0);
    barrier.release();
    await flush();
    assert.strictEqual(server.counts.translate, 0);
    assert.strictEqual(app.hotTranslationCount(), 0);
    assert.strictEqual(port.sent.some((event) => event.type === "translation" || event.type === "block_error"), false);
  });

  await scenario("slow render rejection quarantines a late translation response", async () => {
    const server = createFakeServer();
    server.failRender("slow-render-rejection");
    server.holdRender("slow-render-rejection");
    server.holdTranslation("vi");
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("slow-render-rejection-job", "https://x/slow-render-rejection.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const port = app.connect();
    port.receive(app.startScope("slow-render-rejection", "visible", job));
    await waitUntil(() => server.counts.translate === 1, "held translation request before render rejection");
    const producer = app.producer(keys.pageArtifactKey);
    assert.ok(producer);
    assert.strictEqual(port.sent.some((event) => event.type === "scope_done"), false);
    server.releaseRender("slow-render-rejection");
    await app.waitFor("scope_done", port);
    const terminalPage = JSON.parse(JSON.stringify(producer.page));
    const terminalEvents = structuredClone(port.sent);
    assert.strictEqual(app.hotTranslationCount(), 0);
    server.releaseTranslation("vi");
    await flush();
    assert.strictEqual(app.hotTranslationCount(), 0);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(producer.page)), terminalPage);
    assert.deepStrictEqual(port.sent, terminalEvents);
  });

  await scenario("manifest mismatch emits nothing", async () => {
    const mismatchServer = createFakeServer();
    mismatchServer.setRenderRows("manifest-mismatch", []);
    const mismatchApp = createBackgroundApp({ server: mismatchServer });
    await mismatchApp.ready();
    const mismatchJob = mismatchApp.job("manifest-mismatch-job", "https://x/manifest-mismatch.jpg");
    const mismatchKeys = await mismatchApp.keysFor({ ...mismatchJob, reading_direction: "rtl" });
    const mismatchPort = mismatchApp.connect();
    mismatchPort.receive(mismatchApp.startScope("manifest-mismatch", "visible", mismatchJob));
    await mismatchApp.waitFor("scope_done", mismatchPort);
    assert.strictEqual(mismatchPort.sent.some((event) => event.type === "translation"), false);
    const breakerPage = mismatchApp.page(mismatchKeys.pageArtifactKey);
    assert.strictEqual(breakerPage.manifest_mismatch_count, 1);
    assert.strictEqual(breakerPage.ocr_done, true);
    assert.deepStrictEqual(breakerPage.manifest_ids, ["b1"]);
    assert.strictEqual(breakerPage.blocks[0].trans_text.startsWith("vi:"), true);

    const beforeRevisit = structuredClone(mismatchServer.counts);
    const revisit = mismatchApp.connect();
    revisit.receive(mismatchApp.startScope(
      "manifest-mismatch-revisit",
      "visible",
      mismatchApp.job("manifest-mismatch-revisit-job", mismatchJob.source_url),
    ));
    await mismatchApp.waitFor("scope_done", revisit);
    assert.deepStrictEqual(
      {
        render: mismatchServer.counts.render - beforeRevisit.render,
        ocr: mismatchServer.counts.ocr - beforeRevisit.ocr,
        text: mismatchServer.counts.translate - beforeRevisit.translate,
      },
      { render: 0, ocr: 0, text: 0 },
    );
  });

  await scenario("first fresh manifest mismatch claims before one paid recovery and preserves the claim", async () => {
    const storage = fakeStorage();
    const server = createFakeServer();
    const bootstrap = createBackgroundApp({ storage, server });
    await bootstrap.ready();
    const job = bootstrap.job("mismatch-recovery-job", "https://x/mismatch-recovery.jpg");
    const keys = await bootstrap.keysFor({ ...job, reading_direction: "rtl" });
    const pageStorageKey = `mt:page:${keys.pageArtifactKey}`;
    storage.rows[pageStorageKey] = cachedTranslatedPage({ keys, server, job });
    server.primeRender(keys.renderArtifactKey, "mismatch-recovery");
    server.setRenderRows("mismatch-recovery", []);
    server.setOcrRows("mismatch-recovery", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      { type: "ocr_block", block_id: "new", bbox: [5, 6, 7, 8], src_text: "new" },
      { type: "image_done", recognized: 1, failed: 0 },
    ]);
    server.queueTranslationResult({ items: [{ id: "new", kind: "text", translation: "vi:new" }] });
    let recoverySnapshot = null;
    server.beforeNextOcr(() => {
      recoverySnapshot = structuredClone(storage.rows[pageStorageKey]);
      server.setRenderRows("mismatch-recovery", [
        {
          block_id: "new", patch_id: "patch-new", patch_bbox: [5, 6, 7, 8], clean_region: [5, 6, 7, 8],
          fit_bbox: [5, 6, 7, 8], patch_mime: "image/png", patch_rgba: Buffer.from("patch:new").toString("base64"), reason: null,
        },
        {
          block_id: "artifact-extra", patch_id: null, patch_bbox: null, clean_region: null,
          fit_bbox: null, patch_mime: null, patch_rgba: null, reason: "unsupported_region",
        },
      ]);
    });

    const app = bootstrap.restart();
    await app.ready();
    const port = app.connect();
    port.receive(app.startScope("mismatch-recovery", "visible", job));
    const done = await app.waitFor("scope_done", port);

    assert.strictEqual(recoverySnapshot?.manifest_mismatch_count, 1, "claim must persist before recovery OCR");
    assert.deepStrictEqual(
      { source: server.counts.source, ocr: server.counts.ocr, text: server.counts.translate, render: server.counts.render },
      { source: 1, ocr: 1, text: 1, render: 2 }
    );
    assert.strictEqual(done.failed, 0);
    assert.deepStrictEqual(port.sent.filter((event) => event.type === "translation").map((event) => event.block_id), ["new"]);
    assert.deepStrictEqual(app.page(keys.pageArtifactKey).manifest_ids, ["new"]);
    assert.strictEqual(app.page(keys.pageArtifactKey).manifest_mismatch_count, 1);

    const recoveryEvent = port.sent.find((event) => event.type === "translation");
    server.setRenderRows("mismatch-recovery", []);
    const beforeRepeat = structuredClone(server.counts);
    const repeat = app.connect();
    repeat.receive(app.startScope("mismatch-repeat", "visible", app.job("mismatch-repeat-job", job.source_url)));
    await app.waitFor("scope_done", repeat);
    assert.deepStrictEqual(app.page(keys.pageArtifactKey).render, {
      schema_version: "render-page-v1",
      render_artifact_key: keys.renderArtifactKey,
      patch_versions: server.patchVersions,
      layout_fit_version: "dom-fit-10px-v1",
      breaker_open: true,
      blocks: [],
    });
    assert.deepStrictEqual(
      {
        render: server.counts.render - beforeRepeat.render,
        ocr: server.counts.ocr - beforeRepeat.ocr,
        text: server.counts.translate - beforeRepeat.translate,
      },
      { render: 1, ocr: 0, text: 0 }
    );

    port.receive({
      type: "render_metric",
      request_id: "mismatch-recovery",
      job_id: "mismatch-recovery-job",
      page_artifact_key: recoveryEvent.page_artifact_key,
      render_artifact_key: recoveryEvent.render_artifact_key,
      layout_fit_version: recoveryEvent.layout_fit_version,
      block_id: recoveryEvent.block_id,
      painted: true,
      reason: null,
      layout_profile: { font_px: 16, line_height: 1.2 },
    });
    await flush();
    assert.strictEqual(app.page(keys.pageArtifactKey).render.breaker_open, true, "late pre-breaker metric must not replace the sentinel");
    assert.strictEqual(vm.runInContext("renderOutcomeCollectors.size", app.context), 0, "durable sentinel must invalidate the old collector");

    const beforeSentinelRevisit = structuredClone(server.counts);
    const sentinelRevisit = app.connect();
    sentinelRevisit.receive(app.startScope("sentinel-revisit", "visible", app.job("sentinel-revisit-job", job.source_url)));
    await app.waitFor("scope_done", sentinelRevisit);
    assert.deepStrictEqual(
      {
        render: server.counts.render - beforeSentinelRevisit.render,
        ocr: server.counts.ocr - beforeSentinelRevisit.ocr,
        text: server.counts.translate - beforeSentinelRevisit.translate,
      },
      { render: 0, ocr: 0, text: 0 }
    );

    const bumpedPatchVersions = { ...server.patchVersions, cleaner: "c2" };
    app.context.__patchVersionsJson = JSON.stringify(bumpedPatchVersions);
    server.setResponsePatchVersions(vm.runInContext("JSON.parse(__patchVersionsJson)", app.context));
    await vm.runInContext("refreshServerVersions(false)", app.context);
    const bumpedKeys = await app.keysFor({ ...job, reading_direction: "rtl" });
    server.primeRender(bumpedKeys.renderArtifactKey, "mismatch-recovery");
    server.setRenderRows("mismatch-recovery", [{
      block_id: "new", patch_id: "patch-new-c2", patch_bbox: [5, 6, 7, 8], clean_region: [5, 6, 7, 8],
      fit_bbox: [5, 6, 7, 8], patch_mime: "image/png", patch_rgba: Buffer.from("patch:new:c2").toString("base64"), reason: null,
    }]);
    const beforePatchRetry = structuredClone(server.counts);
    const patchRetry = app.connect();
    patchRetry.receive(app.startScope("patch-retry", "visible", app.job("patch-retry-job", job.source_url)));
    await app.waitFor("scope_done", patchRetry);
    assert.deepStrictEqual(
      {
        render: server.counts.render - beforePatchRetry.render,
        ocr: server.counts.ocr - beforePatchRetry.ocr,
        text: server.counts.translate - beforePatchRetry.translate,
      },
      { render: 1, ocr: 0, text: 0 }
    );
    assert.deepStrictEqual(patchRetry.sent.filter((event) => event.type === "translation").map((event) => event.block_id), ["new"]);
    assert.strictEqual(app.page(keys.pageArtifactKey).manifest_mismatch_count, 1);
  });

  await scenario("missing and stale renders rebuild without spending the mismatch claim", async () => {
    for (const kind of ["missing", "stale"]) {
      const storage = fakeStorage();
      const server = createFakeServer();
      const bootstrap = createBackgroundApp({ storage, server });
      await bootstrap.ready();
      const job = bootstrap.job(`${kind}-render-job`, `https://x/${kind}-render.jpg`);
      const keys = await bootstrap.keysFor({ ...job, reading_direction: "rtl" });
      const page = cachedTranslatedPage({ keys, server, job });
      if (kind === "stale") {
        page.render = {
          schema_version: "render-page-v1",
          render_artifact_key: keys.renderArtifactKey,
          patch_versions: structuredClone(server.patchVersions),
          layout_fit_version: "dom-fit-old",
          breaker_open: false,
          blocks: [{
            block_id: "old", render_mode: "in_place", patch_id: "old-patch", patch_bbox: [1, 2, 3, 4],
            fit_bbox: [1, 2, 3, 4], layout_profile: { font_px: 16, line_height: 1.2 }, reason: null,
          }],
        };
      }
      storage.rows[`mt:page:${keys.pageArtifactKey}`] = page;
      server.primeRender(keys.renderArtifactKey, `${kind}-render`);
      server.setRenderRows(`${kind}-render`, [{
        block_id: "old", patch_id: "new-patch", patch_bbox: [1, 2, 3, 4], clean_region: [1, 2, 3, 4],
        fit_bbox: [1, 2, 3, 4], patch_mime: "image/png", patch_rgba: Buffer.from("new-patch").toString("base64"), reason: null,
      }]);

      const app = bootstrap.restart();
      await app.ready();
      const port = app.connect();
      port.receive(app.startScope(`${kind}-render`, "visible", job));
      await app.waitFor("scope_done", port);
      assert.deepStrictEqual(
        { render: server.counts.render, ocr: server.counts.ocr, text: server.counts.translate },
        { render: 1, ocr: 0, text: 0 }
      );
      assert.strictEqual(app.page(keys.pageArtifactKey).manifest_mismatch_count, 0);
      assert.deepStrictEqual(port.sent.filter((row) => row.type === "translation").map((row) => row.block_id), ["old"]);
    }
  });

  await scenario("mismatch claim write failure never starts paid recovery", async () => {
    const storage = fakeStorage();
    const server = createFakeServer();
    const bootstrap = createBackgroundApp({ storage, server });
    await bootstrap.ready();
    const job = bootstrap.job("mismatch-write-failure-job", "https://x/mismatch-write-failure.jpg");
    const keys = await bootstrap.keysFor({ ...job, reading_direction: "rtl" });
    storage.rows[`mt:page:${keys.pageArtifactKey}`] = cachedTranslatedPage({ keys, server, job });
    server.primeRender(keys.renderArtifactKey, "mismatch-write-failure");
    server.setRenderRows("mismatch-write-failure", []);
    storage.beforeSet = async (values) => {
      if (Object.values(values).some((row) => row?.schema_version === "page-v2" && row.manifest_mismatch_count === 1)) {
        throw new Error("claim write refused");
      }
    };

    const app = bootstrap.restart();
    await app.ready();
    const port = app.connect();
    port.receive(app.startScope("mismatch-write-failure", "visible", job));
    const done = await app.waitFor("scope_done", port);

    assert.deepStrictEqual(
      { render: server.counts.render, ocr: server.counts.ocr, text: server.counts.translate },
      { render: 1, ocr: 0, text: 0 }
    );
    assert.strictEqual(done.failed, 1);
    assert.strictEqual(port.sent.some((event) => event.type === "translation"), false);
  });

  await scenario("different crops share one retained source fetch", async () => {
    // Mutation caught: deduping the source entry by URL plus crop instead of URL alone.
    const server = createFakeServer();
    server.holdSource("shared-crop");
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    port.receive({
      ...app.startScope("shared-crop", "visible"),
      jobs: [
        app.job("shared-crop-full", "https://x/shared-crop.jpg"),
        app.job("shared-crop-half", "https://x/shared-crop.jpg", {
          crop: { left: 0, top: 0, right: 0.5, bottom: 1 },
        }),
      ],
    });
    await waitUntil(() => server.counts.source === 1, "one shared source fetch");
    server.releaseSource("shared-crop");
    const done = await app.waitFor("scope_done", port);
    assert.deepStrictEqual({ images: done.images, failed: done.failed }, { images: 2, failed: 0 });
    assert.strictEqual(server.counts.source, 1);
  });

  await scenario("late consumer replays a completed in-flight page before persistence", async () => {
    const storage = fakeStorage();
    const releaseCompleteWrite = deferred();
    let completeWriteHeld = false;
    storage.beforeSet = async (values) => {
      if (completeWriteHeld || !Object.values(values).some((row) => row?.schema_version === "page-v2" && row.state === "complete")) return;
      completeWriteHeld = true;
      await releaseCompleteWrite.promise;
    };
    const app = createBackgroundApp({ storage });
    await app.ready();
    const source = "https://x/late-replay.jpg";
    const first = app.connect();
    first.receive(app.startScope("late-replay-first", "visible", app.job("late-replay-first-job", source)));
    await waitUntil(() => completeWriteHeld, "held complete-page persistence");

    const late = app.connect();
    late.receive(app.startScope("late-replay-second", "visible", app.job("late-replay-second-job", source)));
    await app.waitFor("page_job_accepted", late);
    try {
      assert.deepStrictEqual(
        late.sent.filter((event) => event.type === "translation").map((event) => event.block_id),
        ["b1"]
      );
    } finally {
      releaseCompleteWrite.resolve();
    }
    const done = await app.waitFor("scope_done", late);
    assert.deepStrictEqual({ translated: done.translated, failed: done.failed, cache_hit: done.cache_hit }, { translated: 1, failed: 0, cache_hit: false });
  });

  await scenario("late consumers during terminal cleanup retry without stale stages", async () => {
    for (const fixture of [
      {
        name: "partial",
        source: "https://x/cleanup-partial.jpg",
        rows: [
          { type: "analysis_ready", image_w: 100, image_h: 200 },
          { type: "ocr_block", block_id: "good", bbox: [1, 2, 3, 4], src_text: "good" },
          { type: "ocr_block_error", block_id: "bad", code: "recognition_failed" },
          { type: "image_done", recognized: 1, failed: 1 },
        ],
        expected: { translated: 1, failed: 1 },
        lateExpected: { translated: 1, failed: 0 },
        sourceCalls: 2,
      },
      {
        name: "failed",
        source: "https://x/cleanup-failed.jpg",
        rows: [
          { type: "analysis_ready" },
          { type: "image_done", recognized: 0, failed: 0 },
        ],
        expected: { translated: 0, failed: 1 },
        lateExpected: { translated: 0, failed: 1 },
        sourceCalls: 2,
      },
      {
        name: "pre-ocr-failed",
        source: "https://x/cleanup-pre-ocr-failed.jpg",
        failSourceInitially: true,
        expected: { translated: 0, failed: 1 },
        lateExpected: { translated: 1, failed: 0 },
        sourceCalls: 2,
        ocrCalls: 1,
        translationCalls: 1,
      },
    ]) {
      const storage = fakeStorage();
      const releaseRemove = deferred();
      let removeHeld = false;
      storage.beforeRemove = async () => {
        removeHeld = true;
        await releaseRemove.promise;
      };
      const server = createFakeServer();
      if (fixture.rows) server.setOcrRows(`cleanup-${fixture.name}`, fixture.rows);
      if (fixture.failSourceInitially) server.failSource(`cleanup-${fixture.name}`);
      const app = createBackgroundApp({ storage, server });
      await app.ready();

      const first = app.connect();
      first.receive(app.startScope(`cleanup-${fixture.name}-first`, "visible", app.job(`cleanup-${fixture.name}-first-job`, fixture.source)));
      const firstDone = await app.waitFor("scope_done", first);
      assert.deepStrictEqual({ translated: firstDone.translated, failed: firstDone.failed }, fixture.expected);
      if (fixture.failSourceInitially) server.allowSource(`cleanup-${fixture.name}`);
      await waitUntil(() => removeHeld, `${fixture.name} producer cleanup removal`);

      const late = app.connect();
      late.receive(app.startScope(`cleanup-${fixture.name}-late`, "visible", app.job(`cleanup-${fixture.name}-late-job`, fixture.source)));
      await app.waitFor("page_job_accepted", late);
      releaseRemove.resolve();
      const done = await app.waitFor("scope_done", late);
      assert.ok(late.sent.some((event) => event.type === "image_done"));
      assert.deepStrictEqual({ translated: done.translated, failed: done.failed }, fixture.lateExpected);
      assert.strictEqual(server.counts.source, fixture.sourceCalls);
      if (fixture.ocrCalls !== undefined) assert.strictEqual(server.counts.ocr, fixture.ocrCalls);
      if (fixture.translationCalls !== undefined) assert.strictEqual(server.counts.translate, fixture.translationCalls);
    }
  });

  await scenario("A continues after disconnect and exact return only rehashes source", async () => {
    const server = createFakeServer();
    server.holdSource("detached");
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("detached-job", "https://x/detached.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const first = app.connect();
    first.receive(app.startScope("detached-request", "visible", job));
    await waitUntil(() => server.counts.source === 1, "detached source fetch");
    first.disconnect();
    server.releaseSource("detached");
    await waitUntil(() => app.page(keys.pageArtifactKey)?.state === "complete", "detached page completion");
    await waitUntil(() => app.storedJob("detached-job") === undefined, "detached ledger cleanup");
    const calls = structuredClone(server.counts);

    const back = app.connect();
    back.receive(app.startScope("return-request", "visible", app.job("return-job", "https://x/detached.jpg")));
    const done = await app.waitFor("scope_done", back);
    assert.strictEqual(done.cache_hit, true);
    assert.strictEqual(done.page_metrics.length, 1);
    assert.strictEqual(done.page_metrics[0].job_id, "return-job");
    assert.strictEqual(done.page_metrics[0].cache_hit, true);
    assert.ok(done.page_metrics[0].page_artifact_key);
    assert.strictEqual(done.page_metrics[0].fetch_ms, null);
    assert.strictEqual(done.page_metrics[0].first_overlay_ms, null);
    assert.strictEqual(done.page_metrics[0].accepted_offset_ms, null);
    assert.strictEqual(done.page_metrics[0].recognized, 1);
    assert.strictEqual(done.page_metrics[0].failed, 0);
    const replayed = back.sent.find((event) => event.type === "translation" && event.cache_hit);
    assert.deepStrictEqual(
      { image_w: replayed.image_w, image_h: replayed.image_h },
      { image_w: 100, image_h: 200 }
    );
    // Mutation caught: retaining a settled source entry after the producer's
    // final release would make this revisit skip the required byte hash fetch.
    assert.deepStrictEqual({ ...server.counts, source: calls.source, render: calls.render, renderKey: calls.renderKey }, calls);
    assert.strictEqual(server.counts.source, calls.source + 1);
    assert.strictEqual(server.counts.render, calls.render + 1);
    assert.strictEqual(server.counts.renderKey, calls.renderKey + 1);
    assert.strictEqual(server.counts.renderBlob, calls.renderBlob);
  });

  await scenario("loaded disconnect aborts active and queued work and leaves no storage", async () => {
    const server = createFakeServer();
    server.holdSource("loaded-a");
    server.holdSource("loaded-b");
    const app = createBackgroundApp({ server });
    await app.ready();
    const loaded = app.connect();
    loaded.receive({
      ...app.startScope("loaded-request", "loaded"),
      jobs: [
        app.job("loaded-a", "https://x/loaded-a.jpg"),
        app.job("loaded-b", "https://x/loaded-b.jpg"),
        app.job("loaded-queued", "https://x/loaded-queued.jpg"),
      ],
    });
    await waitUntil(() => server.counts.source === 2, "loaded source fetches");
    loaded.disconnect();
    await flush();
    assert.strictEqual(server.counts.aborted, 2);
    assert.strictEqual(server.counts.source, 2);
    assert.deepStrictEqual(Object.keys(app.storage.rows).filter((key) => key.startsWith("mt:")), []);
  });

  await scenario("loaded disconnect after an OCR block remains memory-only", async () => {
    const server = createFakeServer();
    server.setOcrRows("loaded-late", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      { type: "ocr_block", block_id: "early", bbox: [1, 2, 3, 4], src_text: "early" },
      { type: "ocr_block", block_id: "late", bbox: [5, 6, 7, 8], src_text: "late" },
      { type: "image_done", recognized: 2, failed: 0 },
    ]);
    server.holdOcrAfterFirst("loaded-late");
    const app = createBackgroundApp({ server });
    await app.ready();
    const loaded = app.connect();
    loaded.receive(app.startScope("loaded-late", "loaded", app.job("loaded-late-job", "https://x/loaded-late.jpg")));
    await waitUntil(
      () => vm.runInContext("[...producers.values()].some((producer) => producer.page.blocks.length === 1)", app.context),
      "loaded first OCR block"
    );
    loaded.disconnect();
    server.releaseOcr("loaded-late");
    await waitUntil(() => app.debug().producers === 0, "loaded late cleanup");
    await flush();
    assert.deepStrictEqual(Object.keys(app.storage.rows).filter((key) => key.startsWith("mt:")), []);
  });

  await scenario("offline waits for explicit health and cache full is visible", async () => {
    const offlineServer = createFakeServer();
    offlineServer.setOnline(false);
    const offline = createBackgroundApp({ server: offlineServer });
    await offline.ready();
    const port = offline.connect();
    port.receive(offline.startScope("offline", "visible", offline.job("offline-job", "https://x/offline.jpg")));
    await waitUntil(() => offline.storedJob("offline-job")?.waiting_for_health === true, "offline ledger");
    await flush(20);
    // Mutation caught: deferring source acquisition until server health returns
    // breaks eager URL dedupe/hash work and forces resume to fetch again.
    assert.deepStrictEqual(
      { health: offlineServer.counts.health, source: offlineServer.counts.source },
      { health: 2, source: 1 }
    );
    offlineServer.setOnline(true);
    assert.strictEqual((await offline.message({ type: "health" })).ok, true);
    const done = await offline.waitFor("scope_done", port);
    assert.deepStrictEqual(
      { health: offlineServer.counts.health, source: offlineServer.counts.source },
      { health: 3, source: 1 }
    );
    assert.deepStrictEqual({ translated: done.translated, failed: done.failed }, { translated: 1, failed: 0 });

    const fullStorage = fakeStorage();
    const full = createBackgroundApp({ storage: fullStorage });
    await full.ready();
    fullStorage.failWrites = true;
    const fullPort = full.connect();
    fullPort.receive(full.startScope("full", "visible", full.job("full-job", "https://x/full.jpg")));
    const error = await full.waitFor("job_error", fullPort);
    assert.strictEqual(error.code, "cache_full");
    const fullDone = await full.waitFor("scope_done", fullPort);
    assert.strictEqual(fullDone.failed, 1);
    assert.strictEqual(fullDone.page_metrics.length, 1);
    assert.deepStrictEqual(
      { cache_hit: fullDone.page_metrics[0].cache_hit, error_code: fullDone.page_metrics[0].error_code, page_artifact_key: fullDone.page_metrics[0].page_artifact_key, fetch_ms: fullDone.page_metrics[0].fetch_ms, accepted_offset_ms: fullDone.page_metrics[0].accepted_offset_ms },
      { cache_hit: false, error_code: "cache_full", page_artifact_key: null, fetch_ms: null, accepted_offset_ms: null }
    );

    const loadedServer = createFakeServer();
    loadedServer.setOnline(false);
    const loaded = createBackgroundApp({ server: loadedServer });
    await loaded.ready();
    const loadedPort = loaded.connect();
    loadedPort.receive(loaded.startScope("offline-loaded", "loaded", loaded.job("offline-loaded-job", "https://x/offline-loaded.jpg")));
    await waitUntil(() => loaded.debug().offline === 1, "offline loaded queue");
    loadedPort.disconnect();
    await flush();
    assert.strictEqual(loaded.debug().offline, 0);
    assert.deepStrictEqual(Object.keys(loaded.storage.rows).filter((key) => key.startsWith("mt:")), []);
  });

  await scenario("restored legacy ledger defaults direction before keys and repersist", async () => {
    const descriptor = {
      job_id: "legacy-direction-job",
      source_url: "https://x/legacy-direction.jpg",
      crop: null,
      natural_width: 100,
      natural_height: 200,
      priority: 0,
      distance: 0,
      src_lang: "ja",
      dst_lang: "vi",
      scope: "visible",
    };
    const storage = fakeStorage({
      "mt:job:legacy-direction-job": {
        job_id: descriptor.job_id,
        request_id: "legacy-direction-request",
        scope: "visible",
        src_lang: "ja",
        dst_lang: "vi",
        descriptor,
        state: "queued",
        created_at: 1,
      },
    });
    const server = createFakeServer();
    server.holdSource("legacy-direction");
    server.holdOcrAfterFirst("legacy-direction");
    const app = createBackgroundApp({ storage, server });
    // Mutation caught: awaiting restored source bytes inside global readiness
    // blocks every new worker request while one old image fetch is slow.
    await app.ready();
    await waitUntil(() => server.counts.source === 1, "legacy direction source fetch");
    server.releaseSource("legacy-direction");
    await waitUntil(() => app.storedJob(descriptor.job_id)?.page_artifact_key, "legacy direction repersist");
    const stored = app.storedJob(descriptor.job_id);
    const expected = await app.keysFor({ ...descriptor, reading_direction: "rtl" });
    assert.strictEqual(stored.descriptor.reading_direction, "rtl");
    assert.strictEqual(stored.page_artifact_key, expected.pageArtifactKey);
    server.releaseOcr("legacy-direction");
    await waitUntil(() => app.storedJob(descriptor.job_id) === undefined, "legacy direction completion");
  });

  await scenario("corrupt restored direction is removed without duplicating valid jobs", async () => {
    function restoredLedger(jobId, readingDirection) {
      const descriptor = {
        job_id: jobId,
        source_url: `https://x/${jobId}.jpg`,
        crop: null,
        natural_width: 100,
        natural_height: 200,
        priority: 0,
        distance: 0,
        src_lang: "ja",
        dst_lang: "vi",
        reading_direction: readingDirection,
        scope: "visible",
      };
      return {
        job_id: jobId,
        request_id: `${jobId}-request`,
        scope: "visible",
        src_lang: "ja",
        dst_lang: "vi",
        descriptor,
        state: "queued",
        created_at: 1,
      };
    }

    for (const initialOnline of [true, false]) {
      const prefix = initialOnline ? "main" : "fallback";
      const validIds = [`${prefix}-rtl`, `${prefix}-ltr`];
      const corruptId = `${prefix}-vertical`;
      const storage = fakeStorage(Object.fromEntries([
        [validIds[0], "rtl"],
        [corruptId, "vertical"],
        [validIds[1], "ltr"],
      ].map(([jobId, direction]) => [`mt:job:${jobId}`, restoredLedger(jobId, direction)])));
      const server = createFakeServer();
      server.setOnline(initialOnline);
      const app = createBackgroundApp({ storage, server });

      await app.ready();
      await waitUntil(() => app.storedJob(corruptId) === undefined, `${prefix} corrupt job removal`);
      if (!initialOnline) {
        server.setOnline(true);
        assert.strictEqual((await app.message({ type: "health" })).ok, true);
      }
      await waitUntil(
        () => validIds.every((jobId) => app.storedJob(jobId) === undefined),
        `${prefix} valid job completion`,
      );
      assert.strictEqual(server.counts.source, 2);
    }
  });

  await scenario("prewarm performs OCR only at prewarm priority without persistence", async () => {
    const app = createBackgroundApp();
    await app.ready();
    const job = app.job("prewarm-job", "https://x/prewarm.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    app.server.holdSource("prewarm");
    const responsePromise = app.message({
      type: "prewarmJob",
      src_lang: "ja",
      dst_lang: "vi",
      job,
    });
    // Mutation caught: leaving the runtime prewarm caller on the old
    // attachDescriptor signature skips source acquisition/hash entirely.
    await waitUntil(() => app.server.counts.source === 1, "prewarm source identity");
    assert.strictEqual(app.debug().producers, 0);
    app.server.releaseSource("prewarm");
    const response = await responsePromise;
    assert.strictEqual(response.ok, true);
    app.context.__prewarmKey = keys.pageArtifactKey;
    assert.strictEqual(vm.runInContext("producers.get(__prewarmKey).descriptor.reading_direction", app.context), "rtl");
    assert.strictEqual(app.storedJob("prewarm-job"), undefined);
    assert.strictEqual(app.page(keys.pageArtifactKey), undefined);
    await waitUntil(() => app.server.counts.ocr === 1 && app.debug().producers === 0, "prewarm completion");
    assert.deepStrictEqual(
      { source: app.server.counts.source, ocr: app.server.counts.ocr, translate: app.server.counts.translate },
      { source: 1, ocr: 1, translate: 0 }
    );
    assert.strictEqual(app.storedJob("prewarm-job"), undefined);
    assert.strictEqual(app.page(keys.pageArtifactKey), undefined);
    assert.deepStrictEqual(Object.keys(app.storage.rows).filter((key) => key.startsWith("mt:")), []);
    assert.strictEqual(vm.runInContext("requestTier({ connected: true, scope: 'prewarm' })", app.context), 2);
  });

  await scenario("prewarm skips OCR already complete in the persisted session cache", async () => {
    const app = createBackgroundApp();
    await app.ready();
    const job = app.job("visible-job", "https://x/cached-prewarm.jpg");
    const port = app.connect();
    port.receive(app.startScope("visible-request", "visible", job));
    await app.waitFor("scope_done", port);
    const before = structuredClone(app.server.counts);

    const response = await app.message({
      type: "prewarmJob",
      src_lang: "ja",
      job: app.job("prewarm-job", "https://x/cached-prewarm.jpg"),
    });
    assert.strictEqual(response.ok, true);
    await waitUntil(() => app.debug().producers === 0, "cached prewarm completion");
    // Mutation caught: URL-only prewarm lookup would skip hashing the current
    // bytes before deciding that the page artifact is still compatible.
    assert.deepStrictEqual({ ...app.server.counts, source: before.source }, before);
    assert.strictEqual(app.server.counts.source, before.source + 1);
  });

  await scenario("target change reuses a persisted zero-block OCR completion", async () => {
    const server = createFakeServer();
    server.setOcrRows("empty", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      { type: "image_done", recognized: 0, failed: 0 },
    ]);
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("empty-vi-job", "https://x/empty.jpg");
    const vi = app.connect();
    vi.receive(app.startScope("empty-vi", "visible", job));
    const viDone = await app.waitFor("scope_done", vi);
    assert.deepStrictEqual(
      { translated: viDone.translated, failed: viDone.failed },
      { translated: 0, failed: 0 }
    );
    assert.deepStrictEqual(viDone.page_metrics[0].translation_batches, []);
    assert.strictEqual(server.counts.translate, 0);

    const before = structuredClone(server.counts);
    await app.message({
      type: "prewarmJob",
      src_lang: "ja",
      job: app.job("empty-prewarm", "https://x/empty.jpg"),
    });
    const en = app.connect();
    en.receive({ ...app.startScope("empty-en", "visible", app.job("empty-en-job", "https://x/empty.jpg")), dst_lang: "en" });
    const enDone = await app.waitFor("scope_done", en);
    // Mutation caught: prewarm and target-change jobs must each establish the
    // current byte identity even when zero-block OCR itself is reusable.
    assert.deepStrictEqual({ ...server.counts, source: before.source, render: before.render, renderKey: before.renderKey }, before);
    assert.strictEqual(server.counts.source, before.source + 2);
    assert.strictEqual(server.counts.render, before.render + 1);
    assert.strictEqual(server.counts.renderKey, before.renderKey + 1);
    assert.deepStrictEqual(
      { translated: enDone.translated, failed: enDone.failed, cache_hit: enDone.cache_hit },
      { translated: 0, failed: 0, cache_hit: false }
    );
    assert.deepStrictEqual(enDone.page_metrics[0].translation_batches, []);
    assert.deepStrictEqual(structuredClone(app.debug()), { activeTasks: 0, queued: 0, offline: 0, requests: 0, producers: 0 });
  });

  await scenario("all-hot full page emits in order without a request or trace", async () => {
    const server = createFakeServer();
    server.setOcrRows("all-hot", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      { type: "ocr_block", block_id: "left", bbox: [10, 10, 20, 20], src_text: "left" },
      { type: "ocr_block", block_id: "right", bbox: [50, 10, 20, 20], src_text: "right" },
      { type: "image_done", recognized: 2, failed: 0 },
    ]);
    const app = createBackgroundApp({ server });
    await app.ready();
    const source = "https://x/all-hot.jpg";
    const seed = app.connect();
    seed.receive(app.startScope("all-hot-seed", "loaded", app.job("all-hot-seed", source)));
    await app.waitFor("scope_done", seed);
    assert.strictEqual(server.counts.translate, 1);

    const hot = app.connect();
    hot.receive(app.startScope("all-hot", "loaded", app.job("all-hot-job", source)));
    const done = await app.waitFor("scope_done", hot);
    assert.strictEqual(server.counts.translate, 1);
    assert.deepStrictEqual(done.page_metrics[0].translation_batches, []);
    assert.deepStrictEqual(
      hot.sent.filter((event) => event.type === "translation").map((event) => event.block_id),
      ["right", "left"]
    );
  });

  await scenario("detached queued manual work is demoted to background FIFO", async () => {
    const server = createFakeServer();
    server.holdOcrAfterFirst("slot-a");
    server.holdOcrAfterFirst("slot-b");
    const app = createBackgroundApp({ server });
    await app.ready();
    const blockers = app.connect();
    blockers.receive({
      ...app.startScope("slot-blockers", "loaded"),
      jobs: [
        app.job("slot-a", "https://x/slot-a.jpg"),
        app.job("slot-b", "https://x/slot-b.jpg"),
      ],
    });
    await waitUntil(() => server.counts.ocr === 2, "occupied producer slots");
    const manual = app.connect();
    manual.receive(app.startScope("queued-manual", "visible", app.job("queued-manual-job", "https://x/queued-manual.jpg")));
    // Mutation caught: coupling the source-pool limit to producer slots would
    // prevent this third identity from reaching the foreground task queue.
    await app.waitFor("page_job_accepted", manual);
    await waitUntil(
      () => vm.runInContext("taskQueue.some((task) => task.producer?.descriptor.job_id === 'queued-manual-job')", app.context),
      "queued manual producer"
    );
    assert.strictEqual(
      vm.runInContext("taskQueue.find((task) => task.producer?.descriptor.job_id === 'queued-manual-job').tier", app.context),
      0
    );
    manual.disconnect();
    assert.strictEqual(
      vm.runInContext("taskQueue.find((task) => task.producer?.descriptor.job_id === 'queued-manual-job').tier", app.context),
      1
    );
    blockers.disconnect();
    await waitUntil(() => server.counts.ocr === 3, "detached manual OCR");
    assert.strictEqual(server.counts.source, 3);
  });

  await scenario("detached A never renders on replacement B", async () => {
    const server = createFakeServer();
    server.holdSource("A");
    const app = createBackgroundApp({ server });
    await app.ready();
    const active = app.connect();
    active.receive(app.startScope("rA", "visible", app.job("jA", "https://x/A.jpg")));
    await waitUntil(() => server.counts.source === 1, "detached A source identity");
    // Mutation caught: cancelling an unmatched visible acquisition during
    // replacement would prevent detached A from completing in background.
    active.receive(app.startScope("rB", "visible", app.job("jB", "https://x/B.jpg"), "rA"));
    await waitUntil(
      () => active.sent.some((event) => event.type === "scope_done" && event.request_id === "rB"),
      "replacement B completion"
    );
    server.releaseSource("A");
    await waitUntil(
      () => server.counts.translate === 2,
      `detached A completion; counts=${JSON.stringify(server.counts)} rows=${JSON.stringify(app.storage.rows)}`
    );
    assert.strictEqual(
      active.sent.some((event) => event.request_id === "rB" && event.job_id === "jA"),
      false
    );
  });

  await scenario("worker restart requeues persisted running job", async () => {
    const storage = fakeStorage();
    const app = createBackgroundApp({ storage });
    await app.ready();
    const descriptor = {
      ...app.job("persisted", "https://x/restart.jpg"),
      src_lang: "ja",
      dst_lang: "vi",
      scope: "visible",
    };
    const keys = await app.keysFor({ ...descriptor, reading_direction: "rtl" });
    const now = Date.now();
    storage.rows[`mt:page:${keys.pageArtifactKey}`] = {
      schema_version: "page-v2",
      page_artifact_key: keys.pageArtifactKey,
      analysis_key: keys.analysisKey,
      ocr_key: keys.ocrKey,
      render_artifact_key: keys.renderArtifactKey,
      source_content_hash: sourceIdentityFor(descriptor.source_url).sourceContentHash,
      source_url: descriptor.source_url,
      crop: "full",
      natural_width: 100,
      natural_height: 200,
      src_lang: "ja",
      dst_lang: "vi",
      reading_direction: "rtl",
      versions: vm.runInContext("serverVersions", app.context),
      patch_versions: app.server.patchVersions,
      state: "running",
      analysis_known: false,
      ocr_done: false,
      image_w: null,
      image_h: null,
      blocks: [],
      manifest_mismatch_count: 0,
      created_at: now,
      updated_at: now,
      last_accessed_at: now,
      last_error: null,
    };
    storage.rows["mt:job:persisted"] = {
      job_id: "persisted",
      request_id: "restored-request",
      scope: "visible",
      src_lang: "ja",
      dst_lang: "vi",
      state: "running",
      created_at: now,
      waiting_for_health: false,
      page_artifact_key: keys.pageArtifactKey,
      descriptor,
    };

    const restarted = app.restart();
    await restarted.ready();
    assert.strictEqual(restarted.storedJob("persisted").state, "queued");
    assert.strictEqual(restarted.page(keys.pageArtifactKey).state, "queued");
    await waitUntil(
      () => restarted.page(keys.pageArtifactKey)?.state === "complete",
      `rehydrated page completion; page=${JSON.stringify(restarted.page(keys.pageArtifactKey))} job=${JSON.stringify(restarted.storedJob("persisted"))} counts=${JSON.stringify(restarted.server.counts)} debug=${JSON.stringify(restarted.debug())}`
    );
    assert.strictEqual(restarted.storedJob("persisted"), undefined);
  });

  await scenario("exact replacement keeps one producer and transfers ownership", async () => {
    const server = createFakeServer();
    server.holdSource("shared");
    const app = createBackgroundApp({ server });
    await app.ready();
    const active = app.connect();
    active.receive(app.startScope("old", "visible", app.job("old-job", "https://x/shared.jpg")));
    await waitUntil(() => server.counts.source === 1, "shared source fetch");
    // Mutation caught: releasing the old final ref before acquiring the exact
    // replacement aborts the shared fetch and starts a second URL request.
    active.receive(app.startScope(
      "new",
      "visible",
      app.job("new-job", "https://x/shared.jpg"),
      "old"
    ));
    await waitUntil(() => app.storedJob("old-job") === undefined, "old ledger removal");
    server.releaseSource("shared");
    await waitUntil(
      () => active.sent.some((event) => event.type === "page_job_accepted" && event.request_id === "new"),
      "replacement acceptance"
    );
    await waitUntil(
      () => active.sent.some((event) => event.type === "scope_done" && event.request_id === "new"),
      "replacement completion"
    );
    assert.deepStrictEqual(
      { source: server.counts.source, ocr: server.counts.ocr, translate: server.counts.translate },
      { source: 1, ocr: 1, translate: 1 }
    );
    assert.strictEqual(
      active.sent.some((event) => event.type === "translation" && event.request_id === "old"),
      false
    );
    assert.ok(active.sent.some((event) => event.type === "translation" && event.request_id === "new"));
    assert.strictEqual(app.storedJob("new-job"), undefined);
  });

  await scenario("exact replacement preserves an in-flight translation batch", async () => {
    const server = createFakeServer();
    server.setOcrRows("exact-pending", [
      { type: "analysis_ready", image_w: 200, image_h: 300 },
      ...[1, 2, 3, 4].map((id) => ({
        type: "ocr_block",
        block_id: `b${id}`,
        bbox: [id * 25, 10, 20, 20],
        src_text: `text-${id}`,
      })),
      { type: "image_done", recognized: 4, failed: 0 },
    ]);
    server.holdTranslation("vi");
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    const source = "https://x/exact-pending.jpg";
    port.receive(app.startScope("pending-old", "visible", app.job("pending-old-job", source)));
    await waitUntil(() => server.counts.translate === 1, "pending exact cloud request");
    port.receive(app.startScope(
      "pending-new",
      "visible",
      app.job("pending-new-job", source),
      "pending-old"
    ));
    await waitUntil(
      () => port.sent.some((event) => event.type === "page_job_accepted" && event.request_id === "pending-new"),
      "pending exact replacement acceptance"
    );
    server.releaseTranslation("vi");
    await waitUntil(
      () => port.sent.some((event) => event.type === "scope_done" && event.request_id === "pending-new"),
      "pending exact replacement completion"
    );
    assert.deepStrictEqual(server.translationBatches, [["b4", "b3", "b2", "b1"]]);
    assert.strictEqual(
      port.sent.some((event) => event.type === "translation" && event.request_id === "pending-old"),
      false
    );
    assert.deepStrictEqual(
      port.sent.filter((event) => event.type === "translation" && event.request_id === "pending-new").map((event) => event.block_id),
      ["b4", "b3", "b2", "b1"]
    );
    assert.strictEqual(app.storedJob("pending-old-job"), undefined);
    assert.strictEqual(app.storedJob("pending-new-job"), undefined);
  });

  await scenario("late shared-stage consumer inherits analysis and OCR timing", async () => {
    const server = createFakeServer();
    server.setOcrRows("shared-timing", [
      { type: "analysis_ready", image_w: 100, image_h: 200, analysis_ms: 17, analysis_cache_hit: true },
      { type: "ocr_block", block_id: "shared-b1", bbox: [1, 2, 3, 4], src_text: "shared" },
      { type: "image_done", recognized: 1, failed: 0 },
    ]);
    server.holdTranslation("vi");
    const app = createBackgroundApp({ server });
    await app.ready();
    const first = app.connect();
    first.receive(app.startScope("shared-timing-first", "loaded", app.job("shared-timing-first-job", "https://x/shared-timing.jpg")));
    await waitUntil(() => server.counts.translate === 1, "first translation held after OCR completion");

    const late = app.connect();
    late.receive({
      ...app.startScope("shared-timing-late", "loaded", app.job("shared-timing-late-job", "https://x/shared-timing.jpg")),
      dst_lang: "en",
    });
    await app.waitFor("page_job_accepted", late);
    server.releaseTranslation("vi");
    const done = await app.waitFor("scope_done", late);
    const row = done.page_metrics[0];
    assert.deepStrictEqual(
      { analysis_ms: row.analysis_ms, analysis_cache_hit: row.analysis_cache_hit, recognized: row.recognized, failed: row.failed },
      { analysis_ms: 17, analysis_cache_hit: true, recognized: 1, failed: 0 }
    );
    assert.ok(Number.isFinite(row.first_ocr_ms));
    assert.ok(Number.isFinite(row.ocr_done_ms));
    assert.ok(row.ocr_done_ms >= row.first_ocr_ms);

    await app.waitFor("scope_done", first);
  });

  await scenario("target and recognizer changes reuse the deepest valid artifact", async () => {
    const app = createBackgroundApp();
    await app.ready();
    const source = "https://x/reuse.jpg";

    const vi = app.connect();
    vi.receive(app.startScope("vi", "visible", app.job("vi-job", source)));
    await app.waitFor("scope_done", vi);
    assert.deepStrictEqual(
      { source: app.server.counts.source, ocr: app.server.counts.ocr, translate: app.server.counts.translate },
      { source: 1, ocr: 1, translate: 1 }
    );

    const en = app.connect();
    en.receive({
      ...app.startScope("en", "visible", app.job("en-job", source)),
      dst_lang: "en",
    });
    await app.waitFor("scope_done", en);
    // Mutation caught: artifact reuse must follow a fresh exact-byte identity,
    // not treat a repeated URL as proof that source content is unchanged.
    assert.deepStrictEqual(
      { source: app.server.counts.source, ocr: app.server.counts.ocr, translate: app.server.counts.translate },
      { source: 2, ocr: 1, translate: 2 }
    );

    const es = app.connect();
    es.receive({
      ...app.startScope("es", "visible", app.job("es-job", source)),
      src_lang: "es",
    });
    await app.waitFor("scope_done", es);
    assert.deepStrictEqual(
      {
        source: app.server.counts.source,
        coldOcr: app.server.counts.coldOcr,
        warmOcr: app.server.counts.warmOcr,
        translate: app.server.counts.translate,
      },
      { source: 3, coldOcr: 1, warmOcr: 1, translate: 3 }
    );

    const back = app.connect();
    back.receive(app.startScope("back", "visible", app.job("back-job", source)));
    await app.waitFor("scope_done", back);
    assert.deepStrictEqual(
      { source: app.server.counts.source, ocr: app.server.counts.ocr, translate: app.server.counts.translate },
      { source: 4, ocr: 2, translate: 3 }
    );
    assert.ok(back.sent.some((event) => event.type === "translation" && event.cache_hit));
  });

  await scenario("partial page requests the complete ordered page without replaying cached blocks", async () => {
    const server = createFakeServer();
    server.setOcrRows("partial", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      { type: "ocr_block", block_id: "b1", bbox: [1, 2, 3, 4], src_text: "one" },
      { type: "ocr_block", block_id: "b2", bbox: [5, 6, 7, 8], src_text: "two" },
      { type: "image_done", recognized: 2, failed: 0 },
    ]);
    server.holdTranslation("vi");
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("partial-job", "https://x/partial.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const now = Date.now();
    app.storage.rows[`mt:page:${keys.pageArtifactKey}`] = {
      schema_version: "page-v2",
      page_artifact_key: keys.pageArtifactKey,
      analysis_key: keys.analysisKey,
      ocr_key: keys.ocrKey,
      render_artifact_key: keys.renderArtifactKey,
      source_content_hash: sourceIdentityFor(job.source_url).sourceContentHash,
      source_url: job.source_url,
      crop: "full",
      natural_width: 100,
      natural_height: 200,
      src_lang: "ja",
      dst_lang: "vi",
      reading_direction: "rtl",
      versions: app.server.versions,
      patch_versions: app.server.patchVersions,
      state: "partial",
      analysis_known: true,
      ocr_done: true,
      image_w: 100,
      image_h: 200,
      blocks: [
        { block_id: "b1", bbox: [1, 2, 3, 4], src_text: "one", trans_text: "vi:one", kind: "text", vertical: false, reading_order: 0, state: "translated" },
        { block_id: "b2", bbox: [5, 6, 7, 8], src_text: "two", trans_text: null, kind: "text", vertical: false, reading_order: 1, state: "ocr_complete" },
      ],
      manifest_mismatch_count: 0,
      created_at: now,
      updated_at: now,
      last_accessed_at: now,
      last_error: "translation_failed",
    };
    const port = app.connect();
    port.receive(app.startScope("partial", "visible", job));
    await waitUntil(() => server.translationBodies.length === 1, "partial full-page request");
    assert.strictEqual(
      port.sent.some((event) => event.type === "translation"),
      false
    );
    assert.deepStrictEqual(
      server.translationBodies[0].items,
      [
        { id: "b1", text: "one", reading_order: 0, bbox: [1, 2, 3, 4] },
        { id: "b2", text: "two", reading_order: 1, bbox: [5, 6, 7, 8] },
      ]
    );
    server.releaseTranslation("vi");
    const done = await app.waitFor("scope_done", port);
    assert.deepStrictEqual(
      port.sent.filter((event) => event.type === "translation").map((event) => event.block_id),
      ["b1", "b2"]
    );
    assert.deepStrictEqual(app.server.translationBatches, [["b1", "b2"]]);
    // Mutation caught: a partial-page reuse still has to prove the source hash
    // before trusting its analysis/OCR identities.
    assert.deepStrictEqual(
      { source: app.server.counts.source, ocr: app.server.counts.ocr },
      { source: 1, ocr: 0 }
    );
    assert.strictEqual(app.page(keys.pageArtifactKey).state, "complete");
    assert.ok(Number.isFinite(done.page_metrics[0].fetch_ms));
    assert.deepStrictEqual(
      { analysis_ms: done.page_metrics[0].analysis_ms, first_ocr_ms: done.page_metrics[0].first_ocr_ms, ocr_done_ms: done.page_metrics[0].ocr_done_ms },
      { analysis_ms: null, first_ocr_ms: null, ocr_done_ms: null }
    );
  });

  await scenario("partial manifest replays before one claimed OCR recovery and retranslates a changed snapshot", async () => {
    const storage = fakeStorage();
    const server = createFakeServer();
    const bootstrap = createBackgroundApp({ storage, server });
    await bootstrap.ready();
    const job = bootstrap.job("ocr-recovery-changed-job", "https://x/ocr-recovery-changed.jpg");
    const keys = await bootstrap.keysFor({ ...job, reading_direction: "rtl" });
    storage.rows[`mt:page:${keys.pageArtifactKey}`] = cachedIncompleteOcrPage({ keys, server, job });
    server.primeRender(keys.renderArtifactKey, "ocr-recovery-changed");
    server.setRenderRows("ocr-recovery-changed", [{
      block_id: "old", patch_id: "patch-old", patch_bbox: [1, 2, 3, 4], clean_region: [1, 2, 3, 4],
      fit_bbox: [1, 2, 3, 4], patch_mime: "image/png", patch_rgba: Buffer.from("patch:old").toString("base64"), reason: null,
    }]);
    server.setOcrRows("ocr-recovery-changed", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      { type: "ocr_block", block_id: "new", bbox: [5, 6, 7, 8], src_text: "new" },
      { type: "image_done", recognized: 1, failed: 0 },
    ]);

    const app = bootstrap.restart();
    await app.ready();
    const port = app.connect();
    let beforeOcr = null;
    server.beforeNextOcr(() => {
      beforeOcr = {
        recovery: structuredClone(storage.rows[`mt:ocr-recovery:${keys.ocrKey}`]),
        jobPresent: storage.rows["mt:job:ocr-recovery-changed-job"] !== undefined,
        events: structuredClone(port.sent),
      };
      server.setRenderRows("ocr-recovery-changed", [{
        block_id: "new", patch_id: "patch-new", patch_bbox: [5, 6, 7, 8], clean_region: [5, 6, 7, 8],
        fit_bbox: [5, 6, 7, 8], patch_mime: "image/png", patch_rgba: Buffer.from("patch:new").toString("base64"), reason: null,
      }]);
    });
    port.receive(app.startScope("ocr-recovery-changed", "visible", job));
    const done = await app.waitFor("scope_done", port);

    assert.deepStrictEqual(beforeOcr?.recovery, { schema_version: "ocr-recovery-v1" });
    assert.strictEqual(beforeOcr?.jobPresent, true);
    assert.deepStrictEqual(
      beforeOcr?.events.filter((event) => event.type === "translation").map((event) => event.block_id),
      ["old"],
    );
    assert.strictEqual(beforeOcr?.events.some((event) => event.type === "image_done"), false);
    assert.deepStrictEqual(
      { ocr: server.counts.ocr, text: server.counts.translate },
      { ocr: 1, text: 1 },
    );
    assert.strictEqual(server.ocrForms[0].get("image"), null);
    assert.deepStrictEqual(server.translationBatches, [["new"]]);
    assert.deepStrictEqual(
      port.sent.filter((event) => event.type === "translation").map((event) => event.block_id),
      ["old", "new"],
    );
    assert.ok(
      port.sent.findIndex((event) => event.type === "translation" && event.block_id === "old") <
        port.sent.findIndex((event) => event.type === "image_done"),
    );
    assert.deepStrictEqual(
      { translated: done.translated, failed: done.failed, state: app.page(keys.pageArtifactKey).state },
      { translated: 1, failed: 0, state: "complete" },
    );
    assert.strictEqual(app.page(keys.pageArtifactKey).ocr_done, true);
    assert.deepStrictEqual(app.page(keys.pageArtifactKey).manifest_ids, ["new"]);
  });

  await scenario("unchanged OCR recovery reuses the authoritative manifest without Gemini", async () => {
    const storage = fakeStorage();
    const server = createFakeServer();
    const bootstrap = createBackgroundApp({ storage, server });
    await bootstrap.ready();
    const job = bootstrap.job("ocr-recovery-unchanged-job", "https://x/ocr-recovery-unchanged.jpg");
    const keys = await bootstrap.keysFor({ ...job, reading_direction: "rtl" });
    const page = cachedIncompleteOcrPage({ keys, server, job });
    page.render = {
      schema_version: "render-page-v1",
      render_artifact_key: keys.renderArtifactKey,
      patch_versions: structuredClone(server.patchVersions),
      layout_fit_version: "dom-fit-old",
      breaker_open: false,
      blocks: [{
        block_id: "old", render_mode: "in_place", patch_id: "old-patch",
        patch_bbox: [1, 2, 3, 4], fit_bbox: [1, 2, 3, 4],
        layout_profile: { font_px: 16, line_height: 1.2 }, reason: null,
      }],
    };
    storage.rows[`mt:page:${keys.pageArtifactKey}`] = page;
    server.primeRender(keys.renderArtifactKey, "ocr-recovery-unchanged");
    server.setRenderRows("ocr-recovery-unchanged", [{
      block_id: "old", patch_id: "patch-old", patch_bbox: [1, 2, 3, 4], clean_region: [1, 2, 3, 4],
      fit_bbox: [1, 2, 3, 4], patch_mime: "image/png", patch_rgba: Buffer.from("patch:old").toString("base64"), reason: null,
    }]);
    server.setOcrRows("ocr-recovery-unchanged", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      { type: "ocr_block", block_id: "old", bbox: [1, 2, 3, 4], src_text: "old" },
      { type: "image_done", recognized: 1, failed: 0 },
    ]);

    const app = bootstrap.restart();
    await app.ready();
    const port = app.connect();
    port.receive(app.startScope("ocr-recovery-unchanged", "visible", job));
    const done = await app.waitFor("scope_done", port);

    assert.deepStrictEqual(
      { ocr: server.counts.ocr, text: server.counts.translate },
      { ocr: 1, text: 0 },
    );
    assert.deepStrictEqual(
      port.sent.filter((event) => event.type === "translation").map((event) => event.block_id),
      ["old"],
    );
    assert.deepStrictEqual(
      { translated: done.translated, failed: done.failed, state: app.page(keys.pageArtifactKey).state },
      { translated: 1, failed: 0, state: "complete" },
    );
    assert.strictEqual(app.page(keys.pageArtifactKey).ocr_done, true);
    assert.deepStrictEqual(app.page(keys.pageArtifactKey).manifest_ids, ["old"]);
    assert.strictEqual(storage.rows[`mt:page:${keys.pageArtifactKey}`].render, undefined);
  });

  await scenario("OCR kind transitions force exact full-page translation in both directions", async () => {
    const recover = async (fromKind, toKind) => {
      const name = `ocr-recovery-kind-${fromKind}-${toKind}`;
      const storage = fakeStorage();
      const server = createFakeServer();
      const bootstrap = createBackgroundApp({ storage, server });
      await bootstrap.ready();
      const job = bootstrap.job(`${name}-job`, `https://x/${name}.jpg`);
      const keys = await bootstrap.keysFor({ ...job, reading_direction: "rtl" });
      const page = cachedIncompleteOcrPage({ keys, server, job });
      page.blocks[0].kind = fromKind;
      page.blocks[0].trans_text = fromKind === "sfx" ? null : "vi:old";
      page.manifest_ids = fromKind === "sfx" ? [] : ["old"];
      storage.rows[`mt:page:${keys.pageArtifactKey}`] = page;
      server.primeRender(keys.renderArtifactKey, name);
      server.setOcrRows(name, [
        { type: "analysis_ready", image_w: 100, image_h: 200 },
        { type: "ocr_block", block_id: "old", bbox: [1, 2, 3, 4], src_text: "old", kind: toKind },
        { type: "image_done", recognized: 1, failed: 0 },
      ]);
      server.queueTranslationResult({
        items: [{ id: "old", kind: toKind, translation: toKind === "sfx" ? null : "vi:old" }],
      });

      const app = bootstrap.restart();
      await app.ready();
      const port = app.connect();
      port.receive(app.startScope(name, "visible", job));
      await app.waitFor("scope_done", port);
      const stored = app.page(keys.pageArtifactKey);
      return {
        transition: `${fromKind}->${toKind}`,
        network: { ocr: server.counts.ocr, text: server.counts.translate },
        batches: server.translationBatches,
        block: {
          kind: stored.blocks[0].kind,
          trans_text: stored.blocks[0].trans_text,
          state: stored.blocks[0].state,
        },
        manifest_ids: stored.manifest_ids,
      };
    };

    const observed = [];
    for (const transition of [["text", "sfx"], ["sfx", "text"]]) {
      observed.push(await recover(...transition));
    }
    assert.deepStrictEqual(observed, [
      {
        transition: "text->sfx",
        network: { ocr: 1, text: 1 },
        batches: [["old"]],
        block: { kind: "sfx", trans_text: null, state: "translated" },
        manifest_ids: [],
      },
      {
        transition: "sfx->text",
        network: { ocr: 1, text: 1 },
        batches: [["old"]],
        block: { kind: "text", trans_text: "vi:old", state: "translated" },
        manifest_ids: ["old"],
      },
    ]);
  });

  await scenario("concurrent partial pages sharing an OCR identity spend one recovery claim", async () => {
    const storage = fakeStorage();
    const server = createFakeServer();
    const bootstrap = createBackgroundApp({ storage, server });
    await bootstrap.ready();
    const source = "https://x/ocr-recovery-shared.jpg";
    const viJob = bootstrap.job("ocr-recovery-shared-vi-job", source);
    const enJob = bootstrap.job("ocr-recovery-shared-en-job", source);
    const viKeys = await bootstrap.keysFor({ ...viJob, reading_direction: "rtl" }, "ja", "vi");
    const enKeys = await bootstrap.keysFor({ ...enJob, reading_direction: "rtl" }, "ja", "en");
    const viPage = cachedIncompleteOcrPage({ keys: viKeys, server, job: viJob });
    const enPage = cachedIncompleteOcrPage({ keys: enKeys, server, job: enJob });
    enPage.dst_lang = "en";
    storage.rows[`mt:page:${viKeys.pageArtifactKey}`] = viPage;
    storage.rows[`mt:page:${enKeys.pageArtifactKey}`] = enPage;
    server.primeRender(viKeys.renderArtifactKey, "ocr-recovery-shared");
    server.setRenderRows("ocr-recovery-shared", [{
      block_id: "old", patch_id: "patch-old", patch_bbox: [1, 2, 3, 4], clean_region: [1, 2, 3, 4],
      fit_bbox: [1, 2, 3, 4], patch_mime: "image/png", patch_rgba: Buffer.from("patch:old").toString("base64"), reason: null,
    }]);
    server.setOcrRows("ocr-recovery-shared", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      { type: "ocr_block", block_id: "old", bbox: [1, 2, 3, 4], src_text: "old" },
      { type: "image_done", recognized: 1, failed: 0 },
    ]);
    server.holdOcrAfterFirst("ocr-recovery-shared");

    const app = bootstrap.restart();
    await app.ready();
    const vi = app.connect();
    const en = app.connect();
    vi.receive(app.startScope("ocr-recovery-shared-vi", "visible", viJob));
    en.receive({ ...app.startScope("ocr-recovery-shared-en", "visible", enJob), dst_lang: "en" });
    await waitUntil(() => server.counts.ocr === 1, "single shared OCR recovery");
    await waitUntil(
      () => vi.sent.some((event) => event.type === "scope_done") || en.sent.some((event) => event.type === "scope_done"),
      "ledger-losing shared visit terminal",
    );
    assert.strictEqual(server.counts.ocr, 1);
    assert.strictEqual(server.counts.translate, 0);
    assert.deepStrictEqual(storage.rows[`mt:ocr-recovery:${viKeys.ocrKey}`], { schema_version: "ocr-recovery-v1" });
    assert.strictEqual(enKeys.ocrKey, viKeys.ocrKey);

    server.releaseOcr("ocr-recovery-shared");
    await app.waitFor("scope_done", vi);
    await app.waitFor("scope_done", en);
    assert.strictEqual(server.counts.ocr, 1);
    assert.deepStrictEqual(
      [vi, en].map((port) => port.sent.filter((event) => event.type === "translation").map((event) => event.block_id)),
      [["old"], ["old"]],
    );
  });

  await scenario("a warm recovery miss spends no second OCR POST and cannot retry on revisit", async () => {
    const storage = fakeStorage();
    const server = createFakeServer();
    const bootstrap = createBackgroundApp({ storage, server });
    await bootstrap.ready();
    const job = bootstrap.job("ocr-recovery-warm-miss-job", "https://x/ocr-recovery-warm-miss.jpg");
    const keys = await bootstrap.keysFor({ ...job, reading_direction: "rtl" });
    const page = cachedTranslatedPage({ keys, server, job });
    page.state = "partial";
    page.ocr_done = false;
    page.last_error = "ocr_incomplete";
    storage.rows[`mt:page:${keys.pageArtifactKey}`] = page;
    server.primeRender(keys.renderArtifactKey, "ocr-recovery-warm-miss");
    server.setRenderRows("ocr-recovery-warm-miss", [{
      block_id: "old", patch_id: "patch-old", patch_bbox: [1, 2, 3, 4], clean_region: [1, 2, 3, 4],
      fit_bbox: [1, 2, 3, 4], patch_mime: "image/png", patch_rgba: Buffer.from("patch:old").toString("base64"), reason: null,
    }]);

    const app = bootstrap.restart();
    await app.ready();
    const first = app.connect();
    first.receive(app.startScope("ocr-recovery-warm-miss", "visible", job));
    const failed = await app.waitFor("scope_done", first);
    assert.deepStrictEqual(
      { ocr: server.counts.ocr, coldOcr: server.counts.coldOcr, text: server.counts.translate },
      { ocr: 1, coldOcr: 0, text: 0 },
    );
    assert.strictEqual(server.ocrForms.length, 1);
    assert.strictEqual(server.ocrForms[0].get("image"), null);
    assert.deepStrictEqual(first.sent.filter((event) => event.type === "translation").map((event) => event.block_id), ["old"]);
    assert.deepStrictEqual({ translated: failed.translated, failed: failed.failed }, { translated: 1, failed: 1 });
    assert.deepStrictEqual(storage.rows[`mt:ocr-recovery:${keys.ocrKey}`], { schema_version: "ocr-recovery-v1" });

    const revisit = app.connect();
    revisit.receive(app.startScope(
      "ocr-recovery-warm-miss-revisit",
      "visible",
      app.job("ocr-recovery-warm-miss-revisit-job", job.source_url),
    ));
    const done = await app.waitFor("scope_done", revisit);
    assert.strictEqual(server.counts.ocr, 1);
    assert.deepStrictEqual({ translated: done.translated, failed: done.failed }, { translated: 1, failed: 0 });
  });

  await scenario("failed OCR recovery preserves replay and its ledger across page identities", async () => {
    const storage = fakeStorage();
    const server = createFakeServer();
    const bootstrap = createBackgroundApp({ storage, server });
    await bootstrap.ready();
    const job = bootstrap.job("ocr-recovery-incomplete-job", "https://x/ocr-recovery-incomplete.jpg");
    const keys = await bootstrap.keysFor({ ...job, reading_direction: "rtl" });
    storage.rows[`mt:page:${keys.pageArtifactKey}`] = cachedIncompleteOcrPage({ keys, server, job });
    server.primeRender(keys.renderArtifactKey, "ocr-recovery-incomplete");
    server.setRenderRows("ocr-recovery-incomplete", [{
      block_id: "old", patch_id: "patch-old", patch_bbox: [1, 2, 3, 4], clean_region: [1, 2, 3, 4],
      fit_bbox: [1, 2, 3, 4], patch_mime: "image/png", patch_rgba: Buffer.from("patch:old").toString("base64"), reason: null,
    }]);
    server.setOcrRows("ocr-recovery-incomplete", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      { type: "ocr_block", block_id: "old", bbox: [1, 2, 3, 4], src_text: "old" },
      { type: "image_done", recognized: 1, failed: 1 },
    ]);

    const app = bootstrap.restart();
    await app.ready();
    const port = app.connect();
    port.receive(app.startScope("ocr-recovery-incomplete", "visible", job));
    const done = await app.waitFor("scope_done", port);

    assert.deepStrictEqual(
      { ocr: server.counts.ocr, text: server.counts.translate },
      { ocr: 1, text: 0 },
    );
    assert.deepStrictEqual(port.sent.filter((event) => event.type === "translation").map((event) => event.block_id), ["old"]);
    assert.deepStrictEqual(
      port.sent.filter((event) => event.type === "image_done").map((event) => ({ translated: event.translated, failed: event.failed })),
      [{ translated: 1, failed: 1 }],
    );
    assert.deepStrictEqual({ translated: done.translated, failed: done.failed }, { translated: 1, failed: 1 });
    assert.deepStrictEqual(
      {
        state: app.page(keys.pageArtifactKey).state,
        ocr_done: app.page(keys.pageArtifactKey).ocr_done,
        manifest_ids: app.page(keys.pageArtifactKey).manifest_ids,
      },
      { state: "partial", ocr_done: false, manifest_ids: ["old"] },
    );
    assert.deepStrictEqual(storage.rows[`mt:ocr-recovery:${keys.ocrKey}`], { schema_version: "ocr-recovery-v1" });

    const restarted = app.restart();
    await restarted.ready();
    const beforeRevisit = structuredClone(server.counts);
    const revisit = restarted.connect();
    revisit.receive(restarted.startScope(
      "ocr-recovery-failed-revisit",
      "visible",
      restarted.job("ocr-recovery-failed-revisit-job", job.source_url),
    ));
    const revisitDone = await restarted.waitFor("scope_done", revisit);
    assert.deepStrictEqual(
      { ocr: server.counts.ocr - beforeRevisit.ocr, text: server.counts.translate - beforeRevisit.translate },
      { ocr: 0, text: 0 },
    );
    assert.deepStrictEqual(revisit.sent.filter((event) => event.type === "translation").map((event) => event.block_id), ["old"]);
    assert.deepStrictEqual({ translated: revisitDone.translated, failed: revisitDone.failed }, { translated: 1, failed: 0 });

    const dstKeys = await restarted.keysFor({ ...job, reading_direction: "rtl" }, "ja", "en");
    const dstPage = cachedIncompleteOcrPage({ keys: dstKeys, server, job });
    dstPage.dst_lang = "en";
    storage.rows[`mt:page:${dstKeys.pageArtifactKey}`] = dstPage;
    const beforeDst = structuredClone(server.counts);
    const dst = restarted.connect();
    dst.receive({
      ...restarted.startScope("ocr-recovery-new-dst", "visible", restarted.job("ocr-recovery-new-dst-job", job.source_url)),
      dst_lang: "en",
    });
    await restarted.waitFor("scope_done", dst);
    assert.notStrictEqual(dstKeys.pageArtifactKey, keys.pageArtifactKey);
    assert.strictEqual(dstKeys.ocrKey, keys.ocrKey);
    assert.deepStrictEqual(
      { ocr: server.counts.ocr - beforeDst.ocr, text: server.counts.translate - beforeDst.translate },
      { ocr: 0, text: 0 },
    );

    vm.runInContext('serverVersions.prompt = "pr2"', restarted.context);
    const promptKeys = await restarted.keysFor({ ...job, reading_direction: "rtl" });
    const promptPage = cachedIncompleteOcrPage({ keys: promptKeys, server, job });
    promptPage.versions = JSON.parse(vm.runInContext("JSON.stringify(serverVersions)", restarted.context));
    storage.rows[`mt:page:${promptKeys.pageArtifactKey}`] = promptPage;
    const beforePrompt = structuredClone(server.counts);
    const prompt = restarted.connect();
    prompt.receive({
      ...restarted.startScope("ocr-recovery-new-prompt", "visible", restarted.job("ocr-recovery-new-prompt-job", job.source_url)),
      dst_lang: "vi",
    });
    await restarted.waitFor("scope_done", prompt);
    assert.notStrictEqual(promptKeys.pageArtifactKey, keys.pageArtifactKey);
    assert.strictEqual(promptKeys.ocrKey, keys.ocrKey);
    assert.deepStrictEqual(
      { ocr: server.counts.ocr - beforePrompt.ocr, text: server.counts.translate - beforePrompt.translate },
      { ocr: 0, text: 0 },
    );

    const newOcrKeys = await restarted.keysFor({ ...job, reading_direction: "rtl" }, "es", "vi");
    const newOcrPage = cachedIncompleteOcrPage({ keys: newOcrKeys, server, job });
    newOcrPage.src_lang = "es";
    newOcrPage.versions = JSON.parse(vm.runInContext("JSON.stringify(serverVersions)", restarted.context));
    storage.rows[`mt:page:${newOcrKeys.pageArtifactKey}`] = newOcrPage;
    const beforeNewOcr = structuredClone(server.counts);
    const newOcr = restarted.connect();
    newOcr.receive({
      ...restarted.startScope("ocr-recovery-new-key", "visible", restarted.job("ocr-recovery-new-key-job", job.source_url)),
      src_lang: "es",
    });
    await restarted.waitFor("scope_done", newOcr);
    assert.notStrictEqual(newOcrKeys.ocrKey, keys.ocrKey);
    assert.deepStrictEqual(
      { ocr: server.counts.ocr - beforeNewOcr.ocr, text: server.counts.translate - beforeNewOcr.translate },
      { ocr: 1, text: 0 },
    );
    assert.deepStrictEqual(storage.rows[`mt:ocr-recovery:${newOcrKeys.ocrKey}`], { schema_version: "ocr-recovery-v1" });
  });

  await scenario("OCR recovery claim write failure returns without OCR or Gemini", async () => {
    const storage = fakeStorage();
    const server = createFakeServer();
    const bootstrap = createBackgroundApp({ storage, server });
    await bootstrap.ready();
    const job = bootstrap.job("ocr-recovery-claim-failed-job", "https://x/ocr-recovery-claim-failed.jpg");
    const keys = await bootstrap.keysFor({ ...job, reading_direction: "rtl" });
    storage.rows[`mt:page:${keys.pageArtifactKey}`] = cachedIncompleteOcrPage({ keys, server, job });
    server.primeRender(keys.renderArtifactKey, "ocr-recovery-claim-failed");
    server.setRenderRows("ocr-recovery-claim-failed", [{
      block_id: "old", patch_id: "patch-old", patch_bbox: [1, 2, 3, 4], clean_region: [1, 2, 3, 4],
      fit_bbox: [1, 2, 3, 4], patch_mime: "image/png", patch_rgba: Buffer.from("patch:old").toString("base64"), reason: null,
    }]);
    storage.beforeSet = async (values) => {
      if (Object.keys(values).some((key) => key.startsWith("mt:ocr-recovery:"))) throw new Error("quota");
    };

    const app = bootstrap.restart();
    await app.ready();
    const port = app.connect();
    port.receive(app.startScope("ocr-recovery-claim-failed", "visible", job));
    const done = await app.waitFor("scope_done", port);

    assert.deepStrictEqual(
      port.sent.filter((event) => event.type === "translation").map((event) => event.block_id),
      ["old"],
    );
    assert.ok(port.sent.some((event) => event.type === "job_error" && event.code === "cache_full"));
    assert.deepStrictEqual(
      { ocr: server.counts.ocr, text: server.counts.translate, failed: done.failed },
      { ocr: 0, text: 0, failed: 1 },
    );
    assert.strictEqual(storage.rows[`mt:ocr-recovery:${keys.ocrKey}`], undefined);
    assert.strictEqual(app.page(keys.pageArtifactKey).ocr_done, false);
    assert.deepStrictEqual(app.page(keys.pageArtifactKey).manifest_ids, ["old"]);
  });

  await scenario("OCR block failure keeps valid translated blocks", async () => {
    const server = createFakeServer();
    server.setOcrRows("ocr-partial", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      { type: "ocr_block", block_id: "good", bbox: [1, 2, 3, 4], src_text: "good" },
      { type: "ocr_block_error", block_id: "bad", code: "recognition_failed" },
      { type: "image_done", recognized: 1, failed: 1 },
    ]);
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("ocr-partial-job", "https://x/ocr-partial.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const port = app.connect();
    port.receive(app.startScope("ocr-partial", "visible", job));
    const done = await app.waitFor("scope_done", port);
    assert.ok(port.sent.some((event) => event.type === "progress" && event.image_w === 100));
    assert.ok(port.sent.some((event) => event.type === "block_error" && event.block_id === "bad"));
    const translation = port.sent.find((event) => event.type === "translation" && event.block_id === "good");
    assert.deepStrictEqual(
      { image_w: translation.image_w, image_h: translation.image_h },
      { image_w: 100, image_h: 200 }
    );
    assert.deepStrictEqual({ translated: done.translated, failed: done.failed }, { translated: 1, failed: 1 });
    assert.strictEqual(app.page(keys.pageArtifactKey).state, "partial");
  });

  await scenario("invalid decoded dimensions fail without natural-dimension fallback", async () => {
    const server = createFakeServer();
    server.setOcrRows("missing-dimensions", [
      { type: "analysis_ready" },
      { type: "ocr_block", block_id: "missing-b1", bbox: [1, 2, 3, 4], src_text: "missing" },
      { type: "image_done", recognized: 1, failed: 0 },
    ]);
    server.setOcrRows("invalid-dimensions", [
      { type: "analysis_ready", image_w: 0, image_h: 200 },
      { type: "ocr_block", block_id: "invalid-b1", bbox: [1, 2, 3, 4], src_text: "invalid" },
      { type: "image_done", recognized: 1, failed: 0 },
    ]);
    const app = createBackgroundApp({ server });
    await app.ready();
    for (const page of ["missing-dimensions", "invalid-dimensions"]) {
      const port = app.connect();
      port.receive(app.startScope(
        page,
        "visible",
        app.job(`${page}-job`, `https://x/${page}.jpg`, { natural_width: 999, natural_height: 777 })
      ));
      const done = await app.waitFor("scope_done", port);
      assert.deepStrictEqual({ translated: done.translated, failed: done.failed }, { translated: 0, failed: 1 });
      assert.strictEqual(done.page_metrics[0].error_code, "invalid_page_dimensions");
      assert.strictEqual(port.sent.some((event) => event.type === "translation"), false);
    }
    assert.strictEqual(server.counts.translate, 0);
  });

  await scenario("duplicate geometry completes through reading-order error taxonomy", async () => {
    const server = createFakeServer();
    server.setOcrRows("duplicate-geometry", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      { type: "ocr_block", block_id: "duplicate-a", bbox: [1, 2, 3, 4], src_text: "one" },
      { type: "ocr_block", block_id: "duplicate-b", bbox: [1, 2, 3, 4], src_text: "two" },
      { type: "image_done", recognized: 2, failed: 0 },
    ]);
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    port.receive(app.startScope(
      "duplicate-geometry",
      "visible",
      app.job("duplicate-geometry-job", "https://x/duplicate-geometry.jpg")
    ));
    const done = await app.waitFor("scope_done", port);
    assert.deepStrictEqual({ translated: done.translated, failed: done.failed }, { translated: 0, failed: 1 });
    assert.strictEqual(done.page_metrics[0].error_code, "reading_order_failed");
    assert.strictEqual(server.counts.translate, 0);
    assert.deepStrictEqual(structuredClone(app.debug()), { activeTasks: 0, queued: 0, offline: 0, requests: 0, producers: 0 });
  });

  await scenario("warm OCR sibling supplies decoded dimensions before full-page request", async () => {
    const server = createFakeServer();
    server.setOcrRows("warm-sibling", [
      { type: "analysis_ready", image_w: 321, image_h: 654 },
      { type: "ocr_block", block_id: "warm-b1", bbox: [1, 2, 3, 4], src_text: "warm" },
      { type: "image_done", recognized: 1, failed: 0 },
    ]);
    server.holdTranslation("vi");
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("warm-sibling-job", "https://x/warm-sibling.jpg", { natural_width: 999, natural_height: 777 });
    const target = await app.keysFor({ ...job, reading_direction: "rtl" });
    const sibling = await app.keysFor({ ...job, reading_direction: "rtl" }, "ja", "en");
    const timestamp = Date.now();
    app.storage.rows[`mt:page:${sibling.pageArtifactKey}`] = {
      schema_version: "page-v2",
      page_artifact_key: sibling.pageArtifactKey,
      analysis_key: sibling.analysisKey,
      ocr_key: sibling.ocrKey,
      render_artifact_key: sibling.renderArtifactKey,
      source_content_hash: sourceIdentityFor(job.source_url).sourceContentHash,
      source_url: job.source_url,
      crop: "full",
      natural_width: 999,
      natural_height: 777,
      src_lang: "ja",
      dst_lang: "en",
      reading_direction: "rtl",
      versions: app.server.versions,
      patch_versions: app.server.patchVersions,
      state: "partial",
      analysis_known: false,
      ocr_done: true,
      image_w: 321,
      image_h: 654,
      blocks: [{ block_id: "warm-b1", bbox: [1, 2, 3, 4], src_text: "warm", trans_text: null, kind: "text", vertical: false, reading_order: 0, state: "ocr_complete" }],
      manifest_mismatch_count: 0,
      created_at: timestamp,
      updated_at: timestamp,
      last_accessed_at: timestamp,
      last_error: null,
    };
    const port = app.connect();
    port.receive(app.startScope("warm-sibling", "visible", job));
    await waitUntil(() => server.translationBodies.length === 1, "warm sibling translation request");
    assert.deepStrictEqual(
      { page_width: server.translationBodies[0].page_width, page_height: server.translationBodies[0].page_height },
      { page_width: 321, page_height: 654 }
    );
    // Mutation caught: warm OCR reuse still starts from a verified current
    // source hash; only detector/recognizer calls are skipped.
    assert.deepStrictEqual(
      { source: server.counts.source, ocr: server.counts.ocr },
      { source: 1, ocr: 0 }
    );
    server.releaseTranslation("vi");
    await app.waitFor("scope_done", port);
    assert.deepStrictEqual(
      { image_w: app.page(target.pageArtifactKey).image_w, image_h: app.page(target.pageArtifactKey).image_h },
      { image_w: 321, image_h: 654 }
    );
  });

  await scenario("page metrics keep zero analysis timing and one network batch trace", async () => {
    const server = createFakeServer();
    server.setOcrRows("telemetry", [
      { type: "analysis_ready", image_w: 100, image_h: 200, analysis_ms: 0, analysis_cache_hit: false },
      ...[1, 2, 3].map((id) => ({ type: "ocr_block", block_id: `b${id}`, bbox: [40 - id * 10, id, id + 1, id + 1], src_text: `text-${id}` })),
      { type: "image_done", recognized: 3, failed: 0 },
    ]);
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    port.receive(app.startScope("telemetry", "visible", app.job("job-1", "https://x/telemetry.jpg")));
    const done = await app.waitFor("scope_done", port);
    assert.strictEqual(done.page_metrics.length, 1);
    const row = done.page_metrics[0];
    assert.strictEqual(row.job_id, "job-1");
    assert.strictEqual(row.analysis_ms, 0);
    assert.strictEqual(row.analysis_cache_hit, false);
    assert.ok(Number.isFinite(row.ocr_done_ms));
    assert.ok(Number.isFinite(row.final_translation_ms));
    assert.deepStrictEqual(row.translation_batches[0].block_ids, ["b1", "b2", "b3"]);
    assert.strictEqual(row.translation_batches[0].block_count, row.translation_batches[0].block_ids.length);
    assert.strictEqual(row.translation_batches[0].status, "success");
    assert.ok(row.ocr_done_ms >= row.first_ocr_ms);
    assert.ok(row.final_translation_ms >= row.first_translation_ms);
    assert.ok(row.translation_batches[0].duration_ms >= 0);
    assert.strictEqual(Object.keys(row).some((key) => ["source_url", "text", "trans_text", "api_key"].includes(key)), false);
  });

  await scenario("render metrics stay attributed to their page before and after scope completion", async () => {
    const server = createFakeServer();
    server.holdSource("metric-a");
    server.holdSource("metric-b");
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    const jobs = [app.job("metric-a-job", "https://x/metric-a.jpg"), app.job("metric-b-job", "https://x/metric-b.jpg")];
    port.receive({ ...app.startScope("early-metrics", "visible"), jobs });
    await waitUntil(() => server.counts.source === 2, "metric source fetches");
    port.receive({ type: "render_metric", request_id: "early-metrics", job_id: "metric-a-job", first_overlay_ms: 40 });
    port.receive({ type: "render_metric", request_id: "early-metrics", job_id: "unknown-job", first_overlay_ms: 0 });
    port.receive({ type: "render_metric", request_id: "early-metrics", job_id: "metric-b-job", first_overlay_ms: 10 });
    server.releaseSource("metric-a");
    server.releaseSource("metric-b");
    const earlyDone = await app.waitFor("scope_done", port);
    assert.deepStrictEqual(earlyDone.page_metrics.map((row) => [row.job_id, row.first_overlay_ms]).sort(), [["metric-a-job", 40], ["metric-b-job", 10]]);
    assert.strictEqual(earlyDone.metrics.first_overlay_ms, 10);

    const lateJob = app.job("late-job", "https://x/late.jpg");
    port.receive(app.startScope("late-metrics", "visible", lateJob));
    await waitUntil(() => port.sent.some((event) => event.type === "scope_done" && event.request_id === "late-metrics"), "late metric scope completion");
    port.receive({ type: "render_metric", request_id: "late-metrics", job_id: "late-job", first_overlay_ms: 7 });
    port.receive({ type: "render_metric", request_id: "late-metrics", job_id: "stale-job", first_overlay_ms: 0 });
    const lateSample = JSON.parse(vm.runInContext("JSON.stringify(metricSamplesByRequest.get('late-metrics'))", app.context));
    assert.strictEqual(lateSample.first_overlay_ms, 7);
    assert.deepStrictEqual(lateSample.page_metrics.map((row) => [row.job_id, row.first_overlay_ms]), [["late-job", 7]]);
  });

  await scenario("producer accepted offsets preserve zero and shared negative values", async () => {
    let tick = 0;
    const server = createFakeServer();
    server.holdOcrAfterFirst("shared-offset");
    const app = createBackgroundApp({ server, clock: { now: () => tick } });
    await app.ready();
    const first = app.connect();
    first.receive(app.startScope("offset-first", "visible", app.job("offset-first-job", "https://x/shared-offset.jpg")));
    await app.waitFor("page_job_accepted", first);
    tick = 10;
    const second = app.connect();
    second.receive(app.startScope("offset-second", "visible", app.job("offset-second-job", "https://x/shared-offset.jpg")));
    await app.waitFor("page_job_accepted", second);
    // Mutation caught: recreating an exact in-flight producer for the late
    // consumer loses the original accepted timestamp and negative offset.
    server.releaseOcr("shared-offset");
    const firstDone = await app.waitFor("scope_done", first);
    const secondDone = await app.waitFor("scope_done", second);
    assert.strictEqual(firstDone.page_metrics[0].accepted_offset_ms, 0);
    assert.strictEqual(secondDone.page_metrics[0].accepted_offset_ms, -10);
  });

  await scenario("late render metric patches its completed live row without adding another", async () => {
    const server = createFakeServer();
    server.holdSource("late-live-b");
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    port.receive({ ...app.startScope("late-live", "visible"), jobs: [app.job("late-live-a-job", "https://x/late-live-a.jpg"), app.job("late-live-b-job", "https://x/late-live-b.jpg")] });
    await waitUntil(() => vm.runInContext("requests.get('late-live')?.done.has('late-live-a-job')", app.context), "first live row completion");
    port.receive({ type: "render_metric", request_id: "late-live", job_id: "late-live-a-job", first_overlay_ms: 9 });
    const liveRows = JSON.parse(vm.runInContext("JSON.stringify(requests.get('late-live').metricRows)", app.context));
    assert.deepStrictEqual(liveRows.map((row) => [row.job_id, row.first_overlay_ms]), [["late-live-a-job", 9]]);
    server.releaseSource("late-live-b");
    await app.waitFor("scope_done", port);
  });

  await scenario("one failed image does not discard a valid sibling image", async () => {
    const server = createFakeServer();
    server.failSource("broken");
    const app = createBackgroundApp({ server });
    await app.ready();
    const good = app.job("good-image", "https://x/good.jpg");
    const broken = app.job("broken-image", "https://x/broken.jpg");
    const goodKeys = await app.keysFor({ ...good, reading_direction: "rtl" });
    const brokenKeys = await app.keysFor({ ...broken, reading_direction: "rtl" });
    const port = app.connect();
    port.receive({ ...app.startScope("mixed-images", "visible"), jobs: [good, broken] });
    const done = await app.waitFor("scope_done", port);
    assert.deepStrictEqual(
      { images: done.images, translated: done.translated, failed: done.failed },
      { images: 2, translated: 1, failed: 1 }
    );
    assert.strictEqual(app.page(goodKeys.pageArtifactKey).state, "complete");
    assert.strictEqual(app.page(brokenKeys.pageArtifactKey), undefined);
    assert.strictEqual(done.page_metrics.find((row) => row.job_id === "broken-image").error_code, "source_unavailable");
    server.allowSource("broken");
    const retry = app.connect();
    retry.receive(app.startScope("broken-retry", "visible", app.job("broken-retry-job", broken.source_url)));
    const retried = await app.waitFor("scope_done", retry);
    assert.deepStrictEqual({ translated: retried.translated, failed: retried.failed }, { translated: 1, failed: 0 });
    assert.strictEqual(app.page(brokenKeys.pageArtifactKey).state, "complete");
  });

  await scenario("failed translation batch preserves a later valid batch", async () => {
    const server = createFakeServer();
    server.setOcrRows("batch-partial", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      ...[1, 2, 3, 4].map((id) => ({
        type: "ocr_block",
        block_id: `b${id}`,
        bbox: [id, id, id + 1, id + 1],
        src_text: `text-${id}`,
      })),
      { type: "image_done", recognized: 4, failed: 0 },
    ]);
    server.queueTranslationResult(new Error("translation batch failed"));
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("batch-partial-job", "https://x/batch-partial.jpg");
    const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
    const port = app.connect();
    port.receive(app.startScope("batch-partial", "visible", job));
    const done = await app.waitFor("scope_done", port);
    assert.deepStrictEqual(server.translationBatches, [["b4", "b3", "b2", "b1"]]);
    assert.deepStrictEqual(
      port.sent.filter((event) => event.type === "translation"),
      []
    );
    assert.deepStrictEqual({ translated: done.translated, failed: done.failed }, { translated: 0, failed: 4 });
    assert.deepStrictEqual(
      done.page_metrics[0].translation_batches.map((batch) => ({ block_ids: batch.block_ids, status: batch.status, error_code: batch.error_code })),
      [
        { block_ids: ["b4", "b3", "b2", "b1"], status: "failed", error_code: "translation_failed" },
      ]
    );
    assert.strictEqual(app.page(keys.pageArtifactKey).state, "partial");

    const later = app.connect();
    later.receive(app.startScope(
      "batch-later",
      "visible",
      app.job("batch-later-job", "https://x/batch-later.jpg")
    ));
    const laterDone = await app.waitFor("scope_done", later);
    assert.deepStrictEqual(
      { translated: laterDone.translated, failed: laterDone.failed },
      { translated: 1, failed: 0 }
    );
    assert.deepStrictEqual(server.translationBatches, [
      ["b4", "b3", "b2", "b1"],
      ["b1"],
    ]);
  });

  await scenario("translation IDs are exact and a later click can retry", async () => {
    const server = createFakeServer();
    const invalidReplies = [
      [{ id: "b2", kind: "text", translation: "two" }],
      [{ id: "b2", kind: "text", translation: "two" }, { id: "foreign", kind: "text", translation: "wrong" }],
      [{ id: "b2", kind: "text", translation: "two" }, { id: "b2", kind: "text", translation: "duplicate" }],
    ];
    for (let index = 0; index < invalidReplies.length; index++) {
      server.setOcrRows(`invalid-ids-${index}`, [
        { type: "analysis_ready", image_w: 100, image_h: 200 },
        { type: "ocr_block", block_id: "b1", bbox: [10, 10, 20, 20], src_text: `one-${index}` },
        { type: "ocr_block", block_id: "b2", bbox: [50, 10, 20, 20], src_text: `two-${index}` },
        { type: "image_done", recognized: 2, failed: 0 },
      ]);
    }
    const app = createBackgroundApp({ server });
    await app.ready();
    let retrySource;
    let retryKeys;
    for (let index = 0; index < invalidReplies.length; index++) {
      const source = `https://x/invalid-ids-${index}.jpg`;
      const job = app.job(`invalid-${index}`, source);
      const keys = await app.keysFor({ ...job, reading_direction: "rtl" });
      server.queueTranslationResult({ items: invalidReplies[index] });
      const attempt = app.connect();
      attempt.receive(app.startScope(`invalid-${index}`, "visible", job));
      const failed = await app.waitFor("scope_done", attempt);
      assert.deepStrictEqual({ translated: failed.translated, failed: failed.failed }, { translated: 0, failed: 2 });
      assert.deepStrictEqual(
        failed.page_metrics[0].translation_batches.map((batch) => ({ status: batch.status, error_code: batch.error_code })),
        [{ status: "invalid_response", error_code: "invalid_response" }]
      );
      assert.strictEqual(attempt.sent.some((event) => event.type === "translation"), false);
      assert.deepStrictEqual(app.page(keys.pageArtifactKey).blocks.map((block) => block.trans_text), [null, null]);
      assert.strictEqual(vm.runInContext("hotTranslations.size", app.context), 0);
      retrySource = source;
      retryKeys = keys;
    }

    const retry = app.connect();
    retry.receive(app.startScope("invalid-retry", "visible", app.job("invalid-retry", retrySource)));
    const recovered = await app.waitFor("scope_done", retry);
    assert.deepStrictEqual({ translated: recovered.translated, failed: recovered.failed }, { translated: 2, failed: 0 });
    assert.deepStrictEqual(
      retry.sent.filter((event) => event.type === "translation").map((event) => event.block_id),
      ["b2", "b1"]
    );
    assert.deepStrictEqual(server.translationBatches, [
      ["b2", "b1"],
      ["b2", "b1"],
      ["b2", "b1"],
      ["b2", "b1"],
    ]);
    assert.strictEqual(app.page(retryKeys.pageArtifactKey).state, "complete");
  });

  await scenario("rate-limited translation keeps its own trace and page rows remain per job", async () => {
    const server = createFakeServer();
    server.holdSource("good");
    server.queueTranslationResult({ response: { ok: false, status: 429, json: async () => ({ error: "gemini: quota", error_code: "rate_limited" }) } });
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    port.receive({
      ...app.startScope("two-jobs", "visible"),
      jobs: [app.job("rate-job", "https://x/rate.jpg"), app.job("good-job", "https://x/good.jpg")],
    });
    await waitUntil(() => server.counts.translate === 1, "rate-limited request before good source");
    server.releaseSource("good");
    const done = await app.waitFor("scope_done", port);
    assert.deepStrictEqual(done.page_metrics.map((row) => row.job_id).sort(), ["good-job", "rate-job"]);
    const rate = done.page_metrics.find((row) => row.job_id === "rate-job");
    const good = done.page_metrics.find((row) => row.job_id === "good-job");
    assert.deepStrictEqual(rate.translation_batches.map((batch) => ({ status: batch.status, error_code: batch.error_code })), [{ status: "rate_limited", error_code: "rate_limited" }]);
    assert.deepStrictEqual(good.translation_batches.map((batch) => batch.status), ["success"]);
    assert.strictEqual((await app.message({ type: "benchmarkSummary" })).counters.rate_limited, 1);
    const counterRecords = [...vm.runInContext("metricSamplesByRequest.get('two-jobs').counter_records", app.context)];
    assert.strictEqual(counterRecords.filter((record) => record.rate_limited > 0).length, 1);
  });

  await scenario("structured invalid response keeps an invalid trace", async () => {
    const server = createFakeServer();
    server.queueTranslationResult({ response: { ok: false, status: 502, json: async () => ({ error: "gemini: duplicate id", error_code: "invalid_response" }) } });
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    port.receive(app.startScope("invalid-server", "visible", app.job("invalid-server-job", "https://x/invalid-server.jpg")));
    const done = await app.waitFor("scope_done", port);
    assert.deepStrictEqual(
      done.page_metrics[0].translation_batches.map((batch) => ({ status: batch.status, error_code: batch.error_code })),
      [{ status: "invalid_response", error_code: "invalid_response" }]
    );
    assert.strictEqual((await app.message({ type: "benchmarkSummary" })).counters.rate_limited, 0);
  });

  await scenario("server invalid_request keeps a failed trace with its error code", async () => {
    const server = createFakeServer();
    server.queueTranslationResult({ response: { ok: false, status: 422, json: async () => ({ error: "duplicate input id", error_code: "invalid_request" }) } });
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    port.receive(app.startScope("invalid-request", "visible", app.job("invalid-request-job", "https://x/invalid-request.jpg")));
    const done = await app.waitFor("scope_done", port);
    assert.deepStrictEqual(
      done.page_metrics[0].translation_batches.map((batch) => ({ status: batch.status, error_code: batch.error_code })),
      [{ status: "failed", error_code: "invalid_request" }]
    );
    assert.deepStrictEqual({ translated: done.translated, failed: done.failed }, { translated: 0, failed: 1 });
  });

  await scenario("non-rate-limited 502 keeps a failed trace without incrementing the rate-limit counter", async () => {
    const server = createFakeServer();
    server.queueTranslationResult({ response: { ok: false, status: 502, json: async () => ({ error: "gemini: upstream 429 text" }) } });
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    port.receive(app.startScope("generic-502", "visible", app.job("generic-502-job", "https://x/generic-502.jpg")));
    const done = await app.waitFor("scope_done", port);
    assert.deepStrictEqual(
      done.page_metrics[0].translation_batches.map((batch) => ({ status: batch.status, error_code: batch.error_code })),
      [{ status: "failed", error_code: "translation_failed" }]
    );
    assert.strictEqual((await app.message({ type: "benchmarkSummary" })).counters.rate_limited, 0);
  });

  await scenario("hot artifact caches stay bounded", async () => {
    const app = createBackgroundApp();
    await app.ready();
    const sizes = vm.runInContext(`(() => {
      for (let index = 0; index < 300; index++) lruSet(hotOcr, 'ocr-' + index, index, 256);
      for (let index = 0; index < 2100; index++) lruSet(hotTranslations, 'tr-' + index, index, 2048);
      return [hotOcr.size, hotTranslations.size, hotOcr.has('ocr-0'), hotTranslations.has('tr-0')];
    })()`, app.context);
    assert.deepStrictEqual([...sizes], [256, 2048, false, false]);
  });

  await scenario("target replacement retires old unsent translation but shares OCR", async () => {
    const server = createFakeServer();
    server.holdOcrAfterFirst("replace-target");
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    const source = "https://x/replace-target.jpg";
    port.receive(app.startScope("old-target", "visible", app.job("old-target-job", source)));
    await app.waitFor("page_job_accepted", port);
    await waitUntil(() => server.counts.source === 1, "old target source fetch");
    await waitUntil(
      () => vm.runInContext("[...producers.values()].some((producer) => producer.page.blocks.length === 1)", app.context),
      "old target first OCR block",
    );
    // Mutation caught: retiring the old OCR stage before the target-language
    // replacement attaches forces a second recognition pass.
    port.receive({
      ...app.startScope("new-target", "visible", app.job("new-target-job", source), "old-target"),
      dst_lang: "en",
    });
    await waitUntil(
      () => port.sent.some((event) => event.type === "page_job_accepted" && event.request_id === "new-target"),
      "new target acceptance"
    );
    await waitUntil(() => app.storedJob("old-target-job") === undefined, "old target ledger removal");
    server.releaseOcr("replace-target");
    await waitUntil(
      () => port.sent.some((event) => event.type === "scope_done" && event.request_id === "new-target"),
      "new target completion"
    );
    assert.deepStrictEqual(
      { source: server.counts.source, ocr: server.counts.ocr },
      { source: 1, ocr: 1 }
    );
    assert.deepStrictEqual(server.translationRequests, [{ dst_lang: "en", ids: ["b1"] }]);
    assert.strictEqual(
      port.sent.some((event) => event.type === "translation" && event.request_id === "old-target"),
      false
    );
  });

  await scenario("multi-page target replacement attaches every shared OCR stage before release", async () => {
    // Mutation caught: releasing the whole old request after only the first
    // matching row retires the second page's OCR stage and recognizes it twice.
    const server = createFakeServer();
    server.holdOcrAfterFirst("replace-many-a");
    server.holdOcrAfterFirst("replace-many-b");
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    const jobs = ["a", "b"].map((suffix) =>
      app.job(`replace-many-old-${suffix}`, `https://x/replace-many-${suffix}.jpg`));
    port.receive({ ...app.startScope("replace-many-old", "visible"), jobs });
    await waitUntil(
      () => server.counts.ocr === 2 && vm.runInContext(
        "[...producers.values()].filter((producer) => producer.page.blocks.length === 1).length === 2",
        app.context,
      ),
      "two old OCR stages",
    );

    port.receive({
      ...app.startScope("replace-many-new", "visible", undefined, "replace-many-old"),
      dst_lang: "en",
      jobs: ["a", "b"].map((suffix) =>
        app.job(`replace-many-new-${suffix}`, `https://x/replace-many-${suffix}.jpg`)),
    });
    await waitUntil(
      () => port.sent.filter((event) =>
        event.type === "page_job_accepted" && event.request_id === "replace-many-new").length === 2,
      "two replacement acceptances",
    );
    server.releaseOcr("replace-many-a");
    server.releaseOcr("replace-many-b");
    await waitUntil(
      () => port.sent.some((event) => event.type === "scope_done" && event.request_id === "replace-many-new"),
      "multi-page replacement completion",
    );
    assert.deepStrictEqual(
      { source: server.counts.source, ocr: server.counts.ocr, translate: server.counts.translate },
      { source: 2, ocr: 2, translate: 2 },
    );
    assert.ok(server.translationRequests.every((row) => row.dst_lang === "en"));
  });

  await scenario("target replacement replays OCR blocks emitted before it attached", async () => {
    const server = createFakeServer();
    server.setOcrRows("mid-stream", [
      { type: "analysis_ready", image_w: 100, image_h: 200 },
      { type: "ocr_block", block_id: "early", bbox: [1, 2, 3, 4], src_text: "early" },
      { type: "ocr_block", block_id: "late", bbox: [5, 6, 7, 8], src_text: "late" },
      { type: "image_done", recognized: 2, failed: 0 },
    ]);
    server.holdOcrAfterFirst("mid-stream");
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    const source = "https://x/mid-stream.jpg";
    const oldJob = app.job("mid-stream-old", source);
    port.receive(app.startScope("mid-stream-old", "loaded", oldJob));
    await app.waitFor("page_job_accepted", port);
    await waitUntil(
      () => vm.runInContext("[...producers.values()].some((producer) => producer.page.blocks.length === 1)", app.context),
      "completed first loaded OCR block"
    );

    const newJob = app.job("mid-stream-new", source);
    port.receive({
      ...app.startScope("mid-stream-new", "visible", newJob, "mid-stream-old"),
      dst_lang: "en",
    });
    await waitUntil(
      () => port.sent.some((event) => event.type === "page_job_accepted" && event.request_id === "mid-stream-new"),
      "mid-stream replacement acceptance"
    );
    assert.ok(port.sent.some((event) => event.type === "progress" && event.request_id === "mid-stream-new" && event.image_w === 100));
    server.releaseOcr("mid-stream");
    await waitUntil(
      () => port.sent.some((event) => event.type === "scope_done" && event.request_id === "mid-stream-new"),
      "mid-stream replacement completion"
    );
    assert.deepStrictEqual(
      port.sent.filter((event) => event.type === "translation" && event.request_id === "mid-stream-new").map((event) => event.block_id).sort(),
      ["early", "late"]
    );
    assert.deepStrictEqual(
      { source: server.counts.source, ocr: server.counts.ocr },
      { source: 1, ocr: 1 }
    );
  });

  await scenario("stale cloud response warms cache without emitting to replacement", async () => {
    const server = createFakeServer();
    server.setOcrRows("stale-cloud", [
      { type: "analysis_ready", image_w: 200, image_h: 300 },
      ...[1, 2, 3, 4].map((id) => ({
        type: "ocr_block",
        block_id: `b${id}`,
        bbox: [id * 25, 10, 20, 20],
        src_text: `text-${id}`,
      })),
      { type: "image_done", recognized: 4, failed: 0 },
    ]);
    server.holdTranslation("vi");
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    const source = "https://x/stale-cloud.jpg";
    const oldJob = app.job("stale-old-job", source);
    const oldKeys = await app.keysFor({ ...oldJob, reading_direction: "rtl" });
    const newJob = app.job("stale-new-job", source);
    const newKeys = await app.keysFor({ ...newJob, reading_direction: "rtl" }, "ja", "en");
    port.receive(app.startScope("stale-old", "visible", oldJob));
    await waitUntil(() => server.counts.translate === 1, "old cloud request");
    port.receive({
      ...app.startScope("stale-new", "visible", newJob, "stale-old"),
      dst_lang: "en",
    });
    await waitUntil(
      () => port.sent.some((event) => event.type === "scope_done" && event.request_id === "stale-new"),
      "replacement translation"
    );
    assert.strictEqual(vm.runInContext("hotTranslations.size", app.context), 4);
    const stalePageBefore = structuredClone(app.page(oldKeys.pageArtifactKey));
    server.releaseTranslation("vi");
    await waitUntil(
      () => vm.runInContext("hotTranslations.size", app.context) === 8,
      "stale response hot cache"
    );
    assert.strictEqual(app.page(newKeys.pageArtifactKey).ocr_done, true);
    assert.deepStrictEqual(app.page(oldKeys.pageArtifactKey), stalePageBefore);
    assert.ok(app.page(oldKeys.pageArtifactKey).blocks.every((block) => block.trans_text === null));
    assert.strictEqual(
      port.sent.some((event) => event.type === "translation" && event.request_id === "stale-old"),
      false
    );
    assert.strictEqual(
      port.sent.some((event) => event.type === "translation" && event.request_id === "stale-new" && event.trans_text.startsWith("vi:")),
      false
    );
    assert.strictEqual(
      port.sent.some((event) => event.type === "image_done" && event.request_id === "stale-old"),
      false
    );
    assert.strictEqual(
      port.sent.some((event) => event.type === "scope_done" && event.request_id === "stale-old"),
      false
    );
    const callsBeforeReturn = server.counts.translate;
    const back = app.connect();
    back.receive(app.startScope("stale-back", "visible", app.job("stale-back-job", source)));
    const backDone = await app.waitFor("scope_done", back);
    assert.deepStrictEqual(
      back.sent.filter((event) => event.type === "translation").map((event) => event.block_id),
      ["b4", "b3", "b2", "b1"]
    );
    assert.deepStrictEqual(backDone.page_metrics[0].translation_batches, []);
    assert.strictEqual(server.counts.translate, callsBeforeReturn);
  });

  await scenario("shared producer counters count once across requests", async () => {
    const server = createFakeServer();
    server.holdTranslation("vi");
    const app = createBackgroundApp({ server });
    await app.ready();
    const source = "https://x/shared-counter.jpg";
    const first = app.connect();
    const second = app.connect();
    first.receive(app.startScope("shared-counter-a", "visible", app.job("shared-counter-job-a", source)));
    second.receive(app.startScope("shared-counter-b", "visible", app.job("shared-counter-job-b", source)));
    await waitUntil(() => server.counts.translate === 1, "one shared translation call");
    server.releaseTranslation("vi");
    await app.waitFor("scope_done", first);
    await app.waitFor("scope_done", second);
    assert.strictEqual((await app.message({ type: "benchmarkSummary" })).counters.translation_calls, 1);
    const retained = vm.runInContext(`metricSamples.flatMap((row) =>
      [...(row.counter_records || row.counter_producers || [])].map((value) => ({
        keys: Object.keys(value).sort(),
        numeric: Object.values(value).every(Number.isFinite),
      })))`, app.context);
    assert.ok(retained.length > 0);
    assert.ok(retained.every((row) => row.numeric));
    assert.ok(retained.every((row) => JSON.stringify(row.keys) === JSON.stringify([
      "rate_limited", "stale_work", "translation_calls",
    ])));
    assert.ok(vm.runInContext("metricSamples.length <= 100", app.context));
  });

  await scenario("one replacement cannot retire another request's shared producer", async () => {
    const server = createFakeServer();
    server.holdTranslation("vi");
    const app = createBackgroundApp({ server });
    await app.ready();
    const source = "https://x/shared-consumer.jpg";
    const changing = app.connect();
    changing.receive(app.startScope("shared-changing", "visible", app.job("shared-changing-job", source)));
    await waitUntil(() => server.counts.translate === 1, "shared producer cloud request");

    const staying = app.connect();
    staying.receive(app.startScope("shared-staying", "visible", app.job("shared-staying-job", source)));
    await app.waitFor("page_job_accepted", staying);
    changing.receive({
      ...app.startScope("shared-new-target", "visible", app.job("shared-new-target-job", source), "shared-changing"),
      dst_lang: "en",
    });
    await waitUntil(
      () => changing.sent.some((event) => event.type === "scope_done" && event.request_id === "shared-new-target"),
      "new target for one consumer"
    );
    server.releaseTranslation("vi");
    const stayedDone = await app.waitFor("scope_done", staying);
    assert.deepStrictEqual({ translated: stayedDone.translated, failed: stayedDone.failed }, { translated: 1, failed: 0 });
    assert.ok(staying.sent.some((event) => event.type === "translation" && event.trans_text.startsWith("vi:")));
    assert.deepStrictEqual(server.translationRequests.map((row) => row.dst_lang).sort(), ["en", "vi"]);
  });

  await scenario("distinct job IDs sharing one source all complete", async () => {
    const app = createBackgroundApp();
    await app.ready();
    const port = app.connect();
    const source = "https://x/duplicate-source.jpg";
    port.receive({
      ...app.startScope("duplicate-source", "visible"),
      jobs: [
        app.job("duplicate-a", source),
        app.job("duplicate-b", source),
      ],
    });
    const done = await app.waitFor("scope_done", port);
    assert.deepStrictEqual(
      { images: done.images, translated: done.translated, failed: done.failed },
      { images: 2, translated: 2, failed: 0 }
    );
    assert.deepStrictEqual(
      [...new Set(port.sent.filter((event) => event.type === "translation").map((event) => event.job_id))].sort(),
      ["duplicate-a", "duplicate-b"]
    );
    assert.deepStrictEqual(
      { source: app.server.counts.source, ocr: app.server.counts.ocr, translate: app.server.counts.translate },
      { source: 1, ocr: 1, translate: 1 }
    );
  });

  await scenario("recognizer replacement keeps cold analysis owner alive", async () => {
    const server = createFakeServer();
    server.holdOcrAfterFirst("replace-recognizer");
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    const source = "https://x/replace-recognizer.jpg";
    port.receive(app.startScope("old-recognizer", "visible", app.job("old-recognizer-job", source)));
    await app.waitFor("page_job_accepted", port);
    await waitUntil(() => server.counts.source === 1, "recognizer source fetch");
    await waitUntil(() => server.counts.coldOcr === 1, "cold recognizer OCR");
    // Mutation caught: retiring the cold recognizer before the replacement
    // attaches aborts the shared analysis owner needed by the warm recognizer.
    port.receive({
      ...app.startScope(
        "new-recognizer",
        "visible",
        app.job("new-recognizer-job", source),
        "old-recognizer"
      ),
      src_lang: "es",
    });
    await waitUntil(
      () => port.sent.some((event) => event.type === "page_job_accepted" && event.request_id === "new-recognizer"),
      "new recognizer acceptance"
    );
    await waitUntil(() => app.storedJob("old-recognizer-job") === undefined, "old recognizer ledger removal");
    await flush();
    assert.strictEqual(server.counts.source, 1);
    assert.strictEqual(server.counts.aborted, 0);
    server.releaseOcr("replace-recognizer");
    await waitUntil(
      () => port.sent.some((event) => event.type === "scope_done" && event.request_id === "new-recognizer"),
      "new recognizer completion"
    );
    assert.deepStrictEqual(
      {
        source: server.counts.source,
        coldOcr: server.counts.coldOcr,
        warmOcr: server.counts.warmOcr,
        translate: server.counts.translate,
      },
      { source: 1, coldOcr: 1, warmOcr: 1, translate: 1 }
    );
  });

  const versions = {
    detector: "d1", dedupe: "dd1", prep: "p1", region_resolver: "rr1",
    recognizers: { ja: "r-ja", es: "r-latin", pt: "r-latin" },
    translator_model: "g1", prompt: "pr1", policy: "po1", layout_order: "reading-order-v1", page_schema: "page-v2",
  };
  const patchVersions = { cleaner: "c1", render_encoding: "png-rgba-v1", render_schema: "render-v1" };
  const job = {
    source_url: "https://x/page.jpg?token=secret",
    crop: null,
    natural_width: 1000,
    natural_height: 1600,
    src_lang: "ja",
    dst_lang: "vi",
    reading_direction: "rtl",
  };
  const sourceIdentity = sourceIdentityFor(job.source_url, Buffer.from([0, 1, 2, 255]));
  const vi = await context.buildKeys(job, sourceIdentity, versions, patchVersions);
  const restoredFull = await context.buildKeys({ ...job, crop: "full" }, sourceIdentity, versions, patchVersions);
  const otherUrl = await context.buildKeys({ ...job, source_url: "https://other/page.jpg" }, sourceIdentity, versions, patchVersions);
  const changedBytes = await context.buildKeys(job, sourceIdentityFor(job.source_url, Buffer.from([0, 1, 3, 255])), versions, patchVersions);
  const en = await context.buildKeys({ ...job, dst_lang: "en" }, sourceIdentity, versions, patchVersions);
  const es = await context.buildKeys({ ...job, src_lang: "es" }, sourceIdentity, versions, patchVersions);
  const pt = await context.buildKeys({ ...job, src_lang: "pt" }, sourceIdentity, versions, patchVersions);
  const ltr = await context.buildKeys({ ...job, reading_direction: "ltr" }, sourceIdentity, versions, patchVersions);
  const oldLayout = await context.buildKeys(job, sourceIdentity, { ...versions, layout_order: "reading-order-v0" }, patchVersions);
  const resolverBump = await context.buildKeys(job, sourceIdentity, { ...versions, region_resolver: "rr2" }, patchVersions);
  const promptBump = await context.buildKeys(job, sourceIdentity, { ...versions, prompt: "pr2" }, patchVersions);
  const modelBump = await context.buildKeys(job, sourceIdentity, { ...versions, translator_model: "g2" }, patchVersions);
  const cleanerBump = await context.buildKeys(job, sourceIdentity, versions, { ...patchVersions, cleaner: "c2" });
  const hashJson = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const expectedAnalysis = hashJson([sourceIdentity.sourceContentHash, "full", "d1", "dd1", "p1", "rr1"]);
  const expectedOcr = hashJson([expectedAnalysis, "ja", "r-ja"]);
  const expectedPage = hashJson([expectedOcr, "vi", "rtl", "reading-order-v1", "g1", "pr1", "po1", "page-v2"]);
  const expectedRender = hashJson([expectedAnalysis, "c1", "png-rgba-v1", "render-v1"]);
  assert.deepStrictEqual(
    { analysis: vi.analysisKey, ocr: vi.ocrKey, page: vi.pageArtifactKey, render: vi.renderArtifactKey },
    { analysis: expectedAnalysis, ocr: expectedOcr, page: expectedPage, render: expectedRender },
  );
  // Mutation caught: PageCache persists an omitted crop as the canonical
  // "full" sentinel, which must retain the same analysis identity on restart.
  assert.strictEqual(restoredFull.analysisKey, vi.analysisKey);
  assert.strictEqual(vi.analysisKey, otherUrl.analysisKey);
  assert.notStrictEqual(vi.analysisKey, changedBytes.analysisKey);
  assert.notStrictEqual(vi.analysisKey, resolverBump.analysisKey);
  assert.strictEqual(vi.analysisKey, en.analysisKey);
  assert.strictEqual(vi.ocrKey, en.ocrKey);
  assert.notStrictEqual(vi.pageArtifactKey, en.pageArtifactKey);
  assert.strictEqual(vi.analysisKey, es.analysisKey);
  assert.notStrictEqual(vi.ocrKey, es.ocrKey);
  assert.notStrictEqual(es.ocrKey, pt.ocrKey);
  assert.strictEqual(vi.analysisKey, ltr.analysisKey);
  assert.strictEqual(vi.ocrKey, ltr.ocrKey);
  assert.notStrictEqual(vi.pageArtifactKey, ltr.pageArtifactKey);
  assert.strictEqual(vi.analysisKey, oldLayout.analysisKey);
  assert.strictEqual(vi.ocrKey, oldLayout.ocrKey);
  assert.notStrictEqual(vi.pageArtifactKey, oldLayout.pageArtifactKey);
  assert.strictEqual(vi.renderArtifactKey, en.renderArtifactKey);
  assert.strictEqual(vi.renderArtifactKey, promptBump.renderArtifactKey);
  assert.strictEqual(vi.renderArtifactKey, modelBump.renderArtifactKey);
  assert.notStrictEqual(vi.renderArtifactKey, cleanerBump.renderArtifactKey);

  const blocks = [
    { block_id: "b2", src_text: "second" },
    { block_id: "b1", src_text: "first" },
  ];
  const producer = { ocrKey: "ocr-key", descriptor: { dst_lang: "vi", reading_direction: "rtl" }, page: { versions } };
  const translationKey = await context.translationKeyForBatch(producer, blocks, blocks[0]);
  const ltrTranslationKey = await context.translationKeyForBatch({ ...producer, descriptor: { ...producer.descriptor, reading_direction: "ltr" } }, blocks, blocks[0]);
  const layoutTranslationKey = await context.translationKeyForBatch({ ...producer, page: { versions: { ...versions, layout_order: "reading-order-v0" } } }, blocks, blocks[0]);
  const promptTranslationKey = await context.translationKeyForBatch({ ...producer, page: { versions: { ...versions, prompt: "pr2" } } }, blocks, blocks[0]);
  const policyTranslationKey = await context.translationKeyForBatch({ ...producer, page: { versions: { ...versions, policy: "po2" } } }, blocks, blocks[0]);
  const renderVersionTranslationKey = await context.translationKeyForBatch({ ...producer, page: { versions, patch_versions: { cleaner: "c2", render_encoding: "png-rgba-v2", render_schema: "render-v2" } } }, blocks, blocks[0]);
  assert.strictEqual(new Set([translationKey, ltrTranslationKey, layoutTranslationKey, promptTranslationKey, policyTranslationKey]).size, 5);
  assert.strictEqual(renderVersionTranslationKey, translationKey);

  const parsed = [];
  for await (const row of context.readNdjson(
    responseFrom(['{"type":"a"}\n{"ty', 'pe":"b"}'])
  )) parsed.push(row.type);
  assert.deepStrictEqual(parsed, ["a", "b"]);

  const order = [
    { tier: 2, sequence: 1 },
    { tier: 1, sequence: 2 },
    { tier: 0, sequence: 3 },
  ].sort(context.compareTasks);
  assert.deepStrictEqual(order.map((row) => row.tier), [0, 1, 2]);
  const foregroundOrder = [
    { tier: 0, distance: 100, sequence: 1 },
    { tier: 0, distance: 0, sequence: 2 },
  ].sort(context.compareTasks);
  assert.deepStrictEqual(foregroundOrder.map((row) => row.sequence), [2, 1]);

  const starts = [];
  const releases = [];
  const task = (name, tier) => ({
    tier,
    cancelled: () => false,
    run: () => {
      starts.push(name);
      return new Promise((resolve) => releases.push(resolve));
    },
    fail: (error) => { throw error; },
    done() {},
  });
  context.enqueueTask(task("blocker-a", 0));
  context.enqueueTask(task("blocker-b", 0));
  context.enqueueTask(task("prewarm", 2));
  context.enqueueTask(task("detached-visible", 1));
  await Promise.resolve();
  assert.deepStrictEqual(starts, ["blocker-a", "blocker-b"]);
  releases.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual(starts, ["blocker-a", "blocker-b", "detached-visible"]);
  releases.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual(starts, ["blocker-a", "blocker-b", "detached-visible", "prewarm"]);
  releases.splice(0).forEach((release) => release());
  await new Promise((resolve) => setTimeout(resolve, 0));

  let failures = 0;
  let synchronousDone = 0;
  context.enqueueTask({
    tier: 0,
    cancelled: () => false,
    run: () => { throw new Error("synchronous task failure"); },
    fail: () => { failures++; },
    done: () => { synchronousDone++; },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterFailure = [];
  context.enqueueTask({
    tier: 0,
    cancelled: () => false,
    run: () => { afterFailure.push("ran"); },
    fail: (error) => { throw error; },
    done() {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(failures, 1);
  assert.strictEqual(synchronousDone, 1);
  assert.deepStrictEqual(afterFailure, ["ran"]);

  const producerStarts = [];
  context.runProducer = (producer) => {
    producerStarts.push(producer.descriptor.job_id);
    return Promise.resolve();
  };
  context.failProducer = (producer, error) => { throw error; };
  context.enqueueTask(task("admission-blocker-a", 0));
  context.enqueueTask(task("admission-blocker-b", 0));
  const request = {
    connected: false,
    outstanding: 0,
    pendingJobs: [0, 1, 2, 3, 4].map((job_id) => ({
      descriptor: { job_id, priority: job_id === 0 ? 2 : 0, distance: job_id === 0 ? 100 : job_id },
    })),
  };
  const foregroundRequest = {
    connected: true,
    priority: 2,
    outstanding: 0,
    pendingJobs: [{ descriptor: { job_id: "foreground", priority: 0, distance: 0 } }],
  };
  context.admitRequestJobs(request);
  context.admitRequestJobs(foregroundRequest);
  context.enqueueTask({
    tier: 2,
    cancelled: () => false,
    run: () => { producerStarts.push("prewarm"); },
    fail: (error) => { throw error; },
    done() {},
  });
  await Promise.resolve();
  assert.strictEqual(request.outstanding, 4);
  assert.strictEqual(request.pendingJobs.length, 1);
  releases.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual(producerStarts.slice(0, 2), ["foreground", 0]);
  releases.splice(0).forEach((release) => release());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual(producerStarts, ["foreground", 0, 1, 2, 3, 4, "prewarm"]);
  assert.strictEqual(request.outstanding, 0);
  assert.strictEqual(request.pendingJobs.length, 0);
  assert.strictEqual(foregroundRequest.outstanding, 0);
});
