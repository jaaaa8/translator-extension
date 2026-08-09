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
  const counts = { health: 0, source: 0, ocr: 0, coldOcr: 0, warmOcr: 0, translate: 0, aborted: 0 };
  const translationBatches = [];
  const translationRequests = [];
  const translationBodies = [];
  const ocrForms = [];
  const sourceGates = new Map();
  const failedSources = new Set();
  const ocrRows = new Map();
  const ocrAfterFirstGates = new Map();
  const analysisSources = new Map();
  const translationGates = new Map();
  const translationResults = [];
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
      translationBodies.push(body);
      await waitForGate(translationGates.get(body.dst_lang), options.signal);
      if (translationResults.length) {
        const result = translationResults.shift();
        if (result instanceof Error) throw result;
        if (result.response) return result.response;
        return { ok: true, json: async () => result };
      }
      return { ok: true, json: async () => ({ items: body.items.map((item) => ({ id: item.id, translation: `${body.dst_lang}:${item.text}` })) }) };
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
    fetch,
    setResponseVersions(value) { responseVersions = value; },
    setResponsePatchVersions(value) { responsePatchVersions = value; },
    setOnline(value) { online = value; },
    holdSource(pageName) { const gate = deferred(); sourceGates.set(pageName, gate); return gate; },
    releaseSource(pageName) { sourceGates.get(pageName)?.resolve(); sourceGates.delete(pageName); },
    failSource(pageName) { failedSources.add(pageName); },
    allowSource(pageName) { failedSources.delete(pageName); },
    setOcrRows(pageName, rows) { ocrRows.set(pageName, rows); },
    holdOcrAfterFirst(pageName) { const gate = deferred(); ocrAfterFirstGates.set(pageName, gate); return gate; },
    releaseOcr(pageName) { ocrAfterFirstGates.get(pageName)?.resolve(); ocrAfterFirstGates.delete(pageName); },
    holdTranslation(dstLang) { const gate = deferred(); translationGates.set(dstLang, gate); return gate; },
    releaseTranslation(dstLang) { translationGates.get(dstLang)?.resolve(); translationGates.delete(dstLang); },
    queueTranslationResult(result) { translationResults.push(result); },
  };
}

function createBackgroundApp({ storage = fakeStorage(), server = createFakeServer(), clock = performance } = {}) {
  let connectListener;
  const runtimeListeners = [];
  const context = {
    Promise, Map, Set, URL, TextEncoder, TextDecoder, Buffer, performance: clock,
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
        server.patchVersions,
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
      { id: "bottom", translation: "vi:bottom" },
      { id: "left", translation: "vi:left" },
      { id: "right", translation: "vi:right" },
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
    assert.deepStrictEqual({ ...server.counts, source: calls.source }, calls);
    assert.strictEqual(server.counts.source, calls.source + 1);
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
    assert.deepStrictEqual({ ...server.counts, source: before.source }, before);
    assert.strictEqual(server.counts.source, before.source + 2);
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
      [{ id: "b2", translation: "two" }],
      [{ id: "b2", translation: "two" }, { id: "foreign", translation: "wrong" }],
      [{ id: "b2", translation: "two" }, { id: "b2", translation: "duplicate" }],
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
  assert.strictEqual(new Set([translationKey, ltrTranslationKey, layoutTranslationKey, promptTranslationKey, policyTranslationKey]).size, 5);

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
