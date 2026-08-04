# Reading Order + Full-Page Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đưa reading order RTL/LTR tất định, một request dịch toàn trang cho mỗi producer và source language Portuguese dùng chung Latin OCR engine vào production mà vẫn giữ nguyên control Spec A.

**Architecture:** Merge toàn bộ Spec A trước để lấy fixture và telemetry làm nền. Background đợi OCR hoàn tất, gọi một helper JavaScript thuần để tạo ordered view rồi gửi contract full-page nghiêm ngặt tới server; production và acceptance dùng chung Pydantic models/validation handler. Direction và layout chỉ tham gia cache identity từ overlay/translation trở lên, còn ES/PT chia sẻ một instance `PaddleLatinEngine` nhưng giữ cache OCR tách theo `src_lang`.

**Tech Stack:** Chrome Extension Manifest V3 · vanilla JavaScript · Node `assert`/`vm` · Python 3.12 · FastAPI/Pydantic v2 · pytest · PaddleOCR 3.7.0 · Git/PowerShell.

## Global Constraints

- Thiết kế nguồn đã duyệt: `docs/superpowers/specs/2026-08-04-reading-order-full-page-translation-design.md` tại commit `112df59` hoặc hậu duệ chứa amendment `reading_direction` của comparator.
- Thực thi trên `D:\MangaTranslator`, nhánh `feat/v3`; không dùng detached worktree của Codex làm checkout triển khai.
- Trước câu hỏi code/call-path trong mỗi task, dùng CodeGraph; chỉ đọc trực tiếp khi graph chưa thấy code Spec A vừa merge hoặc báo thiếu/stale.
- Mỗi task dừng ở checkpoint review. Không bắt đầu task kế tiếp trước khi người dùng duyệt task hiện tại.
- Task 1 phải merge toàn bộ `feat/spec-a-telemetry-quality-gate` bằng merge commit; không cherry-pick riêng fixture hoặc evaluator.
- Không chạy `server/tests/test_ocr.py`. File này chỉ được cập nhật expectation tĩnh; mọi Python gate dùng `--ignore=server/tests/test_ocr.py` khi chạy toàn suite.
- Dùng interpreter repo: `D:\MangaTranslator\venv\Scripts\python.exe`.
- Không thêm dependency, framework, spatial index, queue abstraction hoặc compatibility layer mới.
- Không suy `reading_direction` từ site/`src_lang`; extension default missing thành `rtl` tại đúng ba descriptor boundary, server không default.
- Không thêm `page_kind` vào request hoặc cache key; helper suy từ decoded `image_w/image_h` với ngưỡng spread `1.2`.
- Không dùng DOM natural dimensions làm page context; request dịch chỉ dùng positive integer `producer.page.image_w/image_h` cùng hệ tọa độ bbox.
- Không mutate thứ tự/field của OCR artifact để tạo reading order; dùng ordered shallow-copy view.
- Page record không lưu direction và `page_schema` giữ `page-v1`; chỉ persisted job descriptor round-trip `reading_direction`.
- Khai tử toàn bộ microbatch `3/8`, timer `250/500 ms`, pending queue, attempted IDs, numeric batch counter và translation chain trong cùng Task 6; không ship trạng thái lai.
- Không sửa detector, dedupe, OCR stream protocol, overlay geometry, text fitting, inpainting hoặc Spec C.
- Không ghi source URL, OCR text, translation text hoặc API key vào telemetry/worklog.
- Control `docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json` phải giữ byte-for-byte kể từ merge commit Task 1; không rebaseline bằng full-page traces.
- Live Gemini quality rerun không phải gate của vertical slice. Task runtime sau checkpoint chỉ ghi telemetry mới vào worklog Spec B.
- Giữ các thay đổi người dùng không liên quan ngoài staging; mọi `git add` trong plan liệt kê path cụ thể.
- Dùng `apply_patch` cho mọi chỉnh sửa file. Commit theo Conventional Commits; không auto-push.

## File Responsibility Map

| File | Trách nhiệm sau thay đổi |
|---|---|
| `extension/reading-order.js` | Helper thuần `orderPage()` dùng chung service worker/VM/CommonJS |
| `extension/test/reading-order.test.js` | Comparator production-helper với ba fixture thật và synthetic geometry |
| `extension/background.js` | Descriptor normalization, cache keys, ordered full-page orchestration và trace |
| `extension/content.js` | State/storage snapshot `readingDirection` và `start_scope` explicit |
| `extension/popup.html` | Control RTL/LTR và source option Portuguese |
| `extension/popup.js` | Default/display/persist direction và chuyển setting vào content action |
| `extension/page-cache.js` | Round-trip `reading_direction`; không default legacy row |
| `extension/test/background-progressive.test.js` | VM preload, three-boundary/cache/full-page/retirement/telemetry gates |
| `extension/test/progressive-integration.test.js` | End-to-end fake OCR → one full-page request → overlay |
| `extension/test/content-progressive.test.js` | Storage/onChanged/snapshot direction contract |
| `extension/test/popup.test.js` | Popup default/display/persist direction và PT option |
| `extension/test/page-cache.test.js` | Descriptor round-trip, legacy missing và coarse version purge |
| `server/contracts.py` | Nguồn Pydantic contract và path-scoped validation envelope dùng chung |
| `server/config.py` | `LANGS`, recognizer/layout/prompt/policy version constants |
| `server/main.py` | Production health/lang validation và strict `/translate-items` caller |
| `server/acceptance_app.py` | Dùng shared contract/handler và health version shape tương ứng |
| `server/translator.py` | Prompt item allowlist, JSON page context và Portuguese display name |
| `server/ocr.py` | Pinned PP-OCRv6 và registry cache theo engine class |
| `server/tests/test_ocr_registry.py` | Lightweight ES/PT mapping/sharing tests không load model |
| `server/tests/test_ocr.py` | Chỉ cập nhật expectation `langs`; tuyệt đối không chạy |
| `server/tests/test_translate_endpoint.py` | Production contract/envelope/caller page-context gates |
| `server/tests/test_acceptance_app.py` | Acceptance contract/envelope và recursive version-shape gates |
| `server/tests/test_translator.py` | Exact prompt projection/context/Portuguese/response-ID gates |
| `server/tests/test_health.py` | Production `/health.langs` và recognizer coverage |
| `docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json` | Control pointer, offline checkpoint và runtime telemetry Spec B |

---

### Task 1: Merge nguyên branch Spec A vào `feat/v3`

**Files:**
- Merge: toàn bộ tree của `feat/spec-a-telemetry-quality-gate` tại `18bb9f8`
- Preserve: mọi dirty/untracked file không thuộc merge hoặc design Spec B

**Interfaces:**
- Consumes: `feat/v3` tại hậu duệ của `112df59`; Spec A tip `18bb9f8`.
- Produces: một merge commit có hai parent, đưa fixtures/evaluator/telemetry Spec A vào `feat/v3` nguyên vẹn.

- [ ] **Step 1: Xác nhận đúng checkout và lưu inventory thay đổi người dùng**

Run:

```powershell
git branch --show-current
git rev-parse HEAD
git status --short
git -C .worktrees/spec-a-telemetry-quality-gate rev-parse HEAD
git -C .worktrees/spec-a-telemetry-quality-gate status --short
```

Expected: branch chính là `feat/v3`; Spec A tip là `18bb9f8...`; worktree Spec A sạch. Ghi lại mọi dirty path của `feat/v3` và không stage chúng.

- [ ] **Step 2: Kiểm tra merge-base và phạm vi hai nhánh**

Run:

```powershell
git merge-base feat/v3 feat/spec-a-telemetry-quality-gate
git diff --name-status feat/v3...feat/spec-a-telemetry-quality-gate
git diff --name-status feat/spec-a-telemetry-quality-gate...feat/v3
```

Expected: phía Spec A chứa fixtures, evaluator, telemetry và tests đã review; phía `feat/v3` sau merge-base chỉ có docs/instruction changes đã biết. Nếu xuất hiện code change mới ngoài inventory đã review, dừng checkpoint và báo người dùng trước merge.

- [ ] **Step 3: Tạo merge commit rõ ràng**

Run:

```powershell
git merge --no-ff feat/spec-a-telemetry-quality-gate -m "merge: integrate spec a telemetry quality gate"
```

Expected: merge hoàn tất không conflict. Nếu có conflict, không tự chọn bên nào; dừng và trình exact conflicted paths để review.

- [ ] **Step 4: Xác nhận merge commit và fixture/control có mặt**

Run:

```powershell
git show --no-patch --format='%H%n%P%n%s' HEAD
git rev-parse HEAD^2
Test-Path server/tests/fixtures/real_pages/manifest.json
Test-Path docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json
git status --short
```

Expected: `HEAD^2` là `18bb9f8...`; cả manifest/control tồn tại; dirty inventory ban đầu còn nguyên và không có conflict residue.

- [ ] **Step 5: Dừng ở checkpoint review Task 1**

Bàn giao merge SHA đầy đủ, hai parent, `git show --stat HEAD` và `git status --short`. Không chạy Task 2 trước khi người dùng duyệt merge.

---

### Task 2: Chứng minh baseline Spec A và đóng băng control

**Files:**
- Create: `docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json`
- Verify only: `docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json`
- Verify only: toàn bộ Spec A server/extension tests

**Interfaces:**
- Consumes: merge commit Task 1 và fixtures/evaluator Spec A.
- Produces: worklog Spec B chứa exact merge SHA làm `control_baseline_commit`, control path/policy và batch-count tripwire `25`.

- [ ] **Step 1: Chạy toàn bộ Python baseline nhưng loại model-loading test**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests --ignore=server/tests/test_ocr.py -q
```

Expected: PASS. Không chạy lại bằng `pytest server/tests` trần.

- [ ] **Step 2: Chạy toàn bộ Node baseline**

Run:

```powershell
Get-ChildItem extension/test/*.test.js | Sort-Object Name | ForEach-Object {
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "JS test failed: $($_.Name)" }
}
```

Expected: mọi test process exit `0`.

- [ ] **Step 3: Chạy evaluator offline và semantic batch tripwire**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_real_page_quality.py -q
& 'D:\MangaTranslator\venv\Scripts\python.exe' -c "import json; from pathlib import Path; from server.real_page_quality import QUALITY_ARMS, load_manifest, policy_batches, source_pages; root=Path('.'); manifest=load_manifest(root/'server/tests/fixtures/real_pages/manifest.json'); capture=json.loads((root/'server/tests/fixtures/real_pages/captures/2026-08-01-policy-probe.json').read_text(encoding='utf-8')); total=sum(len(policy_batches(page, arm, capture['baseline'][page['id']])) for page in source_pages(manifest) for arm in QUALITY_ARMS); assert total == 25, total; print(total)"
```

Expected: offline evaluator PASS và command in `25`.

- [ ] **Step 4: Tạo worklog Spec B bằng exact merge SHA**

In đúng JSON cần tạo từ SHA hiện hành:

```powershell
$mergeSha = git rev-parse HEAD
[ordered]@{
  spec = 'reading-order-full-page-translation'
  status = 'baseline_verified'
  control_baseline_path = 'docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json'
  control_baseline_commit = $mergeSha
  control_policy = 'microbatch-3-8-250-500-v1'
  control_policy_batch_count = 25
} | ConvertTo-Json
```

Dùng `apply_patch` tạo file bằng nguyên output JSON của command. Artifact phải chứa SHA literal 40 ký tự, không chứa biến shell hoặc sentinel; gate kế tiếp bắt cả sai format lẫn sai commit.

- [ ] **Step 5: Gate worklog và frozen control**

Run:

```powershell
$specB = Get-Content docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json -Raw | ConvertFrom-Json
if ($specB.control_baseline_commit -notmatch '^[0-9a-f]{40}$') { throw 'invalid control merge SHA' }
if ($specB.control_baseline_commit -ne (git rev-parse HEAD)) { throw 'control SHA is not Task 1 merge commit' }
git diff --exit-code $specB.control_baseline_commit -- $specB.control_baseline_path
```

Expected: SHA gate và frozen-control diff đều pass.

- [ ] **Step 6: Commit riêng worklog baseline**

```powershell
git add docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json
git commit -m "docs: establish spec b control baseline"
```

- [ ] **Step 7: Dừng ở checkpoint review Task 2**

Bàn giao exact test commands/results, semantic total `25`, worklog commit và xác nhận `server/tests/test_ocr.py` không được chạy.

---

### Task 3: Tạo reading-order helper và comparator production-exact

**Files:**
- Create: `extension/reading-order.js`
- Create: `extension/test/reading-order.test.js`
- Modify: `extension/background.js` tại classic-worker `importScripts`
- Modify: `extension/test/background-progressive.test.js` tại cả hai VM context
- Modify: `extension/test/progressive-integration.test.js` tại background VM context

**Interfaces:**
- Produces: `globalThis.MangaReadingOrder.orderPage({ blocks, image_w, image_h, reading_direction }) -> { page_kind, gutter_x, blocks }`.
- Produces: guarded CommonJS export cùng API object cho Node comparator.
- Preserves: input `blocks`, object fields và OCR artifact order.

- [ ] **Step 1: Viết comparator thất bại trước khi helper tồn tại**

Tạo `extension/test/reading-order.test.js` bằng Node stdlib. Test phải require production helper và đọc manifest trực tiếp:

```javascript
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { orderPage } = require("../reading-order.js");

const manifest = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../../server/tests/fixtures/real_pages/manifest.json"),
  "utf8",
));

for (const page of manifest.fixtures) {
  const input = page.regions.map((region) => ({
    block_id: region.fixture_block_id,
    bbox: [...region.bbox],
  }));
  const before = structuredClone(input);
  const shuffled = input.slice(1).reverse().concat(input.slice(0, 1));
  const result = orderPage({
    blocks: shuffled,
    image_w: page.width,
    image_h: page.height,
    reading_direction: page.reading_direction,
  });
  const expected = page.regions
    .slice()
    .sort((left, right) => left.reading_order - right.reading_order)
    .map((region) => region.fixture_block_id);
  assert.deepStrictEqual(result.blocks.map((block) => block.block_id), expected, page.id);
  assert.strictEqual(result.page_kind, page.page_kind, page.id);
  assert.deepStrictEqual(input, before, `${page.id} mutated`);
}
```

Thêm exact gutter assertions: JA1 `515 < gutter_x < 594`, JA2 `502 < gutter_x < 597`, PT `gutter_x === null`.

- [ ] **Step 2: Viết synthetic expected bằng tay và negative control không chép thuật toán**

Thêm single two-band case:

```javascript
const single = [
  { block_id: "z01", bbox: [20, 20, 80, 40] },
  { block_id: "a01", bbox: [300, 25, 80, 40] },
  { block_id: "m01", bbox: [30, 150, 80, 40] },
  { block_id: "b01", bbox: [280, 155, 80, 40] },
];
assert.deepStrictEqual(ids(orderPage({ blocks: single, image_w: 500, image_h: 800, reading_direction: "rtl" })), ["a01", "z01", "b01", "m01"]);
assert.deepStrictEqual(ids(orderPage({ blocks: single, image_w: 500, image_h: 800, reading_direction: "ltr" })), ["z01", "a01", "m01", "b01"]);
```

Thêm panel-gap spread case đã review:

```javascript
const spread = [
  { block_id: "z01", bbox: [20, 100, 80, 40] },
  { block_id: "z02", bbox: [20, 300, 80, 40] },
  { block_id: "a01", bbox: [480, 100, 50, 40] },
  { block_id: "m01", bbox: [900, 100, 80, 40] },
  { block_id: "m02", bbox: [900, 300, 80, 40] },
];
assert.deepStrictEqual(ids(orderPage({ blocks: spread, image_w: 1100, image_h: 800, reading_direction: "rtl" })), ["m01", "m02", "a01", "z01", "z02"]);
assert.deepStrictEqual(ids(orderPage({ blocks: spread, image_w: 1100, image_h: 800, reading_direction: "ltr" })), ["z01", "a01", "z02", "m01", "m02"]);
assert.strictEqual(orderPage({ blocks: spread, image_w: 1100, image_h: 800, reading_direction: "rtl" }).gutter_x, 715);
```

Assert LTR khác `reverse(RTL)`. Thêm bbox phủ tâm để assert fallback `gutter_x === image_w / 2`.

Tall bridge dùng production source với đúng một constant thay từ `0.5` sang `0.25` trong isolated VM; test phải assert replacement thực sự xảy ra rồi gọi cùng `orderPage`, không viết lại connected-components:

```javascript
const bridge = [
  { block_id: "z-top", bbox: [100, 0, 40, 40] },
  { block_id: "m-bridge", bbox: [200, 30, 40, 80] },
  { block_id: "a-bottom", bbox: [300, 100, 40, 40] },
];
assert.deepStrictEqual(ids(orderPage({ blocks: bridge, image_w: 500, image_h: 800, reading_direction: "rtl" })), ["z-top", "m-bridge", "a-bottom"]);
```

Low-threshold VM phải cho thứ tự khác expected; nếu source không chứa đúng constant `const VERTICAL_OVERLAP_THRESHOLD = 0.5`, test fail thay vì false-PASS.

```javascript
const helperPath = path.resolve(__dirname, "../reading-order.js");
const source = fs.readFileSync(helperPath, "utf8");
const lowSource = source.replace(
  "const VERTICAL_OVERLAP_THRESHOLD = 0.5;",
  "const VERTICAL_OVERLAP_THRESHOLD = 0.25;",
);
assert.notStrictEqual(lowSource, source, "threshold constant not replaced");
const lowContext = {};
vm.createContext(lowContext);
vm.runInContext(lowSource, lowContext);
const lowResult = lowContext.MangaReadingOrder.orderPage({
  blocks: bridge,
  image_w: 500,
  image_h: 800,
  reading_direction: "rtl",
});
assert.notDeepStrictEqual(ids(lowResult), ["z-top", "m-bridge", "a-bottom"]);
```

- [ ] **Step 3: Chạy comparator đỏ**

Run:

```powershell
node extension/test/reading-order.test.js
```

Expected: FAIL vì `extension/reading-order.js` chưa tồn tại.

- [ ] **Step 4: Implement helper tối thiểu, O(n²), không ID tie-break**

Trong `extension/reading-order.js`:

```javascript
(() => {
  "use strict";
  const SPREAD_RATIO = 1.2;
  const VERTICAL_OVERLAP_THRESHOLD = 0.5;

  function orderPage({ blocks, image_w, image_h, reading_direction }) {
    const copies = blocks.map((block) => ({ ...block, bbox: [...block.bbox] }));
    const page_kind = image_w / image_h >= SPREAD_RATIO ? "spread" : "single";
    if (page_kind === "single") {
      return { page_kind, gutter_x: null, blocks: orderBands(copies, reading_direction) };
    }
    const gutter_x = findGutter(copies, image_w);
    const left = copies.filter((block) => centerX(block) < gutter_x);
    const right = copies.filter((block) => centerX(block) >= gutter_x);
    const halves = reading_direction === "rtl" ? [right, left] : [left, right];
    return {
      page_kind,
      gutter_x,
      blocks: halves.flatMap((half) => orderBands(half, reading_direction)),
    };
  }

  const api = { orderPage };
  globalThis.MangaReadingOrder = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
```

`findGutter()` merge interval x chồng/tiếp xúc, chỉ chọn strict center gap `lo < image_w / 2 < hi`, nếu không có trả `image_w / 2`. `orderBands()` dựng connected components bằng pair scan, sort band theo min top rồi canonical signature của bbox tuples đã sort; trong band dùng bbox-left-edge keys `(-x,y,w,h)` cho RTL và `(x,y,w,h)` cho LTR. Không dùng arrival order, vendor order, `block_id` hoặc `src_text` làm geometry tie-break.

- [ ] **Step 5: Wire classic worker và mọi VM context**

Đổi đầu `extension/background.js` thành:

```javascript
if (typeof importScripts === "function") {
  importScripts("page-cache.js", "reading-order.js");
}
```

Trong `background-progressive.test.js`, nạp `reading-order.js` sau `page-cache.js` và trước `background.js` ở context helper; ở raw context thứ hai nạp `reading-order.js` trước `background.js`. Trong `progressive-integration.test.js`, làm tương tự sau `page-cache.js`.

- [ ] **Step 6: Chạy comparator và VM smoke gates**

Run:

```powershell
node extension/test/reading-order.test.js
node extension/test/background-progressive.test.js
node extension/test/progressive-integration.test.js
```

Expected: exact match cả ba fixtures; synthetic/fallback/negative-control pass; VM không ném `module is not defined` hoặc thiếu global helper.

- [ ] **Step 7: Commit helper gate**

```powershell
git add extension/reading-order.js extension/test/reading-order.test.js extension/background.js extension/test/background-progressive.test.js extension/test/progressive-integration.test.js
git commit -m "feat: add deterministic page reading order"
```

- [ ] **Step 8: Dừng ở checkpoint review Task 3**

Bàn giao comparator output theo từng fixture, synthetic case names, diff VM wiring và commit. Không bắt đầu direction/cache trước khi gate này được duyệt.

---

### Task 4: Thêm direction setting, descriptor boundaries và layout cache identity

**Files:**
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`
- Modify: `extension/content.js`
- Modify: `extension/background.js`
- Modify: `extension/page-cache.js`
- Modify: `extension/test/popup.test.js`
- Modify: `extension/test/content-progressive.test.js`
- Modify: `extension/test/background-progressive.test.js`
- Modify: `extension/test/page-cache.test.js`
- Modify: `server/config.py`
- Modify: `server/acceptance_app.py`
- Modify: `server/tests/test_acceptance_app.py`

**Interfaces:**
- Produces storage key: `chrome.storage.local.readingDirection: "rtl" | "ltr"`, missing default `rtl`.
- Produces descriptor field: `reading_direction: "rtl" | "ltr"` after `acceptScope`, `offlineLedger` và `prewarmJob` boundaries.
- Produces version: `PIPELINE_VERSIONS["layout_order"] == "reading-order-v1"`.
- Preserves: `analysisKey`/`ocrKey` khi chỉ direction/layout đổi; changes `overlayKey` và `translationKeyForBatch`.

- [ ] **Step 1: Viết popup/content tests đỏ**

Trong popup test, resolve storage không có direction và assert ngay lần đầu:

```javascript
assert.strictEqual(first.elements.readingDirection.value, "rtl");
assert.match(first.elements.currentLanguages.textContent, /RTL/);
first.elements.readingDirection.onchange({ target: { value: "ltr" } });
assert.deepStrictEqual(first.writes.at(-1), { readingDirection: "ltr" });
```

Trong content-progressive test, fake `storage.onChanged` phải lưu listener. Assert default start message có `reading_direction: "rtl"`; emit `{readingDirection:{newValue:"ltr"}}`, gọi action mới và assert snapshot mới là `ltr` trong khi request cũ vẫn `rtl`.

- [ ] **Step 2: Viết three-boundary/cache tests đỏ**

Trong background-progressive test:

- `start_scope` thiếu field trở thành `rtl`; invalid `vertical` phát job error và không tạo producer.
- restored legacy ledger thiếu field trở thành `rtl` trước `buildKeys` và trước persist lại.
- runtime `prewarmJob` thiếu field trở thành `rtl`, thực hiện OCR nhưng `storedJob(...)` xác nhận không persist page.
- cùng descriptor đổi RTL/LTR: `analysisKey` và `ocrKey` bằng nhau, `overlayKey` khác nhau.
- cùng ordered blocks đổi direction/layout/prompt/policy: `translationKeyForBatch` khác nhau.

Trong page-cache test:

```javascript
await cache.putJob({ job_id: "new", descriptor: { reading_direction: "ltr" } });
assert.strictEqual((await cache.rehydrate()).jobs.find((job) => job.job_id === "new").descriptor.reading_direction, "ltr");
await cache.putJob({ job_id: "legacy", descriptor: { src_lang: "ja" } });
assert.strictEqual((await cache.rehydrate()).jobs.find((job) => job.job_id === "legacy").descriptor.reading_direction, undefined);
```

Thêm page row với `layout_order: "reading-order-v0"` và ledger job; `purgeIncompatible()` với v1 phải xóa page row nhưng giữ ledger.

- [ ] **Step 3: Viết recursive version-shape test đỏ**

Trong acceptance test, dùng test-only helper:

```python
def version_shape(value):
    if isinstance(value, dict):
        return {key: version_shape(child) for key, child in sorted(value.items())}
    return str

assert version_shape(payload["versions"]) == version_shape(config.PIPELINE_VERSIONS)
assert payload["versions"]["layout_order"] == "reading-order-v1"
```

Run red gates:

```powershell
node extension/test/popup.test.js
node extension/test/content-progressive.test.js
node extension/test/background-progressive.test.js
node extension/test/page-cache.test.js
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_acceptance_app.py -q
```

Expected: FAIL vì setting, descriptor field và `layout_order` chưa có.

- [ ] **Step 4: Implement setting UI/state tối thiểu**

Thêm `select#readingDirection` với đúng hai option `rtl`/`ltr` và một `#currentLanguages` label cạnh source/destination controls. Popup đọc `{ enabled, srcLang, dstLang, readingDirection }`, dùng `rtl` nếu missing/không hợp lệ để control không rỗng, persist chỉ field đổi.

Content giữ module state:

```javascript
let readingDirection = "rtl";

function uiDirection(value) {
  return value === "ltr" ? "ltr" : "rtl";
}
```

Storage init/onChanged cập nhật state; mỗi `translatePage()` snapshot giá trị hiện hành và mọi `start_scope` mới gửi `reading_direction` explicit. Không suy từ language/site.

- [ ] **Step 5: Implement canonical background normalizer ở đúng ba boundary**

Thêm một hàm duy nhất:

```javascript
function normalizeReadingDirection(value) {
  if (value == null) return "rtl";
  if (value === "rtl" || value === "ltr") return value;
  throw new Error("invalid reading_direction");
}
```

Gọi khi dựng descriptor tại `acceptScope`, khi `offlineLedger` trả descriptor/ledger chung object graph, và inline descriptor của `prewarmJob`. Không gọi default trong `attachDescriptor`, `buildKeys` hoặc `PageCache`.

- [ ] **Step 6: Implement cache/version ownership**

Thêm `reading_direction` vào `storedDescriptor` allowlist. Thêm `layout_order: "reading-order-v1"` vào `PIPELINE_VERSIONS` và acceptance `/health` version object.

Trong `buildKeys`, giữ `analysisKey`/`ocrKey` nguyên inputs; thêm `job.reading_direction` và `versions.layout_order` vào `overlayKey`. Trong `translationKeyForBatch`, ordered context phải là:

```javascript
blocks.map((block, reading_order) => ({
  reading_order,
  block_id: block.block_id,
  src_text: block.src_text,
}))
```

Key cũng chứa explicit direction và `layout_order`; không dựa vào contextHash order như bảo đảm tình cờ.

Cập nhật central fake `/health` version objects trong `background-progressive.test.js` và `progressive-integration.test.js` với `layout_order: "reading-order-v1"`; không tạo default trong test harness.

- [ ] **Step 7: Chạy focused gates**

```powershell
node extension/test/popup.test.js
node extension/test/content-progressive.test.js
node extension/test/background-progressive.test.js
node extension/test/page-cache.test.js
node extension/test/progressive-integration.test.js
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_acceptance_app.py server/tests/test_health.py -q
```

Expected: settings/boundaries/key/version/purge gates PASS; prewarm vẫn không persist/dịch.

- [ ] **Step 8: Commit direction/cache slice**

```powershell
git add extension/popup.html extension/popup.js extension/content.js extension/background.js extension/page-cache.js extension/test/popup.test.js extension/test/content-progressive.test.js extension/test/background-progressive.test.js extension/test/page-cache.test.js extension/test/progressive-integration.test.js server/config.py server/acceptance_app.py server/tests/test_acceptance_app.py server/tests/test_health.py
git commit -m "feat: add reading direction and layout cache identity"
```

- [ ] **Step 9: Dừng ở checkpoint review Task 4**

Bàn giao matrix key invariants, three-boundary evidence, purge behavior và recursive version shape. Ghi rõ rollout sẽ purge page cache một lần dù derived keys chỉ đổi từ layout/translation trở lên.

---

### Task 5: Thêm Portuguese với một shared pinned Latin engine

**Files:**
- Modify: `server/config.py`
- Modify: `server/main.py`
- Modify: `server/ocr.py`
- Modify: `server/translator.py`
- Create: `server/tests/test_ocr_registry.py`
- Modify: `server/tests/test_ocr.py` chỉ cập nhật expectation tĩnh
- Modify: `server/tests/test_health.py`
- Modify: `server/tests/test_translate_endpoint.py`
- Modify: `server/tests/test_translator.py`
- Modify: `server/tests/test_acceptance_app.py`
- Modify: `extension/popup.html`
- Modify: `extension/test/popup.test.js`
- Modify: `extension/test/background-progressive.test.js` chỉ fake `/health` dùng version-shape/PT gate

**Interfaces:**
- Produces: `server.config.LANGS == ("ja", "es", "pt")` dùng bởi production validation và `/health.langs`.
- Produces: `ENGINES["es"] is ENGINES["pt"] is PaddleLatinEngine`.
- Produces: `OcrRegistry.get("es") is OcrRegistry.get("pt")` qua cache keyed by engine class.
- Produces: recognizer versions ES/PT cùng `paddleocr-latin-ppocrv6-v1` nhưng `ocrKey` vẫn chứa `src_lang`.

- [ ] **Step 1: Viết lightweight registry tests đỏ trong file riêng**

Tạo `server/tests/test_ocr_registry.py`; không import/chạy fixture từ `test_ocr.py`:

```python
import server.ocr as ocr
from server import config


def test_real_registry_shape_does_not_load_models():
    registry = ocr.OcrRegistry("cpu")
    assert registry.langs == list(config.LANGS)
    assert ocr.ENGINES["es"] is ocr.PaddleLatinEngine
    assert ocr.ENGINES["pt"] is ocr.PaddleLatinEngine
    assert registry._cache == {}


def test_es_and_pt_share_one_engine_instance(monkeypatch):
    calls = []

    class FakeLatin:
        def __init__(self, device):
            calls.append(device)

    monkeypatch.setattr(ocr, "ENGINES", {"es": FakeLatin, "pt": FakeLatin})
    registry = ocr.OcrRegistry("cpu")
    assert registry.get("es") is registry.get("pt")
    assert calls == ["cpu"]
```

- [ ] **Step 2: Viết health/prompt/popup tests đỏ**

Assert production health:

```python
assert payload["langs"] == ["ja", "es", "pt"]
assert all(lang in payload["versions"]["recognizers"] for lang in payload["langs"])
assert payload["versions"]["recognizers"]["es"] == payload["versions"]["recognizers"]["pt"]
```

Translator prompt với `src="pt"` phải chứa `from Portuguese`, không chứa `from pt`. Popup DOM phải có source option `value="pt"`; fake health version phục vụ PT có nested recognizer entry.

Acceptance health tiếp tục không expose `langs`; recursive shape test assert `"langs" not in payload` rồi so nested `versions.recognizers` keys với production config. Production-only gate mới assert mọi `/health.langs` có recognizer entry.

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_ocr_registry.py server/tests/test_health.py server/tests/test_translate_endpoint.py server/tests/test_translator.py server/tests/test_acceptance_app.py -q
node extension/test/popup.test.js
node extension/test/background-progressive.test.js
```

Expected: FAIL vì PT/version/shared cache chưa có. Không chạy `server/tests/test_ocr.py`.

- [ ] **Step 3: Implement config/main/translator PT sources**

Trong `server/config.py`:

```python
LANGS = ("ja", "es", "pt")
```

Production `main.py` import/use `config.LANGS` ở mọi source-language guard và health; xóa local `LANGS`. Thêm `LANG_NAMES["pt"] = "Portuguese"` trong translator. Popup thêm Portuguese dưới Spanish, giữ public values `es` và `pt` riêng.

- [ ] **Step 4: Pin PP-OCRv6 và cache registry theo class**

Latin constructor phải gọi:

```python
PaddleOCR(
    lang="es",
    ocr_version="PP-OCRv6",
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
    enable_mkldnn=False,
)
```

Registry tối thiểu:

```python
ENGINES = {"ja": MangaOcrEngine, "es": PaddleLatinEngine, "pt": PaddleLatinEngine}

def get(self, lang):
    engine_type = ENGINES[lang]
    if engine_type not in self._cache:
        self._cache[engine_type] = engine_type(self._device)
    return self._cache[engine_type]
```

Đổi recognizers:

```python
"recognizers": {
    "ja": "manga-ocr-v1",
    "es": "paddleocr-latin-ppocrv6-v1",
    "pt": "paddleocr-latin-ppocrv6-v1",
},
```

Không cache theo alias string và không khởi tạo `PaddleOCR(lang="pt")` thứ hai.

- [ ] **Step 5: Cập nhật static expectation nhưng không chạy model test**

Trong `server/tests/test_ocr.py`, chỉ đổi assertion registry languages thành:

```python
assert registry.langs == ["ja", "es", "pt"]
```

Không đổi model/image tests và không gọi file này trong bất kỳ command nào.

- [ ] **Step 6: Chạy focused lightweight gates**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_ocr_registry.py server/tests/test_health.py server/tests/test_translate_endpoint.py server/tests/test_translator.py server/tests/test_acceptance_app.py -q
node extension/test/popup.test.js
node extension/test/background-progressive.test.js
```

Expected: PASS; constructor fake đúng một lần; production health languages đều có recognizer version; không có model initialization output.

- [ ] **Step 7: Commit PT slice**

```powershell
git add server/config.py server/main.py server/ocr.py server/translator.py server/tests/test_ocr_registry.py server/tests/test_ocr.py server/tests/test_health.py server/tests/test_translate_endpoint.py server/tests/test_translator.py server/tests/test_acceptance_app.py extension/popup.html extension/test/popup.test.js extension/test/background-progressive.test.js
git commit -m "feat: share pinned Latin OCR for Portuguese"
```

- [ ] **Step 8: Dừng ở checkpoint review Task 5**

Bàn giao exact mapping/version output, fake init count và danh sách test đã chạy. Nêu riêng `server/tests/test_ocr.py` chỉ được đọc/cập nhật tĩnh.

---

### Task 6: Ship atomic strict-contract + full-page vertical slice

**Files:**
- Create: `server/contracts.py`
- Modify: `server/main.py`
- Modify: `server/acceptance_app.py`
- Modify: `server/translator.py`
- Modify: `server/config.py`
- Modify: `server/tests/test_translate_endpoint.py`
- Modify: `server/tests/test_acceptance_app.py`
- Modify: `server/tests/test_translator.py`
- Modify: `extension/background.js`
- Modify: `extension/test/background-progressive.test.js`
- Modify: `extension/test/progressive-integration.test.js`

**Interfaces:**
- Produces: shared `TranslateItem`, `TranslateItemsBody`, `translate_items_validation_error`.
- Produces: `GeminiTranslator.translate_items(items, src, dst, *, page_width, page_height, reading_direction)`.
- Consumes: `MangaReadingOrder.orderPage()` và explicit descriptor direction từ Tasks 3–4.
- Produces: tối đa một extension `/translate-items` request mỗi producer; no-block/all-hot zero request.
- Produces versions atomically: prompt `comic-page-items-v2`, policy `full-page-v1`.

- [ ] **Step 1: Viết shared-contract production tests đỏ**

Trong `test_translate_endpoint.py`, tạo một local request helper để mọi request cũ dùng cùng contract thật:

```python
def translate_body(items=None, **overrides):
    body = {
        "items": items or [{"id": "b1", "text": "hola", "reading_order": 0, "bbox": [1, 2, 3, 4]}],
        "src_lang": "es",
        "dst_lang": "vi",
        "page_width": 100,
        "page_height": 200,
        "reading_direction": "rtl",
    }
    body.update(overrides)
    return body
```

Fake translator signature phải nhận keyword-only context và ghi lại call. Gate positive assert context exact. Parametrize các request invalid: item/body extra field, bbox sai length, bbox âm, dimensions `0`, missing/invalid direction, duplicate ID, orders `[0,2]`, `[1,0]`. Mọi case phải trả status `422` và `error_code == "invalid_request"`; duplicate exact envelope:

```python
assert response.json() == {"error": "duplicate input id", "error_code": "invalid_request"}
```

- [ ] **Step 2: Viết acceptance shared-contract tests đỏ**

Cập nhật mọi request `/translate-items` hiện có qua helper tương đương. Assert production và acceptance cùng reject duplicate, extra field, non-dense order bằng cùng envelope. Một route acceptance khác cố ý gửi body invalid phải tiếp tục nhận FastAPI `detail`, chứng minh handler chỉ map exact path `/translate-items`.

- [ ] **Step 3: Viết prompt projection/context tests đỏ**

Trong translator tests, update mọi direct caller với keyword args. Fake model capture prompt rồi assert:

```python
assert '"page_width": 1107' in prompt
assert '"page_height": 871' in prompt
assert '"reading_direction": "rtl"' in prompt
assert '"reading_order": 0' in prompt
assert '"bbox": [10, 20, 30, 40]' in prompt
assert "ignored" not in prompt
```

Giữ tests response reorder exact IDs được accept; missing/foreign/duplicate bị reject.

- [ ] **Step 4: Chạy server tests đỏ**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_translate_endpoint.py server/tests/test_acceptance_app.py server/tests/test_translator.py -q
```

Expected: FAIL vì shared models, fields/context và handler chưa tồn tại.

- [ ] **Step 5: Implement `server/contracts.py` làm nguồn duy nhất**

Core model shape:

```python
from typing import Literal

from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, NonNegativeInt, PositiveInt, model_validator


class TranslateItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    text: str
    reading_order: NonNegativeInt
    bbox: tuple[NonNegativeInt, NonNegativeInt, NonNegativeInt, NonNegativeInt]


class TranslateItemsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[TranslateItem]
    src_lang: str
    dst_lang: str
    page_width: PositiveInt
    page_height: PositiveInt
    reading_direction: Literal["rtl", "ltr"]

    @model_validator(mode="after")
    def validate_items(self):
        ids = [item.id for item in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate input id")
        if [item.reading_order for item in self.items] != list(range(len(self.items))):
            raise ValueError("reading_order must match array order 0..n-1")
        return self
```

Handler dùng lỗi đầu tiên, strip prefix `Value error, `, fallback `invalid request`; nếu path khác `/translate-items`, `return await request_validation_exception_handler(request, exc)`. Cả `main.app` và `acceptance_app.app` đăng ký cùng handler; xóa hai cặp duplicate local models và duplicate endpoint ID check.

```python
async def translate_items_validation_error(request, exc):
    if request.url.path != "/translate-items":
        return await request_validation_exception_handler(request, exc)
    errors = exc.errors()
    message = errors[0].get("msg", "invalid request") if errors else "invalid request"
    message = message.removeprefix("Value error, ")
    return JSONResponse(
        status_code=422,
        content={"error": message, "error_code": "invalid_request"},
    )
```

Đăng ký ở cả hai app:

```python
app.add_exception_handler(RequestValidationError, translate_items_validation_error)
```

- [ ] **Step 6: Implement endpoint caller và prompt allowlist**

Endpoint production validate source/destination như hiện hành, rồi gọi:

```python
translated = get_pipeline().translator.translate_items(
    [item.model_dump() for item in body.items],
    body.src_lang,
    body.dst_lang,
    page_width=body.page_width,
    page_height=body.page_height,
    reading_direction=body.reading_direction,
)
```

Translator giữ projection exact:

```python
HTTP_TRANSLATE_ITEM_PROMPT_FIELDS = ("id", "text", "reading_order", "bbox")
page_context = json.dumps(
    {
        "page_width": page_width,
        "page_height": page_height,
        "reading_direction": reading_direction,
    },
    ensure_ascii=False,
)
```

Prompt template mới phải là:

```python
ITEM_PROMPT = """You are translating comic/manga dialogue from {src} to {dst}.
All items belong to one page and are already sorted in reading order. Use the
page context and neighboring bubbles to keep pronouns, politeness, terminology,
and tone consistent. Do not reorder or omit items.

Page context JSON:
{page_context}

Input items JSON:
{items}

Return ONLY a JSON array of objects with exactly these keys:
{{"id":"the input id","translation":"translated text"}}.
Return each input id exactly once; do not invent ids."""
```

Serialize projected items riêng; server không sort và không suy direction. Positive fake-translator test assert IDs tới translator giữ nguyên array order và exact direction từ body. Không đưa arbitrary `model_dump()` vào prompt. Bump cùng patch:

```python
"prompt": "comic-page-items-v2",
"policy": "full-page-v1",
```

- [ ] **Step 7: Chạy server contract/prompt gates xanh**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_translate_endpoint.py server/tests/test_acceptance_app.py server/tests/test_translator.py server/tests/test_health.py -q
```

Expected: production/acceptance strict envelope PASS; fake translator nhận exact page context; prompt projection PASS.

- [ ] **Step 8: Viết full-page orchestration tests đỏ trước khi xóa microbatch**

Trong `background-progressive.test.js`, thêm/đổi assertions:

1. Hold OCR after first block; `translationRequests.length === 0` cho tới `image_done`.
2. Full page body có ordered IDs, dense `reading_order`, bbox, decoded `page_width/page_height`, explicit direction; đúng một request cho producer.
3. No-block/all-hot có zero request và `translation_batches: []`.
4. Partial-hot gửi lại toàn bộ ordered page và không emit cached subset trước response.
5. Reordered exact response apply theo ordered view; missing/foreign/duplicate response không cache/emit phần nào.
6. Server `422 invalid_request` tạo trace `status: "failed"`, `error_code: "invalid_request"`.
7. Stale successful response chỉ warm hot cache, không emit/persist/finish producer retired.
8. OCR block error vẫn dịch blocks tốt; translation failure tính toàn bộ blocks tham gia là failed và page partial.
9. Invalid/missing decoded dimensions đi `failProducer`, không fallback natural dimensions.
10. Warm sibling copy `image_w/image_h` từ `analysis || sibling` trước request.

Rewrite đúng năm scenario gắn microbatch đã duyệt:

- `exact replacement preserves an in-flight translation batch`;
- `partial page replays complete blocks and requests only missing IDs`;
- `failed translation batch preserves a later valid batch`;
- `translation IDs are exact and a later click can retry`;
- `stale cloud response warms cache without emitting to replacement`.

Không sửa expectation của các scenario Spec A còn lại để hợp thức hóa regression.

Trong progressive integration, fake `/translate-items` assert exact body và chỉ được gọi sau OCR `image_done`.

- [ ] **Step 9: Chạy extension tests đỏ**

```powershell
node extension/test/background-progressive.test.js
node extension/test/progressive-integration.test.js
```

Expected: FAIL vì production vẫn gửi microbatch sớm và payload thiếu page context/order/bbox.

- [ ] **Step 10: Rút `applyOcrBlock()` về đúng ba nhiệm vụ**

Minimal target:

```javascript
async function applyOcrBlock(producer, event) {
  const block = ocrBlockFromEvent(event);
  mark(producer, "first_ocr");
  if (!producer.page.blocks.some((row) => row.block_id === block.block_id)) {
    producer.page.blocks.push(block);
  }
  await persist(producer);
}
```

Không `hotOcr` write theo microbatch và không queue translation. Giữ legacy hot OCR namespace chỉ để đọc artifact cũ nếu call path hiện hữu cần nó.

- [ ] **Step 11: Implement ordered full-page cache/network operation nguyên tử**

Giữ `translationKeyForBatch(producer, orderedBlocks, block)` làm per-block hot-translation key nhưng context là toàn ordered page. Hàm full-page phải:

```javascript
const items = orderedBlocks.map((block, reading_order) => ({
  id: block.block_id,
  text: block.src_text,
  reading_order,
  bbox: [...block.bbox],
}));
```

- zero blocks trả `{ translated: 0, failed: 0 }`, không trace/network;
- all-hot apply cached items theo `orderedBlocks`, không trace/network;
- partial-hot không apply subset, gửi `items` toàn trang một lần;
- sau mọi await tính cache key, kiểm tra retired trước apply/persist; failure response retired cũng không mark/emit/persist;
- network trace cố định `batch_id: 1`, `phase: "full_page"`, mọi ordered IDs, `started_ms` tương đối với `producer.timings.accepted`, `cache_hit: false`;
- validate response length + duplicate/missing/foreign IDs trước cache/apply;
- response reorder map bằng ID rồi warm/apply theo ordered view;
- retired success được warm cache sau exact validation nhưng return trước apply/emit/persist/finish;
- error trace dùng `error.errorCode` nếu có; fallback lần lượt `rate_limited`, `invalid_response`, `translation_failed`;
- translation failure mark/emit error cho mọi block tham gia và trả `{ translated: 0, failed: orderedBlocks.length }` dù persisted partial translations cũ từng được replay.

Không tạo class/service mới; một helper validation map và một async full-page function trong `background.js` là đủ.

- [ ] **Step 12: Thay `runProducer()` sequence và xóa microbatch state**

Sau OCR complete/prewarm cleanup:

```javascript
if (!Number.isInteger(producer.page.image_w) || producer.page.image_w <= 0 ||
    !Number.isInteger(producer.page.image_h) || producer.page.image_h <= 0) {
  throw new Error("invalid page dimensions");
}
const ordered = MangaReadingOrder.orderPage({
  blocks: producer.page.blocks,
  image_w: producer.page.image_w,
  image_h: producer.page.image_h,
  reading_direction: producer.descriptor.reading_direction,
});
const summary = await translateFullPage(producer, ordered.blocks);
if (producer.retired) return;
await finishProducer(producer, summary);
```

`finishProducer` dùng summary mới cộng `producer.blockErrors`; first translation/overlay chỉ có sau OCR done. Xóa `queueTranslation`, `flushTranslationBatch`, `flushTranslations`, `pendingTranslations`, `attemptedTranslationIds`, `translationTimer`, `translationChain`, numeric `translationBatches` và timer cleanup tương ứng. Giữ `translationBatchTrace`, `postJson`, `error.status`, `error.errorCode`, `isRateLimited`, producer sharing/retirement hiện có.

- [ ] **Step 13: Chạy full vertical-slice focused gates**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_translate_endpoint.py server/tests/test_acceptance_app.py server/tests/test_translator.py server/tests/test_health.py -q
node extension/test/reading-order.test.js
node extension/test/background-progressive.test.js
node extension/test/progressive-integration.test.js
node extension/test/content-progressive.test.js
node extension/test/page-cache.test.js
```

Expected: strict contract, exact prompt, no-early-request, max-one-request, atomic response/cache/render, retirement và telemetry tests PASS.

- [ ] **Step 14: Chạy deletion/static tripwire**

Run:

```powershell
$obsolete = Select-String -Path extension/background.js -Pattern 'queueTranslation|flushTranslationBatch|flushTranslations|pendingTranslations|attemptedTranslationIds|translationTimer|translationChain|phase:\s*["'']microbatch["'']'
if ($obsolete) { $obsolete; throw 'obsolete microbatch path remains' }
Select-String -Path extension/background.js -Pattern 'phase:\s*["'']full_page["'']|translationBatchTrace|errorCode'
```

Expected: obsolete set rỗng; full-page trace/error-code matches có mặt.

- [ ] **Step 15: Commit atomic vertical slice**

```powershell
git add server/contracts.py server/main.py server/acceptance_app.py server/translator.py server/config.py server/tests/test_translate_endpoint.py server/tests/test_acceptance_app.py server/tests/test_translator.py extension/background.js extension/test/background-progressive.test.js extension/test/progressive-integration.test.js
git commit -m "feat: translate complete pages in reading order"
```

- [ ] **Step 16: Dừng ở checkpoint review Task 6**

Bàn giao request-count matrix, error/trace matrix, exact five rewritten scenarios, unchanged-scenario test result và commit. Không tự gọi vertical slice “đóng” trước Task 7 full gate.

---

### Task 7: Chạy full offline gate và đóng implementation checkpoint

**Files:**
- Modify: `docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json`
- Verify only: toàn bộ files Tasks 1–6
- Verify immutable: `docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json`

**Interfaces:**
- Consumes: mọi implementation commit và frozen control metadata.
- Produces: reproducible offline checkpoint record; không tạo live quality evidence.

- [ ] **Step 1: Chạy full Python suite với explicit exclusion**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests --ignore=server/tests/test_ocr.py -q
```

Expected: PASS. Nếu command nào trong log không có `--ignore`, checkpoint không đạt.

- [ ] **Step 2: Chạy full Node suite gồm comparator mới**

```powershell
Get-ChildItem extension/test/*.test.js | Sort-Object Name | ForEach-Object {
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "JS test failed: $($_.Name)" }
}
```

Expected: mọi process exit `0`, gồm `reading-order.test.js` và toàn bộ Spec A scenarios.

- [ ] **Step 3: Chạy gate evaluator/control riêng**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_real_page_quality.py -q
$specB = Get-Content docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json -Raw | ConvertFrom-Json
git diff --exit-code $specB.control_baseline_commit -- $specB.control_baseline_path
& 'D:\MangaTranslator\venv\Scripts\python.exe' -c "import json; from pathlib import Path; from server.real_page_quality import QUALITY_ARMS, load_manifest, policy_batches, source_pages; root=Path('.'); manifest=load_manifest(root/'server/tests/fixtures/real_pages/manifest.json'); capture=json.loads((root/'server/tests/fixtures/real_pages/captures/2026-08-01-policy-probe.json').read_text(encoding='utf-8')); total=sum(len(policy_batches(page, arm, capture['baseline'][page['id']])) for page in source_pages(manifest) for arm in QUALITY_ARMS); assert total == 25, total; print(total)"
```

Expected: evaluator PASS, control diff rỗng, semantic total `25`.

- [ ] **Step 4: Audit version/contract/microbatch invariants**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -c "from server import config; assert config.LANGS == ('ja','es','pt'); v=config.PIPELINE_VERSIONS; assert v['layout_order']=='reading-order-v1'; assert v['prompt']=='comic-page-items-v2'; assert v['policy']=='full-page-v1'; assert set(config.LANGS) <= set(v['recognizers']); assert v['recognizers']['es']==v['recognizers']['pt']=='paddleocr-latin-ppocrv6-v1'; print(v)"
$obsolete = Select-String -Path extension/background.js -Pattern 'queueTranslation|flushTranslationBatch|flushTranslations|pendingTranslations|attemptedTranslationIds|translationTimer|translationChain|phase:\s*["'']microbatch["'']'
if ($obsolete) { $obsolete; throw 'obsolete microbatch path remains' }
Select-String -Path server/tests/test_ocr.py -Pattern '\["ja", "es", "pt"\]'
```

Expected: version assertions pass; obsolete path absent; static `test_ocr.py` expectation present mà file không được chạy.

- [ ] **Step 5: Audit scenario rewrite scope và diff quality**

```powershell
git diff --check
git status --short
git log --oneline --decorate -8
git show --stat --oneline HEAD
```

Review `background-progressive.test.js` diff từ Task 5 tới Task 6: chỉ năm scenario đã liệt kê được rewrite vì microbatch; các scenario khác chỉ được sửa fixture/payload/version wiring tối thiểu để mang contract mới.

- [ ] **Step 6: Cập nhật worklog bằng evidence thật từ commands trên**

In object cần thêm bằng SHA Task 6 thật:

```powershell
$implementationSha = git rev-parse HEAD
[ordered]@{
  status = 'offline_gates_passed'
  implementation_commit = $implementationSha
  versions = [ordered]@{
    layout_order = 'reading-order-v1'
    recognizers = [ordered]@{
      es = 'paddleocr-latin-ppocrv6-v1'
      pt = 'paddleocr-latin-ppocrv6-v1'
    }
    prompt = 'comic-page-items-v2'
    policy = 'full-page-v1'
  }
  control_policy_batch_count = 25
  test_ocr = 'static_expectation_updated_not_run'
  live_quality_rerun = 'not_a_vertical_slice_gate'
} | ConvertTo-Json -Depth 4
```

Dùng `apply_patch` thêm output này dưới key `implementation_checkpoint`, giữ nguyên năm field control. Artifact phải chứa SHA literal 40 ký tự và exact test counts/output đã quan sát, không ghi số dự đoán. Chỉ đặt `status: offline_gates_passed` sau khi Steps 1–5 đều xanh.

- [ ] **Step 7: Validate worklog và commit checkpoint docs**

```powershell
$specB = Get-Content docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json -Raw | ConvertFrom-Json
if ($specB.implementation_checkpoint.implementation_commit -notmatch '^[0-9a-f]{40}$') { throw 'invalid implementation SHA' }
git cat-file -e "$($specB.implementation_checkpoint.implementation_commit)^{commit}"
git diff --exit-code $specB.control_baseline_commit -- $specB.control_baseline_path
git diff --check
git add docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json
git commit -m "docs: record spec b offline checkpoint"
```

- [ ] **Step 8: Dừng ở checkpoint review Task 7**

Bàn giao full command outputs, test counts, frozen-control proof, microbatch deletion proof, worklog diff và commit. Đây là offline vertical-slice checkpoint; không tuyên bố runtime telemetry hoặc live quality đã hoàn tất.

---

### Task 8: Capture runtime telemetry sau checkpoint

**Files:**
- Modify: `docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json`
- Preserve immutable: `docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json`

**Interfaces:**
- Consumes: offline-approved extension/server build và real-page fixtures.
- Produces: full-page runtime page metrics trong worklog Spec B, gồm first-overlay trade-off; không tạo/rebaseline quality control.

- [ ] **Step 1: Reconfirm Task 7 commit và frozen control trước runtime**

```powershell
$specB = Get-Content docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json -Raw | ConvertFrom-Json
git diff --exit-code $specB.control_baseline_commit -- $specB.control_baseline_path
git status --short
```

Expected: control unchanged; chỉ dirty paths đã biết của người dùng nếu còn.

- [ ] **Step 2: Khởi động đúng production server và fixture server trong hai terminal riêng**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m uvicorn server.main:app --host 127.0.0.1 --port 8910
```

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m http.server 8000 --directory server/tests/fixtures/real_pages
```

Không dùng `/health` đơn lẻ làm bằng chứng OCR → full-page translation → overlay.

- [ ] **Step 3: Capture real extension flows với direction explicit**

Qua popup/extension đã reload từ đúng checkout:

- chạy hai JA spread ở `rtl`, ít nhất một cold và một warm run;
- chạy một synthetic/manual `ltr` page để xác nhận popup → content → background → request;
- chạy PT source để xác nhận public `src_lang="pt"` và shared-engine runtime không khởi tạo model Latin thứ hai trong cùng server process;
- lấy `scope_done.page_metrics`, `translation_batches` và server request evidence; không ghi source/OCR/translation text hoặc credentials.

Mỗi network run phải có đúng một trace `phase: "full_page"`; all-hot run có `[]`. `first_translation_ms` và `first_overlay_ms` phải sau `ocr_done_ms` và được ghi là latency trade-off có chủ ý, không gọi là tối ưu.

- [ ] **Step 4: Ghi observed telemetry vào worklog Spec B**

Dùng `apply_patch` thêm `runtime_telemetry` với commit, device, direction, cache state, exact page metrics/trace counts và nhận xét first-overlay. Chỉ ghi giá trị quan sát thật; nếu một run không thực hiện được, ghi `status: "blocked"` cùng machine-readable reason và dừng review, không thay bằng fake evidence.

Không chạy `server.run_real_page_probe run`, không gọi live quality rerun và không sửa control file Spec A.

- [ ] **Step 5: Re-run privacy/control checks và commit telemetry**

```powershell
$specB = Get-Content docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json -Raw | ConvertFrom-Json
git diff --exit-code $specB.control_baseline_commit -- $specB.control_baseline_path
Select-String -Path docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json -Pattern 'api_key|source_url|src_text|trans_text'
git diff --check
```

Expected: control diff rỗng; sensitive-pattern scan rỗng. Commit only after evidence has been reviewed:

```powershell
git add docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json
git commit -m "docs: record spec b runtime telemetry"
```

- [ ] **Step 6: Dừng ở final Spec B review checkpoint**

Bàn giao runtime evidence, first-overlay trade-off, shared PT engine observation, frozen-control proof và commit. Chỉ gọi Spec B hoàn tất sau khi người dùng duyệt checkpoint này.

---

## Coverage Matrix

| Design requirement | Task |
|---|---:|
| Merge toàn Spec A trước comparator/full-page | 1 |
| Full Spec A offline baseline, no `test_ocr.py`, immutable merge SHA/control | 2 |
| Dual-loaded pure helper, exact real-fixture comparator, RTL/LTR synthetic/gutter/tall bridge | 3 |
| Popup/content direction, three descriptor boundaries, key-layer invariants, `layout_order` | 4 |
| PT public API, shared pinned PP-OCRv6 instance, recognizer/health coverage | 5 |
| Shared strict models/handler, page-context prompt, prompt/policy versions | 6 |
| OCR-complete full-page orchestration, atomic response/cache/render, retirement/trace | 6 |
| Full regression, five-scenario rewrite limit, control diff/tripwire | 7 |
| Runtime telemetry và first-overlay trade-off trong worklog mới | 8 |

## Explicit Deferrals

- Spec C: mask, inpainting, overlay overlap/clipping, text fitting và geometry rendering.
- Spatial index hoặc thuật toán tốt hơn O(n²): chỉ thêm khi page thực tế lớn hơn đáng kể và profiling chứng minh comparator là bottleneck.
- Abort HTTP khi producer retired: chỉ thêm nếu runtime telemetry cho thấy stale request là chi phí đáng kể; current design cho phép validate/warm cache rồi bỏ side effects.
- Live Gemini quality rerun/re-scoring: là paced task riêng nếu người dùng yêu cầu, không nằm trong vertical-slice gate này.
- Migration để giữ OCR page cache qua coarse `purgeIncompatible()`: chỉ thiết kế nếu cold-start purge một lần trở thành vấn đề đo được.
