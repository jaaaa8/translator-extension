# Thiết kế chạy lại quality gate có pacing

**Ngày:** 2026-08-03
**Trạng thái:** Đã duyệt hướng; chờ review tài liệu trước implementation plan
**Phạm vi:** Tiền điều kiện để đóng gate Spec A và xác định phạm vi được phép của Spec B. Không triển khai Spec B/C trong thay đổi này.

## 1. Mục tiêu và bằng chứng

Capture `2026-08-01-policy-probe.json` chạy 75 logical Gemini call trong khoảng 59 giây. Rate limit đầu tiên xuất hiện ở call thứ 33, sau đó success và `rate_limited` tiếp tục xen kẽ. Bằng chứng này phù hợp với quota phục hồi theo cửa sổ ngắn; nó chưa phân biệt chắc chắn RPM với TPM hoặc dynamic quota, nhưng đủ để xác định burst request là biến cần loại bỏ.

Mục tiêu của lần chạy mới là **đóng quality gate**, không mặc định tìm policy thắng. Kết quả hợp lệ có thể là `selected`, `blocked`, `no_context_headroom` hoặc `inconclusive`. Với JA2 `batch_control` đã đạt median `6` và JA1 có một response median `5`, kết cục có khả năng cao nhất là `no_context_headroom`, nhưng runner và evaluator không được tối ưu để ép kết quả đó.

Chỉ chạy đúng một fresh capture đầy đủ. Không vá attempt vào capture cũ, không chạy bù call/attempt lỗi và không chạy lần ba nếu kết quả mới vẫn `inconclusive`.

## 2. Phạm vi thay đổi

Thay đổi code chỉ gồm:

- thêm CLI option `--call-delay-seconds`, mặc định `0`;
- truyền giá trị đó vào `run_quality_probe()`;
- chờ giữa các logical call trong vòng lặp probe;
- thêm test cho pacing, default và validation CLI;
- cập nhật con số full pytest thực đo trong `work-flow.md` ở cùng commit code.

Không thay đổi:

- `GeminiTranslator._generate`, retry hoặc failover production;
- prompt, policy, model, fixture, baseline hoặc thứ tự arm/page/attempt;
- `CAPTURE_METADATA_FIELDS`, capture schema hoặc evaluator;
- Spec B/C, production `/translate-items`, overlay hoặc browser telemetry;
- capture và score đã commit của ngày 2026-08-01.

## 3. Interface và validation

CLI `run` nhận thêm:

```text
--call-delay-seconds <float>
```

Giá trị mặc định là `0`. Ngay sau `parse_args`, trước `validate_manifest`, Gemini và mọi I/O tiếp theo, CLI kiểm:

```python
math.isfinite(value) and value >= 0
```

Giá trị âm, `nan` hoặc `inf` gọi `parser.error(...)` và thoát code `2`, cùng cách xử lý với guard `--preview-latency` hiện có.

Core giữ tương thích vị trí và thêm hai tham số keyword-only:

```python
def run_quality_probe(
    manifest,
    baseline,
    generate,
    attempts=3,
    clock=time.perf_counter,
    *,
    metadata=None,
    call_delay_seconds=0,
    sleep=time.sleep,
):
```

CLI luôn truyền `call_delay_seconds`, kể cả giá trị mặc định `0`.

## 4. Data flow pacing

Counter logical call được khởi tạo cạnh `rows = []`, ngoài mọi vòng page, arm, attempt và batch. Vòng trong cùng là nguồn duy nhất tạo logical call:

```python
logical_calls = 0
for page in source_pages(manifest):
    for arm in QUALITY_ARMS:
        for attempt in range(1, attempts + 1):
            for batch_id, batch in enumerate(batches, 1):
                if logical_calls and call_delay_seconds:
                    sleep(call_delay_seconds)
                logical_calls += 1
                started = clock()
                try:
                    decoded = generate(...)
                except Exception as error:
                    ...
                ended = clock()
```

Sleep diễn ra trước `started`, kể cả khi logical call trước đó thất bại. Vì `except Exception` không cắt vòng lặp, 429 không được phép tắt pacing cho call kế tiếp.

`capture_call` tiếp tục nhận offset `started - probe_started` và `ended - probe_started`. Do đó:

- `started` phản ánh timeline thật có pacing;
- `duration = ended - started` chỉ đo logical Gemini call;
- tie-break theo tổng `duration` không bị cộng thời gian chờ;
- retry vật lý bên trong `_generate` vẫn có thể chạy sát nhau và không thuộc phạm vi flag này.

Với manifest và baseline hiện tại, một fresh run có đúng 75 logical call và 74 khoảng nghỉ. Giá trị `10` tạo đúng 740 giây sleep, ngoài thời gian Gemini.

## 5. Thiết kế test

### 5.1 Pacing xuyên biên và sau lỗi

Dùng `_policy_page()` với baseline `[["b3"], ["b1", "b2"]]`, `attempts=2`:

- `batch_control`: 2 batch;
- `ordered_microbatch`: 2 batch;
- `full_page`: 1 batch;
- tổng: 5 call mỗi attempt, 10 logical call và 9 lần sleep.

Clock giả bắt đầu tại `0`. Sleep giả tăng clock `10`; generate giả tăng clock `2`. Một generate ở giữa chuỗi tăng clock trước rồi ném fake error có `code = 429`.

Test assert:

- 10 generate call và 9 sleep call;
- mọi sleep nhận `10`;
- `started == [0, 12, 24, ...]` qua cả biên attempt và arm;
- mọi `duration == 2`, gồm cả call 429;
- call lỗi được phân loại `rate_limited`;
- call sau lỗi vẫn có khoảng nghỉ.

Test chỉ đo logical call. Physical retry/failover tiếp tục do các test translator hiện có sở hữu.

### 5.2 Default không sleep

Parametrize hai cách gọi:

- bỏ `call_delay_seconds` để kiểm default core;
- truyền tường minh `call_delay_seconds=0` như CLI production.

Cả hai inject sleeper ném assertion nếu được gọi và phải hoàn tất bình thường.

### 5.3 CLI contract

- `--call-delay-seconds 10` truyền `10.0` xuống fake `run_quality_probe`.
- Test dùng manifest fixture thật và monkeypatch `GeminiTranslator`, tránh phụ thuộc API key/model.
- `-1`, `nan`, `inf` đều thoát code `2` trước `validate_manifest`, Gemini và output I/O.
- `--help` tiếp tục chạy khi không có `GEMINI_API_KEY`.

Sau implementation, chạy focused test trước rồi full `pytest server/tests -q`. `work-flow.md` phải ghi số pass thực đọc từ full suite mới, không dự đoán vẫn là `188`.

## 6. Capture và kiểm tra provenance

Capture chỉ được chạy sau khi commit code đã được người dùng review và worktree sạch. `_commit()` dùng `git rev-parse HEAD`, nên thứ tự này bảo đảm `metadata.commit` trỏ đúng commit chứa runner đã sinh capture.

Baseline được trích lại từ `telemetry_validation.baseline` trong worklog đã commit. Không chạy lại Chrome, OCR telemetry hoặc browser cold/warm. Lệnh live phải chứa rõ:

```text
--attempts 3 --call-delay-seconds 10
```

Capture mới dùng file mới; không ghi đè capture 2026-08-01. Sau run, trước khi chấm rubric:

- chạy `validate_capture` với manifest canonical;
- xác nhận metadata có đúng năm field hiện hành và commit đúng code HEAD lúc chạy;
- xác nhận đủ 27 page × arm × attempt row và đúng 75 logical call;
- kiểm tra khoảng cách giữa hai logical call liên tiếp thể hiện pacing, trong khi `duration` không chứa khoảng nghỉ;
- kiểm tra không có file ngoài capture mới trong commit artifact.

Capture được commit một mình rồi dừng để người dùng review provenance, metadata, call count và pacing. Chỉ sau review này mới chuẩn bị toàn bộ phiếu cho mọi valid attempt để `jaa` chấm.

## 7. Checkpoint và điều kiện dừng

Chuỗi công việc bắt buộc:

1. commit design document;
2. người dùng review design;
3. viết và review implementation plan;
4. TDD implement flag, cập nhật `work-flow.md`, chạy test và commit code;
5. người dùng review commit code;
6. từ worktree sạch, chạy đúng một fresh capture;
7. validate và commit riêng capture;
8. người dùng review capture;
9. `jaa` chấm mọi valid attempt;
10. evaluate offline, cập nhật worklog và vault;
11. dừng để review kết quả gate.

Nếu fresh capture hoặc evaluator vẫn cho `inconclusive`, giữ nguyên kết luận và không chạy thêm. Spec C tiếp tục hoãn; phạm vi Spec B chỉ được quyết định sau artifact evaluator cuối cùng.

## 8. Acceptance

- Default `0` không làm chậm hoặc đổi hành vi test/CLI cũ.
- Delay `10` áp dụng cho mọi cặp logical call liên tiếp, kể cả sau 429.
- Sleep không nằm trong `duration` và không sửa retry production.
- Capture schema/metadata cũ vẫn hợp lệ.
- Commit code được review trước capture; capture được review trước human scoring.
- Không có rerun bù, merge capture hoặc thay đổi Spec B/C trong chuỗi này.
