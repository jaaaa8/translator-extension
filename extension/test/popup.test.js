const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function deferred() {
  let resolve;
  return { promise: new Promise((done) => (resolve = done)), resolve };
}

function popup({ tabs = [{ id: 7 }], pageStatus = { background: 0, cached: 0, failed: 0 } } = {}) {
  const settings = deferred();
  const health = deferred();
  const elements = {};
  const sent = [];
  const queries = [];
  const tabCallbacks = [];
  const translateCallbacks = [];
  const writes = [];
  let lastErrorReads = 0;
  const $ = (id) =>
    (elements[id] ||= { checked: false, value: "", textContent: "", style: {}, disabled: false });
  const runtime = {
    sendMessage: (message) => {
      if (message.type === "health") return health.promise;
      if (message.type === "pageStatus") {
        return Promise.resolve(Array.isArray(pageStatus) ? pageStatus.shift() : pageStatus);
      }
      return Promise.resolve();
    },
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
          if (message.type === "translatePage") translateCallbacks.push(done);
          else done();
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
    replyTranslate: (response) => translateCallbacks.at(-1)(response),
    replyTranslateAt: (index, response) => translateCallbacks[index](response),
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
  const direction = popup();
  direction.elements.readingDirection ||= { value: "" };
  direction.elements.currentLanguages ||= { textContent: "" };
  direction.settings.resolve({ srcLang: "es", dstLang: "vi" });
  await flush();
  assert.strictEqual(direction.elements.readingDirection.value, "rtl");
  assert.match(direction.elements.currentLanguages.textContent, /RTL/);
  assert.deepStrictEqual(direction.writes, []);
  direction.elements.readingDirection.onchange({ target: { value: "ltr" } });
  assert.deepStrictEqual({ ...direction.writes.at(-1) }, { readingDirection: "ltr" });

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

  const ready = popup({
    pageStatus: [
      { background: 2, cached: 8, failed: 1 },
      { background: 0, cached: 9, failed: 2 },
    ],
  });
  ready.settings.resolve({ srcLang: "ja", dstLang: "vi" });
  ready.health.resolve({ ok: true, device: "cpu" });
  await flush();
  assert.strictEqual(ready.elements.cacheStatus.textContent, "Đang dịch nền: 2 · Đã cache: 8 · Lỗi: 1");
  ready.elements.srcLang.value = "es";
  ready.elements.dstLang.value = "en";
  ready.elements.readingDirection.onchange({ target: { value: "ltr" } });

  ready.elements.translateVisible.onclick();
  ready.elements.srcLang.value = "ja";
  ready.elements.dstLang.value = "vi";
  ready.elements.readingDirection.onchange({ target: { value: "rtl" } });
  ready.elements.translateLoaded.onclick();
  assert.strictEqual(ready.elements.translateVisible.disabled, false);
  assert.strictEqual(ready.elements.translateLoaded.disabled, false);
  ready.releaseTabs();
  const translations = ready.sent.filter((row) => row.message.type === "translatePage");
  assert.deepStrictEqual(translations, [
    { id: 7, message: { type: "translatePage", scope: "visible", srcLang: "es", dstLang: "en", readingDirection: "ltr" } },
    { id: 7, message: { type: "translatePage", scope: "loaded", srcLang: "ja", dstLang: "vi", readingDirection: "rtl" } },
  ]);
  ready.replyTranslateAt(0, { ok: true, images: 1, blocks: 1, failed: 0 });
  assert.strictEqual(ready.elements.result.textContent, "đang dịch…");
  ready.replyTranslateAt(1, { ok: true, images: 1, blocks: 4, failed: 0, cacheHit: true });
  await flush();
  assert.strictEqual(ready.elements.result.textContent, "Khôi phục từ cache");
  assert.strictEqual(ready.elements.cacheStatus.textContent, "Đang dịch nền: 0 · Đã cache: 9 · Lỗi: 2");

  const failed = popup();
  failed.settings.resolve({ srcLang: "ja", dstLang: "vi" });
  failed.health.resolve({ ok: false });
  await flush();
  failed.elements.translateVisible.onclick();
  failed.releaseTabs();
  failed.replyTranslate({ ok: true, images: 2, blocks: 5, failed: 3, cacheHit: false });
  assert.strictEqual(failed.elements.result.textContent, "xong: 2 ảnh, 5 thoại, 3 lỗi");
  console.log("popup.test.js OK");
})();
