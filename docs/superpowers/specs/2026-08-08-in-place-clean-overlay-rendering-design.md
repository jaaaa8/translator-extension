# Thiết kế Spec C: làm sạch chữ gốc và render bản dịch nguyên vị trí

**Ngày:** 2026-08-08

**Nhánh:** `feat/v4`

**Trạng thái:** brainstorming và phản biện thiết kế đã PASS; tài liệu này chờ người dùng review trước khi lập implementation plan

## 1. Kết quả cần đạt

Spec C thay overlay hình chữ nhật trắng hiện tại bằng một pipeline render nguyên vị trí:

1. Detector giữ lại mask chữ đã có, resolver xác định vùng chứa thoại và server làm sạch riêng các pixel chữ gốc.
2. Gemini dịch toàn trang một lần, đồng thời phân loại `text` hoặc `sfx`; SFX không được dịch và không được vẽ.
3. Bản dịch chỉ xuất hiện khi patch sạch và chữ đã fit cùng sẵn sàng. Patch và chữ được mount nguyên tử trong cùng hệ tọa độ.
4. Chữ được co dần tới tối thiểu `10px`; nếu vẫn tràn thì block đó giữ nguyên ảnh gốc, không dùng nền trắng, card hoặc text-only fallback.
5. Không có bbox nền trắng `overflow:hidden` phủ lên hoặc cắt chữ. Wrapper chung được phép `overflow: visible`; patch tự giới hạn bằng alpha mask.
6. Cache, version và recovery có identity rõ ràng, không chạy lại OCR/Gemini hoặc inpaint do thay đổi không liên quan.
7. Ưu tiên thứ tự: chất lượng UI trước, sau đó mới tới latency và throughput của extension.

Tính nguyên tử ở đây là **theo block**. Một block lỗi giữ nguyên ảnh gốc; các block khác trên cùng trang vẫn có thể render nếu vượt đủ gate.

## 2. Quyết định sản phẩm và ngoài phạm vi

### 2.1 Quyết định đã chốt

- Chỉ dùng chữ và patch ảnh; không thêm khung/card UI.
- Không áp dụng patch làm sạch lên ảnh, không vẽ chữ và không gửi event render cho SFX. RenderArtifact có thể đã tính candidate patch trước khi Gemini trả `kind`; candidate đó bị extension loại và không bao giờ mount.
- Không có text-only fallback. Không bao giờ vẽ chữ dịch đè lên chữ gốc.
- Block thoại/narration không có container chắc chắn vẫn được gửi dịch. Nếu không thể làm sạch và bố trí an toàn, block có `reason: "unsupported_region"` và giữ nguyên ảnh.
- Font co từ kích thước đề xuất xuống `10px`. Dưới mức đó là `fit_failed`, không mount.
- Dùng full-page translation của Spec B; không quay lại microbatch hoặc dịch từng bubble.
- Giữ reading order `rtl`/`ltr` của Spec B. Spec C chỉ bổ sung orientation của fragment trong một vùng.

### 2.2 Ngoài phạm vi

- `CaptureSource`, `captureVisibleTab`, canvas capture và adapter riêng theo site.
- Dịch hoặc vẽ SFX.
- Thay model OCR, batching OCR hoặc tối ưu backend inference.
- Viết lại thuật toán reading order cấp trang của Spec B.
- Persist bitmap patch trong `chrome.storage` hoặc xin quyền `unlimitedStorage`.
- Thêm dependency/framework mới khi OpenCV, DOM và Chrome storage hiện tại đã đủ.
- Implementation plan, code và commit trước khi tài liệu này được người dùng duyệt.

## 3. Luồng end-to-end

```text
content tạo scope và các descriptor theo thứ tự DOM
  -> background fetch bytes có giới hạn, hash SHA-256 và chia sẻ theo source URL
  -> build analysis_key, ocr_key, page_artifact_key, render_artifact_key
  -> /ocr-stream tạo/replay AnalysisArtifact và OcrArtifact
       -> detector trả region + raw mask + refined inpaint mask + vertical
       -> resolver gom fragment theo container trong page-space
       -> render build được submit ngoài _ocr_lock và chạy song song OCR
       -> OCR chỉ giữ _ocr_lock khi gọi model
  -> background orderPage toàn bộ OCR block
  -> /translate-items trả exact IDs cùng kind=text|sfx
  -> manifest_ids chỉ chứa kind=text
  -> background lấy /render-artifact theo key
  -> ghép manifest với artifact và đo fit bằng DOM tách khỏi màn hình
  -> mỗi block hợp lệ mount patch + chữ trong một DOM commit
  -> persist PageRow metadata, translation, manifest và layout profile
```

Render build không nằm trong `_ocr_lock`. Ngay sau khi analysis hoàn thành, server submit một singleflight task theo `render_artifact_key` vào executor riêng `max_workers=1`, rồi OCR tiếp tục. `/render-artifact` có thể đợi task đang chạy thay vì khởi tạo lần thứ hai.

## 4. Analysis artifact, mask và resolver

### 4.1 Contract detector

`TextDetector.__call__()` hiện đã tính cả `mask` và `mask_refined` với `REFINEMASK_INPAINT`; adapter không được bỏ chúng. Kết quả analysis phải giữ:

```text
DetectedRegion {
  bbox: [x, y, width, height],
  vertical: boolean,
  raw_mask_crop: uint8,
  refined_mask_crop: uint8,
  crop_rgb: uint8
}
```

- `raw_mask_crop` bám sát nét chữ, dùng cho occupancy, resolver và layout.
- `refined_mask_crop` đã nở cho inpaint, dùng làm erase mask.
- `vertical` đi xuyên suốt detector -> `PreparedRegion` -> OCR event/cache -> background.
- Byte của cả hai mask phải được tính trong `AnalysisArtifact.byte_size`.

### 4.2 Hệ tọa độ duy nhất

Mọi bbox và mask công khai sau analysis đều ở **page-space** của ảnh gốc:

- Detector vẫn chạy trên `work` sau crop.
- Pipeline cộng `offset_x`, `offset_y` vào bbox và origin của mask đúng một lần khi dựng artifact.
- `clean_region`, `patch_bbox` và `fit_bbox` trong render artifact cũng là page-space.
- Content không tự bù crop lần thứ hai.
- Bbox là `[x, y, width, height]`, tọa độ integer, đã clamp vào ảnh và có diện tích dương.

### 4.3 Dedupe và resolve container

IoU/exact dedupe hiện hữu tiếp tục chạy **trước** resolver. Nó vẫn là hàng rào loại detector duplicate, không bị thay bằng grouping.

Resolver dùng raw mask cùng tín hiệu connected component, nền và biên quanh text để tìm vùng chứa có ranh giới kín. Kết quả có hai dạng:

```text
ResolvedTextRegion {
  bbox: union bbox duy nhất trong trang,
  fragments: DetectedRegion[],
  bounded: true,
  container_mask: uint8
}

UnboundedTextRegion {
  bbox: union bbox duy nhất trong trang,
  fragments: DetectedRegion[],
  bounded: false,
  container_mask: null
}
```

Các quy tắc bắt buộc:

1. Fragment chỉ được gom khi cùng connected container và không tạo cầu nối qua hai bubble.
2. Union bbox sau resolver phải duy nhất trong trang; exact duplicate union được hợp nhất trước khi phát artifact.
3. Fragment overlap mạnh hoặc có OCR text trùng phải được khử trùng trước khi nối, tránh dịch lặp câu.
4. Fragment ngang sắp trên-xuống rồi trái-phải. Fragment dọc sắp phải-sang-trái, trong cột là trên-xuống.
5. Nối `src_text` bằng `"\n"`; không chèn space vào tiếng Nhật.
6. `block_id = stable_block_id(analysis_key, union_bbox, 0)`.
7. Unbounded không bị coi mặc định là SFX và không bị bỏ khỏi translation.

`AnalysisArtifact` giữ đủ OCR crop, source crop, raw/refined mask và resolved region để OCR theo `src_lang` khác hoặc render-only rebuild không cần detect lại.

## 5. Làm sạch và RenderArtifact phía server

### 5.1 Thuật toán làm sạch

Với region bounded, cleaner:

1. Lấy ROI có context đã clamp vào ảnh để inpaint, nhưng không mở rộng vùng alpha được vẽ.
2. Dùng `refined_mask` làm erase mask và source RGB làm đầu vào.
3. Chạy OpenCV inpaint với tham số cố định trong version `cleaner`.
4. Tạo patch RGBA: RGB là kết quả inpaint; alpha chỉ khác 0 bên trong erase mask và feather **vào phía trong** biên mask.
5. Pixel ngoài erase mask có alpha 0 tuyệt đối. Patch không phải hình chữ nhật trắng và không có overscan nhìn thấy được.
6. Nếu mask rỗng, vượt ảnh, không phủ đủ raw ink hoặc cleaner không tạo được patch hợp lệ, trả capability failure `clean_failed`.

Feather chỉ làm mềm seam; nó không được làm hẹp alpha tới mức lộ lại viền chữ gốc. Tham số inpaint, dilation và feather thuộc `patch_versions.cleaner`.

### 5.2 Tính `fit_bbox`

Server tính `fit_bbox` từ interior của resolved container và raw text/layout mask:

- nằm hoàn toàn trong page bounds;
- không đè qua border bubble;
- có padding nội bộ cố định, versioned;
- không phụ thuộc bản dịch, model Gemini hoặc ngôn ngữ đích;
- null với region không có vùng bố trí an toàn.

`font_px` và `line_height` không nằm trong server artifact. Chúng phụ thuộc text/CSS thực tế và do content script đo.

### 5.3 Contract `RenderArtifact`

```text
RenderArtifact {
  schema_version: "render-v1",
  render_artifact_key: string,
  analysis_key: string,
  image_w: integer,
  image_h: integer,
  blocks: [
    {
      block_id: string,
      patch_id: string | null,
      patch_bbox: [x, y, width, height] | null,
      clean_region: [x, y, width, height] | null,
      fit_bbox: [x, y, width, height] | null,
      patch_mime: "image/png" | null,
      patch_rgba: encoded bytes | null,
      reason: null | "clean_failed" | "layout_failed" | "unsupported_region"
    }
  ]
}
```

Artifact liệt kê mọi analysis block để có thể kiểm manifest, kể cả block sau đó được Gemini phân loại là SFX. Artifact độc lập translation; phía extension mới lọc theo `manifest_ids`.

`patch_rgba` là PNG RGBA lossless được base64 trong JSON response; `patch_mime` khóa kiểu dữ liệu. `patch_id` là content hash của encoded PNG cùng bbox/encoding version. Encoded bytes chỉ tồn tại trong server cache và response; extension không ghi chúng vào page cache.

### 5.4 API lấy artifact

Thêm `POST /render-artifact` theo mô hình key-first:

- Request đầu gửi `analysis_key`, `render_artifact_key` và crop metadata.
- Nếu analysis/source artifact còn sống, server trả hoặc đợi singleflight render task.
- Nếu thiếu source/analysis, server trả `409 artifact_missing`; background gửi lại cùng request kèm blob ảnh đã hash.
- Server recompute SHA-256 bytes khi nhận blob; hash không khớp identity thì trả `409 source_identity_mismatch`, không ghi cache.
- Cùng `render_artifact_key` chỉ có một build đang chạy.

## 6. Translation contract và SFX

Request `/translate-items` giữ nguyên field để không đổi full-page context của Spec B:

```json
{
  "items": [
    {"id": "...", "text": "...", "reading_order": 0, "bbox": [0, 0, 1, 1]}
  ]
}
```

Response nguyên tử đổi thành:

```json
{
  "items": [
    {"id": "...", "kind": "text", "translation": "..."},
    {"id": "...", "kind": "sfx", "translation": null}
  ]
}
```

Validation strict:

- exact response ID set bằng exact request ID set;
- không duplicate/missing/extra ID;
- mỗi item chỉ có `id`, `kind`, `translation`;
- `kind="text"` yêu cầu translation là string không rỗng sau trim;
- `kind="sfx"` yêu cầu translation là `null`;
- validate kiểu trước mọi `str()` coercion;
- một item sai làm hỏng toàn response; không persist manifest nửa vời.

Điểm sửa bắt buộc là `server/translator.py::_normalize_items()` (hiện quanh dòng 54-67): helper phải validate enum/nullable pair và giữ `translation=null` trước mọi coercion. Không được giữ `rows[item_id] = str(item["translation"])`, vì nó biến SFX thành chuỗi `"None"`. `server/main.py` gọi lại cùng normalizer trước khi trả `/translate-items` (hiện quanh dòng 174), nên cả decode từ Gemini và HTTP response phải đi qua đúng một semantics mới.

Prompt/policy bump thành semantic mới, tối thiểu `prompt=full-page-v3`. Gemini là nơi duy nhất quyết định SFX trong Spec C. `manifest_ids` được tạo sau response hợp lệ và chỉ chứa ID có `kind="text"`, theo reading order. Trang toàn SFX có `manifest_ids: []` hợp lệ.

Retry translation luôn ở cấp toàn trang với cùng exact item set và context hash; không retry subset. Hot translation cache phải lưu cả `kind` và `translation`, và chỉ được dùng khi đủ mọi item của full-page context. Thiếu một item thì gọi lại full-page request.

## 7. Render nguyên tử trong content script

### 7.1 Điều kiện mount

Một block chỉ có `render_mode="in_place"` khi đồng thời có:

- translation `kind="text"` hợp lệ;
- patch, patch bbox và fit bbox hợp lệ;
- DOM measurement fit ở font không dưới `10px`;
- binding ảnh/source signature còn hiện hành.

Content tạo element đo ngoài màn hình với đúng font, width, line-height và writing mode cuối. Nó co font từ cỡ đề xuất tới `10px`, dùng `scrollWidth <= clientWidth` và `scrollHeight <= clientHeight`. Chỉ khi fit thành công mới tạo `layout_profile` và commit wrapper vào overlay root.

Nếu vẫn overflow ở `10px`, block thành `fit_failed`; patch và chữ đều không mount. Không có trạng thái patch-only hoặc text-only.

`layout_profile.font_px` và `line_height` là CSS pixel của lần fit thành công gần nhất, chỉ là hint để bắt đầu lần đo sau. Content luôn revalidate với kích thước ảnh đang render và vẫn cưỡng chế minimum `10px`; không được tin profile cache đến mức bỏ qua overflow check khi viewport/zoom thay đổi.

Sau phép đo, content gửi `render_metric` best-effort gồm `page_artifact_key`, `render_artifact_key`, `layout_fit_version`, `block_id`, `painted`, `reason` và `layout_profile`. Collector phía background độc lập vòng đời producer:

- producer không đợi result/ACK từ content để terminal;
- result thiếu do disconnect/supersede không làm treo job;
- chỉ khi collector có outcome hợp lệ cho toàn bộ `manifest_ids` mới persist một RenderSubrecord ready;
- không persist subrecord nửa manifest; nếu collector thiếu result thì giữ `render` absent và đo lại ở lượt sau;
- update chỉ được commit khi page key, render key và layout version vẫn khớp, tránh late metric ghi vào identity mới.

### 7.2 Cấu trúc DOM/CSS

Mỗi block dùng một wrapper với một transform page-space -> rendered-image-space:

```text
.mt-render-block            overflow: visible; background: transparent
  .mt-clean-patch           clip/alpha riêng, pointer-events: none
  .mt-translated-text       không background trắng, không overflow:hidden
```

- Patch và text không tự round/scale bằng hai công thức khác nhau.
- Wrapper dùng cùng origin và transform với overlay root để tránh seam 1px.
- Text nằm trong `fit_bbox`, có thể dùng `writing-mode` theo `vertical`.
- Không tái sử dụng `.mt-bubble` trắng hiện tại.
- DOM commit của wrapper là mốc `first_overlay_ms`; không chốt metric khi mới có text hoặc mới có patch.

## 8. Identity và versioning

### 8.1 Source identity và fetch scheduler

`source_revision` từ URL/kích thước tự nhiên không đủ mạnh. Spec C dùng:

```text
source_content_hash = SHA256(exact fetched image bytes)
```

Background khởi tạo promise fetch/hash cho mọi descriptor sớm, nhưng:

- có queue riêng `MAX_SOURCE_FETCH = 2`, không dùng `MAX_CONCURRENT` của producer;
- dedupe shared fetch theo source URL, không theo crop;
- mỗi shared entry có `AbortController` và refcount;
- release request chỉ abort khi consumer cuối cùng rời;
- await identity theo thứ tự job ban đầu rồi attach/admit, nên job đầu không chờ tổng thời gian download cả scope;
- fetch thất bại là `source_unavailable`, không purge cache và được retry ở lượt sau.

### 8.2 Công thức key

```text
analysis_key = H(
  source_content_hash,
  canonical_crop,
  versions.detector,
  versions.dedupe,
  versions.prep,
  versions.region_resolver
)

ocr_key = H(
  analysis_key,
  src_lang,
  versions.recognizers[src_lang]
)

page_artifact_key = H(
  ocr_key,
  dst_lang,
  reading_direction,
  versions.layout_order,
  versions.translator_model,
  versions.prompt,
  versions.policy,
  versions.page_schema
)

render_artifact_key = H(
  analysis_key,
  patch_versions.cleaner,
  patch_versions.render_encoding,
  patch_versions.render_schema
)
```

Translation identity không được nằm trong `render_artifact_key`. Đổi Gemini model, prompt hoặc `dst_lang` phải dùng lại cùng patch sạch. `LAYOUT_FIT_VERSION` là hằng phía extension; nó không nằm trong `/health` hoặc server key.

### 8.3 `/health`

Production và acceptance server cùng trả hai sibling object:

```json
{
  "versions": {
    "detector": "...",
    "dedupe": "...",
    "prep": "...",
    "region_resolver": "...",
    "recognizers": {"ja": "...", "es": "...", "pt": "..."},
    "translator_model": "...",
    "prompt": "...",
    "policy": "...",
    "layout_order": "...",
    "page_schema": "page-v2"
  },
  "patch_versions": {
    "cleaner": "...",
    "render_encoding": "...",
    "render_schema": "render-v1"
  }
}
```

`region_resolver` phải vừa có trong health vừa tham gia `buildKeys()`. Chỉ thêm metadata mà quên key sẽ khiến server replay analysis cũ.

## 9. Cache server và browser

### 9.1 Server LRU

- `_analysis_cache`: `max_items=8`, `max_bytes=128 MiB`.
- `_ocr_cache`: `max_items=256`, không có byte cap.
- `_render_cache`: cache riêng, `max_items=32`, `max_bytes=128 MiB`.

Item cap của analysis là giới hạn chính với artifact khoảng 10 MiB/trang; byte cap là hàng rào an toàn. Render cache không chia sẻ eviction hoặc mutation với OCR cache.

`BoundedLru.put()` phải có semantics:

```python
size = size_of(value)
if self.max_bytes is not None and size > self.max_bytes:
    return None
# chỉ từ đây mới được thay entry cùng key và evict LRU
```

- Guard oversize chạy trước `pop()` entry cũ cùng key.
- `None` nghĩa là không cache; `[]` nghĩa là đã cache và không evict entry nào.
- Update oversize không được xóa value cũ cùng key.
- Không có phase compaction, cache mutation muộn hoặc `replace_if_current`.

### 9.2 Browser cache và invalidation chọn lọc

`PAGE_SCHEMA` bump thành `page-v2`. Page cache chỉ giữ metadata, translation, manifest, patch ID/bbox và layout profile; không giữ `patch_rgba`.

Bump schema phải đổi đồng thời hai site sở hữu identity: `extension/page-cache.js` hằng `PAGE_SCHEMA` (hiện dòng 1) và `server/config.py` field `PIPELINE_VERSIONS["page_schema"]` (hiện dòng 24). Production/acceptance `/health` phải cùng phát `page-v2`; lệch một site sẽ làm `purgeIncompatible()` xóa PageRow mỗi lần worker khởi động.

Vì patch bytes không persist, warm replay vẫn có đúng một call rẻ tới `/render-artifact`. Nếu server cache hit, response chỉ lấy artifact đã encode; nếu miss thì server rebuild từ analysis artifact hoặc yêu cầu lại blob theo giao thức `409`. “Cache hit” trong PageRow không có nghĩa là zero server call cho patch.

`purgeIncompatible()`:

- so sánh page-version subset theo `row.src_lang`;
- đổi recognizer `es` không purge page `ja`;
- patch-version bump chỉ bỏ `render` subrecord, giữ PageRow/translation;
- `LAYOUT_FIT_VERSION` bump chỉ bỏ/recompute `layout_profile`, giữ patch và `fit_bbox`;
- page schema hoặc page-affecting version mismatch mới purge PageRow;
- xử lý cả `mt:page:*` và `mt:ocr-recovery:*` theo schema tương ứng.

## 10. PageRow `page-v2`

### 10.1 Stored block allowlist

Mọi field phải được liệt kê rõ vì `storedBlock()` là trust boundary:

```text
TranslationBlock {
  block_id: string,
  bbox: [x, y, width, height],
  src_text: string,
  trans_text: string | null,
  kind: null | "text" | "sfx",
  vertical: boolean,
  reading_order: null | nonnegative integer,
  state: "ocr_complete" | "translated" | "failed"
}
```

`vertical` phải được nối đủ bốn hop trước khi schema required: detector, `PreparedRegion`, OCR payload/cache replay và nhánh background dựng block sibling. `reading_order` nullable trước `orderPage`, rồi được ghi lại sau ordering.

`extension/page-cache.js::storedBlock()` (hiện dòng 91-109, allowlist chính ở dòng 94) là site bắt buộc phải mở rộng. Không chỉ thêm tên vào `copyStrings`: `kind` cần validator riêng cho `null | "text" | "sfx"`, `vertical` cần boolean required, và `reading_order` cần `null | nonnegative integer`. Nếu thiếu, storage vẫn ghi thành công nhưng ba field biến mất sau rehydrate, làm partial replay quên SFX/orientation/order.

### 10.2 Page và render subrecord

```text
PageRow {
  schema_version: "page-v2",
  versions: page version metadata,
  patch_versions: patch version metadata,
  page_artifact_key: string,
  analysis_key: string,
  ocr_key: string,
  render_artifact_key: string,
  source_content_hash: string,
  src_lang: string,
  dst_lang: string,
  reading_direction: "rtl" | "ltr",
  state: "queued" | "running" | "partial" | "complete" | "failed",
  ocr_done: boolean,
  blocks: TranslationBlock[],
  manifest_ids?: string[],
  manifest_mismatch_count: 0 | 1,
  render?: RenderSubrecord
}

RenderSubrecord {
  schema_version: "render-page-v1",
  render_artifact_key: string,
  patch_versions: object,
  layout_fit_version: string,
  breaker_open: boolean,
  blocks: RenderBlock[]
}

RenderBlock {
  block_id: string,
  render_mode: "in_place" | "skip",
  patch_id: string | null,
  patch_bbox: bbox | null,
  fit_bbox: bbox | null,
  layout_profile: {font_px: number, line_height: number} | null,
  reason: null | "clean_failed" | "layout_failed" | "fit_failed" | "unsupported_region"
}
```

Invariant validator thuần:

- `in_place` iff `patch_id`, `patch_bbox`, `fit_bbox`, `layout_profile` khác null và `reason=null`;
- `skip` iff `patch_id`, `patch_bbox`, `layout_profile` null và `reason` là capability reason hợp lệ; `fit_bbox` có thể giữ lại như geometry diagnostic;
- SFX không có RenderBlock; không dùng `reason="sfx"`;
- `manifest_ids` chỉ tồn tại sau full translation response hợp lệ;
- property absent khác `[]`; serializer không được dùng `(record.manifest_ids || [])`;
- `manifest_ids=[]` là trang đã dịch xong nhưng toàn SFX;
- `state="complete"` không phải nguồn thẩm quyền của manifest, vì OCR block error có thể giữ page `partial`;
- `breaker_open === false` định nghĩa RenderSubrecord ready và bắt buộc có đúng một RenderBlock cho mỗi `manifest_id`;
- `breaker_open === true` là sentinel: bắt buộc `blocks=[]` và không áp set-equality với `manifest_ids`.

Không được thay nguyên fast-path hiện tại bằng một predicate mới, vì nhánh đó đang gộp cả replay lẫn terminal. Spec C tách hai quyết định:

1. **Replay gate trong `replayPage()`**: phát block khi property `manifest_ids` hiện diện; chỉ phát block có `block_id` thuộc manifest và `trans_text` hợp lệ. Gate này không phụ thuộc `state` hoặc cờ `cacheHit` và không được coerce manifest absent thành empty array.
2. **Terminal cache-hit trong `attachDescriptor()`**: chỉ gọi `accepted(..., cacheHit=true)`, `removeJob()` rồi `return` khi manifest hiện diện, `page.state === "complete"` và `page.ocr_done === true`. Đây là page hoàn tất thật sự, không còn OCR recovery treo.
3. PageRow `partial` có manifest phải rơi tiếp xuống đường tạo/gắn producer, persist job ledger và gọi `accepted(..., cacheHit=false)`. `replayPage()` vẫn phát overlay nhờ replay gate, nhưng không `completeJob()` sớm.

Page-v2 round-trip `putPage -> getPage` phải deep-equal với fixed clock, gồm cả trường hợp manifest absent và empty.

## 11. Manifest, render mismatch và paid recovery breaker

Có hai invariant khác nhau:

```text
fresh server artifact:
  set(manifest_ids) subset-of set(artifact.blocks.block_id)

persisted ready render (breaker_open === false):
  set(manifest_ids) == set(render.blocks.block_id)
```

Thứ tự array không tham gia so sánh set; khi persist, render blocks được canonicalize theo `manifest_ids`.

Luật xử lý:

1. `manifest_ids` absent là cold/incomplete translation, không phải mismatch.
2. Render subrecord thiếu hoặc stale thì bỏ subrecord và rebuild render-only; không tiêu breaker.
3. Fresh artifact match thì lọc SFX, fit text và persist ready render.
4. Fresh artifact thiếu manifest ID, `manifest_mismatch_count=0`: persist count thành `1` **trước** mọi OCR/Gemini network recovery, rồi cho đúng một paid full producer recovery.
5. Recovery thành công vẫn commit PageRow mới với `manifest_mismatch_count=1`.
6. Fresh artifact vẫn mismatch khi count đã `1`: không OCR/Gemini lại, persist sentinel `render={blocks:[], breaker_open:true,...}` và giữ ảnh gốc.
7. Lần ghé sau thấy sentinel cùng render key/version thì không rebuild lặp lại.
8. Patch-version mới được phép render-only rebuild với artifact mới, nhưng không reset paid breaker. Page artifact identity mới mới có count `0`.

Breaker mở không xóa translation cache. Nó chỉ cấm paint và paid recovery lặp vô hạn.

## 12. Partial replay và OCR recovery có trần

Nếu `manifest_ids` hiện diện, PageRow `partial` được replay patch+text hợp lệ ngay. Sau replay, nếu OCR chưa hoàn chỉnh, background được retry tối đa một lần xuyên các lượt ghé cho mỗi `ocr_key`.

Replay của PageRow `partial` không phát `image_done`, không gọi `completeJob()` và không `removeJob()`. Job chỉ terminal sau khi producer đi qua recovery có trần hoặc một error path đã giữ đúng delivered count.

“Replay ngay” nghĩa là ưu tiên lấy RenderArtifact bằng key-call rẻ rồi phát các block đã có translation/layout trước khi bắt đầu OCR recovery; không có nghĩa patch bitmap nằm trong browser storage. Nếu artifact chưa sẵn sàng, ảnh gốc được giữ cho tới khi patch và text cùng đủ.

Ledger:

```text
key: mt:ocr-recovery:<ocr_key>
value: {
  schema_version: "ocr-recovery-v1",
  ocr_key: string,
  used: true,
  claimed_at: integer
}
```

- Absence là chưa dùng; presence là đã dùng. Không cần counter nhiều mức.
- Claim được serialize bởi singleflight stage theo `ocr_key` và persist **trước** `/ocr-stream`.
- Crash sau claim vẫn tiêu budget.
- Claim `CacheFullError`: không gọi recovery trong lượt đó, phát `cache_full`, giữ overlay đã replay.
- `_evictFor()` nhận `protected_page_key`; khi ghi ledger không được evict PageRow đang replay.
- Ledger có tính vào `getBytesInUse(null)` nhưng không là page eviction candidate.
- `purgeIncompatible()` xóa ledger sai schema.
- GC ledger khi không còn PageRow nào tham chiếu `ocr_key`.
- `ocr_key` mới tự cấp budget mới; đổi prompt, model dịch hoặc `dst_lang` không cấp lại OCR budget.

Nếu server còn `_ocr_cache`, retry replay block thành công và chỉ OCR region chưa complete. Nếu cache bị evict/restart, breaker vẫn giới hạn đúng một lượt chạy đắt.

## 13. Progressive delivery và terminal semantics

### 13.1 Đếm block thực sự được giao

Mỗi request có:

```text
deliveredByJob: Map<job_id, Set<block_id>>
```

Map được seed Set rỗng cho **mọi** job trong `createRequest`. Seed không phải delivery. ID chỉ được thêm sau `port.postMessage` thành công tại đúng hai site:

1. vòng lặp per-consumer của `emit(..., "translation", ...)`;
2. lệnh post trực tiếp trong `replayPage()`.

Event `translation` chứa đủ text, patch data, fit bbox và layout profile đã cache; nếu profile chưa có, event đánh dấu layout candidate để content đo trước khi mount. Không có event cho SFX hoặc RenderBlock server-side `skip`. Delivered accounting ghi nhận message đã gửi thành công, không tuyên bố DOM đã paint; kết quả paint đi qua `render_metric` và không phải ACK terminal.

Nhánh cache hit dùng:

```text
translated = deliveredByJob.get(job_id).size
recognized = page.blocks.length
```

Hai số cố ý khác nhau: `recognized` gồm SFX/OCR block; `translated` là số block đã thực sự gửi tới consumer.

### 13.2 `finishProducer` và `failProducer`

Không broadcast một `image_done` dùng chung. Với từng consumer:

1. `req = requests.get(consumer.requestId)`; nếu không có thì `continue`.
2. Nếu `req.done.has(jobId)` thì `continue` để không phát terminal lần hai.
3. Đọc Set đã seed bằng `.get(jobId).size`; không dùng fallback che invariant.
4. Nếu `req.connected && consumer.port`, gửi `image_done` với `translated` riêng **trước** `completeJob`.
5. Dù offline, vẫn gọi `completeJob` để dọn ledger và producer state.

Thứ tự `image_done` trước `completeJob` là bắt buộc: job cuối có thể phát `scope_done`, làm content xóa binding và khiến terminal event đến sau bị bỏ.

`content.js` chỉ remove overlay khi `image_done.translated === 0`. Vì fail/recovery path báo đúng delivered count, overlay partial đã replay không biến mất khi claim hoặc network recovery lỗi.

### 13.3 Rehydrate nhiều job cùng request

`offlineLedger` phải tái sử dụng object từ `requests.get(request_id)`:

- chỉ `createRequest + requests.set` khi request ID chưa tồn tại;
- nếu đã tồn tại, merge `expectedJobIds`, seed `deliveredByJob`, thêm `jobsBySourceCrop` để giữ cùng shape và trả đúng object cũ;
- mọi row cùng request ID trỏ cùng request object;
- startup restore hết vòng ledger trước `resumeOfflineJobs()`, nên invariant đủ key được thiết lập trước job đầu chạy.

`jobsBySourceCrop` trên request rehydrate được giữ vì đối xứng object shape. Replacement logic đọc map của **replacement request**, không được viết test giả rằng release phụ thuộc map của request cũ.

Known limitation chấp nhận: consumer attach đúng khe giữa `applyTranslation` cuối và persist/finish có thể không nhận event, nhận `translated=0`; lượt cache hit kế tiếp tự khôi phục. Không mở rộng protocol ACK trong Spec C.

## 14. Telemetry và latency

Mỗi `page_metrics` có tối thiểu:

```text
overlay_semantics: "atomic_patch_v1"
first_overlay_ms: number | null
cache_hit: boolean
partial_replay: boolean
analysis_cache_hit: boolean | null
render_wait_after_translation_ms: number | null
render_coverage: number | null
render_reason_counts: object
manifest_mismatch: boolean
source_unavailable: boolean
painted: boolean | null
error_code: string | null
```

`first_overlay_ms` đo từ `pendingScopes.startedAt` tới DOM commit patch+text đầu tiên. Tên được giữ để không mở rộng public surface, nhưng `overlay_semantics` bắt buộc để không trộn với baseline text-only cũ.

Background gắn `partial_replay` tại lúc nhận `render_metric`; không đẩy cờ xuống content chỉ để gửi ngược lên. Late metric chỉ được cập nhật timestamp, không ghi đè cohort labels.

Cold latency gate chỉ flatten từ `page_metrics[]` và lọc nghiêm ngặt:

```text
overlay_semantics == "atomic_patch_v1"
cache_hit === false
partial_replay === false
analysis_cache_hit === false
```

`null` không được xem là false. Cohort rỗng trả percentile `null`, không tạo số 0 giả. `metrics.first_overlay_ms`, top-level `first_overlay_ms` và `benchmarkSummary()` cấp scope là mixed-cohort diagnostics, không dùng cho cold gate.

Baseline cũ `first_overlay_ms` đo lúc bubble text xuất hiện nên không so trực tiếp với `atomic_patch_v1`. Warm cache gate của semantic mới là `first_overlay_ms p95 <= 100 ms`. Trên cold cohort, `render_wait_after_translation_ms = max(0, render_ready_at - final_translation_at)` cũng phải có p95 `<= 100 ms`; nếu vượt, executor `max_workers=1` là bottleneck cần đo lại trước khi tăng worker. Cold p50/p95 tổng phải được báo riêng cho cohort trên và không được diễn giải bằng baseline cũ.

## 15. Error policy

| Lỗi | Hành vi UI | Cache/retry |
|---|---|---|
| `source_unavailable` | giữ ảnh gốc | không purge; retry visit sau |
| `clean_failed` | giữ nguyên block | persist skip reason theo artifact/version |
| `layout_failed` | giữ nguyên block | persist skip reason |
| `fit_failed` | giữ nguyên block | persist client layout failure; retry khi `LAYOUT_FIT_VERSION` đổi |
| `unsupported_region` | vẫn giữ translation cache, không paint | không coi là SFX |
| response translation sai schema | không persist manifest mới | `invalid_response`, retry policy hiện hữu |
| render manifest mismatch lần đầu | giữ overlay hợp lệ cũ nếu có | claim breaker rồi một paid recovery |
| mismatch sau breaker | giữ ảnh gốc cho block/page liên quan | persist sentinel, không loop |
| OCR recovery claim cache full | giữ partial replay | không gọi network, báo `cache_full` |
| recovery network/409 thất bại | giữ partial replay đã giao | delivered count ngăn remove overlay |

Không có lỗi nào được biến thành bbox trắng che ảnh gốc.

## 16. Acceptance gates

### Gate A — detector, coordinate và resolver

- Unit test detector adapter giữ raw/refined mask và `vertical`.
- Crop có offset khác 0: bbox, raw/refined mask, clean region và fit bbox đều khớp page-space.
- Dedupe chạy trước resolver; hai detector box gần trùng không làm `src_text` lặp.
- Hai fragment cùng bubble gom một block; hai bubble kề nhau không bị nối.
- Sort ngang/dọc và separator `"\n"` đúng; union bbox duy nhất, reading-order helper không throw duplicate bbox.
- Unbounded đi qua translation candidate và chỉ có thể skip với `unsupported_region` ở render.

### Gate B — patch và atomic UI

- Pixel ngoài erase mask có alpha 0; không có rectangle nền trắng hoặc overscan.
- Refined mask xóa hết raw ink trên fixture; feather không để halo chữ cũ hoặc seam thấy được ở scale không nguyên.
- Patch và chữ cùng mount một lần; không quan sát được patch-only/text-only state.
- Mọi `in_place` block thỏa scrollWidth/scrollHeight tại font `>=10px`.
- Text không fit ở `10px` tạo `fit_failed` và không mount gì.
- CSS không có nền trắng/`overflow:hidden` trên translated text wrapper.
- SFX không có translation event, patch hoặc RenderBlock.
- Fixture canonical đóng băng exact `manifest_ids` dự kiến render và exact capability failure theo block; acceptance phải khớp 100% golden set. `render_coverage` vẫn được báo với mẫu số là toàn bộ `manifest_ids`, không loại capability failure; SFX không nằm trong mẫu số.
- Content feedback không điều khiển producer terminal; disconnect trước feedback để `render` absent, job vẫn kết thúc và lượt sau đo lại.

### Gate C — translation và schema

- Strict response chấp nhận `text/string` và `sfx/null`, reject mọi tổ hợp sai trước coercion.
- SFX round-trip qua `_normalize_items()` và `/translate-items` giữ `translation=null`; không bao giờ sinh chuỗi `"None"`.
- Exact ID validation vẫn nguyên tử.
- `manifest_ids` absent round-trip vẫn absent; `[]` round-trip vẫn empty.
- Trang toàn SFX cache hit: không `translation`, `image_done.translated=0` được gửi trước `scope_done`/cleanup.
- Page-v2 full put/get deep-equal với fixed clock; allowlist giữ `kind`, `vertical`, `reading_order`, manifest và render fields.
- `vertical` có mặt trên OCR fresh path, OCR cache replay và background sibling-copy path.

### Gate D — keys, versions và bounded cache

- Hai URL khác nhau trả cùng bytes tạo cùng source hash/analysis key; cùng URL đổi bytes tạo key mới.
- Fetch cùng URL nhiều crop chỉ tải một lần; refcount không abort khi còn consumer.
- Tối đa hai source fetch đồng thời; attach theo job order; job đầu không chờ toàn scope tải xong.
- `region_resolver` bump đổi analysis key.
- `dst_lang`, translator model hoặc prompt bump không đổi render artifact key.
- Patch bump bỏ render subrecord nhưng giữ translation PageRow; `LAYOUT_FIT_VERSION` bump chỉ bỏ layout profile.
- Recognizer ES bump không purge row JA.
- Artifact 129 MiB: `put()` trả `None`, cache cũ nguyên vẹn. Oversize update cùng key không xóa entry cũ. `_ocr_cache` không ném TypeError khi `max_bytes=None`.
- Extension storage không chứa patch bytes.
- Warm PageRow replay có một `/render-artifact` key-call và không gọi Gemini; không viết gate “zero server call”.

### Gate E — manifest và recovery

- Missing render subrecord rebuild render-only và không tiêu breaker.
- First fresh mismatch persist count `1` trước network; crash không re-arm.
- Recovery thành công giữ count `1`.
- Repeated mismatch persist `breaker_open` sentinel; visit sau không analysis/clean/Gemini lại.
- New patch version có thể render-only rebuild nhưng không cấp paid recovery mới.
- OCR recovery ledger dùng chung cho nhiều `dst_lang`/prompt cùng `ocr_key`.
- Claim cache full không POST OCR, không evict protected page và giữ partial overlay.
- Ledger sai schema được purge; orphan không còn PageRow reference được GC.

### Gate F — delivery, partial replay và rehydrate

- Cold, cache hit, finish và fail đều báo `translated` bằng delivered set của đúng job.
- Lỗi trước mọi translation báo 0; lỗi sau partial replay báo số block đã giao và không remove overlay.
- Set được seed cho job 0-delivery nên không dereference `undefined`.
- Request mất hoặc job đã done không phát terminal lần hai.
- Hai job cache/producer dùng cùng request ID có delivered set riêng.
- Partial PageRow có manifest replay trước recovery; recovery thất bại vẫn giữ overlay.
- PageRow `partial` + manifest + `ocr_done=false` replay translation nhưng chưa phát `image_done`, chưa xóa job ledger và vẫn tạo producer/claim OCR recovery.

Gate rehydrate/replacement bắt buộc dùng fixture:

1. Persist ít nhất hai job visible `queued` cùng `request_id`.
2. Persist hai PageRow `state="partial"`, `ocr_done=false`, property `manifest_ids` **absent** (không phải `[]`), `schema_version="page-v2"`, versions khớp `/health`, source URL hoặc canonical crop khác nhau để có hai `page_artifact_key`.
3. Mock `/health` thành công; await `ready` có sẵn, không sleep/poll; assert `offlineJobs.length === 0`.
4. Assert cùng request object, `expectedJobIds` và `deliveredByJob` đủ hai key, `request.jobs.size === 2`, `new Set(request.jobs.values()).size === 2` và `app.debug().producers === 2`.
5. Giữ hai producer sống tại OCR bằng latch có kiểm soát theo khuôn `holdOcrAfterFirst()` + `waitUntil()` trong `background-progressive.test.js`; `ocr_done=false` bảo đảm `runProducer()` thật sự đi qua `consumeOcr()` và engage latch.
6. Gửi scope mới với `replaces_request_id` cũ và không trùng `sourceCropKey`.
7. Sau release: cả hai producer có `consumers.size === 0`, `retired === false`, vẫn nằm trong `producers` map; old request đã bị xóa; hai old job ledger vẫn còn để background hoàn tất.
8. Khi hai producer hoàn tất: mỗi job terminal đúng một lần, hai ledger được xóa và không có scope completion sớm.

Không spy `demoteQueuedTasks`, không assert tier và không thêm producer thứ ba vào gate này; các tín hiệu đó không chứng minh lỗi rehydrate đã được đóng.

### Gate G — telemetry và performance

- Mọi page row metric mới có `overlay_semantics="atomic_patch_v1"` và cohort flags.
- Exporter cold gate chỉ đọc `page_metrics[]` với bốn điều kiện strict; scope minima bị loại.
- Empty cohort trả null.
- Warm atomic overlay p95 không quá `100 ms` trên fixture cacheable.
- Cold `render_wait_after_translation_ms` p95 không quá `100 ms`.
- Asset performance dùng header route-specific `public, max-age=31536000, immutable`; fault asset giữ `no-store`.
- Báo cáo cold p50/p95 mới tách cache hit, partial replay và analysis cache hit; không so trực tiếp với baseline text-only cũ.

## 17. Rollout và điều kiện hoàn tất

Thứ tự tích hợp phải giữ các contract luôn hợp lệ:

1. Nối detector mask/vertical, page-space artifact và resolver cùng version/key mới.
2. Thêm render artifact/cache/API và kiểm patch độc lập trước khi đổi UI.
3. Bump translation response/prompt và page-v2 schema cùng strict validators.
4. Đổi content sang atomic wrapper, fit measurement và persisted layout profile.
5. Thêm manifest/recovery breakers, delivery accounting và offline rehydrate merge.
6. Chuyển telemetry gate sang `atomic_patch_v1`, chạy toàn bộ acceptance matrix rồi mới rollout.

Spec C chỉ được coi là hoàn tất khi:

- Gate A-G đều PASS bằng test đã chạy, không phải chỉ static inspection;
- không chạy `server/tests/test_ocr.py` ngoài gate được phê duyệt vì nó tải model/fixture thật;
- production và acceptance server trả cùng version contract;
- không còn code path render `.mt-bubble` nền trắng;
- không có SFX translation/paint trong fixture;
- không có retry OCR/Gemini hoặc render rebuild không giới hạn xuyên lượt ghé;
- tài liệu implementation/worklog ghi rõ interpreter và fixture dùng để verify.

Sau khi người dùng duyệt tài liệu này mới viết implementation plan theo từng gate. Không tự động tạo branch mới, commit hoặc triển khai từ bản thiết kế.
