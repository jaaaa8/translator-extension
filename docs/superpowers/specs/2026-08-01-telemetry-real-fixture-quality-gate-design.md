# Thiết kế Spec A: telemetry, fixture trang thật và quality gate

**Ngày:** 2026-08-01

**Nhánh:** `feat/v3`

**Trạng thái:** thiết kế đã được người dùng duyệt ngày 2026-08-01; chờ người dùng review tài liệu đã ghi

## 1. Kết quả cần đạt

Spec A tạo một nền đo đủ tin cậy để Spec B quyết định chính sách dịch theo dữ liệu thay vì suy luận từ code:

1. Thời gian từng stage của một trang thật được ghi đúng, gồm cả `analysis_ms`, thời điểm OCR hoàn tất và từng call Gemini.
2. Sáu ảnh người dùng cung cấp được đưa ra khỏi `server/vendor/` đang bị Git ignore và lưu đúng một bản trong fixture được track.
3. Ba trang nguồn có ground truth về thứ tự đọc, transcript OCR cố định và metadata ngôn ngữ/bố cục.
4. Chất lượng dịch được chấm tay theo rubric cố định; CI chỉ kiểm các guardrail có tính xác định và không gọi Gemini.
5. Một batch control và ba candidate policy `ordered_microbatch`, `full_page`, `preview_then_full` có kết quả, latency, số call và lỗi được lưu thành worklog để làm gate cho Spec B.

Spec A không chọn policy bằng cảm tính. Chất lượng là tiêu chí chính; latency và số call chỉ phá hòa giữa các policy có chất lượng đạt yêu cầu.

## 2. Bằng chứng hiện trạng

Các điểm sau đã được đối chiếu với code hiện tại và fixture thật:

- `server/main.py` phát `analysis_ready` nhưng không gửi `analysis_ms`; `extension/background.js` vẫn đọc trường này nên metric hiện luôn về `0`.
- Vendor `comic_text_detector` đã gọi `sort_textblk_list()` trước khi trả `blk_list`. Thuật toán lật phải sang trái khi đa số block có nhãn `ja`, và có nhánh riêng cho ảnh ngang hai trang.
- `_dedupe_regions()` cần sort bản sao theo diện tích để greedy dedupe giữ box lớn hơn. Sau đó hàm đang trả luôn thứ tự diện tích; `Pipeline.analyze()` lại sort diện tích lần thứ hai. Hai bước này phá thứ tự vendor.
- Hai fixture Nhật là spread ngang: `s-manga_ja_1.png` có 21 region, 20 region dọc; `s-manga_ja_2.png` có 17 region, tất cả dọc. Thứ tự vendor quan sát được đi nửa phải trước rồi nửa trái, hợp lý hơn thứ tự diện tích nhưng chưa được coi là ground truth cho tới khi manifest được người đọc xác nhận.
- Fixture mang tên `mangadex_es.png` chứa tiếng Bồ Đào Nha. Vì các block không đạt đa số nhãn `ja`, vendor không lật phải sang trái dù bố cục trang vẫn là manga. `src_lang` và `reading_direction` vì thế phải là hai trường độc lập.
- `finishProducer()` ghi trang thiếu bản dịch thành `partial`, trong khi `page-cache.js` chỉ tính `state === "failed"` vào bộ đếm `Lỗi:`.
- `attemptedTranslationIds` sống trong một producer; `trans_text` nằm trong page artifact. Cả hai guard hiện ngăn block preview được đưa lại vào final full-page call nếu tái sử dụng đường queue hiện tại.
- Mask bị bỏ trong `Detector.detect()` là text mask dùng cho inpainting, không phải balloon mask. Nó không tự giải quyết vùng layout của chữ dịch.
- Cấu hình đang chạy dùng `gemini-flash-lite-latest`. Tên model, prompt version và policy version phải có trong mọi bản ghi benchmark.

## 3. Ranh giới Spec A

### Trong phạm vi

- Bổ sung telemetry và test contract cho telemetry.
- Tạo một bộ fixture dùng chung, không nhân đôi binary giữa server và extension.
- Tạo manifest cho trang nguồn và ảnh tham chiếu lỗi.
- Ghi expected reading order thủ công cho ba trang nguồn.
- Đóng băng OCR transcript để phép thử policy không bị nhiễu bởi OCR thay đổi.
- Tạo runner thủ công để gọi Gemini và capture kết quả policy; runner không chạy trong CI.
- Tạo evaluator offline dùng kết quả đã capture, rubric thủ công và guardrail tự động.
- Lưu baseline/worklog có version, môi trường, kết quả thô và điểm review.
- Sửa chuỗi mojibake tại `server/main.py:160`; đây là sửa dữ liệu lỗi cục bộ, không tách thành feature.

### Ngoài phạm vi

- Không đổi thứ tự production trong `Pipeline`; việc đó thuộc Spec B.
- Không đổi policy microbatch production và không nới guard translation production.
- Không thêm hỗ trợ `pt` vào popup/OCR registry/API production; việc đó thuộc Spec B. Policy runner của Spec A dùng `source_name: "Portuguese"` từ manifest để không nói sai ngôn ngữ khi probe Gemini.
- Không đổi model Gemini mặc định.
- Không sửa overlay, mask, inpainting, fit text hoặc trạng thái `partial`; việc đó thuộc Spec C.
- Không gọi Gemini trong CI và không dùng LLM-as-judge.
- Không xây panel detector, NER tổng quát, cơ sở dữ liệu benchmark hay dashboard.

## 4. Tổ chức fixture

Một nguồn canonical duy nhất:

```text
server/tests/fixtures/real_pages/
  manifest.json
  mangadex_pt.png
  s-manga_ja_1.png
  s-manga_ja_2.png
  references/
    mangadex_pt_overlay_partial_and_crop.png
    s-manga_ja_overlay_1.png
    s-manga_ja_overlay_2.png
```

Mapping khi implementation:

| Nguồn đang bị ignore | Đích được track | Vai trò |
|---|---|---|
| `server/vendor/comic_text_detector/data/examples/mangadex_es.png` | `real_pages/mangadex_pt.png` | Trang nguồn Portuguese, bố cục manga RTL |
| `server/vendor/comic_text_detector/data/examples/s-manga_ja_1.png` | `real_pages/s-manga_ja_1.png` | Trang nguồn Nhật, spread RTL |
| `server/vendor/comic_text_detector/data/examples/s-manga_ja_2.png` | `real_pages/s-manga_ja_2.png` | Trang nguồn Nhật, spread RTL |
| `server/vendor/comic_text_detector/data/examples/mangadex_es_overlay_and_missing_bubble_bug.png` | `real_pages/references/mangadex_pt_overlay_partial_and_crop.png` | Ảnh tham chiếu lỗi partial/crop trắng |
| `server/vendor/comic_text_detector/data/examples/s-manga_ja_overlay_1.png` | `real_pages/references/s-manga_ja_overlay_1.png` | Ảnh tham chiếu lỗi layout Nhật |
| `server/vendor/comic_text_detector/data/examples/s-manga_ja_overlay_2.png` | `real_pages/references/s-manga_ja_overlay_2.png` | Ảnh tham chiếu lỗi layout Nhật |

Không dùng `git add -f` cho file trong vendor. Sau khi copy, test và tài liệu chỉ tham chiếu đường canonical mới.

### 4.1 Manifest trang nguồn

Mỗi trang nguồn có:

```json
{
  "id": "mangadex_pt",
  "role": "source_page",
  "image": "mangadex_pt.png",
  "sha256": "sha256-của-file-ảnh",
  "src_lang": "pt",
  "source_name": "Portuguese",
  "reading_direction": "rtl",
  "page_kind": "single",
  "width": 500,
  "height": 782,
  "regions": [],
  "term_groups": []
}
```

Hai ảnh Nhật dùng `page_kind: "spread"`. `reading_direction` mô tả bố cục trang, không được suy ra từ `src_lang`.

Mỗi phần tử `regions` dùng ID fixture độc lập với runtime `block_id`:

```json
{
  "fixture_block_id": "b01",
  "bbox": [10, 20, 30, 40],
  "reading_order": 0,
  "src_text": "transcript OCR đã review",
  "required": true
}
```

Expected order được người đọc xác nhận theo panel và chiều đọc manga. Với spread Nhật, toàn bộ nửa phải đi trước nửa trái. Với trang Portuguese, chiều đọc vẫn là RTL dù ngôn ngữ là Latin.

Region detector được ghép với anchor manifest bằng IoU lớn hơn `0.5`. Mỗi required anchor phải ghép đúng một region, một region không được ghép hai anchor. Region mới hoặc mất region phải được báo trong kết quả diagnostic, không tự sửa manifest.

`term_groups` chỉ chứa thuật ngữ/tên riêng thực sự lặp trong trang và các surface form được chấp nhận. Spec A không thêm NER tự động.

### 4.2 Ảnh tham chiếu lỗi

Ba ảnh overlay chỉ có metadata:

- `role: "failure_reference"`;
- liên kết tới `source_page` tương ứng;
- danh sách nhãn lỗi nhìn thấy, ví dụ `partial_translation`, `white_bbox_exposes_source`, `text_clipped`, `fragmented_blocks`.

Chúng không được đưa vào điểm chất lượng Gemini. Spec C sẽ dùng chúng để xây visual acceptance.

## 5. Contract telemetry

Mọi thời điểm phía extension tính tương đối từ lúc producer được accepted. Mọi duration dùng millisecond nguyên, không âm.

### 5.1 Analysis và OCR

Event `analysis_ready` bổ sung:

```json
{
  "analysis_ms": 123,
  "analysis_cache_hit": false
}
```

- `analysis_ms` là thời gian request hiện tại thực sự chờ analysis. Cache hit trả `0` và `analysis_cache_hit: true`.
- `ocr_done_ms` được background ghi khi nhận server `image_done` của OCR.
- `recognized` và `failed` của OCR được giữ trong trace trang.

Metric trang gồm ít nhất:

- `fetch_ms`;
- `analysis_ms`;
- `first_ocr_ms`;
- `ocr_done_ms`;
- `first_translation_ms`;
- `final_translation_ms`;
- `first_overlay_ms`;
- `total_ms`.

`analysis_ms` là duration stage; các trường có hậu tố `_done_ms`/`first_*_ms` là elapsed time từ producer accepted. Hai loại không được trộn trong báo cáo.

### 5.2 Trace từng call Gemini

Mỗi call có một record không chứa source URL đầy đủ hoặc API key:

```json
{
  "batch_id": 1,
  "phase": "microbatch",
  "block_ids": ["block-id-1"],
  "block_count": 3,
  "started_ms": 900,
  "duration_ms": 480,
  "status": "success",
  "cache_hit": false,
  "error_code": null
}
```

`phase` chỉ nhận `microbatch`, `preview` hoặc `final`. `status` nhận `success`, `failed`, `rate_limited` hoặc `invalid_response`. Text OCR và text dịch chỉ nằm trong fixture capture có chủ đích, không nằm trong telemetry runtime chung.

Trace phải cho biết chính xác batch nào tạo trang `partial`. `scope_done` tiếp tục trả tổng số block thất bại; Spec A chưa thay đổi cách popup hiển thị chúng.

## 6. Policy probe dùng transcript cố định

Runner là lệnh thủ công, dùng Python stdlib và dependency Gemini đã cài; không thêm framework. Nó đọc manifest, dùng production model cùng một prompt evaluation cố định cho mọi arm và ghi JSON kết quả.

Prompt evaluation `comic-page-eval-v1` chỉ thêm ngữ cảnh tối thiểu đã duyệt:

- đây là các block hội thoại từ cùng một ảnh/trang manga hoặc comic;
- item được cung cấp kèm `reading_order`, `bbox` và kích thước ảnh;
- giữ nhất quán tên riêng, đại từ và mức lịch sự trong phạm vi trang;
- dùng văn nói tự nhiên, súc tích;
- trả mỗi exact ID đúng một lần.

Prompt không suy đoán nhân vật, không dùng memory nhiều trang và không thêm glossary tự động. Mọi arm dùng cùng prompt này để policy probe không trộn thay đổi prompt với thay đổi ordering/batching.

Runner tạo một control và ba candidate. Mọi arm đều dùng `source_name` đúng từ manifest; vì vậy fixture Portuguese không bị nhiễu bởi lỗi production đang gọi nó là Spanish. Tất cả candidate dùng cùng expected order để tách tác động của ordering khỏi tác động của batch policy:

1. `batch_control`: replay exact block order và batch membership của trace baseline hợp lệ, nhưng dùng prompt evaluation và tên ngôn ngữ đúng từ manifest. Đây là control cho ordering/batching hiện tại; nó không được gọi là production proof.
2. `ordered_microbatch`: lấy danh sách đã xếp theo expected `reading_order`, rồi chia theo đúng dãy batch size của `batch_control`. So sánh control với candidate này đo riêng tác động của ordering.
3. `full_page`: gửi toàn bộ block một lần theo expected `reading_order`.
4. `preview_then_full`: gửi batch đầu của `ordered_microbatch` làm preview, sau đó gửi lại toàn bộ block theo expected `reading_order`.

`batch_control` lấy batch membership từ cold trace đầu tiên có OCR hoàn tất và đủ event thứ tự. Với Portuguese, implementation được phép chạy ảnh qua recognizer Latin hiện có bằng `src_lang=es` chỉ để capture OCR arrival/batch scheduling; text dịch của run này bị loại khỏi quality score. Đây không phải bằng chứng production hỗ trợ Portuguese. Nếu translation call của trace thất bại, membership vẫn hợp lệ khi trace đã ghi đủ `batch_id`, `block_ids` và thời điểm flush.

Kết quả final của `preview_then_full` có cùng input/prompt contract với `full_page`; vì vậy policy này kế thừa điểm semantic của `full_page`. Ba paired run của `preview_then_full` chỉ dùng để đo TTFT, final latency, số call, rate-limit/invalid response và chi phí thay thế overlay. Final response vẫn được lưu để audit exact ID, nhưng không được quảng bá thành một thuật toán chất lượng khác chỉ vì sampling của Gemini cho câu chữ khác.

Mỗi cặp `source_page × arm` chạy đúng ba attempt với cùng model, prompt và transcript. Rubric đầy đủ áp dụng cho `batch_control`, `ordered_microbatch` và `full_page`; `preview_then_full` kế thừa rubric của `full_page`. Runner giữ retry/failover giống production, nhưng không chạy thêm attempt để che lỗi. Nếu một arm có dưới hai response hợp lệ trên một trang, kết quả arm là `inconclusive`; candidate tương ứng không được chọn.

Mỗi capture lưu:

- commit và SHA-256 fixture;
- thời gian, OS, device;
- model, prompt version, policy version, temperature;
- thứ tự block và batch membership;
- latency từng call;
- response theo exact ID;
- lỗi/rate-limit;
- không lưu API key.

Đối với fixture Portuguese, runner dùng `source_name` từ manifest để prompt nói `Portuguese`. Đây là probe benchmark, không tuyên bố production đã hỗ trợ `src_lang=pt`.

## 7. Chấm chất lượng

### 7.1 Rubric thủ công là gate chính

Mỗi response hợp lệ được người đọc chấm `0`, `1` hoặc `2` cho sáu mục:

| Mục | 0 | 1 | 2 |
|---|---|---|---|
| Đúng nghĩa | sai/bịa/bỏ ý quan trọng | còn lỗi nhỏ | đúng và đủ |
| Tên riêng/thuật ngữ | sai hoặc không nhất quán | hiểu được nhưng chưa tự nhiên | đúng và nhất quán |
| Đại từ/đối tượng | nhầm người hoặc quan hệ | mơ hồ nhẹ | rõ và nhất quán |
| Giọng/mức lịch sự | sai nhân vật/ngữ cảnh | chấp nhận được | tự nhiên, đúng vai |
| Mạch toàn trang | câu rời hoặc ngược logic | phần lớn liền mạch | hội thoại liền mạch |
| Độ súc tích | khó đặt vào vùng thoại | cần chỉnh nhẹ | ngắn gọn, tự nhiên |

Reviewer đánh thêm `critical_error: true` nếu có sai nghĩa nghiêm trọng, bỏ thoại, bịa nội dung, nhầm người nói hoặc sai exact ID set. Tổng điểm tối đa là `12`, nhưng một critical error không được bù bằng điểm ở mục khác.

Worklog lưu điểm từng attempt, ghi chú ngắn và reviewer. Không bắt buộc một bản dịch gold duy nhất vì nhiều cách dịch tự nhiên có thể cùng đúng.

### 7.2 Guardrail tự động trong CI

CI chỉ đọc manifest và capture đã commit:

- schema hợp lệ;
- SHA-256 fixture đúng;
- exact ID set, không trùng, không thiếu, translation không rỗng;
- `reading_order` là dãy liên tục và khớp expected manifest;
- term group đã annotate không xuất hiện với nhiều surface form xung đột trong cùng trang;
- tính và báo `translated_chars`, `source_chars`, tỷ lệ độ dài và `chars_per_kpx` theo bbox.

Các số độ dài chỉ là warning trong Spec A. Text bbox hiện không phải balloon/layout bbox, nên chưa được dùng làm pass/fail trước Spec C.

CI kiểm evaluator bằng capture tĩnh; CI tuyệt đối không gọi Gemini.

## 8. Quy tắc chọn policy cho Spec B

1. Reading order đúng theo manifest là điều kiện bắt buộc, không phải biến tối ưu.
2. Loại `ordered_microbatch` hoặc `full_page` nếu có `critical_error` hoặc `inconclusive` trên bất kỳ trang nguồn nào. `preview_then_full` chỉ hợp lệ khi `full_page` hợp lệ và chính nó có ít nhất hai paired run trả exact ID set.
3. Tính median tổng điểm của ba attempt hợp lệ cho từng trang.
4. Candidate phải không thấp hơn `batch_control` trên mọi trang. Nếu không candidate nào đạt, quality gate bị chặn và Spec B không được phép ship policy mới; production tạm giữ nguyên nhưng không được gọi là đã nghiệm thu.
5. `full_page` chỉ thắng `ordered_microbatch` về chất lượng khi không thấp hơn trên mọi trang và cao hơn trên ít nhất một trang. Nếu không đạt điều này, giữ `ordered_microbatch` làm candidate chất lượng tốt nhất.
6. `preview_then_full` bị loại nếu bị `full_page` Pareto-dominate: không cải thiện `first_overlay_ms` nhưng không tốt hơn về final latency, lỗi/rate-limit hoặc số call.
7. Nếu preview cải thiện first overlay nhưng phải trả thêm call/final latency, worklog trình bày đúng trade-off và mặc định chọn `full_page`. Chỉ chọn preview khi người dùng duyệt rõ sau khi xem số đo; Spec A không phát minh một ngưỡng phần trăm tùy ý.
8. Quyết định và bằng chứng được ghi trong worklog; không sửa production policy ngay trong Spec A.

Vì final pass của `preview_then_full` phải chứa cả preview blocks, Spec B không được tái sử dụng mù quáng `queueTranslation()`. Thiết kế Spec B phải tạo final pass có chủ đích hoặc một cơ chế phase rõ ràng; không nới guard toàn cục gây duplicate loop.

## 9. Benchmark và worklog

Spec A tạo worklog:

```text
docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json
```

Worklog chứa ba phần:

- `telemetry_validation`: một cold và một warm end-to-end run cho mỗi trang Nhật; với Portuguese chỉ chạy analysis/OCR và batch-scheduling trace bằng recognizer Latin hiện có, cộng policy probe transcript, cho tới khi Spec B thêm `pt` production;
- `policy_probe`: ba attempt cho mỗi trang/arm như mục 6;
- `manual_review`: rubric, điểm, critical errors và quyết định gate.

Các run Portuguese trong Spec A là policy probe từ transcript cố định, chưa phải production proof. Production benchmark sau khi Spec B thêm `pt` và policy thắng vẫn phải tuân thủ gate hiện có: tối thiểu 20 cold + 20 warm trên một máy, báo p50/p95, first overlay/translation/total và không regress block count.

Fixture port `8000` và production OCR API port `8910` tiếp tục tách biệt. `/health` chỉ chứng minh server sống, không phải bằng chứng OCR → Gemini → overlay hoàn tất.

## 10. Xử lý lỗi

- Gemini trả thiếu/trùng/sai ID: attempt `invalid_response`, không chấm điểm.
- Gemini 429 hoặc 502: lưu status/error code và latency; không thay bằng response của attempt khác.
- Detector không ghép đủ required anchor: order diagnostic fail và không chạy quality probe bằng OCR live; runner vẫn có thể dùng frozen transcript để tách riêng lỗi translation.
- OCR live khác frozen transcript: ghi diff, không tự cập nhật manifest. Việc cập nhật transcript cần review thủ công và commit riêng.
- Fixture hash thay đổi: CI fail cho tới khi manifest và baseline được review lại.
- Model/prompt/policy version thay đổi: baseline cũ vẫn giữ lịch sử nhưng không được dùng làm gate cho version mới.

## 11. Kiểm thử và acceptance

### Tự động

- Test `analysis_ready` có `analysis_ms` và `analysis_cache_hit` đúng cho miss/hit.
- Test `ocr_done_ms` và trace Gemini đơn điệu, không âm, exact block IDs.
- Test failed translation batch xuất hiện trong trace và page tổng hợp thành `partial` hiện trạng.
- Test manifest schema/hash/role và sáu ảnh mới không bị copy trùng ngoài nguồn canonical.
- Test expected-order comparator bắt được area-order sai trên fixture đã capture.
- Test evaluator bắt duplicate/missing ID, term inconsistency và fixture hash drift.
- Test CI path không cần `GEMINI_API_KEY` và không tạo network request.

### Review thủ công

- Xác nhận expected reading order trên ba trang nguồn, đặc biệt gutter của hai spread Nhật và manga Portuguese RTL.
- Xác nhận frozen OCR transcript tương ứng đúng bbox.
- Chạy policy probe ba attempt, chấm theo rubric, lưu worklog.
- Đối chiếu telemetry với thứ tự event thực tế; không chấp nhận field luôn `0` hoặc batch membership không truy được.

### Điều kiện hoàn tất Spec A

- Sáu fixture được track tại một nguồn canonical và manifest/hash hợp lệ.
- Telemetry có đủ stage và batch trace, được test miss/hit/fail.
- Expected order và frozen transcript của ba source pages đã được người đọc review.
- Baseline/worklog có đủ attempt hoặc ghi `inconclusive` đúng quy tắc; không có ô trống hay yêu cầu chưa xác định.
- Quyết định policy cho Spec B có thể được tái lập từ capture + rubric, hoặc worklog kết luận rõ chưa policy nào qua gate.
- Chưa có claim production performance cho Portuguese hoặc policy mới trước benchmark sau Spec B.

## 12. Quan hệ với các spec sau

- **Spec B — reading order và page-context translation:** bảo toàn winner của area-greedy dedupe nhưng trả về theo vendor order; gắn `reading_order`; thêm `pt`; sửa prompt/version/cache; triển khai policy thắng gate và acceptance webtoon `mỗi <img> = một page unit`.
- **Spec C — overlay an toàn:** xử lý `block_error`/`partial`, source-text erasure, mask/inpainting, vùng layout chữ dịch và clipping; dùng ba failure-reference làm visual acceptance.

Spec B không bắt đầu thay đổi production policy trước khi Spec A có worklog gate. Spec C có thể thiết kế song song về hình học, nhưng production acceptance cuối phải dùng output policy đã chốt ở Spec B.
