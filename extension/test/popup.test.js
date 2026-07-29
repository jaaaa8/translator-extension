const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function deferred() {
  let resolve;
  return { promise: new Promise((done) => (resolve = done)), resolve };
}

function popup({ tabs = [{ id: 7 }] } = {}) {
  const settings = deferred();
  const health = deferred();
  const elements = {};
  const sent = [];
  const queries = [];
  const tabCallbacks = [];
  const writes = [];
  let lastErrorReads = 0;
  const $ = (id) =>
    (elements[id] ||= { checked: false, value: "", textContent: "", style: {}, disabled: false });
  const runtime = {
    sendMessage: (message) => (message.type === "health" ? health.promise : Promise.resolve()),
  };
  Object.defineProperty(runtime, "lastError", {
    get: () => {
      lastErrorReads++;
      return null;
    },
  });
  const context = {
    Promise,
    document: { getElementById: $ },
    chrome: {
      storage: { local: { get: () => settings.promise, set: (value) => writes.push(value) } },
      runtime,
      tabs: {
        query: (query, done) => {
          queries.push({ ...query });
          tabCallbacks.push(() => done(tabs));
        },
        sendMessage: (id, message, done) => {
          sent.push({ id, message: { ...message } });
          done();
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("extension/popup.js", "utf8"), context);
  return {
    elements,
    health,
    lastErrorReads: () => lastErrorReads,
    queries,
    releaseTabs: () => tabCallbacks.splice(0).forEach((done) => done()),
    sent,
    settings,
    writes,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

(async () => {
  const first = popup();
  first.settings.resolve({ srcLang: "es", dstLang: "vi" });
  await flush();
  assert.deepStrictEqual(first.sent, []);
  first.health.resolve({ ok: true, device: "cpu" });
  await flush();
  assert.deepStrictEqual(first.queries, [{ active: true, currentWindow: true }]);
  assert.deepStrictEqual(first.sent, []);

  first.elements.srcLang.onchange({ target: { value: "ja" } });
  assert.deepStrictEqual(first.writes.map((value) => ({ ...value })), [{ srcLang: "ja" }]);
  assert.deepStrictEqual(first.queries, [
    { active: true, currentWindow: true },
    { active: true, currentWindow: true },
  ]);
  first.releaseTabs();
  assert.deepStrictEqual(first.sent, [
    { id: 7, message: { type: "prewarmPage", srcLang: "es" } },
    { id: 7, message: { type: "prewarmPage", srcLang: "ja" } },
  ]);
  assert.strictEqual(first.lastErrorReads(), 2);
  assert.deepStrictEqual(first.sent[1], { id: 7, message: { type: "prewarmPage", srcLang: "ja" } });

  const healthFirst = popup();
  healthFirst.health.resolve({ ok: true, device: "cpu" });
  await flush();
  assert.deepStrictEqual(healthFirst.queries, []);
  healthFirst.settings.resolve({ srcLang: "es" });
  await flush();
  assert.deepStrictEqual(healthFirst.queries, [{ active: true, currentWindow: true }]);
  healthFirst.releaseTabs();
  assert.deepStrictEqual(healthFirst.sent, [{ id: 7, message: { type: "prewarmPage", srcLang: "es" } }]);

  const offline = popup();
  offline.settings.resolve({ srcLang: "es" });
  offline.health.resolve({ ok: false });
  await flush();
  offline.elements.srcLang.onchange({ target: { value: "ja" } });
  assert.deepStrictEqual(offline.queries, []);
  assert.deepStrictEqual(offline.sent, []);

  const noTab = popup({ tabs: [] });
  noTab.settings.resolve({ srcLang: "es" });
  noTab.health.resolve({ ok: true, device: "cpu" });
  await flush();
  noTab.releaseTabs();
  assert.deepStrictEqual(noTab.sent, []);
  console.log("popup.test.js OK");
})();
