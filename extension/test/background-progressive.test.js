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

  // End-to-end producer ownership: removing persistUntilDone on disconnect
  // must make this fail by losing the cached second request.
  const store = {};
  const progressiveVersions = { detector: "d1", dedupe: "dd1", prep: "p1", recognizers: { ja: "r-ja" }, translator_model: "g1", prompt: "pr1", policy: "po1", page_schema: "page-v1" };
  const storage = {
    async get(key) { if (key === null) return { ...store }; return { [key]: store[key] }; },
    async set(rows) { Object.assign(store, rows); },
    async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
    async getBytesInUse() { return Buffer.byteLength(JSON.stringify(store)); },
  };
  const calls = { source: 0, ocr: 0, translate: 0 };
  const progressive = {
    Promise, JSON, Map, Set, URL, TextEncoder, TextDecoder, Buffer,
    crypto: webcrypto, console, setTimeout, clearTimeout, AbortController, FormData, Blob,
    importScripts: () => {}, structuredClone,
    chrome: { runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} } }, action: { setBadgeText() {}, setBadgeBackgroundColor() {} }, storage: { session: storage } },
    fetch: async (url) => {
      if (url.endsWith("/health")) return { ok: true, json: async () => ({ versions: progressive.__versions }) };
      if (url === "https://x/A.jpg") { calls.source++; return { ok: true, blob: async () => new Blob(["image"]) }; }
      if (url.endsWith("/ocr-stream")) { calls.ocr++; return { ok: true, body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(`{"type":"analysis_ready","image_w":100,"image_h":100}
{"type":"ocr_block","block_id":"b1","bbox":[1,2,3,4],"text":"ja"}
{"type":"image_done"}
`); } } }; }
      if (url.endsWith("/translate-items")) { calls.translate++; return { ok: true, json: async () => ({ items: [{ id: "b1", translation: "vi" }] }) }; }
      throw new Error(`unexpected ${url}`);
    },
  };
  vm.createContext(progressive);
  vm.runInContext(`globalThis.__versions = ${JSON.stringify(progressiveVersions)}`, progressive);
  vm.runInContext(fs.readFileSync("extension/page-cache.js", "utf8"), progressive);
  vm.runInContext(fs.readFileSync("extension/background.js", "utf8"), progressive);
  await progressive.ready;
  const port = () => ({ sent: [], postMessage(event) { this.sent.push(event); } });
  const first = port();
  const message = { type: "start_scope", request_id: "first", scope: "visible", src_lang: "ja", dst_lang: "vi", jobs: [{ job_id: "one", source_url: "https://x/A.jpg", natural_width: 100, natural_height: 100 }] };
  await progressive.acceptScope(first, message);
  progressive.disconnectPort(first);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(calls.source, 1, JSON.stringify(store));
  assert.strictEqual(calls.ocr, 1);
  assert.strictEqual(calls.translate, 1, JSON.stringify(store));
  const back = port();
  await progressive.acceptScope(back, { ...message, request_id: "back", jobs: [{ ...message.jobs[0], job_id: "two" }] });
  assert.ok(back.sent.some((event) => event.type === "translation" && event.trans_text === "vi"));
  assert.ok(back.sent.some((event) => event.type === "scope_done" && event.cache_hit));
  assert.deepStrictEqual(calls, { source: 1, ocr: 1, translate: 1 });
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
