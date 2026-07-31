const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const { webcrypto } = require("crypto");
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

async function flush(turns = 4) {
  for (let index = 0; index < turns; index++) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitUntil(check, label) {
  for (let index = 0; index < 1000; index++) {
    if (check()) return;
    await flush(1);
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
      return this.cloneForRead ? this.cloneForRead(value) : value;
    },
    async set(values) {
      if (this.failWrites) throw new Error("quota");
      Object.assign(rows, JSON.parse(JSON.stringify(values)));
    },
    async remove(keys) {
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
    detector: "d1", dedupe: "dd1", prep: "p1",
    recognizers: { ja: "r-ja", es: "r-es" },
    translator_model: "g1", prompt: "pr1", policy: "po1", page_schema: "page-v1",
  };
  const counts = { health: 0, source: 0, ocr: 0, coldOcr: 0, warmOcr: 0, translate: 0, aborted: 0 };
  const translationBatches = [];
  const translationRequests = [];
  const sourceGates = new Map();
  const failedSources = new Set();
  const ocrRows = new Map();
  const ocrAfterFirstGates = new Map();
  const analysisSources = new Map();
  const translationGates = new Map();
  const translationResults = [];
  let online = true;
  let responseVersions = versions;

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
      return { ok: true, json: async () => ({ versions: responseVersions }) };
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
    if (url.endsWith("/translate-items")) {
      counts.translate++;
      const body = JSON.parse(options.body);
      translationBatches.push(body.items.map((item) => item.id));
      translationRequests.push({ dst_lang: body.dst_lang, ids: body.items.map((item) => item.id) });
      await waitForGate(translationGates.get(body.dst_lang), options.signal);
      if (translationResults.length) {
        const result = translationResults.shift();
        if (result instanceof Error) throw result;
        return { ok: true, json: async () => result };
      }
      return { ok: true, json: async () => ({ items: body.items.map((item) => ({ id: item.id, translation: `${body.dst_lang}:${item.text}` })) }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }

  return {
    versions,
    counts,
    translationBatches,
    translationRequests,
    fetch,
    setResponseVersions(value) { responseVersions = value; },
    setOnline(value) { online = value; },
    holdSource(pageName) { const gate = deferred(); sourceGates.set(pageName, gate); return gate; },
    releaseSource(pageName) { sourceGates.get(pageName)?.resolve(); sourceGates.delete(pageName); },
    failSource(pageName) { failedSources.add(pageName); },
    setOcrRows(pageName, rows) { ocrRows.set(pageName, rows); },
    holdOcrAfterFirst(pageName) { const gate = deferred(); ocrAfterFirstGates.set(pageName, gate); return gate; },
    releaseOcr(pageName) { ocrAfterFirstGates.get(pageName)?.resolve(); ocrAfterFirstGates.delete(pageName); },
    holdTranslation(dstLang) { const gate = deferred(); translationGates.set(dstLang, gate); return gate; },
    releaseTranslation(dstLang) { translationGates.get(dstLang)?.resolve(); translationGates.delete(dstLang); },
    queueTranslationResult(result) { translationResults.push(result); },
  };
}

function createBackgroundApp({ storage = fakeStorage(), server = createFakeServer() } = {}) {
  let connectListener;
  const runtimeListeners = [];
  const context = {
    Promise, Map, Set, URL, TextEncoder, TextDecoder, Buffer,
    crypto: webcrypto, console, setTimeout, clearTimeout,
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
  vm.runInContext(fs.readFileSync("extension/page-cache.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("extension/background.js", "utf8"), context);
  return {
    context,
    server,
    storage,
    async ready() { await vm.runInContext("ready", context); },
    connect() { const value = fakePort(); connectListener(value); return value; },
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
      return { type: "start_scope", request_id: requestId, replaces_request_id: replacesRequestId, scope, src_lang: "ja", dst_lang: "vi", jobs: job ? [job] : [] };
    },
    async waitFor(type, port) {
      await waitUntil(
        () => port.sent.some((event) => event.type === type),
        `${type} event; received ${JSON.stringify(port.sent)}`
      );
      return port.sent.find((event) => event.type === type);
    },
    async keysFor(job, srcLang = "ja", dstLang = "vi") {
      return context.buildKeys(
        { ...job, src_lang: srcLang, dst_lang: dstLang },
        vm.runInContext("serverVersions", context)
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
    restart() { return createBackgroundApp({ storage, server }); },
  };
}

async function scenario(name, check) {
  try {
    await check();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

const context = {
  Promise, JSON, Map, Set, URL, TextEncoder, TextDecoder,
  crypto: webcrypto,
  console,
  setTimeout, clearTimeout,
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
vm.runInContext(fs.readFileSync("extension/background.js", "utf8"), context);

(async () => {
  // The producer API is deliberately exercised through a port: changing
  // acceptScope to only retain foreground work must make this fail.
  assert.strictEqual(typeof context.acceptScope, "function");

  await scenario("A continues after disconnect and exact return makes zero calls", async () => {
    const server = createFakeServer();
    server.holdSource("detached");
    const app = createBackgroundApp({ server });
    await app.ready();
    const job = app.job("detached-job", "https://x/detached.jpg");
    const keys = await app.keysFor(job);
    const first = app.connect();
    first.receive(app.startScope("detached-request", "visible", job));
    await app.waitFor("page_job_accepted", first);
    first.disconnect();
    server.releaseSource("detached");
    await waitUntil(() => app.page(keys.pageArtifactKey)?.state === "complete", "detached page completion");
    await waitUntil(() => app.storedJob("detached-job") === undefined, "detached ledger cleanup");
    const calls = structuredClone(server.counts);

    const back = app.connect();
    back.receive(app.startScope("return-request", "visible", app.job("return-job", "https://x/detached.jpg")));
    const done = await app.waitFor("scope_done", back);
    assert.strictEqual(done.cache_hit, true);
    const replayed = back.sent.find((event) => event.type === "translation" && event.cache_hit);
    assert.deepStrictEqual(
      { image_w: replayed.image_w, image_h: replayed.image_h },
      { image_w: 100, image_h: 200 }
    );
    assert.deepStrictEqual(server.counts, calls);
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
    assert.deepStrictEqual(
      { health: offlineServer.counts.health, source: offlineServer.counts.source },
      { health: 2, source: 0 }
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

  await scenario("prewarm performs OCR only at prewarm priority without persistence", async () => {
    const app = createBackgroundApp();
    await app.ready();
    const response = await app.message({
      type: "prewarmJob",
      src_lang: "ja",
      dst_lang: "vi",
      job: app.job("prewarm-job", "https://x/prewarm.jpg"),
    });
    assert.strictEqual(response.ok, true);
    await waitUntil(() => app.server.counts.ocr === 1 && app.debug().producers === 0, "prewarm completion");
    assert.deepStrictEqual(
      { source: app.server.counts.source, ocr: app.server.counts.ocr, translate: app.server.counts.translate },
      { source: 1, ocr: 1, translate: 0 }
    );
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
    assert.deepStrictEqual(app.server.counts, before);
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

    const before = structuredClone(server.counts);
    await app.message({
      type: "prewarmJob",
      src_lang: "ja",
      job: app.job("empty-prewarm", "https://x/empty.jpg"),
    });
    const en = app.connect();
    en.receive({ ...app.startScope("empty-en", "visible", app.job("empty-en-job", "https://x/empty.jpg")), dst_lang: "en" });
    const enDone = await app.waitFor("scope_done", en);
    assert.deepStrictEqual(server.counts, before);
    assert.deepStrictEqual(
      { translated: enDone.translated, failed: enDone.failed, cache_hit: enDone.cache_hit },
      { translated: 0, failed: 0, cache_hit: false }
    );
    assert.deepStrictEqual(structuredClone(app.debug()), { activeTasks: 0, queued: 0, offline: 0, requests: 0, producers: 0 });
  });

  await scenario("detached queued manual work is demoted to background FIFO", async () => {
    const server = createFakeServer();
    server.holdSource("slot-a");
    server.holdSource("slot-b");
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
    await waitUntil(() => server.counts.source === 2, "occupied producer slots");
    const manual = app.connect();
    manual.receive(app.startScope("queued-manual", "visible", app.job("queued-manual-job", "https://x/queued-manual.jpg")));
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
    await waitUntil(() => server.counts.source === 3, "detached manual source fetch");
  });

  await scenario("detached A never renders on replacement B", async () => {
    const server = createFakeServer();
    server.holdSource("A");
    const app = createBackgroundApp({ server });
    await app.ready();
    const active = app.connect();
    active.receive(app.startScope("rA", "visible", app.job("jA", "https://x/A.jpg")));
    await app.waitFor("page_job_accepted", active);
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
    const keys = await app.keysFor(descriptor);
    const now = Date.now();
    storage.rows[`mt:page:${keys.pageArtifactKey}`] = {
      schema_version: "page-v1",
      page_artifact_key: keys.pageArtifactKey,
      analysis_key: keys.analysisKey,
      ocr_key: keys.ocrKey,
      overlay_key: keys.overlayKey,
      source_url: descriptor.source_url,
      crop: "full",
      natural_width: 100,
      natural_height: 200,
      src_lang: "ja",
      dst_lang: "vi",
      versions: vm.runInContext("serverVersions", app.context),
      state: "running",
      analysis_known: false,
      ocr_done: false,
      image_w: null,
      image_h: null,
      blocks: [],
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
    await app.waitFor("page_job_accepted", active);
    await waitUntil(() => server.counts.source === 1, "shared source fetch");
    active.receive(app.startScope(
      "new",
      "visible",
      app.job("new-job", "https://x/shared.jpg"),
      "old"
    ));
    await waitUntil(
      () => active.sent.some((event) => event.type === "page_job_accepted" && event.request_id === "new"),
      "replacement acceptance"
    );
    await waitUntil(() => app.storedJob("old-job") === undefined, "old ledger removal");
    server.releaseSource("shared");
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
    assert.strictEqual(server.counts.translate, 1);
    assert.strictEqual(
      port.sent.some((event) => event.type === "translation" && event.request_id === "pending-old"),
      false
    );
    assert.ok(port.sent.some((event) => event.type === "translation" && event.request_id === "pending-new"));
    assert.strictEqual(app.storedJob("pending-old-job"), undefined);
    assert.strictEqual(app.storedJob("pending-new-job"), undefined);
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
    assert.deepStrictEqual(
      { source: app.server.counts.source, ocr: app.server.counts.ocr, translate: app.server.counts.translate },
      { source: 1, ocr: 1, translate: 2 }
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
      { source: 1, coldOcr: 1, warmOcr: 1, translate: 3 }
    );

    const back = app.connect();
    back.receive(app.startScope("back", "visible", app.job("back-job", source)));
    await app.waitFor("scope_done", back);
    assert.deepStrictEqual(
      { source: app.server.counts.source, ocr: app.server.counts.ocr, translate: app.server.counts.translate },
      { source: 1, ocr: 2, translate: 3 }
    );
    assert.ok(back.sent.some((event) => event.type === "translation" && event.cache_hit));
  });

  await scenario("partial page replays complete blocks and requests only missing IDs", async () => {
    const app = createBackgroundApp();
    await app.ready();
    const job = app.job("partial-job", "https://x/partial.jpg");
    const keys = await app.keysFor(job);
    const now = Date.now();
    app.storage.rows[`mt:page:${keys.pageArtifactKey}`] = {
      schema_version: "page-v1",
      page_artifact_key: keys.pageArtifactKey,
      analysis_key: keys.analysisKey,
      ocr_key: keys.ocrKey,
      overlay_key: keys.overlayKey,
      source_url: job.source_url,
      crop: "full",
      natural_width: 100,
      natural_height: 200,
      src_lang: "ja",
      dst_lang: "vi",
      versions: app.server.versions,
      state: "partial",
      analysis_known: true,
      ocr_done: true,
      image_w: 100,
      image_h: 200,
      blocks: [
        { block_id: "b1", bbox: [1, 2, 3, 4], src_text: "one", trans_text: "vi:one", state: "complete" },
        { block_id: "b2", bbox: [5, 6, 7, 8], src_text: "two", trans_text: null, state: "ocr_complete" },
      ],
      created_at: now,
      updated_at: now,
      last_accessed_at: now,
      last_error: "translation_failed",
    };
    const port = app.connect();
    port.receive(app.startScope("partial", "visible", job));
    await app.waitFor("scope_done", port);
    assert.deepStrictEqual(
      port.sent.filter((event) => event.type === "translation").map((event) => event.block_id),
      ["b1", "b2"]
    );
    assert.deepStrictEqual(app.server.translationBatches, [["b2"]]);
    assert.deepStrictEqual(
      { source: app.server.counts.source, ocr: app.server.counts.ocr },
      { source: 0, ocr: 0 }
    );
    assert.strictEqual(app.page(keys.pageArtifactKey).state, "complete");
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
    const keys = await app.keysFor(job);
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

  await scenario("one failed image does not discard a valid sibling image", async () => {
    const server = createFakeServer();
    server.failSource("broken");
    const app = createBackgroundApp({ server });
    await app.ready();
    const good = app.job("good-image", "https://x/good.jpg");
    const broken = app.job("broken-image", "https://x/broken.jpg");
    const goodKeys = await app.keysFor(good);
    const brokenKeys = await app.keysFor(broken);
    const port = app.connect();
    port.receive({ ...app.startScope("mixed-images", "visible"), jobs: [good, broken] });
    const done = await app.waitFor("scope_done", port);
    assert.deepStrictEqual(
      { images: done.images, translated: done.translated, failed: done.failed },
      { images: 2, translated: 1, failed: 1 }
    );
    assert.strictEqual(app.page(goodKeys.pageArtifactKey).state, "complete");
    assert.strictEqual(app.page(brokenKeys.pageArtifactKey).state, "failed");
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
    const keys = await app.keysFor(job);
    const port = app.connect();
    port.receive(app.startScope("batch-partial", "visible", job));
    const done = await app.waitFor("scope_done", port);
    assert.deepStrictEqual(server.translationBatches, [["b1", "b2", "b3"], ["b4"]]);
    assert.deepStrictEqual(
      port.sent.filter((event) => event.type === "translation").map((event) => event.block_id),
      ["b4"]
    );
    assert.deepStrictEqual({ translated: done.translated, failed: done.failed }, { translated: 1, failed: 3 });
    assert.strictEqual(app.page(keys.pageArtifactKey).state, "partial");
  });

  await scenario("translation IDs are exact and a later click can retry", async () => {
    const server = createFakeServer();
    server.queueTranslationResult({ items: [{ id: "unexpected", translation: "wrong" }] });
    const app = createBackgroundApp({ server });
    await app.ready();
    const source = "https://x/invalid-ids.jpg";
    const firstJob = app.job("invalid-first", source);
    const keys = await app.keysFor(firstJob);
    const first = app.connect();
    first.receive(app.startScope("invalid-first", "visible", firstJob));
    const failed = await app.waitFor("scope_done", first);
    assert.deepStrictEqual({ translated: failed.translated, failed: failed.failed }, { translated: 0, failed: 1 });
    assert.ok(first.sent.some((event) => event.type === "block_error" && event.stage === "translation"));
    assert.strictEqual(app.page(keys.pageArtifactKey).state, "partial");

    const retry = app.connect();
    retry.receive(app.startScope("invalid-retry", "visible", app.job("invalid-retry", source)));
    const recovered = await app.waitFor("scope_done", retry);
    assert.deepStrictEqual({ translated: recovered.translated, failed: recovered.failed }, { translated: 1, failed: 0 });
    assert.deepStrictEqual(server.translationBatches, [["b1"], ["b1"]]);
    assert.strictEqual(app.page(keys.pageArtifactKey).state, "complete");
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
    server.holdSource("replace-target");
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    const source = "https://x/replace-target.jpg";
    port.receive(app.startScope("old-target", "visible", app.job("old-target-job", source)));
    await app.waitFor("page_job_accepted", port);
    await waitUntil(() => server.counts.source === 1, "old target source fetch");
    port.receive({
      ...app.startScope("new-target", "visible", app.job("new-target-job", source), "old-target"),
      dst_lang: "en",
    });
    await waitUntil(
      () => port.sent.some((event) => event.type === "page_job_accepted" && event.request_id === "new-target"),
      "new target acceptance"
    );
    await waitUntil(() => app.storedJob("old-target-job") === undefined, "old target ledger removal");
    server.releaseSource("replace-target");
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
    server.holdTranslation("vi");
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    const source = "https://x/stale-cloud.jpg";
    const oldJob = app.job("stale-old-job", source);
    const oldKeys = await app.keysFor(oldJob);
    const newJob = app.job("stale-new-job", source);
    const newKeys = await app.keysFor(newJob, "ja", "en");
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
    server.releaseTranslation("vi");
    await waitUntil(
      () => vm.runInContext("hotTranslations.size", app.context) === 1,
      "stale response hot cache"
    );
    assert.strictEqual(app.page(newKeys.pageArtifactKey).ocr_done, true);
    assert.strictEqual(app.page(oldKeys.pageArtifactKey).state, "partial");
    assert.strictEqual(app.page(oldKeys.pageArtifactKey).blocks[0].trans_text, null);
    assert.strictEqual(
      port.sent.some((event) => event.type === "translation" && event.request_id === "stale-old"),
      false
    );
    assert.strictEqual(
      port.sent.some((event) => event.type === "translation" && event.request_id === "stale-new" && event.trans_text.startsWith("vi:")),
      false
    );
    const callsBeforeReturn = server.counts.translate;
    const back = app.connect();
    back.receive(app.startScope("stale-back", "visible", app.job("stale-back-job", source)));
    await app.waitFor("scope_done", back);
    assert.ok(back.sent.some((event) => event.type === "translation" && event.trans_text));
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
    server.holdSource("replace-recognizer");
    const app = createBackgroundApp({ server });
    await app.ready();
    const port = app.connect();
    const source = "https://x/replace-recognizer.jpg";
    port.receive(app.startScope("old-recognizer", "visible", app.job("old-recognizer-job", source)));
    await app.waitFor("page_job_accepted", port);
    await waitUntil(() => server.counts.source === 1, "recognizer source fetch");
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
    server.releaseSource("replace-recognizer");
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
    detector: "d1", dedupe: "dd1", prep: "p1",
    recognizers: { ja: "r-ja", es: "r-es" },
    translator_model: "g1", prompt: "pr1", policy: "po1", page_schema: "page-v1",
  };
  const job = {
    source_url: "https://x/page.jpg?token=secret",
    crop: null,
    natural_width: 1000,
    natural_height: 1600,
    src_lang: "ja",
    dst_lang: "vi",
  };
  const vi = await context.buildKeys(job, versions);
  const en = await context.buildKeys({ ...job, dst_lang: "en" }, versions);
  const es = await context.buildKeys({ ...job, src_lang: "es" }, versions);
  assert.strictEqual(vi.analysisKey, en.analysisKey);
  assert.strictEqual(vi.ocrKey, en.ocrKey);
  assert.notStrictEqual(vi.pageArtifactKey, en.pageArtifactKey);
  assert.strictEqual(vi.analysisKey, es.analysisKey);
  assert.notStrictEqual(vi.ocrKey, es.ocrKey);

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
  console.log("background-progressive.test.js transport OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
