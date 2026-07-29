const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const timeouts = [];
const ocrPosts = [];
const translationPosts = [];
const sourceFetches = [];
const badgeTexts = [];
let badgeCalls = 0;
let failNextOcr = false;
let failNextTranslation = false;
let firstOcr = true;
let releaseFirstOcr;
let releaseNextOcr;
let holdNextOcr = false;
let resolveFirstOcrStarted;
let resolveNextOcrStarted;
let runtimeListener;
let holdQueuedOcr = false;
const queuedStarts = [];
const queuedReleases = [];
const firstOcrStarted = new Promise((resolve) => { resolveFirstOcrStarted = resolve; });
const nextOcrStarted = new Promise((resolve) => { resolveNextOcrStarted = resolve; });

class FakeFormData {
  constructor() { this.fields = []; }
  append(name, value) { this.fields.push([name, value]); }
}

const context = {
  Promise,
  JSON,
  FormData: FakeFormData,
  AbortSignal: { timeout: (ms) => (timeouts.push(ms), { ms }) },
  fetch: async (url, options) => {
    if (!options) {
      sourceFetches.push(url);
      return { ok: true, blob: async () => ({ url }) };
    }
    if (url.endsWith("/ocr")) {
      ocrPosts.push({ url, body: options.body, timeout: options.signal.ms });
      if (holdQueuedOcr) {
        queuedStarts.push(options.body.fields[0][1].url);
        await new Promise((resolve) => queuedReleases.push(resolve));
      } else if (firstOcr) {
        firstOcr = false;
        resolveFirstOcrStarted();
        await new Promise((resolve) => { releaseFirstOcr = resolve; });
      } else if (holdNextOcr) {
        holdNextOcr = false;
        resolveNextOcrStarted();
        await new Promise((resolve) => { releaseNextOcr = resolve; });
      }
      if (failNextOcr) {
        failNextOcr = false;
        return { ok: false, status: 500, json: async () => ({ error: "failed" }) };
      }
      return { ok: true, json: async () => ({ blocks: [] }) };
    }
    translationPosts.push({ url, timeout: options.signal.ms });
    if (failNextTranslation) {
      failNextTranslation = false;
      return { ok: false, status: 500, json: async () => ({ error: "failed" }) };
    }
    return { ok: true, json: async () => ({ translations: ["xin chào"] }) };
  },
  chrome: {
    runtime: { onMessage: { addListener: (listener) => { runtimeListener = listener; } } },
    action: {
      setBadgeText: ({ text }) => {
        badgeTexts.push(text);
        if (text === "!") badgeCalls++;
      },
      setBadgeBackgroundColor: () => {},
    },
  },
};

vm.createContext(context);
vm.runInContext(fs.readFileSync("extension/background.js", "utf8"), context);

(async () => {
  const crop = { left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 };
  const prewarm = context.ocrImage({ url: "https://x/page.jpg", srcLang: "es", crop, prewarm: true });
  const click = context.ocrImage({ url: "https://x/page.jpg", srcLang: "es", crop });

  await firstOcrStarted;
  assert.strictEqual(ocrPosts.length, 1);
  assert.strictEqual(sourceFetches.length, 1);
  releaseFirstOcr();
  await Promise.all([prewarm, click]);

  assert.strictEqual(ocrPosts.length, 1);
  assert.strictEqual(sourceFetches.length, 1);
  await context.ocrImage({ url: "https://x/page.jpg", srcLang: "es", crop });
  assert.strictEqual(ocrPosts.length, 1);
  assert.strictEqual(sourceFetches.length, 1);
  assert.deepStrictEqual([...ocrPosts[0].body.fields].slice(1), [
    ["src_lang", "es"],
    ["crop_left", 0.1],
    ["crop_top", 0.2],
    ["crop_right", 0.8],
    ["crop_bottom", 0.9],
  ]);

  await context.ocrImage({
    url: "https://x/page.jpg",
    srcLang: "es",
    crop: { left: 0.1, top: 0.3, right: 0.8, bottom: 0.9 },
  });
  assert.strictEqual(ocrPosts.length, 2);

  failNextOcr = true;
  holdNextOcr = true;
  const failedPrewarm = context.ocrImage({ url: "https://x/join.jpg", srcLang: "ja", prewarm: true });
  const failedClick = context.ocrImage({ url: "https://x/join.jpg", srcLang: "ja" });
  await nextOcrStarted;
  releaseNextOcr();
  await assert.rejects(Promise.all([failedPrewarm, failedClick]));
  assert.strictEqual(badgeCalls, 1);

  failNextOcr = true;
  await assert.rejects(context.ocrImage({ url: "https://x/retry.jpg", srcLang: "ja", prewarm: true }));
  const badgesAfterQuietFailure = badgeCalls;
  await context.ocrImage({ url: "https://x/retry.jpg", srcLang: "ja" });
  assert.strictEqual(ocrPosts.length, 5);
  assert.strictEqual(badgeCalls, badgesAfterQuietFailure);

  const badgesBeforeTranslationFailure = badgeCalls;
  failNextTranslation = true;
  await assert.rejects(context.translateTexts({ texts: ["hola"], srcLang: "es", dstLang: "vi" }));
  assert.strictEqual(badgeCalls, badgesBeforeTranslationFailure + 1);

  const clearsBeforeTranslation = badgeTexts.filter((text) => text === "").length;
  const result = await context.translateTexts({ texts: ["hola"], srcLang: "es", dstLang: "vi" });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual([...result.translations], ["xin chào"]);
  assert.strictEqual(badgeTexts.filter((text) => text === "").length, clearsBeforeTranslation + 1);
  assert.ok(ocrPosts.every((post) => post.timeout === 60_000));
  assert.ok(translationPosts.every((post) => post.timeout === 300_000));
  assert.strictEqual(timeouts.filter((timeout) => timeout === 60_000).length, ocrPosts.length);

  holdQueuedOcr = true;
  const queuedUrls = ["https://x/queued-1.jpg", "https://x/queued-2.jpg", "https://x/queued-3.jpg"];
  const queuedResponses = queuedUrls.map((url) => new Promise((resolve) => {
    assert.strictEqual(runtimeListener({ type: "ocrImage", url, srcLang: "ja" }, {}, resolve), true);
  }));
  assert.deepStrictEqual(sourceFetches.slice(-2), queuedUrls.slice(0, 2));
  while (queuedStarts.length < 2) await Promise.resolve();
  assert.deepStrictEqual(queuedStarts, queuedUrls.slice(0, 2));
  queuedReleases.shift()();
  while (queuedStarts.length < 3) await Promise.resolve();
  assert.deepStrictEqual(queuedStarts, queuedUrls);
  queuedReleases.splice(0).forEach((release) => release());
  await Promise.all(queuedResponses);
  console.log("background.test.js OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
