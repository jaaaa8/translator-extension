---
title: "Viewport OCR prewarm và Gemini failover"
note_type: worklog
work_item: viewport-ocr-prewarm-gemini-failover
date_start: 2026-07-29
date_end: 2026-07-29
status: done
versions:
  - "[[feat-v2]]"
specs:
  - "[[2026-07-29-viewport-ocr-prewarm-gemini-failover-design]]"
plans:
  - "[[2026-07-29-viewport-ocr-prewarming]]"
  - "[[2026-07-29-gemini-project-failover]]"
artifacts:
  - "[[2026-07-29-session-handoff]]"
tags:
  - mangatranslator/worklog
---

# Viewport OCR prewarm và Gemini failover

> [!summary] Tóm tắt
> **Vấn đề:** Viewport OCR cần prewarm/dedupe, còn quota Gemini một project có thể chặn toàn bộ phiên.
>
> **Quyết định/fix:** Giới hạn prewarm theo ảnh nhìn thấy và thêm failover hai project với review concurrency.
>
> **Kết quả:** Work item đóng; handoff vẫn lưu rõ các vòng review và giới hạn kiểm chứng.

## Liên kết

- Phiên bản: [[feat-v2]]
- Spec: [[2026-07-29-viewport-ocr-prewarm-gemini-failover-design]]
- Plan: [[2026-07-29-viewport-ocr-prewarming]], [[2026-07-29-gemini-project-failover]]
- Artifact: [[2026-07-29-session-handoff]]

---
## Gemini project failover — đóng phiên cũ (2026-07-29)

> [!info] Bối cảnh
> Phiên trước bị **user tạm dừng** giữa chừng. Spec: `docs/superpowers/specs/2026-07-29-viewport-ocr-prewarm-gemini-failover-design.md` · Ledger: `.superpowers/sdd/2026-07-29-gemini-project-failover/` · Handoff: `docs/superpowers/worklogs/2026-07-29-session-handoff.md`
> Việc còn lại đúng một món: **re-review độc lập fix round 1**. Phiên này làm nốt.

### Re-review fix round 1 → phát hiện 2 lỗi Important

> [!bug] `"429" in last_err` khớp chuỗi, không khớp mã lỗi
> Bất kỳ exception nào có chữ `429` trong text đều bị coi là hết quota. Thủ phạm thực tế: reply hỏng → `json.loads` báo vị trí lỗi, ký tự sai ở offset 428 cho ra `Expecting value: line 1 column 429 (char 428)`.
> **Hậu quả kép:** tốn 1 call của project phụ, **và** vì call fallback đó thành công với `switched=True` nên client phụ **được promote vĩnh viễn** cho mọi lần dịch sau.

> [!bug] Nhánh 429 khi chỉ có 1 key không có test
> `.env.example` mặc định `GEMINI_API_KEY_SECONDARY=` rỗng ⇒ **một client là hình dạng mặc định**, vậy mà guard `len(self._clients) > 1` không test nào chạm tới. Hành vi vốn đã đúng, chỉ là không được chắn regression.

Bốn test 429 cũ ném `RuntimeError("429 ...")` nên **pass nhờ đúng cái trùng chuỗi đang là bug**. Nay ném fake mang `code = 429` theo đúng hình dạng SDK.

### Fix round 2 ✅

- [x] `server/translator.py`: đổi sang `getattr(e, "code", None) == 429` — đọc status HTTP dạng int mà `google.genai.errors.APIError.__init__` gán, `ClientError` kế thừa.
- [x] RED trước khi sửa: `test_decode_error_mentioning_429_does_not_use_secondary` fail với `assert ['unused'] == ['ok']` — `['unused']` chính là reply của client phụ, tức reply hỏng đã fail over thật.
- [x] Test tự kiểm tiền đề của chính nó (`assert "429" in str(decode_error.value)`) nên không mục ruỗng thành tautology nếu Python đổi câu chữ lỗi.
- [x] Thêm `test_single_key_429_raises_without_second_call`: đúng 1 call + `TranslateError`.
- [x] Bỏ `raising=False` trong monkeypatch — nó che lỗi gõ sai tên biến config; suite vẫn pass ⇒ xác nhận tên `GEMINI_API_KEY_SECONDARY` có thật.
- [x] Đối chiếu với **SDK thật** chứ không chỉ fake: `ClientError(429, ...)` có `code == 429` khớp, `ServerError(503, ...)` không khớp.

**Đánh đổi đã chấp nhận:** 429 tới dưới dạng *không phải* `APIError` (ví dụ proxy trả HTML) sẽ không còn kích hoạt failover mà retry cùng client rồi fail. Hỏng theo hướng nhẹ, trong khi khớp chuỗi hỏng theo hướng nặng hơn là promote nhầm project phụ.

**Hoãn có chủ đích:** `client_index = 1 - client_index` hard-code đúng 2 client — khớp trần 2 project của spec, tổng quát hóa bây giờ là abstraction không ai dùng.

### Kiểm chứng

| Lệnh | Kết quả |
| --- | --- |
| `pytest server/tests/test_translator.py -q` | 13 passed |
| `pytest server/tests/test_translator.py server/tests/test_translate_endpoint.py -q` | 23 passed, 1 warning |
| `pytest server/tests --ignore=server/tests/test_ocr.py -q` | 43 passed, 2 warnings |

Warning còn lại là deprecation Starlette/httpx và `pkg_resources` của vendor — có sẵn từ trước.

> [!success] Smoke test đã chạy — PASS (2026-07-29)
> `こんにちは世界` → `Xin chào thế giới`, call Gemini thật qua `scripts\smoke.ps1`. Cả hai project đều hợp lệ khi ép chạy riêng từng client: `primary OK` / `secondary OK`. Failover đã thực sự có hiệu lực.
> Commit `d016038`, nay nằm trên `feat/v2` cùng `b920fdd` (viewport OCR), `f570693` (docs), `de58b42` (config). **Chưa push** theo yêu cầu user.

> [!warning] Còn nợ
> - **Kiểm thử browser tay của plan viewport OCR prewarming vẫn chưa chạy.**
> - Key Gemini bị dán vào chat (cả phiên trước lẫn phiên này) **phải revoke/xoay vòng**; chưa từng lọt vào source, test, log hay `.env.example`. Transcript nằm trên đĩa nên coi như đã lộ.
> - `.git` **đã ghi được trở lại** ở phiên này (phiên trước read-only nên mọi ghi chú "commits unavailable" chỉ đúng với phiên đó).

