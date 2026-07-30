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
