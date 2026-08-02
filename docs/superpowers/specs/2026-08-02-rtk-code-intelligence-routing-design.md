# Thiết kế routing RTK và code intelligence

**Ngày:** 2026-08-02

**Nhánh:** `feat/v3`

**Trạng thái:** thiết kế đã được người dùng duyệt ngày 2026-08-02; chờ duyệt file spec trước khi lập kế hoạch triển khai

## 1. Mục tiêu

Giữ lợi ích giảm output của RTK mà không để output bị cắt trở thành bằng chứng duy nhất khi model khám phá, debug, sửa hoặc review source code.

## 2. Bằng chứng

- Ba truy vấn `rtk rg` thực tế giảm số ký tự lần lượt 27,4%, 24,3% và 66,9%.
- Truy vấn inventory trên `extension/background.js` tìm 65 function nhưng RTK chỉ hiện 25 function đầu và `+40 more`, che các symbol chính phía sau như `acceptScope`, `consumeOcr` và `flushTranslationBatch`.
- `rtk read --level aggressive` giảm `extension/srcset.js` từ 139 xuống 56 dòng nhưng bỏ toàn bộ 34 dòng điều khiển chứa `if`, `for`, `return`, `throw`, `continue`, `catch` hoặc `while`.
- CodeGraph lấy được source hiện hành, blast radius và call path khi câu hỏi nêu đúng symbol; truy vấn rộng vẫn có thể cần thu hẹp.
- Graphify giúp định hướng giữa code và tài liệu nhưng kết quả traversal có thể bị giới hạn budget hoặc thiếu edge; graph phải được kiểm tra độ mới và implementation phải được xác minh lại.

## 3. Thiết kế đã chọn

Áp dụng thứ tự **intelligence-first, RTK-last**:

1. CodeGraph là lựa chọn đầu tiên cho khám phá source, caller/callee, call flow, debug và source dùng để sửa hoặc review.
2. Graphify là lựa chọn đầu tiên cho kiến trúc và quan hệ xuyên tài liệu. Kiểm tra độ mới của graph trước khi dựa vào kết quả; dùng CodeGraph xác minh implementation hiện hành.
3. RTK chỉ nén output vận hành nhiều nhiễu hoặc chạy truy vấn chính xác sau khi đã biết file/symbol cần tìm.
4. Mọi dấu hiệu cắt output như `...`, `+N more`, `TRUNCATED`, giới hạn kết quả hoặc aggressive filtering đều được coi là bằng chứng chưa đầy đủ.
5. Trước khi kết luận, sửa code hoặc báo PASS, model phải thu hẹp truy vấn hoặc chạy lệnh đầy đủ không lọc cho phần còn thiếu.
6. Review cuối cùng phải dùng diff đầy đủ và source context liên quan; status hoặc summary nén chỉ dùng để phân loại ban đầu.

## 4. Thay đổi tài liệu

Thêm cùng một mục `### RTK output routing` ngay sau phần `## Code intelligence routing` hiện có trong:

- `AGENTS.md`
- `CLAUDE.md`

Nội dung rule:

```md
### RTK output routing

RTK compresses shell output; it is not a source-of-truth or code-intelligence layer.

- Use CodeGraph first for source discovery, callers/callees, call flows, debugging, and code needed for edits. Do not replace it with broad RTK searches.
- Use Graphify first for architecture and cross-document questions. Check graph freshness, then verify current implementation with CodeGraph.
- Use RTK for noisy operational output and narrow exact searches after the relevant files or symbols are known.
- Treat `...`, `+N more`, `TRUNCATED`, result caps, and aggressive filtering as incomplete evidence. Narrow the query or run the exact unfiltered command before concluding, editing, or reporting PASS.
- Never use `rtk read --level aggressive` for source reasoning or review. Use verbatim CodeGraph source, a full file read, or `rtk read --level none`.
- For final code review, inspect the full diff and relevant source context; compact status or summaries are only triage.
```

## 5. Phạm vi và kiểm chứng

- Chỉ sửa hai file hướng dẫn; không đổi source, cấu hình RTK, CodeGraph, Graphify hoặc permission của Claude.
- Giữ nguyên mọi thay đổi chưa commit đang có trong hai file.
- Kiểm chứng bằng diff giới hạn ở đúng hai file, xác nhận hai block giống nhau và không có placeholder hoặc mâu thuẫn với routing hiện tại.
