---
title: "In-place clean overlay rendering"
note_type: worklog
work_item: in-place-clean-overlay-rendering
date_start: 2026-08-08
date_end: 2026-08-14
status: incomplete
versions:
  - "[[feat-v4]]"
  - "[[feat-v5]]"
specs:
  - "[[2026-08-08-in-place-clean-overlay-rendering-design]]"
plans:
  - "[[2026-08-09-in-place-clean-overlay-rendering]]"
artifacts: []
tags:
  - mangatranslator/worklog
---

# In-place clean overlay rendering

> [!summary] Tóm tắt
> **Vấn đề:** Overlay cũ không bảo toàn đầy đủ render artifact, recovery và delivery/error accounting.
>
> **Quyết định/fix:** Triển khai page-space artifacts, atomic overlay, bounded OCR recovery, delivery accounting và telemetry.
>
> **Kết quả:** Tasks 1–14 hoàn tất; Task 15 browser/manual acceptance còn mở nên worklog incomplete.

## Liên kết

- Phiên bản: [[feat-v4]], [[feat-v5]]
- Spec: [[2026-08-08-in-place-clean-overlay-rendering-design]]
- Plan: [[2026-08-09-in-place-clean-overlay-rendering]]
- Artifact: Không có.

---
## 2026-08-09 — Spec C: in-place clean overlay rendering (Tasks 1–2)

### Design spec

- Design `docs/superpowers/specs/2026-08-08-in-place-clean-overlay-rendering-design.md` chốt kiến trúc phân tầng analysis/OCR/render, giữ tọa độ public ở page-space và tách clean-patch khỏi OCR.
- Hồ sơ spec + plan được tạo tại `b07d192`; các finding review cuối của plan được đóng tại `5325561`.

### Implementation plan

- Plan `docs/superpowers/plans/2026-08-09-in-place-clean-overlay-rendering.md` được duyệt để triển khai theo checkpoint, TDD và review độc lập từng task.
- Task 3 chịu trách nhiệm migrate `server/pipeline.py` sang contract `DetectionResult`; vì vậy call site cũ ở pipeline được defer có chủ ý trong checkpoint Task 2.

### Task 1 — artifact primitives

- Commit `82c122bee95bf534a7554f04d6f0b211e9f80435` (`feat: add spec c artifact primitives`) thêm `PreparedFragment`, mở rộng `PreparedRegion`, thêm render artifact và chính sách LRU từ chối item vượt byte cap mà không phá entry cũ.
- Verification: `server/tests/test_artifacts.py` = **6 passed**; independent review = **PASS**.

### Task 2 — detector adapter + region resolver

- Detector trả `DetectionResult`; `diagnose_image()` dùng `.regions`; resolver tách namespace component/fragment, dedupe exact union bbox theo thứ tự tất định và giữ mask/source geometry cho bước chuẩn bị artifact.
- Review finding đã đóng đủ bốn mục: diagnose contract, grouping-key collision, duplicate union bbox và real-detector tests dùng `result.regions`.
- Verification được người dùng duyệt: targeted gate **20 passed, 2 deselected**; detector adapter **2 passed, 2 deselected**; `git diff --check` exit 0 (chỉ cảnh báo LF/CRLF). Hai real-model tests không chạy, đúng gate đã duyệt.
- Trạng thái checkpoint: Task 2 **PASS**, thay đổi vẫn chưa commit; bước kế tiếp là Task 3 migrate pipeline/OCR stream.

## 2026-08-09 — Spec C Tasks 2–4: page-space OCR và lossless render artifact

### Chuỗi commit đã xác minh

- Task 2: `5f61499` — `feat: add detection result and region resolver`.
- Task 3: `aeb8006` — `feat: integrate page-space fragment ocr`.
- Task 4: `d1e2d1f` — `feat: build lossless render artifacts`.
- Dòng checkpoint trước đó ghi Task 2 chưa commit là snapshot lịch sử tại thời điểm ghi; mục này supersede trạng thái hiện hành. Worktree `feat/v5` và index sạch sau commit Task 4; chưa push.

### Task 3 — pipeline page-space và OCR theo fragment

- Pipeline chuyển sang `DetectionResult`, resolve region trước khi chuẩn bị artifact, cộng crop offset đúng một lần và giữ mask bằng buffer sở hữu riêng để byte accounting khớp dữ liệu cache thật.
- OCR chạy theo từng fragment, sort ngang/dọc rồi nối bằng newline. Dedupe fragment dùng **text trùng hoặc geometry overlap mạnh**; lazy `OcrRegistry.get()` và từng `engine.read()` được khóa riêng để không khởi tạo model hai lần.
- Review corrections đã đóng: materialize raw/refined masks, sửa dedupe từ `and` thành `or`, và serialize lazy engine initialization.
- Verification: focused **37 passed, 1 warning**; gate Task 1–3 **57 passed, 2 deselected, 1 warning**. Warning duy nhất là `StarletteDeprecationWarning` từ dependency.

### Task 4 — clean patch lossless và fit geometry

- `server/rendering.py` tạo `RenderArtifact` schema `render-v1` với Telea inpaint (`radius=3`), feather inward `2px`, fit padding `4px`, PNG RGBA lossless và `patch_id` phụ thuộc encoded bytes cùng page-space patch bbox.
- Capability fail closed: unbounded → `unsupported_region`; mask/source không hợp lệ → `clean_failed`; container/interior không bố trí an toàn → `layout_failed`. Test pixel khóa alpha ngoài refined mask bằng 0, raw ink bằng 255, offset page-space và round-trip không đảo kênh đỏ/xanh.
- Review ban đầu nêu container chạm biên source ROI là open. Reconsideration **WITHDRAW confirmed**: resolver xác định `bounded` theo biên ảnh đầy đủ trước khi crop `source_bbox` khít component, nên container hợp lệ chạm biên ROI là trạng thái bình thường. Important và Minor liên quan đã được reviewer retract; final verdict **PASS**, không có finding mới.
- Verification Task 4: **8 passed**. Gate Task 1–4: **65 passed, 2 deselected, 1 warning**; warning duy nhất là `StarletteDeprecationWarning` từ dependency. Commit diff sạch; worktree và index sạch.
- Không chạy hai real-detector tests, real-model tests hoặc `server/tests/test_ocr.py`, đúng gate đã duyệt.

> [!success] Checkpoint Spec C Task 4
> Tasks 1–4 đã PASS và được commit riêng. Bước triển khai kế tiếp là Task 5; chưa bắt đầu trong checkpoint này.
## 2026-08-09 — Spec C Tasks 5–8 và post-review fixes

### Trạng thái xác nhận

> [!success] Task 5 và Task 7 đã PASS
> Hai finding Medium hậu kiểm đã được xác minh, sửa bằng TDD, review độc lập và commit riêng. Final combined review không còn finding Critical/Important/Medium.

### Chuỗi commit mới nhất

- Task 5: `1362c7f` — `feat: add render artifact cache and api`.
- Task 6: `866e906` — `feat: add strict sfx translation contract`.
- Task 7: `7b6cfd7` — `feat: persist strict page-v2 cache`.
- Task 8: `cd69c37` — `feat: add content-hash source identity`.
- Post-review fix Task 5: `fed64d4` — `fix: retain analysis for render artifacts`.
- Post-review fix Task 7: `78edc37` — `fix: require translated manifest blocks`.

### Task 5 — render artifact cache/API và correction

- Thêm `/render-artifact`, render singleflight/cache và contract `render_artifact_key`; đường `/ocr-stream` chuẩn bị render cho cả cold và warm analysis.
- Review fix `fed64d4`: `/render-artifact` giữ chính `AnalysisArtifact` vừa resolve ở cả upload và warm/no-image path, rồi truyền `analysis=analysis` vào `ensure_render()`. Vì vậy LRU eviction giữa analyze và render không còn biến upload hợp lệ thành `409 artifact_missing`.
- Regression RED tái hiện cả hai nhánh nhận `409`; GREEN focused **9 passed**, adjacent Task 5 gate **49 passed**. Independent reviewer: **Approved**.

### Task 6 — strict SFX translation contract

- Response dịch dùng strict shape `{id, kind, translation}`; text yêu cầu bản dịch non-empty, SFX yêu cầu `translation=null`.
- Page policy không paint SFX và giữ SFX ngoài manifest render. Commit `866e906` đã được review PASS trong phạm vi server.

### Task 7 — strict page-v2 persistence và correction

- `PageCache` persist strict `page-v2`, tách version domain cho translation, patch và layout-fit; render stale bị loại chọn lọc mà không xóa translation hợp lệ.
- Review fix `78edc37`: mỗi `manifest_id` phải ánh xạ tới **đúng một** block `kind=text`, `state=translated`, với `trans_text` là string non-empty sau `.trim()`.
- Validation mới reject missing ID, duplicate ID, `kind=null`, state `ocr_complete/failed`, và translation null/empty/whitespace. Empty manifest/all-SFX và resumable block ngoài manifest vẫn hợp lệ.
- TDD RED: **17 passed, 9 failed** gồm 8 mutation cases và parent; GREEN page-cache: **26/26 passed**. Independent reviewer: **Approved**.

### Task 8 — exact source identity và runtime handoff

- Shared source pool dedupe theo URL, tối đa hai fetch FIFO, refcount/final-abort, retry sau failure; SHA-256 tính trên exact fetched bytes.
- Artifact keys dùng đúng bốn identity domain; `LAYOUT_FIT_VERSION` chỉ thuộc runtime/purge identity. Extension luôn gửi required `render_artifact_key`; strict page-v2 runtime handoff đã được nối hoàn chỉnh.
- Commit `cd69c37` được hậu kiểm **Approved**, không có finding.

### Verification cuối sau hai correction

- Full extension gate tuần tự: **39 passed, 0 failed** với `--test-concurrency=1`.
- Broad server gate: **262 passed, 2 deselected, 1 warning**.
- Warning duy nhất là `StarletteDeprecationWarning` từ dependency.
- Final combined reviewer Terra medium: **Approved**, không có Critical/Important/Medium.
- HEAD hiện tại: `78edc37` trên `feat/v5`; worktree và index sạch; chưa push.
- Không chạy `server/tests/test_ocr.py`, real-model hoặc hai real-detector tests.

### Việc còn lại

> [!todo] Task 9
> Cần gate end-to-end strict `{id, kind, translation}`. Fake extension hiện còn trả response shape cũ, nên các gate extension hiện tại chưa chứng minh đầy đủ luồng SFX từ server contract tới DOM/runtime.

## 2026-08-12 — Spec C Tasks 9–11: overlay in-place hoàn tất review

### Verdict cuối

> [!success] Tasks 9–11 PASS
> Luồng producer join, atomic clean-overlay và durable render outcome/recovery đã được triển khai, hậu kiểm và sửa theo review. Không còn finding Critical, Important hoặc Minor mở trong phạm vi ba task.

### Chuỗi commit

- Task 9: `3719e36` — `feat: join translation with render artifacts`.
- Task 10: `3b4397b` — `feat: render clean translation overlays atomically`.
- Task 11: `774c06e` — `feat: persist render outcomes and recovery breakers`.
- Review fix Task 11: `f4f7bb6` — `fix: harden render recovery persistence`.
- Review fix Task 10: `6926ef6` — `fix: stabilize translated overlay rendering`.
- Follow-up Minor Task 10: `9662524` — `fix: restore overlay font after resize`.

### Kết quả theo task

- **Task 9 — PASS:** translation strict `{id, kind, translation}` được join với `RenderArtifact`; cold path và warm replay dùng đúng `render_artifact_key`, không paint SFX, và giữ các guard huỷ/stale của producer.
- **Task 10 — PASS:** clean patch decode xong mới mount; `.mt-render-block` chỉ xuất hiện khi patch và text đã sẵn sàng; fit được đo trên probe có layout thật, lưu outcome `painted`/`fit_failed`, và resize lớn trở lại khôi phục cỡ chữ tối đa thay vì giảm đơn điệu.
- **Task 11 — PASS:** render outcomes chỉ persist khi đủ manifest theo canonical order; mismatch breaker bền vững chặn cold revisit khỏi chạy lại analysis/render/Gemini; các page write được tuần tự hóa để không ghi đè identity mới; stale collector/producer và shared OCR stage được cô lập đúng.

### Review corrections đã đóng

- Cold breaker giữ nguyên OCR manifest/translation và được kiểm tra độc lập với terminal cache hit; revisit cùng sentinel sau service-worker restart phát sinh `0` render, `0` OCR, `0` Gemini.
- Overlay khôi phục `color: #111` và font-family tường minh; decode reject không để lại `.mt-overlay` rỗng; transient persistence failure không làm mất collector; invalid geometry được ghi nhận bằng reason hợp lệ.
- Finding `vertical-rl` đã **WITHDRAW** sau đo trực tiếp trên Chrome 151: `scrollWidth/clientWidth` phát hiện đúng overflow ở các case chữ dọc, RTL, vertical-lr và nhánh resize.
- Minor font-size không hồi lại sau chu kỳ shrink → grow đã được sửa bằng TDD: `18px → 12px → 18px`.

### Verification và trạng thái

- Full extension gate: **39 passed, 0 failed**.
- `node --check` và `git diff --check`: PASS ở checkpoint cuối.
- Không chạy server tests hoặc `server/tests/test_ocr.py` trong lượt review/fix Tasks 9–11 này.
- Worktree `spec-c-in-place-overlay-rendering` trên `feat/v5` sạch, ahead `origin/feat/v5` **17 commit**; chưa push.

### Nhật ký lỗi và các fix round

#### Task 9 — join translation với RenderArtifact

1. **Vòng triển khai đầu — event chưa có render payload và warm replay chưa fetch artifact**
   - **Lỗi/RED:** translation event thiếu toàn bộ `patch_*`, `fit_bbox`, `text`, `layout_fit_version`, `layout_hint`; warm replay có `renderKey=0` thay vì `1`.
   - **Lý do:** luồng cũ emit translation ngay sau Gemini và cache chỉ biết text, chưa có readiness join với `RenderArtifact`.
   - **Cách giải quyết:** producer sở hữu hai promise `translationReady` và `renderReady`; fetch render theo key trước, chỉ retry một lần bằng blob khi server trả `409 artifact_missing`; validate schema/key/dimensions/manifest; chỉ emit text sau khi cả hai promise hoàn tất. SFX vẫn được lưu đúng strict contract nhưng không paint.
   - **Kết quả:** cold và warm đều phát event đủ patch/text; warm replay đúng một render key-call và không gọi Gemini.

2. **Fix round 1 — cold translation bị serialize theo render**
   - **Lỗi/RED:** khi test giữ render promise, translation cũng không thể hoàn tất và timeout ở mốc “translation completed while render held”.
   - **Lý do:** production `await producer.renderReady` trước khi bắt đầu `/translate-items`; hai công việc độc lập bị chạy tuần tự, làm mất mục tiêu latency của producer join.
   - **Cách giải quyết:** bỏ đúng `await` chặn trước translation; khởi động render và translation song song, nhưng giữ `Promise.all([renderReady, translationReady])` ngay trước emit để atomicity không đổi.
   - **Kết quả:** cả hai thứ tự hoàn tất render-trước và translation-trước đều GREEN; không có partial patch/text event.

3. **Fix round 2 — ghost translation sau khi render đã thất bại**
   - **Lỗi/RED nhanh:** render reject trước network nhưng continuation muộn vẫn tạo một `/translate-items` call.
   - **Lỗi/RED chậm:** translation request đã đi; sau render reject, response muộn vẫn ghi một entry vào hot translation cache dù producer đã terminal.
   - **Lý do:** strict join ngăn emit nhưng không huỷ sibling continuation; translation pipeline không biết render sibling đã thất bại.
   - **Cách giải quyết:** render rejection đặt `producer.cancelled=true` trước khi rethrow; translation kiểm tra trạng thái sau digest, trước network, sau response và trước apply/cache. Tách rõ `cancelled && !retired` với producer bị replacement: sibling bị huỷ không được cache/apply, còn producer `retired` vẫn được phép warm cache rồi dừng trước page/event apply.
   - **Kết quả:** fast race có zero late network; slow race có zero hot-cache/page/event mutation; invariant stale replacement warm-cache vẫn giữ nguyên.

#### Task 10 — DOM patch + text nguyên tử

1. **Vòng triển khai đầu — wrapper mount quá sớm, fit không revalidate và thiếu identity handoff**
   - **Lỗi/RED:** wrapper đã xuất hiện trước `patch.decode()` (`1 !== 0`); cached 18px được giữ dù chỉ 12px mới vừa hộp; upstream translation thiếu `render_artifact_key`.
   - **Lý do:** `.mt-bubble` cũ chỉ append text, không có lifecycle detached patch+text; fitter tin profile cache; background chưa chuyển render identity tới content.
   - **Cách giải quyết:** dựng detached `.mt-render-block` gồm `.mt-clean-patch` + `.mt-translated-text`, chờ decode và recheck binding rồi mới append đúng một lần; revalidate cả `scrollWidth` lẫn `scrollHeight` xuống sàn 10px; handoff `render_artifact_key` trên mọi renderable translation.
   - **Kết quả:** visible DOM luôn atomic và upstream integration khóa đúng render identity.

2. **Self-review fix — resize fit fail nhưng block tràn vẫn còn**
   - **Lỗi/RED:** re-fit sau resize trả `null`, nhưng live block count vẫn là `1`.
   - **Lý do:** `position()` phát hiện không fit nhưng chỉ bỏ qua cập nhật, không thu hồi UI đã paint.
   - **Cách giải quyết:** khi resize không fit ở 10px, remove block hiện hữu và gửi metric `painted:false`, `reason:"fit_failed"` nếu binding vẫn hợp lệ.
   - **Kết quả:** không còn chữ tràn trên clean patch; collector Task 11 nhận được outcome đầy đủ.

3. **Affected-harness fix — benchmark vẫn dùng selector `.mt-bubble`**
   - **Lỗi/RED:** benchmark không advance source sang `?benchmark=1`.
   - **Lý do:** UI class đã đổi nhưng controller benchmark vẫn query selector legacy.
   - **Cách giải quyết:** đổi đúng selector sang `.mt-translated-text` và thêm regression selector-specific.
   - **Kết quả:** fixture benchmark GREEN mà không mở thêm production scope.

4. **Review fix — đo text trên detached node cho kết quả giả**
   - **Lỗi/RED:** fake DOM ban đầu cho phép detached node có layout metrics nên production nhận sai 18px; fake sát browser hơn trả 0 và làm test fail.
   - **Lý do:** DOM node chưa connected không có layout box thật trong browser.
   - **Cách giải quyết:** dùng probe riêng, hidden/offscreen và nối tạm vào DOM để đo; wrapper thật vẫn detached; probe luôn cleanup bằng `finally` trước visible commit.
   - **Kết quả:** profile hợp lệ 12px được đo từ layout thật mà không phá atomic mount.

5. **Review fix — `scope_done` đến trước decode làm mất block hợp lệ**
   - **Lỗi/RED:** decode chậm hoàn tất sau normal `scope_done` cho live block count `0` thay vì `1`.
   - **Lý do:** cleanup xóa binding ngay ở terminal accounting, trong khi Chrome Port delivery và image decode là các task bất đồng bộ riêng.
   - **Cách giải quyết:** đánh dấu `completedScopeIds` cho normal success; final `validBinding` vẫn revalidate request/image/source/signature/language. `scope_error`, supersede và source change vẫn stale fail-closed.
   - **Kết quả:** normal late decode được paint và ghi metric; các sibling lỗi/stale vẫn không mount.

6. **Review fix — copy `CSSStyleDeclaration` như plain object**
   - **Lỗi/RED:** connected probe vẫn không commit fit 12px khi fake chuyển sang `CSSStyleDeclaration`-like behavior.
   - **Lý do:** `Object.assign(probe.style, element.style)` không copy các value width/height/writing-mode như kỳ vọng trong browser.
   - **Cách giải quyết:** copy tường minh đúng ba field `width`, `height`, `writingMode` cần cho phép đo.
   - **Kết quả:** test sát browser GREEN, không thêm abstraction CSS chung.

7. **Review fix 1 — blanket catch nuốt lỗi renderer thật**
   - **Lỗi/RED:** invalid geometry sau decode tạo zero log vì `.catch(() => {})`, trong khi đây không phải decode failure tạm thời.
   - **Lý do:** một catch boundary xử lý chung cả expected decode rejection và unexpected renderer exception.
   - **Cách giải quyết:** bắt riêng `patch.decode()` rejection và return yên lặng; terminal catch còn lại log đúng một lần với request/job/block identity và Error gốc.
   - **Kết quả:** decode reject vẫn zero block/metric/log; lỗi bất ngờ có dấu vết nhưng không tạo unhandled rejection.

8. **External review fix 2 — màu/font kế thừa và overlay root rỗng**
   - **Lỗi:** `.mt-translated-text` mất `color`/`font-family`, có thể thành chữ sáng trên patch sáng; decode reject xảy ra sau `ensureOverlay()`, để lại root rỗng.
   - **Cách giải quyết:** khôi phục `color:#111` và font stack trước phép đo; dời `ensureOverlay()` xuống sau decode + binding recheck.
   - **Tranh chấp `vertical-rl`:** đề xuất sửa overflow probe được **Challenge** thay vì áp dụng mù. Đo thật trên Chrome 151 cho thấy `scrollWidth/clientWidth` bắt đúng 8/8 case chữ dọc và các bước resize, nên finding được **WITHDRAW** và không có speculative code change.

9. **Follow-up review fix 3 — cỡ chữ chỉ giảm, không hồi lại khi hộp lớn lên**
   - **Lỗi/RED:** chu kỳ resize `18px → 12px → hộp lớn` vẫn giữ 12px.
   - **Lý do:** `position()` dùng `block.profile.font_px` hiện tại làm search ceiling, trong khi fitter chỉ giảm dần.
   - **Cách giải quyết:** mỗi lần resize reset riêng ceiling về 18px nhưng giữ `line_height` đã đo.
   - **Kết quả:** regression GREEN `18px → 12px → 18px`; không đổi lifecycle hoặc metric contract.

#### Task 11 — durable render outcomes và bounded recovery

1. **Vòng triển khai/takeover — collector chưa canonical và recovery phá shared OCR stage**
   - **Lỗi collector:** metric block ngoài manifest có thể chiếm slot, làm `blocks.size` đủ sớm, persist invalid rồi collector bị bỏ; scenario hợp lệ sau đó timeout.
   - **Giải quyết:** chỉ nhận block thuộc `manifestIds`, giữ outcome đầu tiên cho duplicate và persist đúng canonical order khi đủ toàn manifest; identity sai, disconnect và supersede đều invalid collector; giới hạn 128 collector.
   - **Lỗi recovery:** reset mismatch xóa thẳng `ocrStages.delete(producer.ocrKey)`, làm peer dùng chung mất live stage.
   - **Giải quyết:** tách `ocrStageKey` nội bộ; recovery dùng key `${ocrKey}:manifest-recovery`, còn wire/cache `ocr_key` giữ nguyên.
   - **Kết quả:** canonical manifest bền vững không chứa patch bytes; peer giữ original OCR stage và recovery có stage riêng.

2. **Review fix 1 — stale collector ghi đè PageRow identity mới**
   - **Lỗi/RED:** request khác đã ghi `new-render`/cleaner `c2`, nhưng collector cũ persist `activeProducer.page` và phục hồi `old-render`/`c1`.
   - **Lý do:** validate trên object in-memory cũ rồi ghi lại whole row.
   - **Cách giải quyết:** đọc PageRow fresh ngay trước ready write, guard page/render/manifest/patch identity và chỉ ghi row fresh; `persist()` bỏ qua producer có identity cũ.
   - **Kết quả:** race “new identity đã tồn tại trước collector read” được chặn, nhưng self-review tiếp tục phát hiện khoảng TOCTOU giữa fresh get và put.

3. **Review fix 2 — guard fresh-row vẫn hở TOCTOU**
   - **Lỗi/RED:** identity bump chen vào giữa `getPage()` và `putPage()`, sau đó collector cũ vẫn thắng; stale mismatch producer cũng có thể ghi sentinel old-render vào row `c2`.
   - **Lý do:** check-and-write gồm hai storage await nhưng chưa có serialization theo page.
   - **Cách giải quyết:** thêm `pageWriteTails`/`serializePageWrite(page_artifact_key)` cho producer persist, identity bump, collector ready và mismatch claim/sentinel; reread và identity recheck nằm bên trong cùng chain; mismatch stale trả `stale` thay vì ghi.
   - **Kết quả:** queued collector không thể overwrite identity bump hoặc durable sentinel.

4. **Review fix 3 — các writer kề cạnh vẫn nằm ngoài chain**
   - **Lỗi/RED:** terminal render error ghi lại c1 sau c2; retire producer cũ ghi đè hoặc xóa row c2; attach A đọc null rồi ghi placeholder đè row mới do attach B tạo.
   - **Lý do:** mới serialize happy-path collector/mismatch, còn terminal catch, retire và creation vẫn là whole-row writer độc lập.
   - **Cách giải quyết:** terminal partial write, retire partial/remove và fresh-create đều chạy trong page write chain, reread identity ngay trước mutation.
   - **Kết quả:** toàn bộ writer PageRow trong background cùng tuân một ownership/order invariant.

5. **Review fix 4 — LRU touch tự nó là stale whole-row writer**
   - **Lỗi/RED:** `getPage()`/`findPage()` đọc snapshot rồi `_touch()` ghi lại cả row; nếu ready render được persist trong khoảng đó, stale touch làm mất `ready-patch`.
   - **Lý do:** thao tác tưởng là read/LRU update thực chất là read-modify-write whole PageRow ngoài page chain.
   - **Cách giải quyết:** `findPage(..., {touch:false})` chỉ lấy candidate; `findPageForReuse()` vào page chain, đọc/touch fresh và recheck predicate. Initial visible `getPage()` cũng serialize. Active producer cùng render/patch identity được join trước cache read để tránh deadlock cho late consumer.
   - **Kết quả:** initial read và cả ba dynamic find path không thể erase ready render; regression late-consumer Task 9 vẫn pass.

6. **Review fix 5 — request mới reuse producer đã cancelled/retired**
   - **Lỗi/RED đầu:** early path gắn consumer vào cancelled producer và request không complete.
   - **Lỗi/RED fallback:** PageRow non-terminal bypass early guard rồi fallback vẫn reuse stale/mismatched producer và release acquisition của producer mới.
   - **Lỗi cleanup kề cạnh:** sau khi replacement được cài vào map, `failProducer(stale)` hoặc `finishProducer(stale)` xóa vô điều kiện theo page key, làm mất owner mới.
   - **Cách giải quyết:** dùng chung `reusableProducer()` ở early và fallback: producer phải live, không cancelled/retired, render và patch identity đều khớp. Khi thay owner, `finishProducer()`/`failProducer()` chỉ delete nếu map vẫn trỏ đúng object producer đang cleanup.
   - **Kết quả:** stale producer không nhận consumer/acquisition mới và cleanup cũ không xóa replacement.

7. **External review fix 6 — cold breaker, transient collector failure và invalid geometry**
   - **Cold breaker RED:** mismatch kép trên cold path ghi đè `producer.page` bằng cache copy cũ, làm mất `ocr_done`, `manifest_ids` và translated blocks; sau service-worker restart mỗi revisit lại tốn render + OCR + Gemini.
   - **Giải quyết:** persist breaker trên PageRow recovered của chính producer, chỉ merge mismatch count/render sentinel; kiểm tra fresh sentinel độc lập với `terminalHit`. Revisit cùng sentinel sau restart trở thành zero paid network.
   - **Collector RED:** `finally` xóa collector cả khi PageCache write lỗi transient, nên canonical outcomes không thể retry.
   - **Giải quyết:** chỉ xóa khi write durable hoặc identity proven stale; lỗi transient reset `persisting=false` để metric/replay sau thử lại.
   - **Geometry RED:** artifact `reason:null` nhưng patch/fit geometry sai không emit và cũng không prefill outcome, làm collector mãi thiếu block.
   - **Giải quyết:** normalize sang enum có sẵn `layout_failed`, không nới schema.
   - **Kết quả:** full extension suite cuối **39/39 PASS**; cold sentinel giữ đủ OCR/manifest/translation và chặn recovery trả phí đúng thiết kế.

> [!note] Vì sao Task 11 có nhiều vòng fix?
> Các lỗi đều là interleaving khác nhau của cùng một invariant: **PageRow mới hơn không được bị whole-row writer cũ ghi đè, và producer/collector cũ không được sở hữu tài nguyên của request mới**. Mỗi RED dùng barrier xác định để chứng minh một writer cụ thể trước khi mở rộng serialization/ownership guard; không thêm transaction framework khi chưa có race tái hiện được.


## 2026-08-13 — Spec C Task 12: bounded OCR recovery hoàn tất review

### Verdict cuối

> [!success] Task 12 PASS
> Durable OCR-recovery ledger, partial overlay replay và bounded recovery đã được triển khai, sửa đủ 4 finding ban đầu và bổ sung coverage cho nhánh terminal breaker. Không còn finding mở trong phạm vi Task 12.

### Chuỗi commit

- Task 12: `fc8dbed` — `feat: add bounded ocr recovery`.
- Review fix: `d314949` — `fix: harden bounded ocr recovery`.
- Follow-up coverage: `146597e` — `test: cover partial recovery breaker cleanup`.

### Kết quả Task 12

- Ledger `mt:ocr-recovery:<ocr_key>` dùng schema chính xác `ocr-recovery-v1`, claim bền vững tối đa một lần theo OCR identity và không bị eviction như PageRow terminal.
- Page `partial + manifest + ocr_done=false` replay overlay trước; chỉ claimant mới chạy một OCR recovery. Revisit, đổi `dst_lang` hoặc prompt không tiêu thêm OCR budget; đổi OCR identity tạo budget mới.
- OCR snapshot không đổi giữ manifest/translation authoritative và không gọi Gemini; snapshot đổi chạy đúng một full-page translation cho item set mới.
- Orphan ledger chỉ được thu gom ở lifecycle có thể làm mất PageRow cuối: remove, purge, eviction và rehydrate.

### Nhật ký lỗi và các fix round

1. **Vòng triển khai đầu — thiếu durable claim và partial recovery state machine**
   - **Lỗi/RED:** `claimOcrRecovery` chưa tồn tại; ledger sai schema không bị purge; concurrent partial pages có thể lặp OCR; partial manifest đi thẳng producer cũ thay vì replay trước.
   - **Cách giải quyết:** thêm exact ledger schema, serialized one-shot claim theo `ocr_key`, protected eviction và orphan GC; replay manifest trước claim, rồi reset producer sang scratch OCR chỉ cho claimant.
   - **Kết quả:** concurrent/restart/new-dst/new-prompt giữ tối đa một OCR POST cho cùng identity; claim write failure không phát sinh OCR hoặc Gemini.

2. **Fix round 1 — `retireProducer` ghi scratch OCR-recovery đè PageRow authoritative**
   - **Lỗi/RED:** target replacement retire producer giữa recovery làm PageRow mất `manifest_ids`/render và thay block translated cũ bằng scratch block mới.
   - **Lý do:** `persist()` có guard recovery nhưng `retireProducer()` bypass guard và persist whole scratch page.
   - **Cách giải quyết:** chặn retire persistence khi `producer.ocrRecovery`; replacement cleanup vẫn remove toàn bộ job ledger trước retire.
   - **Kết quả:** PageRow bền vẫn giữ `{state:partial, ocr_done:false, blocks:[old], manifest_ids:[old], render:[old]}` trong khi scratch đang có block `new`.

3. **Fix round 2 — partial replay bypass durable manifest-mismatch breaker của Task 11**
   - **Lỗi/RED:** render thiếu manifest ID làm request dừng trước OCR, nhưng `manifest_mismatch_count` chưa được persist và revisit tiếp tục gọi render.
   - **Lý do:** `fetchRenderArtifact()`/`replayPage()` của nhánh partial nằm ngoài mismatch handling; OCR claim lại đặt sau replay.
   - **Cách giải quyết:** bắt riêng `manifest_mismatch`, gọi `handleManifestMismatch()` trước OCR claim; lần đầu queue paid recovery của Task 11, lần hai ghi sentinel `breaker_open`, các revisit sau bị chặn trước replay.
   - **Kết quả:** chuỗi network được khóa `render:2/ocr:1/text:1` → `render:1/ocr:0/text:0` → `render:0/ocr:0/text:0`; mismatch không tiêu ledger OCR-recovery.

4. **Fix round 3 — `putPage()` quét toàn bộ storage thêm một lần cho orphan GC**
   - **Lỗi/RED:** một PageRow rewrite bình thường gọi `storage.get(null)` hai lần.
   - **Lý do:** `_put()` đã scan cho budget nhưng `putPage()` lại chạy `_gcOcrRecoveryLedgers()`, dù rewrite cùng page key không thể đổi OCR identity hợp lệ.
   - **Cách giải quyết:** `putPage()` trả thẳng `_put(...)`; giữ GC ở remove/purge/eviction/rehydrate.
   - **Kết quả:** ordinary rewrite còn đúng một inventory scan, contract return không đổi và ledger đang được tham chiếu vẫn tồn tại.

5. **Fix round 4 — `sameOcrSnapshot()` so sánh block theo vị trí**
   - **Lỗi/RED:** cùng tập block nhưng OCR event đảo thứ tự tạo một Gemini call không cần thiết; fallback `kind` có thể gắn nhầm block.
   - **Cách giải quyết:** map fallback kind theo `block_id`, canonical-sort projection của hai phía rồi mới so sánh.
   - **Kết quả:** reorder `sfx,text` giữ `ocr:1, text:0`, kind/manifest authoritative không đổi; các transition `text ↔ sfx` vẫn buộc dịch lại.

6. **Follow-up Minor — nhánh partial terminal breaker chưa có cleanup coverage**
   - **Finding:** production đã đúng nhưng test trước chỉ phủ partial mismatch lần đầu và terminal complete page; chưa khóa nhánh `action !== recover` cho partial PageRow có `manifest_mismatch_count:1`.
   - **Cách giải quyết:** thêm scenario dựng đúng partial page count 1, assert sentinel bền, zero OCR/Gemini, job ledger được dọn và revisit phải fetch source mới nhưng không gọi render.
   - **Mutation proof:** tạm bỏ `releaseProducerSource(producer)` làm test RED với `source delta=0` thay vì `1`; khôi phục source làm GREEN. Ví dụ bỏ explicit `removeJob` riêng lẻ không phải mutant hành vi vì `completeJob()` đã thực hiện cleanup theo contract chung; test khóa kết quả không còn `mt:job:` thay vì khóa số lần gọi nội bộ.
   - **Kết quả:** resource ownership của nhánh terminal breaker được bảo vệ mà không đổi production code.

### Verification và trạng thái

- Focused Task 12 gate tuần tự: **36 passed, 0 failed**.
- Full extension gate tuần tự: **48 passed, 0 failed**.
- `git diff --check`: PASS trước commit follow-up.
- Không chạy server tests, real-model tests hoặc `server/tests/test_ocr.py` trong fix round này.
- Worktree `spec-c-in-place-overlay-rendering` trên `feat/v5` sạch sau commit `146597e`, ahead `origin/feat/v5` **20 commit**; chưa push.

## 2026-08-13 — Spec C Task 13: delivery accounting và cô lập lỗi Port

### Verdict cuối

> [!success] Task 13 PASS
> Delivery được đếm riêng theo request/job và chỉ sau `postMessage` translation thành công. Lỗi transport của Port trong accepted/progress/block_error/translation/image_done không còn làm hỏng producer, OCR stage, PageRow hoặc telemetry. Independent re-review cuối không còn finding trong phạm vi F2–F5.

### Chuỗi commit

- Task 13: `b1ec9cc` — `feat: track per-job delivery across recovery`.
- Review fix direct replay: `3e21efd` — `fix: preserve cache on replay delivery failure`.
- Bộ nguồn SFX riêng: `7fa019b` — `test: add dedicated sfx image fixtures`.
- Review fix transport hoàn chỉnh: `0efab16` — `fix: contain extension port delivery failures`.

### Nhật ký lỗi và các fix round

1. **Vòng triển khai — số translated dùng kết quả chung thay vì delivery thật của từng consumer**
   - **Lỗi/RED:** page mixed text/SFX báo translated theo tổng block; consumer có Port throw hoặc disconnect có thể được tính như đã nhận; offline jobs cùng request ID không hợp nhất ownership delivery.
   - **Lý do:** chưa có ledger `Map<job_id, Set<block_id>>` ở request boundary; producer result bị dùng thay cho số translation event đã post thành công.
   - **Cách giải quyết:** seed Set cho mọi expected job, merge Set rỗng khi rehydrate, add `block_id` chỉ sau post thành công và dùng đúng Set cho `image_done`/`scope_done`.
   - **Kết quả:** mixed text/SFX, all-SFX, shared producer, late replay, disconnect, replacement và offline restore đều giữ count riêng theo consumer.

2. **Review fix 1 — translation post lỗi trong direct replay làm bẩn PageRow authoritative**
   - **Lỗi/RED:** Port chết ở translation thứ hai làm exception rơi vào render catch; PageRow complete bị hạ thành partial, `last_error` chứa lỗi Port và telemetry báo `render_failed`.
   - **Lý do:** vòng `replayPage()` gọi `postMessage` trần và chỉ ghi delivered sau toàn bộ control flow.
   - **Cách giải quyết:** dừng replay tại post lỗi, chỉ add ID sau từng post thành công; terminal count lấy số event đã giao trước lỗi.
   - **Kết quả:** chỉ block đầu được tính, request vẫn `failed:0`, `cache_hit:true`; PageRow giữ `state:complete`, `last_error:null`.

3. **Review fix 2 — các message transport kề cạnh vẫn làm hỏng pipeline**
   - **Lỗi/RED progress replay:** Port throw ở progress làm PageRow complete thành partial và telemetry `render_failed`.
   - **Lỗi/RED accepted:** Port throw ở `page_job_accepted` thoát lên `acceptScope`, request bị ghi `request_failed` dù cache/render vẫn hợp lệ.
   - **Lỗi/RED producer emit:** Port throw ở progress hoặc block_error reject shared OCR stage; valid block không được dịch, translated từ 1 thành 0.
   - **Lỗi invariant:** delivery Set bị thiếu vẫn bị fallback thành 0, che lỗi lifecycle trái contract.
   - **Cách giải quyết:** một helper `postTo()` best-effort dùng chung cho accepted/progress/block_error/translation/image_done; helper trả boolean để translation chỉ ghi delivered khi post thành công. Mọi access delivery ledger chuyển sang `Map.get(...).add/.size` nghiêm ngặt, không còn optional fallback.
   - **Kết quả:** ba biến thể direct replay accepted/progress/translation giữ PageRow và telemetry đúng; producer progress/block_error không reject OCR stage; test xóa delivery Set xác nhận fail-fast. Focused gate 2/2 và full extension gate sau commit 49/49 PASS.

### Nguồn SFX bổ sung — tách khỏi review transport

- Pack riêng chỉ gồm `s-manga_ja_sfx.png` (thoại + SFX), `sfx_1.jpg` và `sfx_2.jpg` (SFX-only); khóa đúng ba filename, SHA-256, kích thước và vai trò, không nhập vào historical quality baseline.
- Dedicated fixture gate 2/2 và production detector/OCR source gate 3/3 đã PASS.
- Quan sát chất lượng không bị che thành acceptance: `sfx_1` đạt SFX-only; trang mixed chưa nhận diện phần SFX; `sfx_2` còn một block bị phân loại text. Đây là model-quality debt ngoài fix transport Task 13.

### Verification và trạng thái

- RED xác nhận riêng: missing delivery ledger không fail-fast; accepted thành `request_failed`; replay progress thành `render_failed`; emit progress/block_error làm translated từ 1 thành 0.
- GREEN focused: **2 passed, 0 failed**.
- Post-commit full extension: **49 passed, 0 failed**.
- Hai JavaScript syntax checks và `git diff --check`: PASS.
- Independent re-review F2–F5: **Approved**, không có finding mới; phần fixture SFX được loại khỏi review theo yêu cầu.
- Worktree `spec-c-in-place-overlay-rendering` trên `feat/v5` sạch tại `0efab16`, ahead `origin/feat/v5` **24 commit**; chưa push.

## 2026-08-14 — Spec C Task 14: telemetry và acceptance gate

### Verdict cuối

> [!success] Task 14 PASS
> Telemetry `atomic_patch_v1`, acceptance protocol và deterministic gate đã hoàn tất review. Ba Minor follow-up cuối đã được vá và khóa bằng RED/GREEN hoặc mutation proof; không còn finding mở trong phạm vi Task 14.

### Commit

- `6770d74` — `feat: add atomic overlay acceptance gate`.
- Commit đúng 8 file allowlist của Task 14; `extension/content.js` không có diff cuối.

### Kết quả chính

- PageMetric có semantic/cohort/coverage/reason fields; late render metric không được ghi đè ownership labels.
- `first_overlay_ms` đo đến lúc patch + text đã decode, fit và append nguyên tử thành công.
- `render_wait_after_translation_ms` dùng render-ready mới nhất, kể cả nhánh manifest recovery.
- Acceptance app dùng đúng pipeline/patch versions, strict text/SFX schema, deterministic RGBA PNG, key-first render lookup và route-specific cache headers.
- Golden A–D khóa exact manifest/rendered/skip sets, coverage, SFX ngoài denominator và page D `fit_failed` bằng fit box 12×12.

### Trade-off được chấp nhận — percentile chỉ đo trang thực sự paint

Sau Fix 2, cả cohort `warm` và `cold` chỉ đưa row có `first_overlay_ms` hữu hạn vào percentile `render_wait_after_translation_ms`.

Dưới góc nhìn người dùng cuối:

- `first_overlay_ms` trả lời: “Mở trang bao lâu thì tôi thật sự thấy dòng dịch đầu tiên?”
- `render_wait_after_translation_ms` trả lời: “Sau khi dịch xong, tôi còn phải chờ patch sạch bao lâu trước khi thấy kết quả?”
- Một trang có render artifact về nhưng toàn bộ block `fit_failed`, `unsupported_region`, `clean_failed`, `layout_failed` hoặc decode thất bại thì người dùng không bao giờ thấy overlay. Vì vậy row đó không được dùng làm một mẫu “thời gian chờ trước khi thấy kết quả”.
- Việc lọc giống nhau ở warm/cold giữ hai cohort trên cùng tập trải nghiệm, nên chênh lệch giữa chúng phản ánh cache thay vì khác biệt tập mẫu.

> [!warning] Điểm mù cần nhớ khi vận hành
> Nếu một regression vừa làm render chậm vừa làm nhiều trang không paint, p95 có thể đứng yên hoặc đẹp lên vì `sample_count` tụt. Không được đánh giá gate chỉ bằng percentile. Luôn đọc cùng `sample_count`, `render_coverage` và `render_reason_counts`.

Trang không paint không biến mất khỏi telemetry:

- `painted: false`;
- `render_coverage: 0` khi có manifest text nhưng không render được;
- `render_reason_counts` giữ nguyên nhân như `fit_failed` hoặc `unsupported_region`;
- `sample_count` của latency cohort giảm và chính nó là tín hiệu cảnh báo.

Nếu sau này cần trả lời câu hỏi chẩn đoán server “render artifact về nhanh chậm thế nào bất kể frontend có vẽ được không”, hãy thêm cohort riêng như `cold_backend`, chỉ lọc `Number.isFinite(render_wait_after_translation_ms)`. Không nới lỏng cohort `cold` hiện tại vì sẽ mất lại tính đối xứng warm/cold và đổi ý nghĩa UX của metric.

### Verification đóng task

- Full server bằng project venv, loại đúng `server/tests/test_ocr.py`: **268 passed, 2 dependency warnings có sẵn**.
- Full extension chạy tuần tự: **50 passed, 0 failed**.
- `node --check`: **6/6**; venv `py_compile`: **2/2**; `git diff --check`: PASS.
- Browser/manual visual QA và Gate A–G tổng hợp thuộc Task 15; không dùng kết quả `/health` thay cho bằng chứng UI.
- Nhánh `feat/v5` đã commit Task 14 tại `6770d74`; chưa push.
