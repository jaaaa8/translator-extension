# Thiết kế Spec A: telemetry, fixture trang thật và quality gate

**Ngày:** 2026-08-01

**Nhánh:** `feat/v3`

**Trạng thái:** thiết kế đã được người dùng duyệt ngày 2026-08-01; đã hợp nhất ghi chú plan và sẵn sàng lập implementation plan

## 1. Kết quả cần đạt

Spec A tạo một nền đo đủ tin cậy để Spec B quyết định chính sách dịch theo dữ liệu thay vì suy luận từ code:

1. Thời gian từng stage của một trang thật được ghi đúng, gồm cả `analysis_ms`, thời điểm OCR hoàn tất và từng request extension → server `/translate-items`.
2. Sáu ảnh người dùng cung cấp được đưa ra khỏi `server/vendor/` đang bị Git ignore và lưu đúng một bản trong fixture được track.
3. Ba trang nguồn có ground truth về thứ tự đọc, transcript OCR cố định và metadata ngôn ngữ/bố cục.
4. Chất lượng dịch được chấm tay theo rubric cố định; CI chỉ kiểm các guardrail có tính xác định và không gọi Gemini.
5. Một batch control và hai candidate chất lượng `ordered_microbatch`, `full_page` có kết quả, latency, số call và lỗi được lưu thành worklog để làm gate cho Spec B. `preview_then_full` chỉ là probe latency có điều kiện sau khi `full_page` qua quality gate.

Spec A không chọn policy bằng cảm tính. Chất lượng là tiêu chí chính; latency và số call chỉ phá hòa giữa các policy có chất lượng đạt yêu cầu.

## 2. Bằng chứng hiện trạng

Các điểm sau đã được đối chiếu với code hiện tại và fixture thật:

- `server/main.py` phát `analysis_ready` nhưng không gửi `analysis_ms`; `extension/background.js` vẫn đọc trường này nên metric hiện luôn về `0`.
- Vendor `comic_text_detector` đã gọi `sort_textblk_list()` trước khi trả `blk_list`. `blk.weight` tăng đơn điệu trên cả ba lần đo, xác nhận sorter đã chạy. Thuật toán lật phải sang trái khi đa số block có nhãn `ja`, và có nhánh riêng cho ảnh ngang hai trang.
- `_dedupe_regions()` cần sort bản sao theo diện tích để greedy dedupe giữ box lớn hơn. Sau đó hàm đang trả luôn thứ tự diện tích; `Pipeline.analyze()` lại sort diện tích lần thứ hai. Hai bước này phá thứ tự vendor.
- Phép đo `Detector(device="cpu")` trên ba ảnh nguồn hiện tại cho kết quả:

| Trang | Kích thước | Detect → dedupe | Dọc | Nhãn classifier | `flip_lr` | Kendall τ: diện tích so với vendor |
|---|---:|---:|---:|---|---|---:|
| `mangadex_es.png` | 500×782 | 8 → 7 | 0 | `eng: 5`, `ja: 3` | `false` | `0.048` |
| `s-manga_ja_1.png` | 1107×871 | 21 → 21 | 20 | `ja: 20`, `unknown: 1` | `true` | `-0.114` |
| `s-manga_ja_2.png` | 1105×868 | 17 → 17 | 17 | `ja: 17` | `true` | `-0.029` |

τ gần `0` trên cả ba trang chứng minh thứ tự diện tích không tương quan với thứ tự đọc. Dedupe chỉ loại một box trùng trên trang Portuguese; hai spread không bị dedupe thay đổi tập region. Đây là phép đo CPU; production CUDA có thể lệch nhẹ, nên manifest dùng anchor IoU và expected order do người đọc xác nhận thay vì đóng băng raw detector output.
- Đối chiếu độc lập với nội dung ảnh cho thấy vendor đúng `17/17` region trên `s-manga_ja_2`, nhưng xếp sai một region trên `s-manga_ja_1`: `ＣＭによるイメージ向上と` thuộc panel trên bị đẩy xuống sau hai region của panel dưới. Region poster ngang `新人ヒーロー募集中！` là `sign`, không phải thoại.
- Fixture mang tên `mangadex_es.png` chứa tiếng Bồ Đào Nha và đọc RTL, nhưng vendor trả LTR vì chỉ có `3/8` block mang nhãn `ja`, không vượt ngưỡng `4`. Vendor order vì thế là tín hiệu cần bảo toàn qua dedupe, không phải ground truth đủ để ship. `src_lang` và `reading_direction` phải là hai input độc lập.
- Trang Portuguese có đúng bảy bóng thoại sau dedupe; detector tìm đủ cả bảy. Box thứ tám là duplicate cùng một bóng nhưng hai classifier label khác nhau (`eng` và `ja`). Hiện tượng “mất bóng” trong ảnh lỗi vì thế thuộc OCR/translation/overlay downstream, không phải detector bỏ sót.
- `PaddleLatinEngine` đang hard-code `PaddleOCR(lang="es")`; thêm registry key `pt` sau này sẽ không tự đổi recognizer nếu constructor chưa đổi. Frozen transcript Portuguese của Spec A dùng chính engine hiện tại nên vẫn so sánh được qua ranh giới A → B; mọi thay đổi recognizer vẫn phải bump version và review diff.
- Phép đối chứng review này chưa chạy OCR live hoặc Gemini. Mọi nhận định về chất lượng dịch vẫn là giả thuyết cho tới khi policy probe mục 6 có capture và chấm tay.
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
  "term_groups": [],
  "known_order_failures": [
    "vendor trả LTR trong khi ground truth là RTL"
  ]
}
```

Hai ảnh Nhật dùng `page_kind: "spread"`. `reading_direction` mô tả bố cục trang, không được suy ra từ `src_lang`.

Mỗi phần tử `regions` dùng ID fixture độc lập với runtime `block_id`:

```json
{
  "fixture_block_id": "b01",
  "bbox": [10, 20, 30, 40],
  "reading_order": 0,
  "kind": "dialogue",
  "src_text": "transcript OCR đã review",
  "required": true
}
```

`kind` chỉ nhận `dialogue`, `sfx` hoặc `sign`. Đây là annotation dành riêng cho reviewer/evaluator, không được gửi cho Gemini và không thuộc production request contract. Boundary HTTP hiện tại lọc prompt item còn đúng `id`/`text`; policy probe Task 5 dùng allowlist riêng `id`/`text`/`reading_order`/`bbox` và không đi qua `translate_items()`, nên hai contract cố ý khác nhau. Mọi kind vẫn được dịch và phải trả exact ID; chỉ `dialogue` tham gia điểm ngữ cảnh hội thoại. Cụ thể, poster ngang trên `s-manga_ja_1` phải được annotate là `sign`, không được giả làm lời thoại.

Expected order được người đọc xác nhận độc lập theo panel và chiều đọc manga. Với spread Nhật, toàn bộ nửa phải đi trước nửa trái. Với trang Portuguese, chiều đọc vẫn là RTL dù ngôn ngữ là Latin. Tuyệt đối không sinh `reading_order` bằng cách dump `sort_textblk_list()`: vendor đã sai một region trên `s-manga_ja_1` và sai chiều toàn trang trên `mangadex_pt`. Hai sai lệch này phải nằm trong `known_order_failures` để reviewer có mốc kiểm tra, không xác nhận vòng tròn chính output vendor.

Region detector được ghép với anchor manifest bằng IoU lớn hơn `0.5`. Mỗi required anchor phải ghép đúng một region, một region không được ghép hai anchor. Region mới hoặc mất region phải được báo trong kết quả diagnostic, không tự sửa manifest.

`term_groups` chỉ chứa thuật ngữ/tên riêng thực sự lặp trong trang và các surface form nguồn được chấp nhận. Mỗi group dùng schema:

```json
{
  "canonical": "マッコイ",
  "accepted_source_forms": ["マッコイ", "マッコイ氏"],
  "fixture_block_ids": ["b07", "b20"]
}
```

`canonical` là lemma ổn định và duy nhất trong một trang; nó không bắt buộc xuất hiện nguyên dạng trong transcript. `accepted_source_forms` chỉ mô tả các dạng nguồn cùng một thuật ngữ. `fixture_block_ids` phải tham chiếu ít nhất hai region khác nhau trong trang. Group phục vụ kiểm tra self-consistency giữa các block; Spec A không đóng đinh surface form tiếng Việt, không thêm NER tự động và không dùng group để tự chấm chất lượng ngữ nghĩa.

### 4.2 Ảnh tham chiếu lỗi

Ba ảnh overlay chỉ có metadata:

- `role: "failure_reference"`;
- liên kết tới `source_page` tương ứng;
- danh sách nhãn lỗi nhìn thấy, ví dụ `partial_translation`, `white_bbox_exposes_source`, `text_clipped`, `fragmented_blocks`.

Không dùng nhãn `detector_missing_bubble` cho ảnh Portuguese: detector đã tìm đủ `7/7` bóng sau dedupe. Bóng không có overlay phải được ghi là `partial_translation` hoặc `overlay_missing` cho tới khi Spec C định vị chính xác stage downstream.

Các ảnh tham chiếu lỗi không được đưa vào điểm chất lượng Gemini. Spec C sẽ dùng chúng để xây visual acceptance.

## 5. Contract telemetry

`analysis_ms` là duration; `*_done_ms` và `first_*_ms` là elapsed từ producer accepted, trừ `first_overlay_ms`; field này đo từ content scope start để giữ tương thích aggregate/benchmark. Mỗi row có `accepted_offset_ms`; producer-relative overlay xấp xỉ `first_overlay_ms - accepted_offset_ms`; sai số còn lại là IPC + MV3 worker wake. Stage không chạy dùng `null`. Mọi duration dùng millisecond nguyên, không âm; riêng `accepted_offset_ms` là offset chứ không phải duration và được phép âm khi một request đến sau bám vào producer đã được accept từ trước (shared producer).

### 5.1 Analysis và OCR

Event `analysis_ready` bổ sung:

```json
{
  "analysis_ms": 123,
  "analysis_cache_hit": false
}
```

- `analysis_ms` là wall time phía handler từ ngay trước khi gọi `Pipeline.analyze()` đến khi hàm trả về, gồm cả thời gian chờ `_ocr_lock`. Nó có thể lớn hơn `0` khi request miss cache lần đầu, chờ request khác phân tích, rồi hit cache ở lần kiểm tra thứ hai sau lock.
- `analysis_cache_hit: true` khi request này không tự chạy detector, không phụ thuộc `analysis_ms` có bằng `0` hay không. `false` chỉ khi chính request thực thi decode + detect + chuẩn bị region.
- Spec A chưa thêm `analysis_wait_ms`; chỉ tách lock wait thành metric riêng nếu số đo wall time sau này không đủ giải thích contention.
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
- `accepted_offset_ms`;
- `total_ms`.

`analysis_ms` là duration stage. `*_done_ms` và `first_*_ms` là elapsed từ producer accepted, trừ `first_overlay_ms`, được content đo từ scope start; `accepted_offset_ms` cho phép xấp xỉ producer-relative overlay bằng `first_overlay_ms - accepted_offset_ms`, với sai số IPC + MV3 worker wake. Đây là offset giữa hai mốc accepted, không phải duration, nên có thể âm khi request đến sau dùng chung một producer đã được accept trước đó. Stage không chạy là `null`.

`completeJob()` phải nhận hoặc tạo đúng một metric row cho mỗi job hoàn tất. Có ba nguồn row:

- job chạy producer lấy row từ `producerMetrics()`;
- warm page-cache hit trong `replayPage()` tạo row với `cache_hit: true`, các stage không chạy là `null` thay vì giả thành `0`;
- lỗi trong `acceptScope()` trước khi có producer tạo row với `cache_hit: false`, các stage là `null` và `error_code` bằng mã đã phát trong `job_error`. `page_artifact_key` được phép `null` nếu lỗi xảy ra trước khi tạo key.

`scope_done.metrics` vẫn là aggregate tương thích ngược, nhưng `scope_done.page_metrics` phải phát toàn bộ `request.metricRows` để record từng job thực sự rời service worker. Mỗi row gồm `job_id`, `page_artifact_key`, `cache_hit`, `error_code`, `accepted_offset_ms`, các metric trang ở trên, tổng `recognized`/`failed` và trace request dịch của đúng producer nếu có; không chứa source URL, API key hay text. Không được gọi giá trị `Math.max(...)` của nhiều row là metric của một trang.

### 5.2 Trace từng request dịch extension → server

Mỗi request extension → server `/translate-items` có một record không chứa source URL đầy đủ hoặc API key. Server có thể retry hoặc đổi client Gemini bên trong, nên số trace có thể ít hơn số Gemini attempt thật và `duration_ms` gộp thời gian retry/failover đó. Spec A không thêm telemetry attempt phía server:

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

- đây là các block văn bản từ cùng một ảnh/trang manga hoặc comic;
- item được cung cấp kèm `reading_order`, `bbox` và kích thước ảnh;
- giữ nhất quán tên riêng, đại từ và mức lịch sự trong phạm vi trang;
- dùng văn nói tự nhiên, súc tích;
- trả mỗi exact ID đúng một lần.

Prompt không suy đoán nhân vật, không dùng memory nhiều trang và không thêm glossary tự động. Mọi arm dùng cùng prompt này để policy probe không trộn thay đổi prompt với thay đổi ordering/batching.

Runner tạo Gemini items bằng allowlist `id`, `text`, `reading_order`, `bbox`; kích thước ảnh nằm ở page context. Nó không serialize `kind` từ manifest. Field đó chỉ đi vào evaluator thủ công, nên delta của policy probe không phụ thuộc metadata mà production không thể tạo.

Runner tạo một control và hai candidate chất lượng. Mọi arm đều dùng `source_name` đúng từ manifest; vì vậy fixture Portuguese không bị nhiễu bởi lỗi production đang gọi nó là Spanish:

1. `batch_control`: replay exact block order và batch membership của baseline đã commit, nhưng dùng prompt evaluation và tên ngôn ngữ đúng từ manifest. Đây là control cho ordering/batching hiện tại; nó không được gọi là production proof.
2. `ordered_microbatch`: lấy danh sách đã xếp theo expected `reading_order`, rồi chia theo đúng dãy batch size đã commit của `batch_control`. So sánh control với candidate này đo riêng tác động của ordering.
3. `full_page`: gửi toàn bộ block một lần theo expected `reading_order`.

Batch membership phụ thuộc timer `250/500 ms`, nên quality run không được tự capture lại rồi gọi đó là cùng control. Cold trace đầu tiên có OCR hoàn tất và đủ event thứ tự phải được review rồi commit vào `telemetry_validation.baseline_batches` trong worklog, gồm exact `block_ids`, `batch_sizes`, fixture SHA, commit, device và production policy version. `batch_control` đọc exact membership này; `ordered_microbatch` chỉ tái dùng dãy size trên expected order. Dữ liệu này không nằm trong manifest vì nó là artifact runtime phụ thuộc policy/máy, không phải ground truth của ảnh.

Với Portuguese, implementation được phép chạy ảnh qua recognizer Latin hiện có bằng `src_lang=es` chỉ để capture OCR arrival/batch scheduling; text dịch của run này bị loại khỏi quality score. Đây không phải bằng chứng production hỗ trợ Portuguese. Nếu translation call của trace thất bại, membership vẫn hợp lệ khi trace đã ghi đủ `batch_id`, `block_ids` và thời điểm flush.

`preview_then_full` không phải quality arm và không tham gia rubric ở mục 7. Chỉ sau khi `full_page` qua quality gate, nếu telemetry cho thấy first-overlay latency còn là trade-off cần đo, runner mới chạy ba paired attempt trên hai spread Nhật: gửi batch đầu làm preview rồi gửi lại toàn trang. Probe chỉ đo TTFT, final latency, số call, rate-limit/invalid response và exact ID; mặc định vẫn giữ `full_page` cho tới khi người dùng duyệt rõ trade-off. Cách chạy có điều kiện bỏ toàn bộ preview probe trên trang Portuguese không hỗ trợ production và ít phân biệt batching nhất.

Mỗi cặp `source_page × quality arm` chạy đúng ba attempt với cùng model, prompt và transcript. Hai spread Nhật dùng rubric đầy đủ cho `batch_control`, `ordered_microbatch` và `full_page`; trang Portuguese dùng ba mục an toàn ở mục 7. Không chấm `preview_then_full`. Runner giữ retry/failover giống production, nhưng không chạy thêm attempt để che lỗi. Nếu một arm có dưới hai response hợp lệ trên một trang, kết quả arm là `inconclusive`; candidate tương ứng không được chọn.

Mỗi capture lưu:

- commit và SHA-256 fixture;
- thời gian, OS, device;
- model, prompt version, policy version, temperature;
- thứ tự block và batch membership;
- latency từng call;
- response theo exact ID;
- lỗi/rate-limit;
- không lưu API key.

Capture phải có đúng năm metadata bắt buộc: `captured_at`, `commit`, `device`, `model` và `temperature`. `captured_at` là ISO-8601 UTC có timezone, `commit`/`device`/`model` là chuỗi không rỗng, `temperature` là số hữu hạn; thiếu, thừa hoặc sai kiểu làm `validate_capture` fail. `evaluate_gate` echo nguyên `captured_at` từ capture và không sinh timestamp mới. Đây là trust boundary cho artifact đã commit; `run_quality_probe(metadata=None)` vẫn chỉ là helper test và không tạo artifact đủ điều kiện gate.

Đối với fixture Portuguese, runner dùng `source_name` từ manifest để prompt nói `Portuguese`. Đây là probe benchmark, không tuyên bố production đã hỗ trợ `src_lang=pt`.

## 7. Chấm chất lượng

### 7.1 Rubric thủ công là gate chính

Mỗi response hợp lệ của hai spread Nhật được người đọc chấm `0`, `1` hoặc `2` cho sáu mục:

| Mục | 0 | 1 | 2 |
|---|---|---|---|
| Đúng nghĩa | sai/bịa/bỏ ý quan trọng | còn lỗi nhỏ | đúng và đủ |
| Tên riêng/thuật ngữ | sai hoặc không nhất quán | hiểu được nhưng chưa tự nhiên | đúng và nhất quán |
| Đại từ/đối tượng | nhầm người hoặc quan hệ | mơ hồ nhẹ | rõ và nhất quán |
| Giọng/mức lịch sự | sai nhân vật/ngữ cảnh | chấp nhận được | tự nhiên, đúng vai |
| Mạch toàn trang | câu rời hoặc ngược logic | phần lớn liền mạch | hội thoại liền mạch |
| Độ súc tích | khó đặt vào vùng thoại | cần chỉnh nhẹ | ngắn gọn, tự nhiên |

Reviewer đánh thêm `critical_error: true` nếu có sai nghĩa nghiêm trọng, bỏ thoại, bịa nội dung, nhầm người nói hoặc sai exact ID set. Tổng điểm tối đa của mỗi response Nhật là `12`, nhưng một critical error không được bù bằng điểm ở mục khác.

Để so sánh policy mà không cho các mục ít liên quan lấn át tín hiệu batching, evaluator tính thêm `context_score = tên riêng/thuật ngữ + đại từ/đối tượng + mạch toàn trang`, phạm vi `0..6`. Với mục `mạch toàn trang`, reviewer chỉ chấm các region `kind: dialogue`; `sign` và `sfx` vẫn phải đúng ID, đúng nghĩa và súc tích nhưng không bị giả định là một lượt hội thoại.

Trang Portuguese chỉ chấm ba mục an toàn `Đúng nghĩa`, `Giọng/mức lịch sự`, `Độ súc tích`, cộng expected RTL order, exact ID và `critical_error`. Ba mục `Tên riêng/thuật ngữ`, `Đại từ/đối tượng`, `Mạch toàn trang` được ghi `not_applicable`; không tính tổng điểm hay `context_score` cho trang này. Như vậy chín response Portuguese không tạo thêm 27 phán đoán không tham gia quyết định.

`preview_then_full` không xuất hiện trong bảng chấm chất lượng; nó chỉ có record latency có điều kiện như mục 6.

Điểm từng attempt, `context_score` hoặc `not_applicable`, ghi chú ngắn và reviewer nằm trong `captures/2026-08-01-manual-scores.json` đã commit; section `manual_review` của worklog giữ nguyên artifact evaluator. Không bắt buộc một bản dịch gold duy nhất vì nhiều cách dịch tự nhiên có thể cùng đúng.

Mỗi manual score Nhật có annotation explicit `term_forms: {canonical: {fixture_block_id: target_surface_form}}`. Mỗi canonical phải có đúng các `fixture_block_ids` của term group; evaluator chuẩn hóa `strip().casefold()` và reject hơn một surface form trong chính response/attempt đó trừ khi reviewer chấm `terms = 0`. Nó không so sánh surface form giữa các attempt, không suy đoán từ translation text và không dùng NER hay LLM judge.

### 7.2 Guardrail tự động trong CI

CI chỉ đọc manifest và capture đã commit:

- schema hợp lệ;
- SHA-256 fixture đúng;
- exact ID set, không trùng, không thiếu, translation không rỗng;
- `reading_order` là dãy liên tục và khớp expected manifest;
- source page Portuguese bắt buộc có `reading_direction: rtl`;
- term group đã annotate không xuất hiện với nhiều surface form xung đột trong cùng trang;
- tính và báo `translated_chars`, `source_chars`, tỷ lệ độ dài và `chars_per_kpx` theo bbox.

Các số độ dài chỉ là warning trong Spec A. Text bbox hiện không phải balloon/layout bbox, nên chưa được dùng làm pass/fail trước Spec C.

CI kiểm evaluator bằng capture tĩnh; CI tuyệt đối không gọi Gemini.

## 8. Quy tắc chọn policy cho Spec B

1. Expected `reading_order` do người đọc xác nhận phải đúng trên cả ba manifest trước khi chạy quality gate. Vendor order là input hữu ích nhưng không đủ: nó sai một region Nhật và sai chiều toàn trang Portuguese.
2. Trên trang Portuguese, mọi candidate phải đi đúng RTL expected order, trả exact ID và không có `critical_error`. Trang này không tham gia phép so sánh điểm batching.
3. Loại `ordered_microbatch` hoặc `full_page` nếu có `critical_error`, `inconclusive`, hoặc median bằng `0` ở bất kỳ mục an toàn nào trong `Đúng nghĩa`, `Giọng/mức lịch sự`, `Độ súc tích` trên bất kỳ trang nguồn nào.
4. Trên từng spread Nhật, tính median `context_score` của ba attempt hợp lệ cho `batch_control` và mỗi candidate.
5. Nếu `batch_control` đạt median `context_score >= 5` trên cả hai spread, ghi kết quả `no_context_headroom`: với trần `6`, không candidate nào có thể đạt mức tăng `2` trên một spread. Đây là kết quả xác định “không còn headroom đủ lớn cho ordering/batching theo ngưỡng đã chọn”, không phải gate hỏng. Reading order vẫn phải được sửa như correctness bug, nhưng không ship batching mới với claim tăng chất lượng; phần tối ưu chất lượng của Spec B phải re-target sang bottleneck tiếp theo đã đo như OCR, model hoặc prompt và được duyệt lại trước implementation plan.
6. Ngoài nhánh `no_context_headroom`, candidate qua ngưỡng cải thiện so với `batch_control` khi không thấp hơn quá `1` điểm trên bất kỳ spread nào và cao hơn ít nhất `2` điểm trên ít nhất một spread. Dung sai một điểm hấp thụ dao động nhỏ của rubric; yêu cầu tăng hai điểm ngăn một dao động đơn lẻ được gọi là thắng.
7. Nếu không candidate nào qua ngưỡng ở nhánh còn headroom, quality gate bị chặn và Spec B không được ship policy mới. Nếu chỉ một candidate qua, chọn candidate đó. Nếu cả hai qua, so sánh `full_page` với `ordered_microbatch` bằng cùng quy tắc; nếu không arm nào thắng rõ về `context_score`, coi chất lượng hòa và dùng số call Gemini rồi total latency làm tie-breaker. Chi phí tie-break cộng toàn bộ attempt đã capture của candidate trên cả ba source page, kể cả call `failed`, `rate_limited` hoặc `invalid_response`, để lỗi thoáng qua không bị xóa khỏi chi phí policy.
8. Chỉ khi `full_page` được chọn và first-overlay latency còn cần đánh đổi, mới chạy probe `preview_then_full` trên hai spread Nhật. Probe phải có ít nhất hai paired run trả exact ID; nếu không cải thiện first overlay hoặc làm xấu final latency/lỗi/rate-limit mà không có lợi ích đo được, giữ `full_page`.
9. Nếu preview cải thiện first overlay nhưng phải trả thêm call/final latency, worklog trình bày đúng trade-off và mặc định chọn `full_page`. Chỉ chọn preview khi người dùng duyệt rõ sau khi xem số đo; Spec A không phát minh một ngưỡng phần trăm tùy ý.
10. Quyết định và bằng chứng được ghi trong worklog; không sửa production policy ngay trong Spec A.

Vì final pass của `preview_then_full` phải chứa cả preview blocks, Spec B không được tái sử dụng mù quáng `queueTranslation()`. Thiết kế Spec B phải tạo final pass có chủ đích hoặc một cơ chế phase rõ ràng; không nới guard toàn cục gây duplicate loop.

## 9. Benchmark và worklog

Spec A tạo worklog:

```text
docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json
```

Worklog chứa ba phần:

- `telemetry_validation`: một cold và một warm end-to-end run cho mỗi trang Nhật; với Portuguese chỉ chạy analysis/OCR và batch-scheduling trace bằng recognizer Latin hiện có, cộng policy probe transcript, cho tới khi Spec B thêm `pt` production. Phần này lưu `measurement_device`, từng `page_metrics` và `baseline_batches` đã review;
- `policy_probe`: ba attempt cho mỗi trang/quality arm như mục 6, cộng `preview_then_full` latency probe nếu điều kiện kích hoạt được thỏa;
- `manual_review`: nguyên artifact `evaluate` (`captured_at`, `decision` là một trong `selected`/`blocked`/`inconclusive`/`no_context_headroom`, `reason`, `pages`, `arms`); rubric từng attempt nằm trong `captures/2026-08-01-manual-scores.json` đã commit.

CLI `evaluate` chỉ sinh artifact quyết định deterministic dùng làm nguyên section `manual_review`. Task 7 ráp worklog ba phần từ browser telemetry đã review, raw policy capture và artifact evaluator; CLI không phát minh envelope hay schema telemetry mà nó không nhận làm input.

Các run Portuguese trong Spec A là policy probe từ transcript cố định, chưa phải production proof. Production benchmark sau khi Spec B thêm `pt` và policy thắng vẫn phải tuân thủ gate hiện có: tối thiểu 20 cold + 20 warm trên một máy, báo p50/p95, first overlay/translation/total và không regress block count.

Fixture port `8000` và production OCR API port `8910` tiếp tục tách biệt. `/health` chỉ chứng minh server sống, không phải bằng chứng OCR → Gemini → overlay hoàn tất.

## 10. Xử lý lỗi

- Gemini trả thiếu/trùng/sai ID, translation rỗng, hoặc response không phải chuỗi (kể cả `None`): attempt `invalid_response`, không chấm điểm.
- Gemini 429 hoặc 502: lưu status/error code và latency; không thay bằng response của attempt khác.
- Detector không ghép đủ required anchor: order diagnostic fail và không chạy quality probe bằng OCR live; runner vẫn có thể dùng frozen transcript để tách riêng lỗi translation.
- OCR live khác frozen transcript: ghi diff, không tự cập nhật manifest. Việc cập nhật transcript cần review thủ công và commit riêng.
- Fixture hash thay đổi: CI fail cho tới khi manifest và baseline được review lại.
- Model/prompt/policy version thay đổi: baseline cũ vẫn giữ lịch sử nhưng không được dùng làm gate cho version mới.

## 11. Kiểm thử và acceptance

### Tự động

- Test `analysis_ready` có `analysis_ms` và `analysis_cache_hit` đúng cho miss/hit, gồm ca miss trước lock → chờ → hit sau lock có `analysis_cache_hit: true` và `analysis_ms > 0`.
- Test `ocr_done_ms` và trace Gemini đơn điệu, không âm, exact block IDs; `scope_done.page_metrics` có đúng một row mỗi job, kể cả warm page-cache hit và lỗi `attachDescriptor` trước producer, thay vì chỉ aggregate `max`.
- Test failed translation batch xuất hiện trong trace và page tổng hợp thành `partial` hiện trạng.
- Test manifest schema/hash/role/`kind` và sáu ảnh mới không bị copy trùng ngoài nguồn canonical.
- Test expected-order comparator bắt được area-order, vendor LTR của `mangadex_pt` và region vendor sai trên `s-manga_ja_1`; expected order không được sinh từ output đang được kiểm.
- Test `batch_control` replay exact membership đã commit, còn `ordered_microbatch` replay đúng dãy size trên expected order dù timer runtime khác.
- Test policy runner không gửi `kind` cho Gemini; evaluator mới được đọc field này.
- Test evaluator bắt duplicate/missing ID, term inconsistency và fixture hash drift; Portuguese chỉ yêu cầu ba mục an toàn và ghi ba mục ngữ cảnh là `not_applicable`.
- Test `batch_control` có median `context_score >= 5` trên cả hai spread cho kết quả `no_context_headroom`, không phải `blocked`.
- Test CI path không cần `GEMINI_API_KEY` và không tạo network request.

### Review thủ công

- Xác nhận expected reading order trên ba trang nguồn, đặc biệt gutter của hai spread Nhật và manga Portuguese RTL.
- Xác nhận frozen OCR transcript tương ứng đúng bbox.
- Chạy ba attempt cho mỗi quality arm; chấm hai spread bằng rubric/`context_score`, chấm trang Portuguese bằng ba mục an toàn cộng order/exact-ID/critical gate, và chỉ chạy preview latency probe khi điều kiện mục 6 thỏa.
- Đối chiếu telemetry với thứ tự event thực tế; không chấp nhận field luôn `0` hoặc batch membership không truy được.

### Điều kiện hoàn tất Spec A

- Sáu fixture được track tại một nguồn canonical và manifest/hash hợp lệ.
- Telemetry có đủ stage và batch trace, được test miss/hit/fail.
- Expected order và frozen transcript của ba source pages đã được người đọc review.
- Baseline/worklog có đủ attempt hoặc ghi `inconclusive` đúng quy tắc; không có ô trống hay yêu cầu chưa xác định.
- Kết quả Spec B có thể được tái lập từ capture + rubric: chọn policy, `blocked`, hoặc `no_context_headroom` và yêu cầu re-target.
- Chưa có claim production performance cho Portuguese hoặc policy mới trước benchmark sau Spec B.

## 12. Quan hệ với các spec sau

- **Spec B — reading order và page-context translation:** area-greedy dedupe vẫn chọn box lớn nhưng phải trả winner về theo thứ tự input; một stage reading-order riêng sau đó tạo `reading_order` và phải qua expected-order comparator của cả ba fixture. Stage này không được dựa duy nhất vào classifier `ja` hay trả nguyên vendor order. Probe nhận `reading_direction` từ manifest; production nhận giá trị độc lập, do người dùng kiểm soát và truyền trong request, để Portuguese manga có thể chọn RTL mà không giả thành tiếng Nhật. Production `/translate-items` phải mang cùng allowlist `id`, `text`, `reading_order`, `bbox` và page context chứa kích thước ảnh như `comic-page-eval-v1`; prompt/version/cache key phải đổi cùng contract này. Spec B cũng thêm `pt`, triển khai policy thắng gate và acceptance webtoon `mỗi <img> = một page unit`.
- **Spec C — overlay an toàn:** xử lý `block_error`/`partial`, source-text erasure, mask/inpainting, vùng layout chữ dịch và clipping; dùng ba failure-reference làm visual acceptance.

Spec B không bắt đầu thay đổi production policy trước khi Spec A có worklog gate. Spec C có thể thiết kế song song về hình học, nhưng production acceptance cuối phải dùng output policy đã chốt ở Spec B.
