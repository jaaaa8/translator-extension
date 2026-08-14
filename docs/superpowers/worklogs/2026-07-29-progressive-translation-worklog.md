---
title: "Progressive translation"
note_type: worklog
work_item: progressive-translation
date_start: 2026-07-29
date_end: 2026-07-30
status: done
versions:
  - "[[feat-v2]]"
specs:
  - "[[2026-07-30-progressive-translation-workflow-design]]"
plans:
  - "[[2026-07-30-progressive-translation-session-cache]]"
artifacts:
  - "[[2026-07-30-progressive-translation-verification]]"
tags:
  - mangatranslator/worklog
---

# Progressive translation

> [!summary] Tóm tắt
> **Vấn đề:** Latency, box trùng và cache phiên làm người dùng chờ toàn trang; đổi model không xử lý nút thắt chính.
>
> **Quyết định/fix:** Gom điều tra latency, dedupe, roadmap và DeepL vào thiết kế streaming cùng session cache.
>
> **Kết quả:** Progressive delivery/session cache đóng như một narrative thống nhất với evidence riêng.

## Liên kết

- Phiên bản: [[feat-v2]]
- Spec: [[2026-07-30-progressive-translation-workflow-design]]
- Plan: [[2026-07-30-progressive-translation-session-cache]]
- Artifact: [[2026-07-30-progressive-translation-verification]]

---
## Đo latency thật + phương án tối ưu (2026-07-29)

> [!info] Vì sao đo trước khi sửa
> User chốt: **độ chính xác giữ nguyên**, chỉ tối ưu latency, và đau ở cả hai kiểu đọc như nhau. Roadmap `ocr-manga-extension-roadmap.md` đoán nút thắt nằm ở cache/concurrency — **đo xong thì sai**.

### Số warm, một trang thật

| | ja (Aisazu, 24 bóng) | es (mangadex, 13 bóng) |
| --- | --- | --- |
| decode | 0.02s | 0.01s |
| detect | 0.67s | 0.18s |
| **OCR loop** | **7.18s (91%)** | **13.15s (99%)** |
| Gemini | ~4.1s | ~1.7s |
| **end-to-end `/translate`** | **11.8s** | **14.7s** |

Per-crop: manga-ocr (GPU) median **0.179s**, max 1.94s — PaddleOCR (**CPU**) median **1.068s**, overhead cố định 0.237s/call. Cold start lần đầu sau khi bật server: +6–8s mỗi model.

**Kết luận: OCR loop là tất cả.** detect/decode không có gì để lấy; `MAX_CONCURRENT=2` phía client là trang trí vì `_ocr_lock` serialize toàn bộ.

### Phương án A — đưa PaddleOCR lên GPU (TẠM GÁC)

Bốn cách *không cần cài gì* đều đã đo và **loại**:

| Thử | Kết quả |
| --- | --- |
| `enable_mkldnn=True` | Vỡ đúng lỗi PIR mà comment `server/ocr.py:26` mô tả — comment vẫn đúng, không phải nợ cũ |
| Batch cả list vào 1 call | 13.32s vs 12.94s — `predict()` chỉ loop nội bộ, không được gì |
| rec-only (bỏ detect nội bộ) | Nhanh 53× (0.020s/crop) nhưng ra `['T','TA','E','AP']` — crop là **cả bóng nhiều dòng**, `TextRecognition` chỉ đọc một dòng |
| 1 call cả trang rồi gom dòng về bóng | **Chậm hơn** (16.84s vs 12.62s) và đổi text |

Wheel hiện tại `paddle 3.3.1`, **`is_compiled_with_cuda() == False`** → `device="gpu"` chỉ in *"not available, switching to CPU"*. Nên A **bắt buộc cài `paddlepaddle-gpu`**, không có đường vòng.

> [!danger] Rủi ro DLL đã được chứng minh
> Import `paddle` trước `torch` làm hỏng `torch/lib/shm.dll` (`WinError 127`) — gặp thật khi viết probe. Sở dĩ server chạy được là vì `paddleocr` được import **lười** bên trong `PaddleLatinEngine.__init__`, nên torch luôn lên trước.
> Nhét CUDA runtime của paddle cạnh cu121 của torch trên Windows có thể làm **hỏng path `ja` đang chạy tốt**.
> **Cách an toàn khi làm A:** dựng **venv riêng** để thử, chứng minh paddle GPU chạy + đo tốc độ, rồi mới quyết có đổi venv chính không. Không cài đè lên venv đang chạy.

### Phương án B — vẽ chữ dần (ĐANG LÀM)

Hiện tại OCR hết cả trang (7–13s) → 1 call Gemini → **rồi mới vẽ**. User nhìn màn hình trống suốt 12–15s. B không giảm tổng thời gian, nhưng cắt mạnh **thời gian tới chữ đầu tiên**. Chọn B vì nó độc lập với chuyện paddle có lên GPU được hay không.

### Phương án C — bỏ `_ocr_lock` chạy song song (KHÔNG LÀM)

Chỉ đáng khi CPU-bound. Sau A thì hệ thành GPU-bound mà chỉ có một GPU ⇒ gần như vô nghĩa.

### Phát hiện phụ — detector trả box trùng

```
es: [0](379,141,500,230) vs [1](379,141,501,230)  IoU=0.99  ← lệch 1 pixel
    [7](501,422,574,488) vs [8](500,423,575,490)  IoU=0.93
```

2/13 bóng bị OCR **hai lần**: ~2.0s trong 13.15s là công toi, chữ trùng gửi lên Gemini, overlay vẽ đè cùng một câu hai lần.

Trang `ja` khác kiểu: 7 cặp **lồng nhau** (contain≈1.0 nhưng IoU thấp — box nhỏ nằm trong box lớn, chữ dọc). Với ngưỡng IoU 0.5 thì `ja` không mất box nào. **Không đụng phần lồng nhau** vì nó có thể là hiệu ứng âm thanh riêng, và user đã chốt giữ nguyên độ chính xác.

---

## Dedupe box trùng — xong ✅ (2026-07-29)

Commit `9eeb19f` trên `feat/v2`. `server/pipeline.py`: `_iou()` + `_dedupe_regions()` bỏ box có IoU > `_DEDUPE_IOU = 0.5`, **giữ box to hơn** (box to không cắt cụt chữ), gọi ngay trong vòng lặp của `ocr_image()`.

| Trang | Box | OCR trước | OCR sau | Chữ mất |
|---|---|---|---|---|
| `es` mangadex | 13 → 11 | 12.62s | **9.77s (−23%)** | không |
| `ja` Aisazu | 24 → 24 | 7.12s | 6.88s | không |

> [!warning] Độ chính xác trên hai box trùng là **hoà, không phải thắng**
> Heuristic "giữ box to hơn" cho kết quả lẫn lộn trên đúng hai bóng bị trùng của `es`:
> - bóng 1 **kém đi**: `MEL` (đúng phải là `MEU`)
> - bóng 7 **tốt lên**: `EU NÃO VOU` thay vì `ELI NÃO VOUI`
>
> Cái thắng chắc chắn là **mỗi bóng giờ chỉ còn một overlay** thay vì hai cái chồng nhau, cộng 23% thời gian.

4 test mới trong `server/tests/test_pipeline.py` dùng **toạ độ đo thật**, trong đó có test giữ nguyên box lồng nhau của `ja`. Toàn bộ: 47 pytest pass, 4 suite node OK, `git diff --check` sạch.

Commit thứ hai `fde9ca5` — ghi lại số đo latency vào docs.

---

## Kiểm chứng lại `ocr-manga-extension-roadmap.md` (2026-07-29)

Đã đối chiếu từng nhận định của roadmap với code + số đo thật, và ghi thẳng kết quả vào file đó (mục `## 0` mới, cộng annotation tại chỗ ở §2, §3.1, §3.2, §3.4, §8 và Kết luận).

**Đúng, giữ nguyên:** toàn bộ mô tả kiến trúc ở mục 1; `MAX_CONCURRENT=2`, single-flight, timeout 60s/300s; một call Gemini + retry + failover 429; `fitText` 18→10px; cả 4 cơ chế chống race ở §1.7. Và quan trọng nhất: **"chờ OCR xong toàn scope rồi mới dịch" đúng là điểm nghẽn số 1** — đó chính là B2.

**Sai hoặc đặt sai ưu tiên:**

| Roadmap nói | Thực tế đo được |
|---|---|
| P0: thu hẹp `_ocr_lock` theo stage (§3.1) | Phần chạy ngoài lock là 0.01–0.02s / vòng OCR 7–13s ⇒ lấy về ~0.02s. **Bỏ** |
| P0: batch recognition (§3.2) | Paddle list-`predict()` 13.32s vs 12.94s; rec-only trả rác; manga-ocr không có API batch. **Bỏ** |
| P1: "detector trả nhiều vùng" = cơ hội batch | Vấn đề thật là **box trùng** (IoU 0.99/0.93) — roadmap bỏ sót hoàn toàn. Sửa xong được 23% |
| §1.4 có nói `es` dùng PaddleOCR CPU… | …nhưng **không đưa vào bảng điểm nghẽn §2**, nên biến mất khỏi mọi quyết định ưu tiên. Đây mới là hàng đầu bảng: 6× chậm hơn/crop |
| §7: trace 14 stage kiểu OpenTelemetry | Over-engineering khi một số hạng chiếm 91–99%. Một `perf_counter()` là đủ |
| §3.10 tiling | Hạng mục *accuracy* — user đã chốt độ chính xác hiện ổn, không liên quan |

**Bug được roadmap đoán đúng, chưa sửa:** §3.4 thiếu `dstLang` trong cache key. `extension/srcset.js` `jobKey()` = `source|srcLang|crop`, còn `selectCandidates()` bỏ qua ảnh khi `translated.get(img) === key` ⇒ đổi đích vi→en rồi bấm lại thì **ảnh đã dịch bị bỏ qua sai**. Sửa nhỏ, để dành.

**Câu hỏi mở đã trả lời:** #2 (phân bổ thời gian), #5 (không có API batch dùng được), #6 (cả hai scope đều đau ⇒ B2 phải phục vụ cả hai), #10 (24 block vẫn ổn cho một call Gemini). #1 thành vô nghĩa.

---

## DeepL thay Gemini? — phân tích (2026-07-29)

### Cái DeepL sửa được

| Vấn đề API hiện tại | DeepL |
|---|---|
| Rate limit 429 (đang phải nuôi 2 project key để xoay vòng) | Free ~500k ký tự/tháng ≈ **690 trang** ở mức ~720 ký tự/trang. Hết hạn mức thì trả tiền theo ký tự, không phải theo request |
| Gemini 2–4s/call | **~200ms** |
| JSON trả về lệch số phần tử → cả bộ máy retry 2 lần trong `translator.py` | DeepL trả **đúng N chuỗi cho N chuỗi vào**. Bỏ được toàn bộ retry + validate |
| Một call hỏng làm hỏng cả trang | Mỗi chunk độc lập |

Đã xác minh: DeepL hỗ trợ **`VI` làm ngôn ngữ đích** (`translation:true`, có glossary), `JA`/`ES` đều là source hợp lệ. Không bị chặn kỹ thuật.

### Cái DeepL làm hỏng

> [!danger] DeepL dịch trung thành **cả lỗi OCR**
> Text thật lấy từ log phiên này:
> - OCR ra `MELI PÉ FEDIA` — đúng phải là `MEU PÉ`
> - OCR ra `ELI NÃO VOUI CONTAR PRA NINGLIÉM` — đúng phải là `EU NÃO VOU CONTAR PRA NINGUÉM`
>
> LLM **âm thầm sửa** những chữ này vì nó hiểu câu. DeepL sẽ dịch nguyên rác. Với PaddleOCR CPU đang có tỉ lệ lỗi như trên, đây không phải rủi ro lý thuyết — nó xảy ra ở phần lớn bóng thoại.

Ngoài ra mất ngữ cảnh xuyên bóng: đại từ (`you` → *anh/em/mày/ngài*), mức lịch sự, SFX. Đây đúng là lý do §1.5 chọn gộp cả scope vào **một** call.

### Hybrid H1 — "dịch nháp rồi tinh chỉnh" ⭐ khuyến nghị

```text
block OCR xong → DeepL dịch ngay (~200ms) → VẼ LUÔN (bản nháp)
   ...
hết trang → 1 call Gemini cho TOÀN BỘ block → thay chữ tại chỗ (bản chuẩn)
```

- Chữ đầu tiên hiện sau **~2s** thay vì 12–60s.
- Vẫn đúng **1 call Gemini/trang** ⇒ rate limit không đổi so với hôm nay.
- Gemini vẫn thấy toàn trang ⇒ giữ nguyên nhất quán đại từ và khả năng sửa lỗi OCR.
- Rủi ro: chữ **nhảy** khi thay bản nháp bằng bản chuẩn. Giảm bằng cách chỉ thay khi text khác nhau, và cho fade.

### Kết luận

**Không thay Gemini bằng DeepL.** DeepL đóng vai *bản nháp hiện ngay*, Gemini giữ vai *bản chuẩn*. Và dù cuối cùng có làm DeepL hay không, **B2 vẫn phải làm trước** — cả hai đều cần đúng một thứ: cơ chế stream block ra và vẽ dần.

---

## Trạng thái khi đóng phiên (2026-07-29)

- Nhánh: **`feat/v2`**, **7 commit ahead của `origin/feat/v2`, CHƯA push** (user dặn đừng push).
- Đã chốt: **B2 — stream + vẽ dần**. Chưa viết code.
- B2 cần làm: server trả NDJSON theo block (`StreamingResponse`) → background nối bằng `chrome.runtime.connect` port → `content.js` vẽ theo chunk thay vì `Promise.all` toàn scope.
- Việc để dành: `dstLang` vào `jobKey()` trong `srcset.js`; test tay viewport OCR prewarming trên trình duyệt; phương án A (paddle GPU, venv riêng).

> [!danger] Bảo mật — còn nợ
> Hai Gemini API key đã bị dán vào chat trong phiên này. Cả hai **chưa từng** được ghi vào source, test, log, `.env.example` hay note nào. **Cả hai đều nằm trong transcript trên đĩa và phải được xoay/thu hồi.** `.env` chưa từng được đọc hay sửa — chỉ biết *tên biến* và độ dài.


## Progressive translation + session cache — Task 1–8 hoàn tất (2026-07-30)

> [!info] Trạng thái tại mốc cập nhật
> Plan: `docs/superpowers/plans/2026-07-30-progressive-translation-session-cache.md`  
> Worktree: `.worktrees/progressive-session-translation` · nhánh `feat/progressive-session-translation` · HEAD `bbc2395`  
> **Task 1–8 đã triển khai và review sạch. Task 9–10 chưa làm**, nên chưa coi toàn bộ plan là hoàn tất và chưa merge.

### User nhận được gì ở mốc Task 8

- Khi bấm dịch trang hiện tại, từng block có thể xuất hiện dần qua Port thay vì đợi OCR + Gemini của cả scope xong mới vẽ.
- Các trang single-page mà user thực sự bấm dịch (`visible`) được lưu thành page artifact trong cache bền vững, giới hạn **8 MiB**. Quay lại đúng trang/crop/ngôn ngữ/version có thể replay overlay từ cache mà không gọi lại OCR/Gemini.
- Bấm dịch lại hoặc đổi ngôn ngữ tạo request mới. Kết quả trễ của request cũ không được phép ghi đè bản mới; Promise cũ được kết thúc rõ ràng thay vì treo.
- Công đoạn dùng chung được giữ lại đúng tầng: đổi ngôn ngữ đích có thể dùng lại analysis/OCR; đổi recognizer vẫn dùng lại analysis nếu tương thích. Chỉ ownership của request cũ bị bỏ, không mặc định phá hủy mọi công việc nền hữu ích.
- Ảnh chỉ rời viewport **không bị gỡ overlay**; user quay lại vẫn thấy bản dịch. Overlay chỉ bị prune khi node ảnh mất kết nối hoặc source/signature thực sự đổi, tránh chữ trang cũ đè lên trang mới.
- Công việc `visible` đã được nhận có thể tiếp tục ở background và rehydrate sau service-worker restart; `loaded` là RAM-only và bị hủy khi không còn owner. Prewarm chỉ làm OCR tier thấp, không gọi dịch cloud.

### Tiến độ theo task

- [x] **Task 1 — Versioned artifacts:** thêm artifact analysis/OCR, stable block ID và LRU giới hạn item/byte.
- [x] **Task 2 — Split analysis/recognizer:** cache partial OCR theo block, retry đúng block lỗi, giữ API cũ qua compatibility wrapper.
- [x] **Task 3 — `/ocr-stream`:** NDJSON theo thứ tự `analysis_ready → block events → image_done`, hỗ trợ warm analysis và client disconnect.
- [x] **Task 4 — Structured translation:** Gemini nhận/trả block theo stable ID; bắt buộc exact ID set và chuẩn hóa về thứ tự request.
- [x] **Task 5 — Session ledger + 8 MiB page cache:** metadata-only persistence, eviction theo trạng thái/LRU, quota retry một lần, rehydrate job đang chạy về queued.
- [x] **Task 6 — Background transport/scheduler:** cache keys theo version/crop/lang, NDJSON reader, global concurrency 2, tối đa 4 job/request.
- [x] **Task 7 — Background-owned producers:** ownership/replacement/cancellation, shared stages, micro-batch 3 rồi tối đa 8, hot LRU, offline health, restart rehydrate và failure isolation.
- [x] **Task 8 — Content Port subscriber:** atomic `start_scope` kể cả zero-job, stale guards, idempotent block upsert, reconnect đúng request hiện hành và lifecycle overlay.
- [ ] **Task 9 — Popup:** snapshot `srcLang`/`dstLang`, latest-action guard, trạng thái background/cache/error và copy exact-hit.
- [ ] **Task 10 — Acceptance:** cross-layer/browser acceptance, metrics, cập nhật `work-flow.md` và verification worklog trong repo.

### Các quyết định quan trọng

> [!important] Scheduler theo lựa chọn của user
> Tier là **foreground → detached manual → prewarm**. Foreground vẫn ưu tiên ảnh gần viewport; detached manual dùng **strict FIFO**, nên job đến trước không bị job đến sau nhưng gần viewport hơn vượt mặt. Đây là chủ đích để các trang user đã bấm dịch được xử lý theo thứ tự ổn định.

> [!important] Cache không đồng nghĩa giữ mọi byte ảnh
> Cache chỉ lưu metadata, bbox, source text, translation và trạng thái. Image bytes/crop đã chuẩn bị không được phép lọt vào `chrome.storage.local`; nếu không, quota 8 MiB sẽ bị chiếm rất nhanh và còn mở đường cho payload không đúng schema.

> [!important] “Bỏ công việc cũ” được định nghĩa theo ownership
> Request UI cũ bị release và không còn quyền render. Tuy nhiên analysis/OCR stage đang hữu ích có thể tiếp tục nếu request mới hoặc visible persistence vẫn là consumer. Cách này tránh làm lại detect/crop/OCR chỉ vì đổi đích Việt → Anh.

> [!note] Chính sách overlay khi lật/di chuyển trang
> Không dùng `IntersectionObserver` để xóa khi offscreen. Chỉ source/signature change hoặc DOM disconnect mới teardown. Vì vậy quay lại trang cũ không mất overlay, nhưng reuse cùng `<img>` cho trang mới vẫn không mang chữ cũ sang.

### Những phần khó nhất và vì sao

#### 1. Task 5 — cache boundary phải qua 5 vòng fix

Đây là phần fail/review nhiều nhất. Lý do không nằm ở eviction algorithm mà ở **ranh giới dữ liệu lưu bền vững**: object job/page đi qua nhiều tầng và rất dễ vô tình mang theo binary hoặc giá trị có hình dạng “gần đúng”.

| Vòng | Test bắt được | Nguyên nhân | Cách sửa gốc |
| --- | --- | --- | --- |
| 1 | `image_bytes` bị persist; `findPage()` không touch LRU | clone cả object và read-path chưa cập nhật recency | whitelist schema page/block; dùng shared best-effort touch |
| 2 | crop dạng `data:image...` lọt vào | crop chưa có validator canonical | chỉ cho `full` hoặc rect normalized finite |
| 3 | `source_url: data:`/object và binary trong field hợp lệ | whitelist tên field nhưng thiếu type validation | validate từng field; URL chỉ `http:`, `https:`, `blob:` |
| 4 | binary timestamp, `blob:data:...`, `trans_text: null` bị xử sai | validator chưa xét nested scheme và trạng thái OCR partial | finite-number validator; kiểm origin của blob; cho null đúng state |
| 5 | clock giả trả binary làm bẩn row khi cache hit | đường đọc không dùng cùng validator với đường ghi | gom về một touch path; lỗi clock/storage không làm hỏng render |

> [!warning] Bài học
> “Không lưu image bytes” không thể chỉ kiểm một property. Phải coi persistence là trust boundary: whitelist + type-check + canonicalize ở cả write path lẫn read-touch path.

#### 2. Task 6 — priority đúng tên nhưng sai nghĩa qua 3 vòng

- Vòng đầu: `task.run()` ném lỗi đồng bộ trước khi Promise chain được gắn, làm mất scheduler slot.
- Vòng sau: một numeric `priority` bị dùng lẫn cho foreground, detached và prewarm; metadata có thể vô tình hạ foreground hoặc đẩy detached sai tier.
- Vòng cuối: comparator distance-first khiến job detached đến sau nhưng gần viewport hơn vượt job cũ, trái quyết định strict FIFO.

Fix cuối tách rõ **tier** khỏi tie-breaker: foreground/prewarm có thể dùng distance rồi sequence; detached chỉ dùng sequence. Test đối kháng cố ý cho job cũ distance 100 và job mới distance 1 để chứng minh FIFO vẫn giữ.

#### 3. Task 7 — ownership và late join giữa stream

Task này khó nhất về concurrency. Các lỗi chỉ lộ khi dựng đúng interleaving:

- loaded producer đã có OCR hữu ích nhưng không được phép persist partial nếu chưa từng có visible owner;
- hai job cùng source/crop phải dùng chung producer/network nhưng vẫn được tính là **hai consumer/job ID**;
- target mới tham gia giữa block `early` và `late` từng chỉ nhận `late`, vì shared OCR stage chưa giữ snapshot block đã phát;
- stale cloud response có thể làm nóng RAM cache nhưng không được mutate page/render của request đã retired;
- một translation batch hỏng không được reject cả chain và chặn batch sau.

Fix quan trọng là stage OCR giữ snapshot block/error + analysis metadata. Consumer tham gia muộn được seed phần đã có rồi tiếp tục nhận live event, nên không cần OCR lại và không mất block đầu.

#### 4. Task 8 — production đã sửa nhưng test “xanh giả” qua nhiều review

Review đầu bắt được ba lỗi lifecycle thật:

- reconnect callback capture message cũ rồi microtask có thể gửi lại request đã supersede;
- background release request cũ nhưng không emit `scope_done`, làm Promise content cũ treo và leak binding;
- overlay reuse giữ `image_w/image_h` của event đầu, làm scale sai nếu event sau mang dimensions mới.

Sau khi production fix, suite vẫn pass nhưng **chưa chứng minh đúng contract**:

- fake DOM có `appendChild()` no-op nên stale-event test không thể biết DOM có bị ghi hay không;
- “same-config replay” đã prune overlay trước khi replay, vì vậy chỉ chứng minh tạo overlay mới;
- prewarm chỉ có một ảnh, nên không chứng minh chọn ảnh có visible area lớn nhất;
- signature test đổi `srcset` rồi đổi `media` nhưng vẫn so với baseline ban đầu, nên vẫn pass ngay cả khi `media` bị bỏ khỏi signature.

Test harness cuối được viết lại để theo dõi identity container/bubble thật, tách từng stale guard để không guard trước che guard sau, replay khi overlay cũ còn sống, dùng hai ảnh cho prewarm và so signature tuần tự sau từng mutation.

> [!bug] Một RED là lỗi expectation, không phải lỗi production
> Coordinate test ban đầu kỳ vọng `1px`, nhưng fake image hiển thị rộng 600 px với `image_w=500`, nên đúng phải là `1.2px`. Test được sửa theo phép scale; production không đổi. Ghi rõ để tránh hiểu nhầm rằng mọi RED đều là bug sản phẩm.

### Các failure quan trọng khác

- **Task 2:** cancellation đã được check trước lock nhưng request có thể bị cancel trong lúc chờ `_ocr_lock`; cần check lần hai ngay trước `engine.read()`.
- **Task 3:** warm analysis có thể bị LRU eviction giữa bước validate và lúc generator chạy; endpoint phải pin artifact cho toàn stream.
- **Task 4:** provider trả đủ text nhưng reorder/duplicate/foreign ID từng vẫn trả HTTP 200; endpoint nay exact-set validate và normalize theo request order.
- **Môi trường:** một lần full Python suite trong sandbox fail vì model cache/network bị chặn; rerun đúng quyền pass. Các warning `.pytest_cache`, Starlette/httpx, `pkg_resources` và Paddle `ccache` là môi trường/deprecation có sẵn, không phải regression.

### Bằng chứng test và review

| Mốc | Kết quả |
| --- | --- |
| Task 1 full server | **53 passed** |
| Task 2 full server | **56 passed**; sau cancellation fix: pipeline **21 passed** |
| Task 3 full server | **59 passed** |
| Task 4 full server | **66 passed**; translator + endpoint sau exact-ID fix **32 passed** |
| Task 5 extension | **5/5 passed** sau fix round 5 |
| Task 7 extension | **6/6 passed**, final review 0 Critical/Important/Minor |
| Task 8 focused | **3/3 passed** |
| Task 8 full extension | **7/7 passed**, final review 0 Critical/Important/Minor |
| Diff hygiene | `git diff --check` pass ở các mốc hoàn tất |

### Việc tiếp theo

1. Task 9: hoàn thiện popup và snapshot ngôn ngữ ngay tại click; không khóa hai nút đến `scope_done`.
2. Task 10: chạy cross-layer tests và browser acceptance cho single-page cache/replay, đổi ngôn ngữ, reconnect/service-worker restart, source swap và quota/error paths.
3. Chỉ sau acceptance mới cập nhật workflow as-is, đóng worklog verification và cân nhắc merge.

#mangatranslator/progressive-session-cache


---

## Cập nhật Task 9–10 — 2026-07-30

> [!success] Kết quả hiện tại
> Code và kiểm thử tự động Task 9–10 đã sẵn sàng tại commit `326273e`, branch `feat/progressive-session-translation`. Final clean-room review không còn finding Critical/Important. **P0 chưa hoàn tất** vì browser acceptance và benchmark thật chưa chạy.

### User nhận được gì

- Popup không khóa hai nút khi đang dịch; chỉ action mới nhất được cập nhật kết quả.
- Popup hiển thị `Đang dịch nền · Đã cache · Lỗi`; exact hit hiển thị `Khôi phục từ cache`.
- Ngôn ngữ được chụp tại lúc click, nên đổi Việt → Anh dùng đúng config, không bị cache cũ bỏ qua.
- Trang single-page đã dịch replay được từ session cache; callback/request/worker cũ không đè lên trang mới.
- Metrics đo queue/fetch/analysis/OCR/translation/overlay/total/cancel nhưng chỉ expose aggregate, không giữ URL hay text.
- Legacy OCR, progressive Port và prewarm dùng chung scheduler 2 slot.

### Task 9

- [x] `pageStatus` load khi mở popup và refresh sau action mới nhất.
- [x] Copy status/cache-hit đúng spec; pending actions giữ payload ngôn ngữ riêng.
- [x] Extension gate tại Task 9: **7/7 passed**.

> [!note] Minor deferred
> Callback stale return trước khi đọc `chrome.runtime.lastError`, có thể tạo warning nhưng không làm sai UI.

### Task 10 — phần tự động

- [x] Harness chạy production background/content qua paired fake Port + shared fake session storage/NDJSON; không gọi tắt helper.
- [x] Bao phủ stale A/B, exact replay, crop miss, near/far, replacement ở fetch/OCR/translation, worker death/restart, lỗi riêng từng stage, visible/loaded và popup status reopen.
- [x] `work-flow.md` và verification worklog repo phản ánh workflow/kết quả thật.
- [x] Metrics ring 100 sample, late warm `render_metric`, counter shared-producer exact-once.
- [ ] 10 browser cases thật.
- [ ] Ít nhất 20 cold + 20 warm sample.

### Những vòng khó/fail quan trọng

| Vòng | RED/finding | Nguyên nhân gốc | Kết quả |
| --- | --- | --- | --- |
| TDD đầu | Thiếu `scope_done.metrics` | Background chưa phát monotonic metrics | Thêm metrics + bounded summary |
| Fix 1 | Worker cũ vẫn chạy; cancel latency = tuổi request; sai `firstOverlayMs` | Harness chỉ disconnect; mốc đo và mapping sai | Kill capability VM cũ; clock `5000 → 0 ms`; trả `first_overlay_ms` |
| Fix 2 | Warm overlay render nhưng p50/p95 null | Request bị xóa trước khi metric quay lại qua Port | Correlation theo ring; bỏ ID lạ/đã evict |
| Fix 3 | Mixed Port + legacy peak **4** | Hai pool riêng, mỗi pool cap 2 | Một scheduler chung; peak **≤2**, giữ priority/FIFO |
| Fix 4 | Gemini gọi 1 nhưng counter đếm 2 | Cộng counter theo consumer/request | Dedupe theo producer identity qua request |
| Hypothesis fail | Dedupe per-request vẫn cho cross-request `1 → 2` | Request không đại diện call thật | Test đối kháng bác bỏ; union identity trong ring |
| Fix 5 | Telemetry giữ full producer graph | Sample giữ page, URL, OCR/translation text, Promise | Chỉ giữ record 3 số: calls, 429, stale |

> [!important] Vì sao các vòng review này quan trọng
> Test xanh ban đầu chưa đủ: lỗi chỉ lộ khi delivery Port bất đồng bộ, hai request share producer, hoặc legacy và progressive chạy đồng thời. Các fix đi vào ownership/lifecycle chung thay vì vá riêng từng callback.

> [!warning] Browser/benchmark còn pending
> Phiên này chỉ có Codex in-app browser, không có Chrome đã load unpacked worktree hoặc MV3 service-worker target. Fixture localhost mở được nhưng không chứng minh extension thật; vì vậy không đánh dấu pass và không tạo benchmark giả.

### Fresh verification cuối

| Gate | Kết quả |
| --- | --- |
| HEAD | `326273e` |
| Node extension | **8/8 passed** |
| Python server | **69 passed**, 3 warning dependency/tooling có sẵn |
| Diff hygiene | clean |
| Final clean-room review | **0 Critical, 0 Important** |

### Gate còn lại để gọi P0 complete

1. Load `D:\MangaTranslator\.worktrees\progressive-session-translation\extension` dưới dạng unpacked extension trong Chrome.
2. Chạy đủ 10 browser cases ở Task 10 Step 7.
3. Chạy ít nhất 20 cold + 20 warm `visible` trên cùng máy.
4. Đạt first-overlay p50 ≤ 5 s, p95 ≤ 8 s; total regression ≤ 10%; block count không giảm.
5. Ghi hardware, Chrome/Python/model version, timings, hit/miss, stale work, translation calls và 429 vào verification worklog rồi mới đóng P0.

#mangatranslator/progressive-session-cache/task9-task10

> [!warning] Browser retry sau khi user load extension
> Chrome đang chạy và user đã load MangaTranslator, nhưng Codex chỉ phát hiện in-app browser. Kiểm tra connector cho thấy ChatGPT Chrome Extension chưa được cài/enabled trong profile được chọn và native-host manifest/registry chưa tồn tại. Vì vậy Codex chưa thể điều khiển tab Chrome hoặc MV3 service worker; **0/10 browser case vẫn pending**, không có kết quả pass giả. Bước mở khóa: cài/reinstall Chrome plugin từ ChatGPT/Codex plugin UI trong cùng Chrome profile, rồi kết nối lại.

---

