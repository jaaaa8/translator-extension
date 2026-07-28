# Layout Translation Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit “loaded webtoon” and “visible reader page” translation actions while preventing stale overlays when reader images change.

**Architecture:** Keep the existing popup → content script → background queue → local server flow. Put deterministic image selection/source predicates in the already-loaded `srcset.js`, pass an explicit `scope` through the existing `translatePage` message, and make each overlay own and clean up its observers. The server API, OCR queue, and one-request Gemini batching remain unchanged.

**Tech Stack:** Chrome Extension Manifest V3, vanilla JavaScript, DOM observers (`MutationObserver`, `IntersectionObserver`, `ResizeObserver`), Node.js built-in `assert`.

## Global Constraints

- Expose exactly two manual actions: `scope: "loaded"` and `scope: "visible"`.
- Popup copy is exactly **Dịch webtoon đã tải** and **Dịch trang đang xem**.
- Do not auto-detect layout, persist a mode, or auto-translate.
- Support DOM `<img>`/`<picture>` readers only; fullscreen, canvas, and CSS background readers remain out of scope.
- Snapshot `bestSource(img)` before OCR and discard results whose image disconnected or source changed.
- Keep OCR at the existing maximum of 2 concurrent requests and send successful text through one `/translate-texts` request.
- Add no dependency and make no server/API change.
- Keep the existing 400 px minimum image dimension.
- Run `graphify update .` after the code changes, per `AGENTS.md`.
- The approved spec is `docs/superpowers/specs/2026-07-23-layout-modes-unified-design.md`; commit it before the first implementation commit if it is still uncommitted.

---

## File Structure

- Modify `extension/srcset.js`: retain full-resolution source selection; add pure eligibility, viewport, current-source, and scoped-candidate helpers.
- Modify `extension/test/srcset.test.js`: dependency-free regression checks for both scopes and stale-source rejection.
- Modify `extension/content.js`: consume scoped jobs, track translated source URLs, discard stale async results, and own overlay cleanup.
- Modify `extension/popup.html`: replace the single translation button with two explicit actions.
- Modify `extension/popup.js`: send the selected scope and disable both actions during a request.
- Modify `extension/test/fixture.html`: manual webtoon/reader controls for source swaps, DOM replacement, viewport exit, and async races.
- Do not modify `extension/background.js`, `extension/manifest.json`, or any `server/` file.

---

### Task 1: Pure Image Selection and Source Guards

**Files:**
- Modify: `extension/srcset.js:4-24`
- Modify: `extension/test/srcset.test.js:1-30`

**Interfaces:**
- Consumes: existing `bestSource(img): string`.
- Produces: `eligible(img, minSize = 400): boolean`.
- Produces: `isViewportVisible(img, viewportWidth, viewportHeight): boolean`.
- Produces: `isCurrentSource(img, source): boolean`.
- Produces: `selectCandidates(images, scope, translated, viewportWidth, viewportHeight, minSize = 400): Array<{img, source}>`.
- Browser exposure: function declarations remain global because `srcset.js` loads before `content.js`.
- Node exposure: `module.exports` contains all five functions.

- [ ] **Step 1: Write the failing selection tests**

In `extension/test/srcset.test.js`, replace the destructuring import with:

```js
const {
  bestSource,
  eligible,
  isViewportVisible,
  isCurrentSource,
  selectCandidates,
} = require("../srcset.js");
```

Keep the existing three `bestSource` assertions. Insert this exact block before the final `console.log`:

```js
const onscreen = { left: 0, top: 0, right: 600, bottom: 500, width: 600, height: 500 };

function fakeImage({
  src = "https://x/page.jpg",
  complete = true,
  naturalWidth = 1000,
  naturalHeight = 1600,
  isConnected = true,
  rect = onscreen,
} = {}) {
  return {
    src,
    currentSrc: "",
    complete,
    naturalWidth,
    naturalHeight,
    isConnected,
    baseURI: "https://x/",
    parentElement: null,
    getAttribute: () => "",
    getBoundingClientRect: () => rect,
    getClientRects: () => (rect.width > 0 && rect.height > 0 ? [rect] : []),
  };
}

const doneImage = fakeImage({ src: "https://x/done.jpg" });
const offscreenImage = fakeImage({
  src: "https://x/offscreen.jpg",
  rect: { left: 0, top: 900, right: 600, bottom: 1400, width: 600, height: 500 },
});
const smallImage = fakeImage({ src: "https://x/icon.jpg", naturalWidth: 100, naturalHeight: 100 });
const incompleteImage = fakeImage({ src: "https://x/loading.jpg", complete: false });
const translated = new WeakMap([[doneImage, doneImage.src]]);

assert.deepStrictEqual(
  selectCandidates([doneImage, offscreenImage, smallImage, incompleteImage], "loaded", translated, 800, 600),
  [{ img: offscreenImage, source: offscreenImage.src }]
);

const visibleImage = fakeImage({ src: "https://x/visible.jpg" });
const partiallyVisibleImage = fakeImage({
  src: "https://x/partial.jpg",
  rect: { left: 0, top: -300, right: 600, bottom: 100, width: 600, height: 400 },
});
const zeroSizeImage = fakeImage({
  src: "https://x/hidden.jpg",
  rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
});
assert.deepStrictEqual(
  selectCandidates([visibleImage, partiallyVisibleImage, offscreenImage], "visible", new WeakMap(), 800, 600),
  [
    { img: visibleImage, source: visibleImage.src },
    { img: partiallyVisibleImage, source: partiallyVisibleImage.src },
  ]
);

doneImage.src = "https://x/new-page.jpg";
assert.deepStrictEqual(
  selectCandidates([doneImage], "loaded", translated, 800, 600),
  [{ img: doneImage, source: doneImage.src }]
);

assert.strictEqual(eligible(visibleImage), true);
assert.strictEqual(eligible(smallImage), false);
assert.strictEqual(isViewportVisible(visibleImage, 800, 600), true);
assert.strictEqual(isViewportVisible(partiallyVisibleImage, 800, 600), true);
assert.strictEqual(isViewportVisible(offscreenImage, 800, 600), false);
assert.strictEqual(isViewportVisible(zeroSizeImage, 800, 600), false);

const currentImage = fakeImage({ src: "https://x/current.jpg" });
assert.strictEqual(isCurrentSource(currentImage, currentImage.src), true);
currentImage.src = "https://x/replaced.jpg";
assert.strictEqual(isCurrentSource(currentImage, "https://x/current.jpg"), false);
currentImage.isConnected = false;
assert.strictEqual(isCurrentSource(currentImage, currentImage.src), false);

assert.throws(
  () => selectCandidates([], "auto", new WeakMap(), 800, 600),
  /scope không hỗ trợ/
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node extension/test/srcset.test.js
```

Expected: FAIL because `eligible`, `isViewportVisible`, `isCurrentSource`, and `selectCandidates` are not exported yet.

- [ ] **Step 3: Implement the minimal helpers**

In `extension/srcset.js`, add these functions after `bestSource`:

```js
function eligible(img, minSize = 400) {
  return img.naturalWidth >= minSize && img.naturalHeight >= minSize && Boolean(bestSource(img));
}

function isViewportVisible(img, viewportWidth, viewportHeight) {
  const rect = img.getBoundingClientRect();
  return Boolean(
    img.getClientRects().length &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < viewportHeight &&
      rect.left < viewportWidth
  );
}

function isCurrentSource(img, source) {
  return img.isConnected && bestSource(img) === source;
}

function selectCandidates(images, scope, translated, viewportWidth, viewportHeight, minSize = 400) {
  if (scope !== "loaded" && scope !== "visible") throw new Error(`scope không hỗ trợ: ${scope}`);

  const jobs = [];
  for (const img of images) {
    if (!img.complete || !eligible(img, minSize)) continue;
    const source = bestSource(img);
    if (translated.get(img) === source) continue;
    if (scope === "visible" && !isViewportVisible(img, viewportWidth, viewportHeight)) continue;
    jobs.push({ img, source });
  }
  return jobs;
}
```

Replace the CommonJS export with:

```js
if (typeof module !== "undefined") {
  module.exports = { bestSource, eligible, isViewportVisible, isCurrentSource, selectCandidates };
}
```

- [ ] **Step 4: Run the focused checks**

Run:

```powershell
node extension/test/srcset.test.js
node --check extension/srcset.js
```

Expected: `srcset.test.js OK`; syntax check exits 0.

- [ ] **Step 5: Commit the helper slice**

```powershell
git add extension/srcset.js extension/test/srcset.test.js
git commit -m "feat: select translation images by scope"
```

---

### Task 2: Explicit Popup Actions and Scoped Translation Pipeline

**Files:**
- Modify: `extension/content.js:7-82`
- Modify: `extension/popup.html:5-31`
- Modify: `extension/popup.js:19-33`

**Interfaces:**
- Consumes: `selectCandidates(...)` and `isCurrentSource(img, source)` from Task 1.
- Consumes: existing background messages `ocrImage` and `translateTexts` without changing their schemas.
- Produces: content message `{ type: "translatePage", scope: "loaded" | "visible" }`.
- Produces: response `{ ok: true, images: number, blocks: number }` or `{ ok: false, error: string }`.
- Produces: `translated: WeakMap<HTMLImageElement, string>` replacing `done`.

- [ ] **Step 1: Run a failing popup-contract check**

Run against the current popup:

```powershell
node -e 'const a=require("assert"),f=require("fs");const h=f.readFileSync("extension/popup.html","utf8");const j=f.readFileSync("extension/popup.js","utf8");a(h.includes("id=\"translateLoaded\""));a(h.includes("id=\"translateVisible\""));a(j.includes("scope"));'
```

Expected: FAIL because the popup still contains only `id="go"` and sends no scope.

- [ ] **Step 2: Replace the popup button markup**

Add these rules inside the existing `<style>` block in `extension/popup.html`:

```css
.action { width: 100%; margin-top: 12px; padding: 8px; font-weight: bold; cursor: pointer; }
.action + .action { margin-top: 6px; }
```

Replace the existing `button#go` with:

```html
<button id="translateLoaded" class="action">Dịch webtoon đã tải</button>
<button id="translateVisible" class="action">Dịch trang đang xem</button>
```

- [ ] **Step 3: Send an explicit scope and disable both buttons**

Replace the click-handler block at the end of `extension/popup.js` with:

```js
const actions = [$("translateLoaded"), $("translateVisible")];

function setActionsDisabled(disabled) {
  for (const button of actions) button.disabled = disabled;
}

function translate(scope) {
  setActionsDisabled(true);
  $("result").textContent = "đang dịch… (OCR local + 1 call Gemini)";
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.tabs.sendMessage(tab.id, { type: "translatePage", scope }, (res) => {
      setActionsDisabled(false);
      if (chrome.runtime.lastError) {
        $("result").textContent = "không kết nối được trang — F5 trang rồi thử lại";
        return;
      }
      $("result").textContent =
        res && res.ok ? `xong: ${res.images} ảnh, ${res.blocks} thoại` : `lỗi: ${res ? res.error : "?"}`;
    });
  });
}

$("translateLoaded").onclick = () => translate("loaded");
$("translateVisible").onclick = () => translate("visible");
```

- [ ] **Step 4: Switch the state and message contract**

In `extension/content.js`:

1. Replace `const done = new WeakSet()` with:

```js
const translated = new WeakMap(); // img -> bestSource đã hoàn tất
```

2. Pass the message scope into the pipeline:

```js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "translatePage") {
    translatePage(msg.scope).then(sendResponse);
    return true;
  }
});
```

3. Delete the local `eligible` function because Task 1 exposes the same predicate from `srcset.js`.

- [ ] **Step 5: Replace `translatePage` with the source-aware pipeline**

Use this complete function body:

```js
async function translatePage(scope) {
  let jobs;
  try {
    jobs = selectCandidates(
      document.querySelectorAll("img"),
      scope,
      translated,
      innerWidth,
      innerHeight,
      MIN_SIZE
    );
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  if (!jobs.length) return { ok: true, images: 0, blocks: 0 };

  const ocrResults = await Promise.all(
    jobs.map(({ source }) =>
      chrome.runtime.sendMessage({
        type: "ocrImage",
        url: source,
        srcLang,
      })
    )
  );

  const texts = [];
  const slots = [];
  ocrResults.forEach((res, i) => {
    if (!res || !res.ok) {
      if (res) console.warn("[MangaTranslator] ocr:", res.error);
      return;
    }
    const indices = res.blocks.map((b) => texts.push(b.src_text) - 1);
    slots.push({ ...jobs[i], data: res, indices });
  });

  if (!texts.length) {
    let images = 0;
    for (const slot of slots) {
      if (!isCurrentSource(slot.img, slot.source)) continue;
      translated.set(slot.img, slot.source);
      images++;
    }
    return { ok: true, images, blocks: 0 };
  }

  const tr = await chrome.runtime.sendMessage({ type: "translateTexts", texts, srcLang, dstLang });
  if (!tr || !tr.ok) return { ok: false, error: tr ? tr.error : "mất kết nối background" };

  let images = 0;
  let blocks = 0;
  for (const slot of slots) {
    if (!isCurrentSource(slot.img, slot.source)) continue;
    slot.data.blocks.forEach((block, i) => (block.trans_text = tr.translations[slot.indices[i]]));
    if (slot.data.blocks.length) renderOverlay(slot.img, slot.data, slot.source, scope);
    translated.set(slot.img, slot.source);
    images++;
    blocks += slot.data.blocks.length;
  }
  return { ok: true, images, blocks };
}
```

Passing `source` and `scope` to the current two-argument `renderOverlay` is safe in JavaScript; Task 3 will consume both parameters.

- [ ] **Step 6: Run focused automated checks**

Run:

```powershell
node extension/test/srcset.test.js
node --check extension/content.js
node --check extension/popup.js
node -e 'const a=require("assert"),f=require("fs");const h=f.readFileSync("extension/popup.html","utf8");const j=f.readFileSync("extension/popup.js","utf8");a(h.includes("id=\"translateLoaded\""));a(h.includes("id=\"translateVisible\""));a(j.includes("scope"));'
```

Expected: self-check prints `srcset.test.js OK`; every other command exits 0.

- [ ] **Step 7: Smoke-test the two actions**

Reload the unpacked extension, open any page containing one image larger than 400 × 400, then verify:

1. Popup shows both approved Vietnamese labels.
2. Clicking either button disables both until the response returns.
3. `Dịch trang đang xem` returns `0 ảnh` when the only eligible image is offscreen.
4. `Dịch webtoon đã tải` still selects that offscreen loaded image.
5. Repeating the same action on an unchanged source returns `0 ảnh`.

- [ ] **Step 8: Commit the scoped-action slice**

```powershell
git add extension/content.js extension/popup.html extension/popup.js
git commit -m "feat: add explicit layout translation actions"
```

---

### Task 3: Overlay Ownership, Page-Change Cleanup, and Browser Acceptance

**Files:**
- Modify: `extension/content.js:8,86-144`
- Modify: `extension/test/fixture.html:1-10`

**Interfaces:**
- Consumes: `isCurrentSource(img, source)` and Task 2’s `renderOverlay(img, data, source, scope)` call.
- Produces: `removeOverlay(img): void` as the only overlay teardown path.
- Produces: `pruneOverlays(): void` and `schedulePrune(): void` for disconnected/source-changed images.
- Produces: overlay entries `{ container, data, source, scope, resizeObserver, intersectionObserver }`.
- Observer policy: `intersectionObserver` is non-null only for `scope === "visible"`.

- [ ] **Step 1: Expand the manual fixture before changing lifecycle code**

Replace `extension/test/fixture.html` with:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>MangaTranslator layout fixture</title>
    <style>
      body { margin: 0; font-family: sans-serif; }
      h2, .controls { margin: 12px; }
      #webtoon img { width: 70%; display: block; margin: 20px auto; }
      .spacer { height: 900px; background: #eee; }
      #readerFrame { width: 80vw; height: 80vh; margin: 20px auto; overflow: hidden; }
      #readerPage { width: 100%; height: 100%; object-fit: contain; transition: transform 0.2s; }
      #readerPage.out { transform: translateX(120vw); }
    </style>
  </head>
  <body>
    <h2>Webtoon: loaded scope should translate both images</h2>
    <section id="webtoon">
      <img src="ja_page.png" />
      <img src="es_page.png" />
    </section>

    <div class="spacer">Scroll to the reader fixture below.</div>

    <h2>Reader: visible scope should translate only this page</h2>
    <div class="controls">
      <button id="swapSource">Đổi src cùng img</button>
      <button id="replacePage">Thay img node</button>
      <button id="moveViewport">Đẩy vào/ra viewport</button>
    </div>
    <div id="readerFrame">
      <img id="readerPage" src="ja_page.png" />
    </div>

    <script>
      const page = () => document.getElementById("readerPage");
      const otherSource = (img) => (img.src.endsWith("ja_page.png") ? "es_page.png" : "ja_page.png");

      document.getElementById("swapSource").onclick = () => {
        const img = page();
        img.src = otherSource(img);
      };

      document.getElementById("replacePage").onclick = () => {
        const img = page();
        const replacement = img.cloneNode();
        replacement.src = otherSource(img);
        replacement.classList.remove("out");
        img.replaceWith(replacement);
      };

      document.getElementById("moveViewport").onclick = () => page().classList.toggle("out");
    </script>
  </body>
</html>
```

- [ ] **Step 2: Reproduce both lifecycle failures**

Start the fixture server in a separate terminal and keep it running:

```powershell
python -m http.server 8000 --directory extension/test
```

Open `http://127.0.0.1:8000/fixture.html`, reload the unpacked extension, scroll to the reader, and run these checks before implementing cleanup:

1. Click **Dịch trang đang xem**, wait for its overlay, then click **Đổi src cùng img**.
2. Reload, translate the reader again, then click **Đẩy vào/ra viewport**.

Expected: both checks FAIL because the old overlay remains after the source changes or image leaves the viewport.

- [ ] **Step 3: Centralize overlay removal and observer ownership**

Update the `overlays` declaration in `extension/content.js` and add the frame guard:

```js
const overlays = new Map(); // img -> owned overlay state
let pruneFrame = 0;
```

Replace `renderOverlay` with the following block, including the cleanup helpers immediately before it:

```js
function removeOverlay(img) {
  const overlay = overlays.get(img);
  if (!overlay) return;
  overlay.resizeObserver.disconnect();
  if (overlay.intersectionObserver) overlay.intersectionObserver.disconnect();
  overlay.container.remove();
  overlays.delete(img);
  translated.delete(img);
}

function pruneOverlays() {
  for (const [img, overlay] of overlays) {
    if (!isCurrentSource(img, overlay.source)) removeOverlay(img);
  }
}

function schedulePrune() {
  if (pruneFrame) return;
  pruneFrame = requestAnimationFrame(() => {
    pruneFrame = 0;
    pruneOverlays();
  });
}

function renderOverlay(img, data, source, scope) {
  removeOverlay(img);

  const container = document.createElement("div");
  container.className = "mt-overlay";
  if (!enabled) container.style.display = "none";
  for (const block of data.blocks) {
    const element = document.createElement("div");
    element.className = "mt-bubble";
    element.textContent = block.trans_text;
    container.appendChild(element);
  }
  document.body.appendChild(container);

  const resizeObserver = new ResizeObserver(() => position(img));
  const intersectionObserver =
    scope === "visible"
      ? new IntersectionObserver(([entry]) => {
          if (!entry.isIntersecting) removeOverlay(img);
        })
      : null;

  overlays.set(img, { container, data, source, scope, resizeObserver, intersectionObserver });
  position(img);
  resizeObserver.observe(img);
  if (intersectionObserver) intersectionObserver.observe(img);
}
```

- [ ] **Step 4: Observe source/DOM changes and responsive source selection**

Replace the existing document resize observer and window listener at the bottom of `extension/content.js` with:

```js
function repositionOverlays() {
  schedulePrune();
  for (const img of overlays.keys()) position(img);
}

new MutationObserver(schedulePrune).observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["src", "srcset", "sizes", "media", "type"],
});

new ResizeObserver(repositionOverlays).observe(document.documentElement);
window.addEventListener("resize", repositionOverlays);
```

This single scheduled sweep handles direct `src` changes, `<picture><source>` changes, responsive `currentSrc` changes, removed image nodes, and removed ancestors. Do not add a polling loop or auto-translation callback.

- [ ] **Step 5: Run automated and syntax checks**

Run:

```powershell
node extension/test/srcset.test.js
node --check extension/srcset.js
node --check extension/content.js
node --check extension/popup.js
node --check extension/background.js
git diff --check
```

Expected: `srcset.test.js OK`; every syntax and diff check exits 0.

- [ ] **Step 6: Verify loaded-scope behavior in the fixture**

Using the running fixture:

1. On the webtoon section, **Dịch webtoon đã tải** overlays both loaded images.
2. Scroll away and back; loaded-scope overlays remain.
3. Repeat the loaded action; popup reports `0 ảnh` for unchanged sources.

- [ ] **Step 7: Verify reader cleanup and stale-result guards in the fixture**

At the reader section:

1. **Dịch trang đang xem** translates the visible reader image but not offscreen webtoon images.
2. Click **Đổi src cùng img**; the old overlay disappears. Click visible translation again; the new source receives the correct overlay.
3. Click **Thay img node**; the removed node’s overlay disappears and the replacement is eligible on the next click.
4. Click **Đẩy vào/ra viewport**; a visible-scope overlay disappears when the image leaves the viewport.
5. Start visible translation and immediately click **Đổi src cùng img**; the delayed result never renders on the new source.
6. Translate once more, then run this in DevTools Console; the `srcset` mutation removes the old overlay:

```js
const img = document.getElementById("readerPage");
img.srcset = img.src.includes("ja_page.png") ? "es_page.png 2x" : "ja_page.png 2x";
```

- [ ] **Step 8: Verify both layouts on real sites**

1. On a real vertical reader, newly lazy-loaded images translate on the next loaded-scope click without reprocessing old sources.
2. On a real single-page reader, page flips remove old overlays and the next visible-scope click translates only the current page or spread.

- [ ] **Step 9: Refresh the project graph**

Run:

```powershell
graphify update .
```

Expected: incremental update completes successfully; dirty `graphify-out/` artifacts are acceptable per `AGENTS.md`.

- [ ] **Step 10: Commit the lifecycle slice**

```powershell
git add extension/content.js extension/test/fixture.html
git commit -m "fix: clean stale reader overlays"
```

- [ ] **Step 11: Record final evidence**

Run once more after the commit:

```powershell
node extension/test/srcset.test.js
node --check extension/srcset.js
node --check extension/content.js
node --check extension/popup.js
git status --short
```

Expected: the Node self-check prints `srcset.test.js OK`, all syntax checks exit 0, and `git status` contains no unexpected source changes. Existing unrelated dirty files and expected `graphify-out/` updates must be reported rather than altered.
