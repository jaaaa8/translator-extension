const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

let storageChanged;
let resolveOcr;
const messages = [];
const image = {
  src: "https://x/page.jpg",
  complete: true,
  naturalWidth: 1000,
  naturalHeight: 1600,
  isConnected: true,
  baseURI: "https://x/",
  parentElement: null,
  getAttribute: () => "",
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 500, bottom: 800, width: 500, height: 800 }),
  getClientRects: () => [{}],
};
const body = { appendChild: () => {} };
const context = {
  Promise,
  WeakMap,
  Map,
  URL,
  console,
  innerWidth: 800,
  innerHeight: 600,
  scrollX: 0,
  scrollY: 0,
  requestAnimationFrame: () => 1,
  document: {
    body,
    documentElement: {},
    querySelectorAll: () => [image],
    createElement: () => ({ style: {}, children: [], appendChild(child) { this.children.push(child); }, remove() {} }),
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
        if (message.type === "ocrImage") return new Promise((resolve) => { resolveOcr = resolve; });
        return Promise.resolve({ ok: true, translations: ["translated"] });
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
  resolveOcr({ ok: true, blocks: [{ src_text: "text", bbox: [0, 0, 1, 1] }] });
  await page;

  assert.deepStrictEqual({ ...messages[0] }, { type: "ocrImage", url: "https://x/page.jpg", srcLang: "ja" });
  assert.deepStrictEqual(
    { ...messages[1], texts: [...messages[1].texts] },
    { type: "translateTexts", texts: ["text"], srcLang: "ja", dstLang: "vi" }
  );
  console.log("content.test.js OK");
})();
