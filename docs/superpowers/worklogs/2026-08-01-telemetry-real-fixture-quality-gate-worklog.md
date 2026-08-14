---
title: "Telemetry và real-fixture quality gate"
note_type: worklog
work_item: telemetry-real-fixture-quality-gate
date_start: 2026-08-01
date_end: 2026-08-03
status: done
versions:
  - "[[feat-v3]]"
specs:
  - "[[2026-08-01-telemetry-real-fixture-quality-gate-design]]"
plans:
  - "[[2026-08-01-telemetry-real-fixture-quality-gate]]"
artifacts:
  - "[[2026-08-01-real-page-quality-baseline.json]]"
tags:
  - mangatranslator/worklog
---

# Telemetry và real-fixture quality gate

> [!summary] Tóm tắt
> **Vấn đề:** Telemetry và chất lượng trang thật thiếu contract, fixture canonical và gate có thể tái lập.
>
> **Quyết định/fix:** Bổ sung policy probe, real-page fixtures, offline quality gate và nhiều vòng human review.
>
> **Kết quả:** Work item đóng với baseline JSON; các finding contract và offset đã được sửa.

## Liên kết

- Phiên bản: [[feat-v3]]
- Spec: [[2026-08-01-telemetry-real-fixture-quality-gate-design]]
- Plan: [[2026-08-01-telemetry-real-fixture-quality-gate]]
- Artifact: [[2026-08-01-real-page-quality-baseline.json]]

---
## Spec A — tạm dừng sau Task 2 (2026-08-01)

> [!info] Trạng thái phiên
> Phiên Subagent-Driven Development được dừng theo yêu cầu của người dùng sau khi Task 1 và Task 2 đã qua review. Task 3 mới chỉ được trích brief trong workspace SDD; chưa giao implementer và chưa có code Task 3.

### Spec và implementation plan đã chốt

- Spec đã duyệt: `docs/superpowers/specs/2026-08-01-telemetry-real-fixture-quality-gate-design.md`.
- Implementation plan: `docs/superpowers/plans/2026-08-01-telemetry-real-fixture-quality-gate.md`.
- Mốc trên `feat/v3`: `71cad75` hoàn tất spec handoff; `d258ccf` thêm plan 8 task/48 bước TDD.
- Ranh giới giữ nguyên: Spec A chỉ xây telemetry, fixture, policy probe và quality gate. Reading order/page-context translation thuộc Spec B; lỗi overlay chồng, crop trắng che chữ và trạng thái partial thuộc Spec C.

### Phần đã triển khai trong worktree hiện tại

- Worktree: `D:\MangaTranslator\.worktrees\spec-a-telemetry-quality-gate`
- Branch: `feat/spec-a-telemetry-quality-gate`
- HEAD khi dừng: `1a36e2f`

- [x] **Task 1 — server analysis telemetry**
  - Commit `43c0016`.
  - Thêm `Pipeline.analyze_with_status()`, giữ wrapper `analyze()`.
  - `analysis_ready` phát `analysis_ms` và `analysis_cache_hit`; hit sau khi chờ `_ocr_lock` vẫn được phân loại đúng.
  - Verification: Python **88 passed**, 3 warning dependency/tooling có sẵn.
  - Task review: PASS, không có Critical/Important/Minor.

- [x] **Task 2 — per-job metric row và Gemini call trace**
  - Commit triển khai `3949937`; fix review `1a36e2f`.
  - `scope_done.page_metrics` có đúng một row/job cho producer, warm page-cache hit và lỗi trước producer; aggregate cũ vẫn giữ.
  - Trace tách khỏi counter `translationBatches`, nên microbatch 3/8 production không đổi.
  - Fix round 1 xử lý ba finding Important: stage không chạy phải là `null` thay vì `0`; late consumer phải kế thừa shared-stage timing; HTTP 429 phải phân loại theo status thay vì body text.
  - Verification: toàn bộ JS suite **9/9 file pass**; scoped re-review xác nhận **3/3 addressed**, không có breakage mới.

- [x] **Task 3 — `first_overlay_ms` theo từng trang**
  - ==Mục này đã sai khi ghi==: lúc viết worklog Task 3 chưa triển khai, nhưng worktree hiện ở HEAD `01d1dfe` với đủ commit và production diff. Xem [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#Spec A — code review Task 1–3 (2026-08-02)]].

### Trạng thái checkout/worktree

- Checkout chính `D:\MangaTranslator` vẫn ở `feat/v3`, HEAD `d258ccf` trước khi ghi worklog này.
- Worktree hiện tại sạch tại HEAD `1a36e2f`; các commit Task 1–2 chưa merge/cherry-pick về `feat/v3`.
- Người dùng xác nhận các `.worktrees` cũ được nhắc trong lịch sử trước đã bị xóa. Kiểm tra lúc dừng cho thấy chỉ còn worktree hiện tại `spec-a-telemetry-quality-gate`; không được nhầm các đường dẫn worktree cũ trong mục 2026-07-30/31 là workspace còn hoạt động.
- Không xóa worktree hiện tại trước khi tích hợp các commit `43c0016`, `3949937`, `1a36e2f`.

### Điểm tiếp tục ở phiên sau

1. Mở ledger ignored: `.superpowers/sdd/2026-08-01-telemetry-real-fixture-quality-gate/progress.md`; Task 1–2 đã complete.
2. Bắt đầu Task 3 từ brief hiện có và giữ message contract `render_metric` theo `job_id`; producer không được chờ UI.
3. Sau Task 3 mới tiếp tục fixture/ground truth, policy probe, evaluator và manual worklog theo plan.
4. Chưa có claim về policy Gemini mới, chất lượng Portuguese production hoặc fix overlay; các gate đó vẫn pending.

#mangatranslator/spec-a/telemetry-quality-gate

---

## Spec A — code review Task 1–3 (2026-08-02)

> [!warning] Kết luận
> **Task 1 PASS. Task 2 và Task 3 chưa nên coi là xong.** Task 2 có **1 finding Critical**: commit fix `1a36e2f` sửa phân loại 429 theo HTTP status, nhưng server không bao giờ trả 429 — nên mọi rate limit thật bị trace sai. Task 3 có **1 finding Important** về mốc đo `first_overlay_ms` lệch với mọi field còn lại trong cùng row. Không được merge về `feat/v3` trước khi xử lý hai mục này.

### Phạm vi và cách kiểm chứng

- Diff review: `d258ccf..01d1dfe` trên `feat/spec-a-telemetry-quality-gate` — `43c0016` (Task 1), `3949937` + `1a36e2f` (Task 2), `01d1dfe` (Task 3).
- Chạy lại gate tại HEAD `01d1dfe`: pytest **88 passed** (3 warning dependency có sẵn), Node **9/9 file pass**. Số trong worklog trước là đúng.
- Đối chiếu từng task với `docs/superpowers/plans/2026-08-01-telemetry-real-fixture-quality-gate.md`, gồm cả Global Constraints.

### Task 1 — server analysis telemetry (`43c0016`) → PASS

Đạt yêu cầu: `analyze_with_status()` trả `(artifact, cache_hit)`, wrapper `analyze()` vẫn có caller thật ở `server/pipeline.py:226` nên không phải code chết; hit sau khi chờ `_ocr_lock` được phân loại đúng và test dùng hai `Event` + `ThreadPoolExecutor` assert `detector.calls == 1` — đúng chỗ dễ sai nhất. Mojibake `server/main.py:160` đã sửa, không đụng error code.

> [!bug] Minor 1 — `analysis_ms` cộng thêm nhiễu scheduling
> `analysis_started = time.perf_counter()` nằm trong handler (`server/main.py:101`) nhưng `analysis_ms` được tính bên trong `stream()`, mà Starlette chỉ chạy generator khi bắt đầu gửi body. Warm hit vì thế không về ≈0 như kỳ vọng.
> Fix: chuyển `analysis_started` thành dòng đầu tiên của `stream()`.

### Task 2 — per-job metric row và Gemini trace (`3949937`, `1a36e2f`) → CẦN SỬA

Phần đúng: `emptyPageMetrics()` + spread trong `completeJob()` là điểm chuẩn hoá duy nhất, không có schema class, không có row giả `0`; ràng buộc "stage không chạy = `null`" giữ nhất quán tới tận `createProducer` (`durations: { fetch_ms: null, analysis_ms: null }`); aggregate cũ không vỡ vì `scopeMetrics.value()` lọc non-finite; `page_artifact_key` là hash (`extension/background.js:110`) nên không rò URL.

> [!danger] Critical — phân loại 429 sai trong production
> `extension/background.js:701` sau fix dùng `error.status === 429`. Nhưng server **không bao giờ trả HTTP 429**: `server/translator.py:109` bắt `APIError.code == 429`, retry/đổi client, rồi `raise TranslateError(last_err)`; `server/main.py:180` map thành **HTTP 502** với body `"gemini: 429 RESOURCE_EXHAUSTED..."`.
> Hệ quả: mọi rate limit thật bị ghi `status: "failed"`, `error_code: "translation_failed"` — đúng tín hiệu mà Spec A cần để chọn/bác policy dịch.
> Test không bắt được vì fake server trả `{ ok: false, status: 429 }`, một response server thật không phát ra được.
> Đồng thời `background.js:713` vẫn giữ `String(error).includes("429")` cho counter `producer.counters.rate_limited`, nên counter (đúng) và trace (sai) mâu thuẫn nhau trên cùng một lỗi. `1a36e2f` còn đổi body fixture `"429 quota"` → `"quota exceeded"`, làm counter không tăng trong chính kịch bản rate-limit mới thêm; không test nào assert `rate_limited > 0` nên regression này im lặng.
> Fix root-cause một chỗ cho cả hai caller:
> ```javascript
> function isRateLimited(error) { return error.status === 429 || String(error).includes("429"); }
> ```
> Test đi kèm phải dùng response **502** body `"gemini: 429 RESOURCE_EXHAUSTED"`, giữ thêm ca 502-không-429 → `failed`.
> Ghi chú: finding review vòng 1 ("phân loại theo status thay vì body text") đúng về nguyên tắc nhưng sai với codebase này.

> [!warning] Important — `translation_batches` không phải "mỗi Gemini call"
> Plan viết một trace row cho mỗi network Gemini call. Thực tế một trace = một call **extension → server**, trong khi server retry 2 lần và có thể đổi client (`server/translator.py:96-115`). `duration_ms` đã gộp retry, và số trace ≤ số Gemini call thật. Không phải bug code, nhưng evaluator sẽ đọc sai nếu spec giữ nguyên câu chữ. Sửa wording, hoặc để server phát số attempt.

> [!bug] Minor 2–6
> 2. `background.js:613` — `mark(producer, "first_ocr")` giờ thừa: producer tự nằm trong `stage.consumers` nên `applyOcrBlock` (`:643`) đã mark. Xoá được 1 dòng.
> 3. `acceptScope` truyền `meta.pageKey = descriptor.page_artifact_key`, nhưng `content.js` không bao giờ gửi field này → luôn `null`. Ý định trong plan ("key nếu đã tạo") chưa đạt.
> 4. `trace.cache_hit` là hằng `false` vì trace chỉ tạo trên nhánh network (đúng plan), nên field hiện vô nghĩa.
> 5. `batch_id: producer.translationBatches` tăng trước cả nhánh cache-only → có lỗ hổng số thứ tự, `batch_id` ≠ index trong mảng trace.
> 6. `failProducer` hardcode `error_code: "request_failed"` dù `producer.page.last_error` có nguyên nhân thật. Giữ hằng là an toàn về PII, nhưng nên map các mã stage đã biết (`ocr:<code>`).

### Task 3 — `first_overlay_ms` theo từng trang (`01d1dfe`) → CẦN SỬA

Phần đúng và khó: hợp đồng ba nhánh merge được xử lý đầy đủ — `content.js` giữ `firstOverlayByJob` và gửi `render_metric` kèm `job_id` đúng một lần/job; `background.js` chặn job lạ bằng `expectedJobIds`; row đã push trước khi overlay render (đường warm replay) được patch tại chỗ; metric đến sau `scopeDone()` patch bản sao đã sanitize trong `metricSamplesByRequest` chứ không tạo row mới. Aggregate scope dùng `Math.min` nên message lệch thứ tự không phá số cũ — test integration bắn `999999` cho request đã đóng và summary không đổi. `emit()` luôn kèm `job_id: consumer.jobId` nên guard bên content không bao giờ rơi vào key `undefined`.

> [!warning] Important — `first_overlay_ms` lệch mốc so với mọi field cùng row
> Global Constraint của plan: "`*_done_ms` và `first_*_ms` là elapsed từ lúc producer được accepted". Nhưng `content.js:147` đo từ `pending.startedAt` — thời điểm **scope** bắt đầu trong content script, không phải lúc producer của trang đó được accepted.
> Với `MAX_CONCURRENT = 2`, trang thứ ba trở đi phải xếp hàng, nên `first_overlay_ms` bị cộng cả queue wait trong khi `first_translation_ms` cùng row thì không. Hiệu `first_overlay_ms - first_translation_ms` (đúng thứ cần đo cho độ trễ render) sẽ over-report đúng bằng thời gian chờ.
> Row đã có `queue_wait_ms = started - accepted`, còn thiếu `accepted - scopeStart`. Fix rẻ nhất: thêm một field `accepted_offset_ms` (chênh trong cùng đồng hồ worker, tính tại `completeJob` từ `request.acceptedAt` và `producer.timings.accepted`) để evaluator chuẩn hoá. Cách còn lại là ghi rõ trong spec rằng field này có mốc khác và không so trực tiếp được với các `*_ms` khác.

> [!bug] Minor 7 — khoảng trống test
> Ca metric đến **sau `completeJob()` của job đó nhưng trước `scopeDone()` của scope** chỉ được phủ bởi dòng `if (row) row.first_overlay_ms = ...` mà không có test. Hai ca đã test là "trước mọi completeJob" và "sau scopeDone".

### Sai lệch so với worklog 2026-08-01

- Mục Task 3 trong [[2026-08-01-telemetry-real-fixture-quality-gate-worklog#Spec A — tạm dừng sau Task 2 (2026-08-01)]] ghi "chưa triển khai, không có commit" là **sai ở thời điểm đọc lại**: worktree đang ở `01d1dfe` với đủ diff production và test. Đã sửa checkbox tại chỗ.
- Xác nhận đúng: cả 4 commit vẫn **chưa merge/cherry-pick** về `feat/v3`.
- Xác nhận đúng: chỉ còn một worktree `spec-a-telemetry-quality-gate`.

### Việc phải làm trước khi merge về `feat/v3`

1. Sửa Critical 429 bằng `isRateLimited()` dùng chung cho cả trace lẫn counter, kèm test dựng response 502 đúng shape production.
2. Chốt mốc `first_overlay_ms`: thêm `accepted_offset_ms` hoặc ghi rõ mốc khác trong spec.
3. Gom các Minor 1–7 vào một commit dọn.
4. Chạy lại pytest + Node, rồi mới tích hợp `43c0016`, `3949937`, `1a36e2f`, `01d1dfe`.

#mangatranslator/spec-a/telemetry-quality-gate


## Spec A — đóng review Task 1–3 (2026-08-02)

- Task 3 giữ `first_overlay_ms` theo content scope start để tương thích lịch sử benchmark. Commit `0e9523f` thêm `accepted_offset_ms`; overlay quy về mốc producer xấp xỉ `first_overlay_ms - accepted_offset_ms`. Sai số còn lại là IPC + thời gian đánh thức service worker MV3. Giá trị âm hợp lệ khi producer dùng chung được accepted trước request đến sau.
- Commit `688be55` giữ đúng aggregate `scope_done.metrics.first_overlay_ms` khi metric đến muộn; commit `0e9523f` phủ thêm nhánh metric đến sau `completeJob()` nhưng trước `scopeDone()`.
- Task 2: commit `8a997a7` phân loại đúng Gemini 429 bị server bọc thành HTTP 502 và làm trace/counter dùng chung một rule. Wording đã làm rõ một `translation_batches` trace là một request extension → server; retry/failover Gemini có thể xảy ra bên trong.
- Cleanup review: commit `6063322` loại scheduling noise khỏi `analysis_ms` và bỏ mark `first_ocr` trùng.
- Fresh verification tại HEAD `6063322`: Python **89 passed**, toàn bộ **9/9** file test Node passed, `background.js`/`content.js` syntax passed, `git diff --check` passed, worktree clean.
- Review gate Task 1–3 hiện sạch. Chưa merge vào `feat/v3`; Task 4–8 vẫn còn trong kế hoạch.

## Spec A — Task 4 canonical real-page fixtures hoàn tất (2026-08-02)

- Commit `c6d963b` thêm 6 PNG canonical, manifest reviewed 7/21/17 regions, validator/matcher stdlib và mở rộng `server.diagnose` với `--device`/`--manifest-candidate`.
- Diagnostic CPU thật: PT 8 raw → 7 anchors; JA1 21/21 với vendor index 5 được đưa trước 3/4 và poster là `sign`; JA2 17/17 giữ thứ tự đã review. Cả 3 source và 3 failure reference đã được inspect trực tiếp.
- Review fix round 1 `e27aa52`: khóa PNG IHDR dimensions, đúng 6 fixture, unique image/fixture/region ID, exact ground-truth labels/anchors và ngưỡng IoU strict `> 0.5`.
- Review fix round 2 `62c93cf`: pin trực tiếp `reading_order` JA1 để mutation hoán đổi 3↔4 không lọt test. Re-review: overall clean.
- Fresh verification tại HEAD `62c93cf`: server **102 passed** (3 warning baseline), focused fixture+diagnose **16 passed**, 6 SHA-256 exact, không còn `.tmp-real-pages`/`.diag.*`, `git diff --check` và worktree clean.
- Task 4 hoàn tất; chưa merge vào `feat/v3`. Task 5 bắt đầu.

## Spec A — re-review Task 1–3: sửa contract offset âm (2026-08-02)

- Re-review người dùng xác nhận code Task 1–3 PASS; không còn Critical/Important trong code.
- Finding tài liệu được xác nhận: luật duration không âm mâu thuẫn với `accepted_offset_ms = -10` hợp lệ của shared producer.
- Commit `fc9b16e` sửa cả contract tổng quát và mô tả field: `accepted_offset_ms` là offset, không phải duration, và có thể âm khi request đến sau dùng producer đã được accepted trước.
- Verification doc-only: review diff, search contract liên quan, `git diff --check` pass; worktree clean.
- Ba Minor `trace.cache_hit`, khoảng trống `batch_id`, và taxonomy `failProducer` vẫn park/non-blocking theo review. Task 5 đã tạm dừng sạch trước khi có diff để chờ review theo gate mới.

## 2026-08-02 — Spec A Task 4: sửa theo re-review (9cf369c)

- Đã bổ sung term_groups cho JA1 theo schema canonical / accepted_source_forms / fixture_block_ids: マッコイ (b07, b20) và タツマキ (b05, b19). Validator khóa đúng field, canonical duy nhất, danh sách text hợp lệ, ít nhất 2 block khác nhau và mọi block phải tồn tại.
- Đã sửa lỗi báo sai khi role không hợp lệ; tăng kiểm tra known_order_failures; thêm assertion semantic cho thứ tự JA1; test ảnh tracked không còn phụ thuộc CWD; ignore .tmp-real-pages.
- Đã thêm allowlist phòng thủ cho HTTP translate_items: chỉ id và text đi vào prompt. Đây là boundary hiện tại, tách khỏi policy probe Task 5 dự kiến dùng id / text / reading_order / bbox.
- Giữ nguyên duplicate semantics vì nó biểu diễn ambiguity trong graph ứng viên IoU; Task 6 có thể phân loại warning. Giữ nguyên CUDA_VISIBLE_DEVICES vì đây là quyền điều khiển thiết bị của operator.
- Kiểm chứng: pytest toàn server 112 passed; 9/9 file test Node PASS; focused 37 passed; chạy từ thư mục server 19 passed; node --check và git diff --check PASS.
- Trạng thái: Task 4 sẵn sàng để review lại. Task 5 vẫn pending, chưa triển khai tiếp.

## 2026-08-02 — Spec A Task 5: deterministic policy probe (a7c16da, 8ff3bf5, b62d777)

- Đã thêm prompt eval comic-page-eval-v1 với allowlist riêng id / text / reading_order / bbox; không serialize kind, URL hoặc API key. HTTP production vẫn giữ contract id / text và không bị Task 5 thay đổi.
- Đã thêm ba arm batch_control, ordered_microbatch và full_page. Control bắt buộc exact baseline membership; ordered microbatch chỉ mượn dãy batch size trên expected reading order; full page dùng một batch đã sort.
- Runner CLI thủ công dùng đúng một GeminiTranslator và gọi _generate để giữ retry/failover production. Core nhận fake callable nên test không cần GEMINI_API_KEY và không gọi network. Preview latency được parse nhưng từ chối rõ cho tới khi Task 6 có gate chọn full_page.
- Capture giữ fixture SHA, prompt/policy version, baseline, attempt, batch membership, timing, response keyed theo fixture ID và taxonomy success / invalid_response / rate_limited / failed. Không chạy bù attempt lỗi.
- Commit: a7c16da (runner), 8ff3bf5 (giữ taxonomy 429/invalid response), b62d777 (UTF-8 validation và baseline guard trước model).
- Kiểm chứng fresh: focused 29 passed; toàn server 122 passed, 3 warning dependency baseline; CLI help PASS với GEMINI_API_KEY rỗng; diff check, mojibake scan, sensitive-data audit và worktree clean.
- Baseline audit phát hiện flake cũ ở test JS Task 2: scenario hai job dùng một fake error queue chung nhưng hard-code lỗi phải thuộc rate-job; stress fail 2/20 vì job flush trước không deterministic. Đây là test-fixture ordering, không phải regression Task 5, nên chưa sửa trong ba commit này.
- Trạng thái: Task 5 sẵn sàng để người dùng review. Task 6 vẫn pending, chưa bắt đầu.
## 2026-08-02 — Spec A Task 5: đóng human re-review (72c5cbf)

- Đã sửa đủ 3 Important: CLI tạo thư mục cha của `--out` trước khi chạy probe; `GENERATION_TEMPERATURE` là nguồn duy nhất cho cả translator và capture; metadata `{commit, device, model, temperature}` đi qua `run_quality_probe` nên capture hoàn chỉnh được test ở core, không còn vá hậu kỳ trong CLI.
- Đã nhận thêm các Minor có lợi trực tiếp: `calls[].started` giờ tương đối từ đầu probe; response text `None` thành `invalid_response`; test không còn đọc `decode.__defaults__`.
- Giữ nguyên missing-key traceback: đây là lỗi cấu hình runtime trước API call, không phải lỗi cú pháp CLI và không gây mất capture. Flake JS hàng đợi fake toàn cục vẫn tách riêng, không trộn vào Task 5.
- TDD đã quan sát RED cho cả output parent, shared temperature, core metadata, relative start và response `None` trước khi GREEN.
- Kiểm chứng fresh tại `72c5cbf`: focused 52 passed; toàn server 127 passed, 3 warning dependency baseline; chạy từ `server/` 33 passed; CLI help với key rỗng, `git diff --check` và mojibake scan đều PASS; worktree sạch.
- Trạng thái: Task 5 đóng và chờ người dùng review. Task 6 vẫn pending, chưa bắt đầu.
## 2026-08-02 — Spec A Task 6: offline quality gate (1fa3e15, 1546912, 34a591f)

- Đã thêm `validate_capture()` làm trust boundary deterministic: khóa schema/version/hash, exact metadata `{commit, device, model, temperature}`, exact page × arm × 3 attempt theo thứ tự, exact call/batch membership, status/error taxonomy và response IDs chỉ từ các call thành công. JSON bool không được giả làm integer; ID sai kiểu bị từ chối bằng `ValueError` có kiểm soát.
- `term_forms` là annotation thủ công explicit theo `canonical → fixture_block_id → target surface form`; conflict chỉ xét trong cùng response/attempt sau `strip().casefold()`. PT luôn bắt buộc RTL, ba mục context là `not_applicable`; response `None`/non-string được ghi `invalid_response` như đã bổ sung vào spec.
- Đã thêm `evaluate_gate()` hoàn toàn offline với bốn decision `selected`, `blocked`, `no_context_headroom`, `inconclusive`; dùng `statistics.median`, safety gate trước context gate, và tie-break bằng tổng call rồi tổng latency của toàn bộ attempt kể cả attempt lỗi.
- CLI hỗ trợ cả `run ...`, invocation legacy không subcommand, và `evaluate ...`; mode evaluate không import/khởi tạo Gemini và chạy được khi `GEMINI_API_KEY` rỗng. Test Task 5 cũng đã được siết để chứng minh thư mục output tồn tại trước khi core probe bắt đầu.
- Review độc lập vòng đầu phát hiện lỗi đúng hai valid responses, call schema lỏng, PT RTL bypass, tie-break bỏ attempt lỗi và fixture term conflict chưa declarative; toàn bộ đã đóng ở `1546912`. Re-review vòng trust-boundary đóng thêm bool/int alias và ID không phải chuỗi ở `34a591f`; không còn Critical/Important.
- Kiểm chứng fresh tại `34a591f`: focused 75 passed từ repo root và 75 passed từ `server/`; toàn server 169 passed, 3 warning dependency baseline; CLI help legacy/run/evaluate PASS với key rỗng; diff check, mojibake scan và worktree sạch.
- Trạng thái: Task 6 đóng, dừng chờ người dùng review. Chưa chạy Gemini/network/real browser; Task 7 vẫn pending. Flake JS concurrency fixture giữ thành task riêng như đã thống nhất.

## 2026-08-02 — Spec A Task 6: đóng human re-review (d7092a1, b35cc4f)

- Critical `decode_eval_items()` được xác nhận và sửa ở nguồn: item translation `None`, số, chuỗi rỗng hoặc chỉ khoảng trắng đều thành `invalid_response`, không còn bị ép thành `None`/`42` hay làm hỏng toàn capture. Guard `validate_capture` vẫn giữ làm defence-in-depth cho artifact sửa tay.
- Capture metadata giờ có đúng năm field `{captured_at, commit, device, model, temperature}`. `captured_at` phải là ISO-8601 UTC có timezone, CLI sinh một lần trước probe, evaluator echo nguyên giá trị và không tạo timestamp mới.
- Mâu thuẫn worklog Task 7 được đóng bằng contract nhỏ hơn: CLI `evaluate` chỉ sinh artifact deterministic dùng nguyên làm section `manual_review`; Task 7 ráp `telemetry_validation`, raw `policy_probe` và `manual_review`, rồi tái lập/so sánh riêng section evaluator. Không thêm envelope hoặc telemetry input chưa được thiết kế.
- Các Minor đã đóng: `--attempts` chỉ nhận `3`; baseline lỗi có prefix `capture không hợp lệ`; PT→RTL nằm ở manifest/capture boundary thay vì phụ thuộc manual scores; spec ghi rõ tie-break tính mọi attempt/call trên cả ba trang; blocked arm báo đủ các trang lỗi và mọi PT arm có `context_score: not_applicable`.
- TDD RED đã tái hiện 4 translation xấu lọt decoder, timestamp contract hai chiều, attempts sai đi tới I/O, baseline mất taxonomy, PT-LTR lọt manifest, report dừng ở trang đầu và PT arm thiếu context key trước khi GREEN.
- Kiểm chứng fresh: focused 87 passed từ repo root và 87 passed từ `server/`; full server 181 passed, 3 warning dependency baseline. Lần full đầu trong sandbox fail 2 OCR test vì không được đọc model cache/socket; chạy lại ngoài sandbox trên cùng HEAD pass 181/181.
- Đính chính mục Task 6 trước: metadata bốn field và câu “không còn Critical/Important” đã bị review này thay thế; sau `d7092a1` + `b35cc4f` các finding trong review hiện đã đóng.
- Trạng thái: Task 6 dừng chờ người dùng review lại. Task 7 chưa bắt đầu; chưa chạy Gemini/network/real-browser capture.

## 2026-08-02 — Spec A Task 6: re-review PASS và đóng 2 Minor (356d6b9, 1b7308c)

- Re-review tại `b35cc4f` kết luận PASS: Critical, hai Important và 5/5 Minor cũ đã đóng; Task 7 không còn blocker.
- Accept Minor tài liệu: `manual_review` được sửa thành nguyên artifact `evaluate` với `{captured_at, decision, reason, pages, arms}` và đủ bốn decision; rubric từng attempt vẫn ở `captures/2026-08-01-manual-scores.json`.
- Partially accept cách vá Minor evidence: bỏ nhánh skip để arm `inconclusive` vẫn ghi `critical_error`/safety quan sát được, nhưng giữ nguyên ưu tiên trạng thái `inconclusive` và thêm guard cho trang có 0 response hợp lệ để tránh `statistics.median([])`.
- Hai test hồi quy đã RED đúng hai lỗi: mất `critical_error` khỏi `reasons`, và crash ở 0 valid response; sau fix đều GREEN. Focused fresh đạt 89 passed từ repo root và 89 passed từ `server/`.
- Trong env resolver unpinned: 180 passed + 2 detector error do thiếu pkg_resources + 1 OCR failure do PaddleOCR API lệch. Trên venv dự án cùng HEAD 1b7308c: 183 passed, 3 warnings, 0 fail/0 error. Ba lỗi của env unpinned nằm ngoài diff Task 6.
- Commit code/test `356d6b9`; commit spec `1b7308c`; worktree sạch. Task 6 đóng và dừng chờ review; Task 7 chưa bắt đầu.
## 2026-08-03 — Spec A Task 7: real-page baseline + offline quality gate (277f9df)

- Capture thủ công dùng đúng Chrome thật, extension đã cài và popup thật trên fixture server 8000 với production API 8910/CUDA. Môi trường, fixture hash, model và toàn bộ page_metrics đã được lưu trong worklog JSON.
- JA1 cold: 21/21, analysis_cache_hit=false, batch 2+11+8, total page 14163 ms, first overlay 10509 ms; warm cache hit, first overlay 13 ms. JA2 cold: 17/17, batch 2+11+4, total page 12099 ms, first overlay 8954 ms; warm cache hit, first overlay 12 ms.
- PT chỉ là diagnostic vì production_pt_supported=false và dùng recognizer src_lang=es: 7/7, batch 1+1+2+1+2. Translation live PT không tham gia quality score.
- Hai run JA1 trước mẫu cold được chọn không bị giấu: run đầu chỉ dịch 3/21 do hai response Gemini decode/validation lỗi sau HTTP 200; run recovery có analysis cache hit nên không đủ điều kiện cold. Cả hai không được dùng làm baseline.
- Policy probe chạy đúng một lần với 3 page × 3 arm × 3 attempt: 27 attempt, 55 call success, 20 call rate_limited, 16 response hợp lệ. Không chạy bù attempt lỗi; preview probe không chạy vì condition_not_met.
- Rubric chấm đủ 16 response hợp lệ. Evaluator offline kết luận inconclusive vì JA1 batch_control chỉ có 1 response hợp lệ; không policy nào được chọn và không claim cải thiện chất lượng.
- Ba artifact commit: docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json, captures/2026-08-01-policy-probe.json và captures/2026-08-01-manual-scores.json. manual_review tái lập đúng từ capture + scores.
- Kiểm chứng fresh: test_real_page_quality.py 89 passed; 27 attempt/16 score validate; decision tái lập inconclusive; diff check và sensitive-data scan sạch; scratch đã xóa; server tạm đã dừng.
- Task 7 hoàn tất ở commit 277f9df và dừng chờ review. Task 8 chưa bắt đầu.
## 2026-08-03 — Spec A Task 7: human rubric sign-off (7721576)

- Reviewer jaa đã đọc phiếu source → translation và xác nhận toàn bộ 16 rubric row hợp lệ. manual-scores giờ ghi reviewer=jaa cho đúng 16/16 row; điểm, critical_error, term_forms và note không đổi.
- Minor tài liệu đã sửa: điểm từng attempt, note và reviewer nằm ở captures/2026-08-01-manual-scores.json; section manual_review trong worklog giữ nguyên artifact evaluator.
- Evaluator tái lập tuyệt đối cùng kết quả inconclusive vì JA1 batch_control chỉ có một response hợp lệ; không policy nào được chọn.
- Kiểm chứng fresh: test_real_page_quality.py 89 passed; toàn server 183 passed, 3 warning baseline; diff check sạch; scratch human-review đã xóa.
- Commit 7721576. Dừng chờ re-review Task 7; Task 8 chưa bắt đầu.

## 2026-08-03 — Spec A Task 8: regression, audit và handoff

- Nhánh cô lập feat/spec-a-telemetry-quality-gate hiện ở ca7d435 (fix: preserve translation error taxonomy); Task 8 gồm 2eda03d, eef60a1 và fix whole-branch review ca7d435. Chưa merge vào feat/v3.
- work-flow.md đã ghi cách đọc scope_done.page_metrics, duration/elapsed/null, carve-out first_overlay_ms, các lệnh serve/capture/evaluate, quyết định quality hiện tại và cổng chuyển giao Spec B/C.
- Whole-branch review phát hiện false positive: lỗi JSON có chuỗi char 429 có thể bị ghi nhầm rate_limited. ca7d435 giữ code/error_kind có cấu trúc qua translator → /translate-items → extension/probe; rate limit, invalid_response và generation_error không còn suy từ message. Scoped re-review: PASS.
- Fresh automated verification tại ca7d435: pytest server/tests -q = 188 passed, 3 warning dependency; cả 9 file test JS PASS; node --check, CLI help, git diff --check và worktree cleanliness PASS.
- Evidence thủ công đã có từ Task 7: telemetry real Chrome cold/warm đã chạy; detector/OCR transcript và reading order canonical đã được người đọc review; reviewer jaa đã xác nhận đủ 16 rubric rows hợp lệ. Automated PASS không thay thế các evidence này.
- Quality decision vẫn inconclusive vì JA1 batch_control chỉ có 1 response hợp lệ. PT chỉ là diagnostic (production_pt_supported=false, recognizer es), không phải production proof. Spec B policy và Spec C overlay chưa triển khai.
- Dừng tại đây để chờ review Task 8 của người dùng.

### 2026-08-03 — Task 8 review fix (e90552a)

- Accept Important: work-flow.md đã đổi regression evidence từ 183 thành 188 passed để khớp HEAD sau 5 test taxonomy mới.
- Accept Minor: đã ghi contract lỗi máy đọc được của /translate-items: error_code rate_limited/invalid_response/generation_error; chỉ rate_limited dùng HTTP 429, hai loại còn lại dùng 502; consumer không suy taxonomy từ text error.
- Không triển khai ghi chú giả định về subtype ValueError/rate_limited vì chưa có type hoặc caller như vậy.
- Fresh verification: pytest server/tests -q = 188 passed, 3 warning dependency; 9/9 file JS PASS; git diff --check sạch. Chỉ work-flow.md thay đổi trong e90552a.
- Nhánh/worktree vẫn chưa merge; dừng chờ re-review Task 8.

