---
title: "Reading order và full-page translation"
note_type: worklog
work_item: reading-order-full-page-translation
date_start: 2026-08-04
date_end: 2026-08-05
status: done
versions:
  - "[[feat-v3]]"
specs:
  - "[[2026-08-04-reading-order-full-page-translation-design]]"
plans:
  - "[[2026-08-04-reading-order-full-page-translation]]"
artifacts:
  - "[[2026-08-04-reading-order-full-page-translation.json]]"
tags:
  - mangatranslator/worklog
---

# Reading order và full-page translation

> [!summary] Tóm tắt
> **Vấn đề:** Trang đầy đủ thiếu reading direction, Portuguese OCR phù hợp và contract end-to-end nghiêm ngặt.
>
> **Quyết định/fix:** Thêm deterministic reading order, dùng chung Latin OCR, full-page vertical slice và cleanup race.
>
> **Kết quả:** Spec B đóng sau offline checkpoint, runtime review và stale-stage follow-up.

## Liên kết

- Phiên bản: [[feat-v3]]
- Spec: [[2026-08-04-reading-order-full-page-translation-design]]
- Plan: [[2026-08-04-reading-order-full-page-translation]]
- Artifact: [[2026-08-04-reading-order-full-page-translation.json]]

---
## 2026-08-05 — Spec B Tasks 1–4: merge fixture, reading order và direction/cache

- Spec B đã qua design/plan review; triển khai trên `feat/v3` theo checkpoint review từng task. Plan: `docs/superpowers/plans/2026-08-04-reading-order-full-page-translation.md` (`7313536`, amendment `9237454`). Task 5 chưa bắt đầu.
- Task 1 PASS: merge Spec A bằng merge commit `9b1d153df7bccbb8dce34eaa451e47d32ee70bab`, parent Spec A `18bb9f875795ff2d8d80a5516e3b9ee5f1a74ffd`; fixture/control được đưa vào trước comparator và `full_page`.
- Task 2 PASS: baseline cuối `193 passed`, Node `9/9`, evaluator `98 passed`, semantic policy batch count `25`. Race timing telemetry test-only được ổn định ở `0d47b5c`; control worklog ở `c35569a`, giữ `control_baseline_commit=9b1d153...`.
- Task 3 PASS: `04e695e` thêm helper `extension/reading-order.js` và comparator Node gọi đúng helper production. Exact-match: `mangadex_pt` 7/7 (single), `s-manga_ja_1` 21/21 (spread, gutter 554.5), `s-manga_ja_2` 17/17 (spread, gutter 549.5); synthetic RTL/LTR, panel-gap, fallback, tall-bridge và mutation threshold đều xanh.
- Task 3 follow-up PASS: `c806f14` đóng arrival-order ambiguity bằng hai lớp — server loại exact normalized bbox trùng sau clamp/trước OCR, còn `orderPage()` reject duplicate full bbox; bump dedupe version thành `iou-0.5-area-clamp-exact-v3`. Gate: Python `25 passed`, ba Node gate PASS.
- Task 4 PASS: `1ee4b07` thêm UI `readingDirection` RTL/LTR (mặc định hiển thị RTL nhưng không persist lúc startup), snapshot theo request, và normalize đúng ba boundary `acceptScope`, `offlineLedger`, `prewarmJob`. `layout_order=reading-order-v1`; direction/layout không vào analysis/OCR key nhưng vào overlay/translation key; rollout purge page cache một lần, ledger sống sót.
- Gate Task 4: năm Node gate PASS, Python `17 passed, 1 warning`, `git diff --check` PASS. Không chạy `server/tests/test_ocr.py`.
- Deferred Minor không chặn: popup test mock `||=` có thể che việc xóa HTML ID; fake translation FIFO có race 429 trong harness, không phải regression production.
- Checkpoint hiện tại: HEAD `1ee4b0708436fad0209e29dc2284c40999286281`; Tasks 1–4 hoàn tất và đã review. Bước kế tiếp là Task 5 (PT/shared Latin engine và version-shape), chưa triển khai.

## 2026-08-05 — Đối chiếu plan ban đầu và bug trong Tasks 1–4

### Amendment của plan trước khi triển khai (`7313536` → `9237454`)

- **Task 3 — comparator fixture:** bản plan đầu duyệt toàn bộ `manifest.fixtures`, trong khi manifest có 3 `source_page` và 3 `failure_reference` không có `regions`, dimensions hay reading metadata. Cách cũ sẽ ném `TypeError` hoặc so với dữ liệu `undefined`. Amendment lọc `role === source_page` và assert đúng 3 trang trước khi exact-match.
- **Task 4 — default direction:** siết rõ `rtl` lúc startup chỉ là default hiển thị/state; không được tự ghi `readingDirection` vào storage. Test thêm `first.writes == []` để giữ nguyên nguyên tắc “chỉ persist field người dùng đổi”.
- **Task 4 — version-shape gate:** ghi rõ assertion shape cấp cao vốn đã PASS trước Task 4; red signal thật là thiếu `layout_order`. Việc kiểm sâu `recognizers` chỉ bắt đầu có ý nghĩa ở Task 5.
- **Task 4 — migration cache có chủ ý:** đổi context từ `{blockId, srcText}` sang `{reading_order, block_id, src_text}` tạo namespace hot-translation cache mới; bump `layout_order` cũng purge coarse page cache một lần. Đây là migration cost đã duyệt, không phải regression.

### Phát hiện khi thực thi và cách xử lý

#### Task 1 — merge Spec A

- **Lệch so với plan:** không có. Merge nguyên branch Spec A bằng merge commit hai parent `9b1d153`, đúng thứ tự fixture/control trước comparator và `full_page`.
- **Bug:** không phát hiện conflict hay regression; các dirty/untracked file ngoài phạm vi được giữ nguyên.

#### Task 2 — baseline/control

- **Bug:** `progressive-integration.test.js` thỉnh thoảng đọc `cancel_latency_ms.p50` khi metric replacement cancellation chưa được ghi. Race xảy ra vì `acceptScope()` có `await`, producer chạy ở task queue khác, và request cũ có thể đã bị `scopeDone` xóa khỏi `requests` trước lúc `releaseRequest(oldRequestId)` chạy; tái hiện 17/50 vòng.
- **Thay đổi so với plan:** thêm Task 2a test-only, commit `0d47b5c`; production code không đổi.
- **Cách xử lý:** nâng `eventually()` để `await` được async predicate và chờ `replacement.summary().cancel_latency_ms.p50` hữu hạn trước khi cho held pipeline chạy tiếp. Sau đó mới đóng control worklog ở `c35569a`.
- **Kết quả:** baseline ổn định: Python `193 passed`, Node `9/9`, evaluator `98 passed`, policy batch count `25`.

#### Task 3 — reading order

- **Bug contract/thuật toán:** hai block có bbox giống hệt làm mọi geometry sort key hòa nhau; `Array.sort` stable sẽ vô tình giữ arrival order, trái invariant “không dùng arrival/vendor/block ID”. Đây không chỉ là fake input: hai detector region khác nhau có thể trở thành cùng bbox sau clamp vào crop boundary; dedupe IoU trước clamp không bảo vệ được ca này, dẫn tới OCR hai lần và hai block cùng tọa độ.
- **Thay đổi so với plan:** ngoài helper/comparator extension ở `04e695e`, thêm follow-up `c806f14` chạm `server/pipeline.py`, `server/tests/test_pipeline.py`, `server/config.py` và guard/test phía extension — các file server này chưa nằm trong map Task 3 ban đầu.
- **Cách xử lý hai lớp:** server dedupe exact normalized bbox ngay sau clamp và trước tạo crop/OCR; `orderPage()` reject duplicate full bbox để chặn cache cũ, fake caller hoặc regression upstream. Test phủ cả hai hoán vị input và ca hai bbox cùng x/y nhưng khác size vẫn hợp lệ.
- **Cache migration:** bump dedupe version từ `iou-0.5-area-bbox-v2` lên `iou-0.5-area-clamp-exact-v3`, tránh tái dùng artifact cũ có duplicate geometry.
- **Kết quả:** Python focused `25 passed`; comparator exact-match cả 3 fixture và toàn bộ synthetic/mutation gate PASS.

#### Task 4 — direction/version/cache

- **Lệch so với final plan:** không có thay đổi production ngoài phạm vi đã duyệt; implementation `1ee4b07` đi đúng ba normalization boundary (`acceptScope`, `offlineLedger`, `prewarmJob`) và đúng phân tầng key.
- **Bug mới:** không phát hiện production bug. Các RED ban đầu (control direction rỗng, descriptor thiếu field, thiếu `layout_order`) là TDD signal dự kiến, không phải regression.
- **Kết quả:** năm Node gate PASS, Python `17 passed, 1 warning`, `git diff --check` PASS.

### Minor còn mở, không được ghi nhầm là đã sửa

- Popup harness dùng mock `||=` nên có thể che regression xóa `readingDirection` hoặc `currentLanguages` khỏi HTML. Reviewer xếp Minor; chưa sửa trong Tasks 1–4.
- Fake translation FIFO có race 429 trong harness. Scoped review xác nhận không phải regression production; không thêm workaround vào production, để lại cho đợt cleanup test harness.
- Không chạy `server/tests/test_ocr.py` trong bất kỳ gate nào vì file này load model thật và ảnh fixture; finding tĩnh liên quan file được xác nhận bằng đọc source.

- Đính chính ký hiệu ở amendment Task 3: comparator lọc trường role có giá trị literal source_page; đây không phải tên biến JavaScript.

## 2026-08-05 — Spec B review fix Tasks 3–4

- Review sau checkpoint Tasks 1–4: Tasks 1, 2 và 4 giữ nguyên PASS; Task 3 cần bổ sung hồ sơ clamp và regression test. Không revert code.
- **Finding Important về `c806f14`:** commit này thực tế gồm hai thay đổi độc lập: (1) clamp detector bbox thành giao thật với work image, nên bbox tràn mép có đúng width/height phần còn nằm trong ảnh và region hoàn toàn ngoài ảnh bị loại; (2) dedupe exact normalized bbox sau clamp trước crop/OCR. Version `iou-0.5-area-clamp-exact-v3` bao phủ cả hai về cache identity.
- Commit `f84bc3b` thêm regression test detector bbox `(-40, 10, 20, 20)` phải cho `analysis.regions` rỗng. Mutation về clamp semantics cũ cho RED đúng nguyên nhân: sinh region ma `(0, 10, 20, 20)`; khôi phục code hiện tại cho GREEN.
- Task 3 cũng khóa hai hành vi đã duyệt bằng expected viết tay: connected-components được phép chain khi bridge đạt ngưỡng `0.5` với hai hàng; RTL/LTR sort trong band theo `bbox[0]` (cạnh trái), kể cả bbox lồng/lệch. Không đổi thuật toán.
- `stable_block_id` vẫn giữ tham số ordinal để tránh API churn ngoài scope; pipeline truyền `0` có chủ ý vì exact normalized bbox giờ unique.
- Commit `a7dab1a` sửa hai Minor Task 4: row cache có `reading_direction` sai được cô lập/xóa theo từng job thay vì làm `ready` reject hoặc nhân đôi job hợp lệ; popup gửi direction explicit cùng `srcLang`/`dstLang`, content normalize và snapshot direction của chính action nên click ngay sau đổi hướng không phụ thuộc `storage.onChanged`.
- Commit `73c3c73` cập nhật design spec với clamp semantics, cache version và các quyết định Task 3/4 trên.
- Verification của implementer: toàn bộ 10 Node test scripts PASS; `server/tests/test_pipeline.py` + `test_artifacts.py` = `28 passed`; syntax và `git diff --check` PASS. Không chạy `server/tests/test_ocr.py`.
- Independent reviewer Terra medium: **PASS** cho cả spec compliance và task quality; không còn Critical/Important/Minor chặn Task 5.
- Deferred sang Task 6: normalize field cấp scope trước job loop và map lỗi `orderPage()` vào taxonomy job/producer thay vì unhandled rejection. Fake translation FIFO race vẫn là harness flake đã biết.
- Checkpoint mới: HEAD `73c3c73`; Task 5 chưa bắt đầu.


## 2026-08-05 — Spec B Task 5: Portuguese dùng chung Latin OCR

- Commit `fec60ac64069380a7a163b20f4df976d167e2cbb` thêm `pt` vào public language contract, popup và translator; `config.LANGS` là nguồn production duy nhất.
- ES/PT vẫn là hai alias và hai OCR cache identity riêng, nhưng dùng chung một instance `PaddleLatinEngine` cache theo class. Paddle được pin `lang=es`, `ocr_version=PP-OCRv6`; không tạo engine `lang=pt` thứ hai.
- Recognizer versions: JA `manga-ocr-v1`; ES/PT cùng `paddleocr-latin-ppocrv6-v1`. Acceptance `/health` giữ shape riêng và có recognizer PT.
- Verification: server `199 passed, 2 warnings` với `server/tests/test_ocr.py` bị loại tuyệt đối; full Node gate `2×10/10`; fake probe xác nhận shared instance, một init và exact Paddle kwargs; `git diff --check` sạch.
- `server/tests/test_ocr.py` chỉ đổi expectation tĩnh `['ja', 'es', 'pt']`, không chạy model/fixture test này.
- External review: **PASS**, một Minor không chặn deferred sang Task 6 — `server/acceptance_app.py` quảng cáo PT nhưng `/ocr` và `/translate-items` còn allowlist `{ja, es}` tại dòng hiện hành 350 và 406. Task 6 phải thêm `pt` vào đúng hai literal và giữ gate từ chối `fr`.
- Dirty user files và deletion `Welcome.md` được giữ nguyên, không stage. Chưa push; Task 6 chưa bắt đầu.

## 2026-08-05 — Spec B Task 6: strict contract và full-page vertical slice

- Commit `a37fbdec0dd2dd2d717a9fd754a07b98a475540b` thay microbatch bằng một request dịch toàn trang sau `image_done`; policy/prompt được bump nguyên tử thành `full-page-v1` và `comic-page-items-v2`.
- `server/contracts.py` là nguồn Pydantic contract dùng chung cho production/acceptance: exact fields, bbox 4 số không âm, dimensions dương, direction bắt buộc, ID unique và `reading_order` dense theo array. Lỗi `/translate-items` dùng `error_code=invalid_request`; route khác giữ FastAPI `detail`.
- Background tạo ordered shallow-copy bằng `MangaReadingOrder.orderPage()`, dùng decoded `image_w/image_h`, gửi tối đa một request/producer. Zero/all-hot không request; partial-hot gửi lại toàn page; response ID được validate nguyên tử trước cache/render; stale success chỉ warm cache.
- Đã xóa toàn bộ queue 3/8, timer 250/500 ms, pending/attempted IDs, numeric batch counter, translation chain và phase `microbatch`. Năm scenario được duyệt đã rewrite sang semantics full-page.
- Deferred review đã đóng: invalid direction phát đúng một `scope_error`; duplicate geometry và invalid dimensions đi qua `failProducer/completeJob` với error code máy đọc được; acceptance `/ocr-stream` và `/translate-items` nhận PT, vẫn từ chối `fr`.
- Fresh controller verification: server `211 passed, 2 warnings` với `server/tests/test_ocr.py` bị loại tuyệt đối; Node `2×10/10`; deletion/static tripwire PASS; control baseline không đổi; staging rỗng.
- Independent reviewer Terra medium: **Spec Compliance PASS**, **Task Quality Approved**, không có Critical/Important/Minor. Task 7 full offline/quality checkpoint chưa bắt đầu; chưa gọi vertical slice là đóng.

### 2026-08-05 — External review Task 6

- Verdict giữ **PASS**; không có Critical/Important. Hai Minor dưới đây chưa sửa và phải còn trong final whole-branch triage.
- Minor 1: `replayPage()` chỉ replay translation khi `cacheHit`. Trong cửa sổ producer đã set `page.state=complete` nhưng chưa persist, consumer mới có thể gắn vào producer, nhận `image_done` thành công nhưng không nhận translation event. Correction đề xuất: replay khi `cacheHit || page.state === complete`; thêm regression test giữ completion persistence. Partial-hot vẫn không replay.
- Minor 2: scenario `partial page replays complete blocks and requests only missing IDs` đã đổi assertion sang full-page nhưng chưa đổi tên. Rename thành `partial page requests the complete ordered page without replaying cached blocks`.
- Không sửa production/test và không tạo commit ở checkpoint review này. Task 7 chưa bắt đầu.

## 2026-08-05 — Spec B Task 7: full offline checkpoint

- Commit checkpoint `18aa2f8ef435d91b92494495119583e9cfda05a2` chỉ cập nhật worklog Spec B; implementation được khóa tại `a37fbdec0dd2dd2d717a9fd754a07b98a475540b`.
- Full server gate: `211 passed, 2 warnings`; lệnh có explicit `--ignore=server/tests/test_ocr.py`. File test OCR model thật không được chạy.
- Full Node suite tuần tự: `10/10`; comparator reading-order exact-match đủ 3 source fixture và synthetic gates. Evaluator offline: `98 passed`; semantic policy batch count: `25`.
- Frozen control tại `9b1d153...` không đổi; versions chốt `reading-order-v1`, ES/PT `paddleocr-latin-ppocrv6-v1`, `comic-page-items-v2`, `full-page-v1`; obsolete microbatch match = 0.
- Independent reviewer Terra medium: PASS, không có Critical/Important/Minor cho Task 7. Đây chỉ là offline vertical-slice checkpoint; chưa tuyên bố runtime telemetry hoặc live quality hoàn tất.
- Hai Minor Task 6 vẫn deferred: race replay cho consumer gắn vào producer đã complete trước persist, và tên scenario partial-page đã lỗi thời. Không sửa lén trong Task 7.
- Không push; dirty files của user và deletion `Welcome.md` giữ nguyên. Dừng trước Task 8 để chờ review.


## 2026-08-05 — Spec B post-checkpoint fix `8a4b08d`

- Commit `8a4b08d3d43c9d8510bf4bef6ed8e24f1ff59679` đóng hai Minor Task 6: consumer đến sau khi producer đã `complete` nhưng còn chờ persist được replay translation; scenario partial-hot được đổi tên đúng semantics full-page.
- Worklog Task 7 vẫn pin checkpoint implementation tại `a37fbdec0dd2dd2d717a9fd754a07b98a475540b`; `8a4b08d` là production fix phát sinh sau checkpoint, không viết lại lịch sử evidence.
- Fresh verification tại HEAD `8a4b08d`: server `211 passed, 2 warnings` với explicit `--ignore=server/tests/test_ocr.py`; Node `10/10`. Không chạy model/fixture test `server/tests/test_ocr.py`.
- Follow-up mở cho final whole-branch triage: consumer có thể gắn vào terminal producer `partial` sau vòng `completeJob()` nhưng trước `producers.delete()`, rồi không nhận `image_done`/`scope_done`. Correction đề xuất là xóa producer khỏi map trước khi await `removeProducerJobs()` trong cả `finishProducer()` và `failProducer()`; chưa sửa production trong lượt cập nhật hồ sơ này.


## 2026-08-05 — Spec B Task 8 runtime + final whole-branch review

- Runtime được capture trên `feat/v3` từ build `bec403b`; worklog telemetry: `b46b716`, amendment evidence: `78bcf2f`.
- JA1 RTL network: 21 block, `ocr_done=38 ms`, `first_overlay=23782 ms`, đúng một batch `full_page`.
- JA1 translation-memory hot: 21 block, `first_overlay=26 ms`, `translation_batches=[]`, `translation_calls=0`; đây không phải page-artifact cache hit.
- JA2 RTL post-reset: 17 block, `ocr_done=35 ms`, `first_overlay=3314 ms`, đúng một batch `full_page`. Popup prewarm được quan sát nên không gọi đây là model-cold.
- LTR manual: popup/content/background/request đều mang `reading_direction=ltr`, kích thước 1105×868, 17 item.
- PT public: OCR/request mang `src_lang=pt`, RTL, kích thước 500×782, 7 item; `ocr_done=5095 ms`, `first_overlay=48725 ms`.
- Shared Latin observation có giới hạn: cùng PID server, Paddle creation markers `0 → 4` khi PT và vẫn `4` sau ES prewarm; chỉ kết luận ES không tạo sequence thứ hai trong cùng process, không suy marker thành proof unique instance.
- Trade-off được xác nhận: mọi network `full_page` chỉ có translation/overlay sau `ocr_done`; đây là đánh đổi context toàn trang, không phải claim tối ưu latency.

### Final review fix

- Final whole-branch review phát hiện race merge-blocking: late consumer có thể gắn vào terminal `partial` producer trong cửa sổ awaited cleanup và mất `image_done`/`scope_done`.
- Commit `3fc910d` xóa producer khỏi map trước `await removeProducerJobs()` ở cả `finishProducer()` và `failProducer()`; regression giữ đúng cleanup window bao phủ `partial` và `failed`.
- Popup harness Minor cũng đóng: bỏ fallback mock cho `readingDirection`/`currentLanguages`.
- Regression RED: timeout chờ `scope_done`; mutation đưa delete trở lại sau await tái tạo lỗi. GREEN: focused background/popup và full Node suite `10/10`.
- Commit `9353618` đóng follow-up trong worklog và pin đúng SHA production `3fc910d`; net diff không còn artifact `.superpowers/sdd`.

### Trạng thái checkpoint

- HEAD hiện tại: `935361855cc34d10ca0abd6d8e3becf9d0fa2f7a`.
- Frozen control Spec A và privacy scan sạch; không chạy live-quality hay `server/tests/test_ocr.py`.
- Task 8 review và final-fix scoped re-review đều PASS; không còn finding Critical/Important mở.
- Chưa gọi Spec B hoàn tất cho tới khi người dùng duyệt checkpoint cuối. Việc xóa `Welcome.md` vẫn được giữ nguyên và không nằm trong commit Spec B.

## 2026-08-05 — Spec B post-final review stale-stage follow-up

- Review sau `9353618` phát hiện cửa sổ hẹp: producer đã bị xóa khỏi map nhưng OCR/analysis stage cũ chưa release trong lúc `removeProducerJobs()` đang await; request muộn sau lỗi trước `ocr_done` có thể bám vào promise đã reject và fail mà không retry.
- Commit `1855a2700d35362619208579cca185aab14782ff` đổi cả `finishProducer()` và `failProducer()` sang thứ tự đồng bộ `releaseProducerStages()` → `producers.delete()` → `await removeProducerJobs()`.
- Regression `pre-ocr-failed`: thứ tự cũ RED `{translated:0, failed:1}`; bản sửa GREEN `{translated:1, failed:0}`, tổng call `source=2`, `ocr=1`, `translate=1`.
- Focused `background-progressive.test.js` và full Node suite `10/10` PASS; Terra medium re-review không còn finding Critical/Important/Minor. `server/tests/test_ocr.py` không chạy.
- Worklog record commit: `32718b2`; Spec B vẫn chờ người dùng duyệt checkpoint cuối.

## 2026-08-05 — Spec B closed

- Người dùng duyệt checkpoint cuối: Spec B `reading-order-full-page-translation` hoàn tất, không còn finding mở; pull request đã được người dùng tạo và nhánh kế tiếp là `feat/v4`.
- Final implementation: `1855a2700d35362619208579cca185aab14782ff`; pre-closure worklog: `32718b2c1291fd7a9db3ee331b1207acb639aac5`; verification HEAD trên `feat/v4`: `e0e948e58c3e00513e28f15fdb139eac5415dbe1`.
- Fresh close gate: Python `211 passed, 2 warnings`; Node `10/10`; `server/tests/test_ocr.py` bị loại và không chạy.
- Chấp nhận trade-off: Spec B ưu tiên reading order tất định, chất lượng context toàn trang và một translation request mỗi page; cold first-overlay latency là debt riêng, không phải claim tối ưu latency.
- Các dòng HEAD/checkpoint cũ phía trên là snapshot lịch sử; mục này là trạng thái đóng hiện hành. Bước tiếp theo: brainstorm Spec C về overlay an toàn.

