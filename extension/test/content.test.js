const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

let storageChanged;
let resolveOcr;
const messages = [];
let ocrReplies = [];
const rendered = [];

function deferred() {
  let resolve;
  return { promise: new Promise((done) => { resolve = done; }), resolve };
}

function fakeImage(src, rect) {
  return {
    src,
    currentSrc: "",
    complete: true,
    naturalWidth: 1000,
    naturalHeight: 1600,
    isConnected: true,
    baseURI: "https://x/",
    parentElement: null,
    getAttribute: () => "",
    getBoundingClientRect: () => rect,
    getClientRects: () => [rect],
  };
}

const image = fakeImage(
  "https://x/page.jpg",
  { left: 10, top: 20, right: 510, bottom: 820, width: 500, height: 800 }
);
const smallVisibleImage = fakeImage(
  "https://x/small-visible.jpg",
  { left: 0, top: 500, right: 200, bottom: 700, width: 200, height: 200 }
);
const largeVisibleImage = fakeImage(
  "https://x/large-visible.jpg",
  { left: 0, top: -300, right: 600, bottom: 100, width: 600, height: 400 }
);
let images = [image];
const body = { appendChild: (element) => rendered.push(element) };
const context = {
  Promise,
  WeakMap,
  Map,
  URL,
  console,
  innerWidth: 800,
  innerHeight: 600,
  scrollX: 3,
  scrollY: 4,
  requestAnimationFrame: () => 1,
  document: {
    body,
    documentElement: {},
    querySelectorAll: () => images,
    createElement: () => ({
      style: {},
      children: [],
      removed: false,
      appendChild(child) { this.children.push(child); },
      remove() { this.removed = true; },
    }),
  },
  window: { addEventListener: () => {} },
  MutationObserver: class { observe() {} },
  ResizeObserver: class { disconnect() {} observe() {} },
  IntersectionObserver: class { disconnect() {} observe() {} },
  chrome: {
    storage: {
      local: { get: () => Promise.resolve({ srcLang: "ja", dstLang: "vi" }) },
      onChanged: { addListener: (listener) => { storageChanged = listener; } },
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: (message) => {
        messages.push(message);
        if (message.type === "ocrImage") {
          if (ocrReplies.length) return Promise.resolve(ocrReplies.shift());
          return new Promise((resolve) => { resolveOcr = resolve; });
        }
        return Promise.resolve({ ok: true, translations: message.texts.map((text) => `${text}-vi`) });
      },
    },
  },
};

vm.createContext(context);
vm.runInContext(fs.readFileSync("extension/srcset.js", "utf8"), context);
vm.runInContext(fs.readFileSync("extension/content.js", "utf8"), context);

(async () => {
  await Promise.resolve();
  const page = context.translatePage("loaded");
  storageChanged({ srcLang: { newValue: "en" }, dstLang: { newValue: "fr" } });
  resolveOcr({
    ok: true,
    image_w: 1000,
    image_h: 400,
    blocks: [{ src_text: "text", bbox: [100, 50, 200, 100] }],
  });
  await page;

  assert.deepStrictEqual({ ...messages[0] }, { type: "ocrImage", url: "https://x/page.jpg", srcLang: "ja" });
  assert.deepStrictEqual(
    { ...messages[1], texts: [...messages[1].texts] },
    { type: "translateTexts", texts: ["text"], srcLang: "ja", dstLang: "vi" }
  );

  const firstOverlay = rendered.at(-1);
  assert.deepStrictEqual({ ...firstOverlay.style }, {
    left: "13px",
    top: "24px",
    width: "500px",
    height: "800px",
  });
  assert.deepStrictEqual({ ...firstOverlay.children[0].style }, {
    left: "50px",
    top: "100px",
    width: "100px",
    height: "200px",
    fontSize: "18px",
  });

  const regressions = [];
  const regression = async (name, check) => {
    try {
      await check();
    } catch (error) {
      regressions.push(`${name}: ${error.message}`);
    }
  };

  await regression("all-empty OCR removes its overlay", async () => {
    ocrReplies = [{ ok: true, image_w: 1000, image_h: 400, blocks: [] }];
    await context.translatePage("loaded");
    assert.strictEqual(firstOverlay.removed, true);
  });

  await regression("mixed empty slot removes only its owned overlay", async () => {
    const emptyImage = fakeImage(
      "https://x/mixed-empty.jpg",
      { left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600 }
    );
    const textImage = fakeImage(
      "https://x/mixed-text.jpg",
      { left: 400, top: 0, right: 800, bottom: 600, width: 400, height: 600 }
    );
    context.renderOverlay(emptyImage, {
      image_w: 800,
      image_h: 1200,
      blocks: [{ src_text: "old", trans_text: "old-vi", bbox: [10, 20, 30, 40] }],
    }, emptyImage.src, "loaded");
    const emptyOverlay = rendered.at(-1);
    images = [emptyImage, textImage];
    ocrReplies = [
      { ok: true, image_w: 800, image_h: 1200, blocks: [] },
      { ok: true, image_w: 800, image_h: 1200, blocks: [{ src_text: "new", bbox: [10, 20, 30, 40] }] },
    ];
    await context.translatePage("loaded");
    assert.strictEqual(emptyOverlay.removed, true);
  });

  await regression("zero-job manual action supersedes an older crop", async () => {
    let edgeRect = { left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600 };
    const edgeImage = fakeImage("https://x/zero-job-race.jpg", edgeRect);
    edgeImage.getBoundingClientRect = () => edgeRect;
    edgeImage.getClientRects = () => [edgeRect];
    images = [edgeImage];
    ocrReplies = [{
      ok: true,
      image_w: 1200,
      image_h: 1200,
      blocks: [{ src_text: "current", bbox: [10, 20, 30, 40] }],
    }];
    await context.translatePage("loaded");
    const currentOverlay = rendered.at(-1);

    edgeRect = { left: 0, top: -300, right: 600, bottom: 100, width: 600, height: 400 };
    const oldOcr = deferred();
    ocrReplies = [oldOcr.promise];
    const older = context.translatePage("visible");
    const messageCount = messages.length;
    await context.translatePage("loaded");
    assert.strictEqual(messages.length, messageCount);

    oldOcr.resolve({
      ok: true,
      image_w: 1200,
      image_h: 800,
      blocks: [{ src_text: "stale", bbox: [10, 20, 30, 40] }],
    });
    await older;
    assert.strictEqual(currentOverlay.removed, false);
    assert.strictEqual(rendered.filter((overlay) => !overlay.removed).at(-1).children[0].textContent, "current-vi");

    ocrReplies = [{ ok: true, image_w: 1200, image_h: 1200, blocks: [] }];
    const afterOlder = messages.length;
    await context.translatePage("loaded");
    assert.strictEqual(messages.length, afterOlder);
  });

  await regression("only the newest manual action may render or complete", async () => {
    const raceImage = fakeImage(
      "https://x/race.jpg",
      { left: 0, top: -300, right: 600, bottom: 100, width: 600, height: 400 }
    );
    images = [raceImage];
    const oldOcr = deferred();
    const newOcr = deferred();
    ocrReplies = [oldOcr.promise, newOcr.promise];
    const older = context.translatePage("visible");
    const newer = context.translatePage("loaded");
    newOcr.resolve({
      ok: true,
      image_w: 1200,
      image_h: 800,
      blocks: [{ src_text: "new", bbox: [10, 20, 30, 40] }],
    });
    await newer;
    const newestOverlay = rendered.at(-1);
    oldOcr.resolve({
      ok: true,
      image_w: 1200,
      image_h: 800,
      blocks: [{ src_text: "old", bbox: [10, 20, 30, 40] }],
    });
    await older;
    assert.strictEqual(newestOverlay.removed, false);
    assert.strictEqual(rendered.filter((overlay) => !overlay.removed).at(-1).children[0].textContent, "new-vi");

    ocrReplies = [{ ok: true, image_w: 1200, image_h: 800, blocks: [] }];
    const messageCount = messages.length;
    await context.translatePage("loaded");
    assert.strictEqual(messages.length, messageCount);
  });

  messages.length = 0;
  images = [smallVisibleImage, largeVisibleImage];
  ocrReplies = [{ ok: true, image_w: 1200, image_h: 1800, blocks: [] }];

  await context.prewarmPage("es");

  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].type, "ocrImage");
  assert.strictEqual(messages[0].url, largeVisibleImage.currentSrc || largeVisibleImage.src);
  assert.strictEqual(messages[0].srcLang, "es");
  assert.strictEqual(messages[0].prewarm, true);
  assert.ok(messages[0].crop);
  assert.strictEqual(messages.some((message) => message.type === "translateTexts"), false);
  if (regressions.length) throw new Error(regressions.join("\n"));
  console.log("content.test.js OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
