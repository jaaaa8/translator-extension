# Viewport OCR and Intent-Gated Prewarming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make single-page OCR process only the visible image slice and prewarm one visible reader/webtoon image when the popup opens, without speculative chapter-wide OCR or Gemini calls.

**Architecture:** `srcset.js` will produce canonical OCR jobs containing a source URL, optional normalized crop, and language-aware job key. The background worker will deduplicate completed and in-flight jobs before posting optional crop fields to `/ocr`; the server will convert normalized bounds against raw decoded dimensions, crop before detection, and offset returned boxes into original-image coordinates. Popup-open prewarming will submit at most the largest visible job through this same path, so manual translation reuses identical work and webtoon translation starts with hot local models.

**Tech Stack:** Chrome Extension Manifest V3, plain JavaScript, Node `assert`/`vm`, FastAPI, OpenCV, pytest.

> **Approved execution ruling (2026-07-29):** The detailed Task 1–3 snippets below that use `naturalWidth`-derived source pixels and `crop_x/crop_y/crop_w/crop_h` are superseded. The implemented contract uses normalized `{left, top, right, bottom}` bounds rounded to six decimals and `/ocr` fields `crop_left/crop_top/crop_right/crop_bottom`; the server converts them only after raw image decode using floor starts and ceil ends.

## Global Constraints

- Preserve the existing `loaded` webtoon action: full-resolution OCR for every eligible loaded image and one batched Gemini translation call.
- `visible` uses `img.currentSrc || img.src`, a viewport intersection padded by 10% on each axis, and normalized crop bounds converted against raw decoded dimensions on the server.
- Popup-open prewarming submits at most one visible OCR job and never calls Gemini, renders an overlay, marks translation complete, auto-scrolls, or scans the full chapter.
- OCR identity is URL + source language + canonical crop; a crop covering the complete source is canonicalized to `null`/`full`.
- Invalid crop input is rejected at the server trust boundary; unsuccessful OCR is never cached.
- Preserve the existing 60-second OCR timeout, 300-second translation timeout, two-job extension queue, and serialized server ML lock.
- Add no dependency and never edit `.env` or place an API key in source, tests, logs, or documentation.
- Preserve unrelated dirty-worktree changes; stage only the files named by the current task.

---

### Task 1: Crop before server detection and return original-image coordinates

**Files:**
- Modify: `server/pipeline.py:44-67`
- Modify: `server/main.py:38-46`
- Modify: `server/tests/test_pipeline.py:120-135`
- Modify: `server/tests/test_translate_endpoint.py:21-36,73-87`

**Interfaces:**
- Consumes: existing `Pipeline._ocr_lock`, detector `detect(np.ndarray)`, and OCR registry `get(src_lang)`.
- Produces: `Pipeline.ocr_image(image_bytes: bytes, src_lang: str, crop: tuple[int, int, int, int] | None = None) -> dict` and `/ocr` form fields `crop_x`, `crop_y`, `crop_w`, `crop_h`.
- Returns: original `image_w`/`image_h`; every block bbox is `[original_x, original_y, width, height]` even when detection runs on a crop.

- [ ] **Step 1: Write failing pipeline and endpoint tests**

Add these focused cases to `server/tests/test_pipeline.py`:

```python
def test_ocr_image_crops_before_detection_and_offsets_blocks():
    out = make_pipeline().ocr_image(
        encode_png(300, 200),
        "es",
        crop=(50, 60, 150, 100),
    )

    assert out["image_w"] == 300 and out["image_h"] == 200
    assert out["blocks"] == [
        {"bbox": [60, 70, 100, 50], "src_text": "hola"}
    ]


@pytest.mark.parametrize(
    "crop",
    [(-1, 0, 10, 10), (0, 0, 0, 10), (250, 0, 100, 10), (0, 190, 10, 20)],
)
def test_ocr_image_rejects_invalid_crop(crop):
    with pytest.raises(ValueError, match="crop"):
        make_pipeline().ocr_image(encode_png(300, 200), "es", crop=crop)
```

Update `FakePipeline` in `server/tests/test_translate_endpoint.py` so the endpoint can expose what it forwarded:

```python
class FakePipeline:
    langs = ["ja", "es"]

    def __init__(self, error=None):
        self.error = error
        self.translator = FakeTranslator(error)
        self.last_crop = None

    def ocr_image(self, data, src, crop=None):
        if self.error:
            raise self.error
        self.last_crop = crop
        return {"image_w": 100, "image_h": 100, "blocks": [{"bbox": [1, 2, 3, 4], "src_text": "hola"}]}
```

Add endpoint parsing and partial-input cases:

```python
def test_ocr_forwards_complete_crop(monkeypatch):
    pipeline = FakePipeline()
    monkeypatch.setattr(main, "_pipeline", pipeline)

    r = TestClient(main.app).post(
        "/ocr",
        files={"image": ("p.png", PNG, "image/png")},
        data={"src_lang": "es", "crop_x": 1, "crop_y": 2, "crop_w": 30, "crop_h": 40},
    )

    assert r.status_code == 200
    assert pipeline.last_crop == (1, 2, 30, 40)


def test_ocr_rejects_partial_crop(monkeypatch):
    monkeypatch.setattr(main, "_pipeline", FakePipeline())
    r = TestClient(main.app).post(
        "/ocr",
        files={"image": ("p.png", PNG, "image/png")},
        data={"src_lang": "es", "crop_x": 1},
    )
    assert r.status_code == 422
```

- [ ] **Step 2: Run the focused tests and confirm the new contract fails**

Run:

```powershell
venv\Scripts\python.exe -m pytest server/tests/test_pipeline.py server/tests/test_translate_endpoint.py -q
```

Expected: FAIL because `Pipeline.ocr_image` does not accept `crop`, and `/ocr` does not forward crop fields.

- [ ] **Step 3: Implement crop validation, detection, and bbox offsets**

Change `Pipeline.ocr_image` to keep original dimensions while running the existing detector/OCR loop on `work`:

```python
def ocr_image(
    self,
    image_bytes: bytes,
    src_lang: str,
    crop: tuple[int, int, int, int] | None = None,
) -> dict:
    with self._ocr_lock:
        arr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("không decode được ảnh")
        image_h, image_w = img.shape[:2]
        offset_x = offset_y = 0
        work = img
        if crop is not None:
            offset_x, offset_y, crop_w, crop_h = crop
            if (
                offset_x < 0
                or offset_y < 0
                or crop_w <= 0
                or crop_h <= 0
                or offset_x + crop_w > image_w
                or offset_y + crop_h > image_h
            ):
                raise ValueError("crop ngoài biên ảnh")
            work = img[offset_y : offset_y + crop_h, offset_x : offset_x + crop_w]

        work_h, work_w = work.shape[:2]
        engine = self.ocr.get(src_lang)
        blocks = []
        for region in self.detector.detect(work):
            x, y, bw, bh = region.bbox
            x, y = max(0, x), max(0, y)
            x2, y2 = min(work_w, x + bw), min(work_h, y + bh)
            if x2 <= x or y2 <= y:
                continue
            crop_rgb = cv2.cvtColor(work[y:y2, x:x2], cv2.COLOR_BGR2RGB)
            text = engine.read(_prep_crop(crop_rgb)).strip()
            if text:
                blocks.append(
                    {
                        "bbox": [offset_x + x, offset_y + y, x2 - x, y2 - y],
                        "src_text": text,
                    }
                )
        return {"image_w": image_w, "image_h": image_h, "blocks": blocks}
```

Extend `/ocr` with optional integer form fields and reject partial crop tuples before calling the pipeline:

```python
@app.post("/ocr")
def ocr(
    image: UploadFile = File(...),
    src_lang: str = Form(...),
    crop_x: int | None = Form(None),
    crop_y: int | None = Form(None),
    crop_w: int | None = Form(None),
    crop_h: int | None = Form(None),
):
    if src_lang not in LANGS:
        return JSONResponse(status_code=422, content={"error": f"src_lang không hỗ trợ: {src_lang}"})
    values = (crop_x, crop_y, crop_w, crop_h)
    if any(value is not None for value in values) and not all(value is not None for value in values):
        return JSONResponse(status_code=422, content={"error": "crop phải có đủ x, y, w, h"})
    crop = None if crop_x is None else values
    try:
        return get_pipeline().ocr_image(image.file.read(), src_lang, crop=crop)
    except ValueError as e:
        return JSONResponse(status_code=422, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
```

- [ ] **Step 4: Run the server tests and confirm the crop contract passes**

Run:

```powershell
venv\Scripts\python.exe -m pytest server/tests/test_pipeline.py server/tests/test_translate_endpoint.py -q
```

Expected: all selected tests PASS, including the existing serialized-model regression.

- [ ] **Step 5: Commit the server crop slice**

```powershell
git add server/pipeline.py server/main.py server/tests/test_pipeline.py server/tests/test_translate_endpoint.py
git commit -m "feat: crop viewport before OCR"
```

---

### Task 2: Build canonical browser OCR jobs and render cropped results correctly

**Files:**
- Modify: `extension/srcset.js:31-67`
- Modify: `extension/content.js:28-105,119-185`
- Modify: `extension/test/srcset.test.js`
- Modify: `extension/test/content.test.js`

**Interfaces:**
- Consumes: `/ocr` optional crop contract from Task 1.
- Produces: `viewportCrop(img, viewportWidth, viewportHeight, padding = 0.1) -> {x, y, w, h} | null`, `visibleArea(img, viewportWidth, viewportHeight) -> number`, and `selectCandidates(images, scope, translated, viewportWidth, viewportHeight, srcLang, minSize = 400) -> Array<{img, source, crop, key}>`.
- Produces messages: `{type: "ocrImage", url, srcLang, crop?}` and `{type: "ocrImage", url, srcLang, crop?, prewarm: true}`.

- [ ] **Step 1: Extend the pure helper checks with current-source crops and language-aware keys**

Update every existing `selectCandidates` call in `extension/test/srcset.test.js` to pass a source language after the viewport dimensions. Update expected jobs to contain `crop` and `key`. Add these focused checks:

Replace the existing completed-source fixture with its new language-aware identity:

```javascript
const translated = new WeakMap([[doneImage, `${doneImage.src}|ja|full`]]);
```

```javascript
const croppedImage = fakeImage({
  src: "https://x/original.jpg",
  rect: { left: 0, top: -300, right: 600, bottom: 100, width: 600, height: 400 },
});
croppedImage.currentSrc = "https://x/current-1000.jpg";

assert.deepStrictEqual(viewportCrop(croppedImage, 800, 600), {
  x: 0,
  y: 1160,
  w: 1000,
  h: 440,
});

const [visibleJob] = selectCandidates(
  [croppedImage],
  "visible",
  new WeakMap(),
  800,
  600,
  "ja"
);
assert.strictEqual(visibleJob.source, croppedImage.currentSrc);
assert.deepStrictEqual(visibleJob.crop, { x: 0, y: 1160, w: 1000, h: 440 });
assert.strictEqual(
  visibleJob.key,
  "https://x/current-1000.jpg|ja|0,1160,1000,440"
);

const fullJob = selectCandidates(
  [visibleImage],
  "visible",
  new WeakMap(),
  800,
  600,
  "es"
)[0];
assert.strictEqual(fullJob.crop, null);
assert.strictEqual(fullJob.key, "https://x/visible.jpg|es|full");

const completed = new WeakMap([[croppedImage, visibleJob.key]]);
assert.deepStrictEqual(
  selectCandidates([croppedImage], "visible", completed, 800, 600, "ja"),
  []
);
assert.strictEqual(isCurrentSource(croppedImage, croppedImage.currentSrc, "visible"), true);
```

Add `viewportCrop` and `visibleArea` to the test import from `srcset.js`.

In `extension/test/content.test.js`, retain the existing language-snapshot assertion and add a second phase that supplies two visible images, calls `context.prewarmPage("es")`, and verifies exactly one OCR message for the image with the larger visible intersection:

```javascript
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
```

Make the test harness use mutable `images` and queued `ocrReplies` so `document.querySelectorAll()` returns the current phase's images and prewarm OCR resolves immediately.
Include `image_w` and `image_h` in the existing manual OCR resolution because overlay scaling now uses response coordinates:

```javascript
resolveOcr({
  ok: true,
  image_w: 1000,
  image_h: 1600,
  blocks: [{ src_text: "text", bbox: [0, 0, 1, 1] }],
});
```

- [ ] **Step 2: Run the Node checks and confirm crop/prewarm helpers are missing**

Run:

```powershell
node extension/test/srcset.test.js
node extension/test/content.test.js
```

Expected: FAIL because `viewportCrop`, language-aware job keys, and `prewarmPage` do not exist.

- [ ] **Step 3: Implement source selection, crop math, job identity, and content integration**

Add these pure helpers to `extension/srcset.js` and export them in the existing CommonJS block:

```javascript
function sourceForScope(img, scope) {
  return scope === "visible" ? img.currentSrc || img.src : bestSource(img);
}

function visibleArea(img, viewportWidth, viewportHeight) {
  if (!img.getClientRects().length) return 0;
  const rect = img.getBoundingClientRect();
  const width = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  return width * height;
}

function viewportCrop(img, viewportWidth, viewportHeight, padding = 0.1) {
  const rect = img.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewportWidth, rect.right);
  const bottom = Math.min(viewportHeight, rect.bottom);
  if (!img.getClientRects().length || right <= left || bottom <= top || rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const padX = (right - left) * padding;
  const padY = (bottom - top) * padding;
  const x1 = Math.max(0, Math.floor(((Math.max(rect.left, left - padX) - rect.left) / rect.width) * img.naturalWidth));
  const y1 = Math.max(0, Math.floor(((Math.max(rect.top, top - padY) - rect.top) / rect.height) * img.naturalHeight));
  const x2 = Math.min(img.naturalWidth, Math.ceil(((Math.min(rect.right, right + padX) - rect.left) / rect.width) * img.naturalWidth));
  const y2 = Math.min(img.naturalHeight, Math.ceil(((Math.min(rect.bottom, bottom + padY) - rect.top) / rect.height) * img.naturalHeight));
  if (x1 === 0 && y1 === 0 && x2 === img.naturalWidth && y2 === img.naturalHeight) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function jobKey(source, srcLang, crop) {
  return `${source}|${srcLang}|${crop ? `${crop.x},${crop.y},${crop.w},${crop.h}` : "full"}`;
}
```

Replace `isViewportVisible`, `isCurrentSource`, and `selectCandidates` with the language/crop-aware contract:

```javascript
function isViewportVisible(img, viewportWidth, viewportHeight) {
  return visibleArea(img, viewportWidth, viewportHeight) > 0;
}

function isCurrentSource(img, source, scope = "loaded") {
  return img.isConnected && sourceForScope(img, scope) === source;
}

function selectCandidates(images, scope, translated, viewportWidth, viewportHeight, srcLang, minSize = 400) {
  if (scope !== "loaded" && scope !== "visible") throw new Error(`scope không hỗ trợ: ${scope}`);
  const jobs = [];
  for (const img of images) {
    if (!img.complete || !eligible(img, minSize)) continue;
    if (scope === "visible" && !isViewportVisible(img, viewportWidth, viewportHeight)) continue;
    const source = sourceForScope(img, scope);
    const crop = scope === "visible" ? viewportCrop(img, viewportWidth, viewportHeight) : null;
    const key = jobKey(source, srcLang, crop);
    if (translated.get(img) === key) continue;
    jobs.push({ img, source, crop, key });
  }
  return jobs;
}
```

In `extension/content.js`, route both manual and speculative OCR through one helper:

```javascript
function requestOcr(job, requestSrcLang, prewarm = false) {
  const message = { type: "ocrImage", url: job.source, srcLang: requestSrcLang };
  if (job.crop) message.crop = job.crop;
  if (prewarm) message.prewarm = true;
  return chrome.runtime.sendMessage(message);
}

async function prewarmPage(requestSrcLang) {
  try {
    const jobs = selectCandidates(
      document.querySelectorAll("img"),
      "visible",
      translated,
      innerWidth,
      innerHeight,
      requestSrcLang,
      MIN_SIZE
    );
    let selected = null;
    for (const job of jobs) {
      if (!selected || visibleArea(job.img, innerWidth, innerHeight) > visibleArea(selected.img, innerWidth, innerHeight)) {
        selected = job;
      }
    }
    if (!selected) return;
    const result = await requestOcr(selected, requestSrcLang, true);
    if (!result || !result.ok) console.warn("[MangaTranslator] prewarm:", result && result.error);
  } catch (error) {
    console.warn("[MangaTranslator] prewarm:", error);
  }
}
```

Add a synchronous acknowledgement to the existing message listener while the prewarm continues independently:

```javascript
if (msg.type === "prewarmPage") {
  prewarmPage(msg.srcLang);
  sendResponse({ ok: true });
}
```

Update `translatePage` to pass `requestSrcLang` into `selectCandidates`, use `requestOcr(job, requestSrcLang)`, store `job.key` in `translated`, and call `isCurrentSource(job.img, job.source, scope)` before applying results. Update overlay pruning to call `isCurrentSource(img, overlay.source, overlay.scope)`.

The changed call/state sites are:

```javascript
jobs = selectCandidates(
  document.querySelectorAll("img"),
  scope,
  translated,
  innerWidth,
  innerHeight,
  requestSrcLang,
  MIN_SIZE
);

const ocrResults = await Promise.all(jobs.map((job) => requestOcr(job, requestSrcLang)));

// In both the no-text and rendered-result loops:
if (!isCurrentSource(slot.img, slot.source, scope)) continue;
translated.set(slot.img, slot.key);

// In pruneOverlays:
if (!isCurrentSource(img, overlay.source, overlay.scope)) removeOverlay(img);
```

Replace the single overlay scale with response-coordinate scales:

```javascript
const scaleX = r.width / o.data.image_w;
const scaleY = r.height / o.data.image_h;
o.data.blocks.forEach((b, i) => {
  const [x, y, w, h] = b.bbox;
  const el = o.container.children[i];
  el.style.left = x * scaleX + "px";
  el.style.top = y * scaleY + "px";
  el.style.width = w * scaleX + "px";
  el.style.height = h * scaleY + "px";
  fitText(el);
});
```

- [ ] **Step 4: Run the browser job/content checks**

Run:

```powershell
node extension/test/srcset.test.js
node extension/test/content.test.js
```

Expected: both scripts print their `OK` line and exit 0.

- [ ] **Step 5: Commit canonical browser jobs**

```powershell
git add extension/srcset.js extension/content.js extension/test/srcset.test.js extension/test/content.test.js
git commit -m "feat: OCR only the visible image slice"
```

---

### Task 3: Deduplicate completed and in-flight OCR in the background worker

**Files:**
- Modify: `extension/background.js:4-93`
- Modify: `extension/test/background.test.js`

**Interfaces:**
- Consumes: content messages `{type: "ocrImage", url: string, srcLang: string, crop?: {x, y, w, h}, prewarm?: boolean}`.
- Produces: one source fetch and one `/ocr` POST per URL/language/crop identity while a request is pending; only successful payloads enter `ocrCache`.
- Error policy: explicit OCR and translation failures set the badge; prewarm-only failures do not. An explicit request joining a failed prewarm still sets the badge in its own caller path.

- [ ] **Step 1: Write failing cache/deduplication and retry checks**

Extend the `FormData` fake in `extension/test/background.test.js` so it records fields:

```javascript
class FakeFormData {
  constructor() { this.fields = []; }
  append(name, value) { this.fields.push([name, value]); }
}
```

Track `/ocr` posts, badge calls, and a controllable first OCR response. Add assertions with this sequence:

```javascript
const crop = { x: 10, y: 20, w: 300, h: 400 };
const prewarm = context.ocrImage({ url: "https://x/page.jpg", srcLang: "es", crop, prewarm: true });
const click = context.ocrImage({ url: "https://x/page.jpg", srcLang: "es", crop });

await firstOcrStarted;
assert.strictEqual(ocrPosts.length, 1);
releaseFirstOcr();
await Promise.all([prewarm, click]);

assert.strictEqual(ocrPosts.length, 1);
assert.deepStrictEqual(
  ocrPosts[0].body.fields.slice(1),
  [["src_lang", "es"], ["crop_x", 10], ["crop_y", 20], ["crop_w", 300], ["crop_h", 400]]
);

await context.ocrImage({
  url: "https://x/page.jpg",
  srcLang: "es",
  crop: { x: 10, y: 420, w: 300, h: 400 },
});
assert.strictEqual(ocrPosts.length, 2);

failNextOcr = true;
await assert.rejects(
  context.ocrImage({ url: "https://x/retry.jpg", srcLang: "ja", prewarm: true })
);
const badgesAfterQuietFailure = badgeCalls;
await context.ocrImage({ url: "https://x/retry.jpg", srcLang: "ja" });
assert.strictEqual(ocrPosts.filter((post) => post.url.endsWith("/ocr")).length, 4);
assert.strictEqual(badgeCalls, badgesAfterQuietFailure);
```

Define `firstOcrStarted` and `releaseFirstOcr` in the fetch fake: the first `/ocr` POST resolves `firstOcrStarted`, then awaits a Promise released by `releaseFirstOcr`. Later `/ocr` posts return immediately unless `failNextOcr` is set, in which case they return `{ok: false, json: async () => ({error: "failed"})}` once.

Retain timeout assertions, but assert that every OCR POST used `60_000` and the translation POST used `300_000` rather than comparing one fixed two-item array.

- [ ] **Step 2: Run the background check and confirm duplicate `/ocr` calls occur**

Run:

```powershell
node extension/test/background.test.js
```

Expected: FAIL because there is no in-flight map, crop fields, or prewarm-aware error policy.

- [ ] **Step 3: Implement canonical OCR keys, an in-flight Promise map, and caller-specific badges**

Add the in-flight map next to the existing cache:

```javascript
const ocrCache = new Map();
const ocrInFlight = new Map();

function ocrKey({ url, srcLang, crop }) {
  return `${url}|${srcLang}|${crop ? `${crop.x},${crop.y},${crop.w},${crop.h}` : "full"}`;
}
```

Split network work from per-caller error policy:

```javascript
async function fetchOcr({ url, srcLang, crop }) {
  const imgResp = await fetch(url);
  if (!imgResp.ok) throw new Error(`fetch ảnh: HTTP ${imgResp.status}`);
  const blob = await imgResp.blob();
  const form = new FormData();
  form.append("image", blob, "page.png");
  form.append("src_lang", srcLang);
  if (crop) {
    form.append("crop_x", crop.x);
    form.append("crop_y", crop.y);
    form.append("crop_w", crop.w);
    form.append("crop_h", crop.h);
  }
  return postJson(`${SERVER}/ocr`, form);
}

async function ocrImage(msg) {
  const key = ocrKey(msg);
  try {
    if (ocrCache.has(key)) return { ok: true, ...ocrCache.get(key) };
    if (!ocrInFlight.has(key)) {
      const pending = fetchOcr(msg)
        .then((data) => {
          ocrCache.set(key, data);
          return data;
        })
        .finally(() => ocrInFlight.delete(key));
      ocrInFlight.set(key, pending);
    }
    return { ok: true, ...(await ocrInFlight.get(key)) };
  } catch (error) {
    if (!msg.prewarm) badge();
    throw error;
  }
}
```

Remove badge mutation from generic `postJson`. Wrap `translateTexts` so translation failures retain the current badge behavior:

```javascript
async function translateTexts({ texts, srcLang, dstLang }) {
  try {
    const data = await postJson(`${SERVER}/translate-texts`, null, {
      texts,
      src_lang: srcLang,
      target_lang: dstLang,
    }, 300000);
    chrome.action.setBadgeText({ text: "" });
    return { ok: true, ...data };
  } catch (error) {
    badge();
    throw error;
  }
}
```

- [ ] **Step 4: Run the background and dependent content checks**

Run:

```powershell
node extension/test/background.test.js
node extension/test/content.test.js
```

Expected: both scripts print `OK` and exit 0; concurrent identical OCR produces one server POST.

- [ ] **Step 5: Commit background deduplication**

```powershell
git add extension/background.js extension/test/background.test.js
git commit -m "perf: deduplicate OCR prewarming"
```

---

### Task 4: Trigger one bounded prewarm after popup health succeeds

**Files:**
- Modify: `extension/popup.js:3-17`
- Create: `extension/test/popup.test.js`

**Interfaces:**
- Consumes: content message `{type: "prewarmPage", srcLang: string}` from Task 2.
- Produces: one prewarm message after settings and health both resolve, plus one new message when `srcLang` changes while the server is healthy.

- [ ] **Step 1: Write a failing popup orchestration check**

Create `extension/test/popup.test.js` using the existing Node `vm` style:

```javascript
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const elements = Object.fromEntries(
  ["enabled", "srcLang", "dstLang", "status", "result", "translateLoaded", "translateVisible"].map(
    (id) => [id, { id, style: {}, checked: false, value: "", textContent: "", disabled: false }]
  )
);
const tabMessages = [];
const context = {
  Promise,
  document: { getElementById: (id) => elements[id] },
  chrome: {
    storage: {
      local: {
        get: async () => ({ enabled: true, srcLang: "es", dstLang: "vi" }),
        set: async () => {},
      },
    },
    runtime: {
      lastError: undefined,
      sendMessage: async () => ({ ok: true, device: "cpu" }),
    },
    tabs: {
      query: (_query, callback) => callback([{ id: 7 }]),
      sendMessage: (_tabId, message, callback) => {
        tabMessages.push(message);
        if (callback) callback({ ok: true });
      },
    },
  },
};

vm.createContext(context);
vm.runInContext(fs.readFileSync("extension/popup.js", "utf8"), context);

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual({ ...tabMessages[0] }, { type: "prewarmPage", srcLang: "es" });

  elements.srcLang.onchange({ target: { value: "ja" } });
  await Promise.resolve();
  assert.deepStrictEqual({ ...tabMessages[1] }, { type: "prewarmPage", srcLang: "ja" });
  console.log("popup.test.js OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Run the popup check and confirm no prewarm message is sent**

Run:

```powershell
node extension/test/popup.test.js
```

Expected: FAIL because `tabMessages[0]` is absent.

- [ ] **Step 3: Coordinate settings, health, and active-tab prewarming**

Replace the independent settings/health startup blocks in `extension/popup.js` with promises that retain current UI behavior and call `prewarm` only after both are ready:

```javascript
let serverReady = false;

const settingsReady = chrome.storage.local.get(["enabled", "srcLang", "dstLang"]).then((v) => {
  $("enabled").checked = v.enabled !== false;
  $("srcLang").value = v.srcLang || "ja";
  $("dstLang").value = v.dstLang || "vi";
});

const healthReady = chrome.runtime.sendMessage({ type: "health" }).then((res) => {
  serverReady = Boolean(res && res.ok);
  $("status").textContent = serverReady ? `● server: ${res.device}` : "● server offline";
  $("status").style.color = serverReady ? "#2a2" : "#d33";
});

function prewarm(srcLang) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: "prewarmPage", srcLang }, () => void chrome.runtime.lastError);
  });
}

Promise.all([settingsReady, healthReady]).then(() => {
  if (serverReady) prewarm($("srcLang").value);
});
```

Keep enabled/destination handlers unchanged. Replace the source-language handler with:

```javascript
$("srcLang").onchange = (e) => {
  chrome.storage.local.set({ srcLang: e.target.value });
  if (serverReady) prewarm(e.target.value);
};
```

- [ ] **Step 4: Run all extension and sandbox-compatible server checks**

Run:

```powershell
node extension/test/srcset.test.js
node extension/test/content.test.js
node extension/test/background.test.js
node extension/test/popup.test.js
venv\Scripts\python.exe -m pytest server/tests --ignore=server/tests/test_ocr.py -q
```

Expected: four Node scripts print `OK`; the Python suite passes. `server/tests/test_ocr.py` remains excluded because it loads real external OCR models and is covered by the manual check below.

- [ ] **Step 5: Manually verify reader and webtoon behavior**

1. Rotate/configure server secrets locally, start `run_server.bat`, and reload the unpacked extension so the current MV3 worker is active.
2. Open a single-page reader and then the popup; confirm one `/ocr` starts before pressing `Translate visible`, and pressing it does not produce a duplicate `/ocr` for the same crop.
3. Scroll to a new slice of a tall page and press `Translate visible`; confirm a new cropped `/ocr` runs and its overlay aligns with the visible speech bubbles.
4. Open a multi-image webtoon and then the popup; confirm only one visible image is prewarmed. Press `Translate loaded`; confirm the remaining loaded images follow the existing full-image queue and only one Gemini batch is sent.
5. Open a very tall single-strip webtoon; confirm popup-open does not OCR the full strip, while `Translate loaded` retains the existing full-strip behavior.
6. Stop the server, reopen the popup, and confirm prewarm is skipped without a red badge or blocked buttons.

- [ ] **Step 6: Commit popup prewarming**

```powershell
git add extension/popup.js extension/test/popup.test.js
git commit -m "perf: prewarm visible OCR from popup"
```
