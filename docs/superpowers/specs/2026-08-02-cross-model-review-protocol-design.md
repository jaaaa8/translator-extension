# Thiết kế protocol phản biện Codex–Claude

**Ngày:** 2026-08-02

**Nhánh:** `feat/v3`

**Trạng thái:** thiết kế đã được người dùng duyệt ngày 2026-08-02; chờ duyệt file spec trước khi triển khai

## 1. Mục tiêu

Tách rõ hai vai trò nhưng giữ một vòng phản biện dựa trên bằng chứng:

- Codex là implementation partner có independent judgment, được phép tìm và đề xuất phương án tốt hơn review của Claude.
- Claude là reviewer-only, phải đánh giá lại counter-review của Codex thay vì bảo vệ verdict cũ theo quán tính.
- Người dùng chuyển nội dung giữa hai model và là người quyết định cuối cùng.

## 2. Cách tiếp cận đã chọn

Áp dụng **evidence-mediated review**, không dùng Claude-authoritative hoặc adversarial debate cho mọi finding.

1. Codex kiểm chứng từng finding của Claude với requirement, current source, caller/blast radius và test liên quan.
2. Finding đúng được đánh dấu `Accept`, triển khai và kiểm chứng.
3. Finding đúng một phần hoặc có phương án tốt hơn được đánh dấu `Partially accept` hoặc `Challenge`.
4. Nếu phần tranh chấp làm thay đổi đáng kể kết quả, Codex chưa áp dụng phần đó và viết counter-review tự chứa để người dùng chuyển cho Claude.
5. Counter-review phải có `Assessment`, `Evidence`, `Better alternative`, `Trade-offs` và `Recommendation`.
6. Claude đánh giá lại counter-review và kết thúc từng finding bằng `UPHOLD`, `REVISE` hoặc `WITHDRAW`, kèm bằng chứng.
7. Không model nào phản biện để thể hiện cá tính, phục tùng vì thẩm quyền, hoặc giữ quan điểm chỉ để nhất quán với câu trả lời trước.

## 3. Thiết kế AGENTS.md

Toàn bộ instruction dùng tiếng Anh, gồm:

- `Role: implementation partner with independent judgment` đứng đầu file.
- Quyền chủ động khảo sát nhiều phương án và nêu tối ưu tốt hơn trong phạm vi yêu cầu.
- Tối ưu mở rộng phạm vi chỉ được đề xuất, không tự triển khai.
- Protocol xử lý Claude review theo `Accept`, `Partially accept`, `Challenge`.
- Working discipline theo tinh thần Karpathy: assumption rõ, giải pháp tối thiểu đúng, surgical changes và verification trước completion claim.
- Project rules, CodeGraph/Graphify routing và RTK routing hiện có.

## 4. Thiết kế CLAUDE.md

Toàn bộ instruction dùng tiếng Anh, gồm:

- `Role: reviewer, not implementer` đứng đầu file.
- Review contract với PASS gate và severity hiện có.
- Protocol đánh giá counter-review theo `UPHOLD`, `REVISE`, `WITHDRAW`.
- Review discipline: đọc current evidence, tìm root cause, đề xuất fix nhỏ nhất và không tạo finding để lấp chỗ trống.
- Project rules, CodeGraph/Graphify routing và RTK routing hiện có.

## 5. Ngôn ngữ và ranh giới

- Nội dung của `AGENTS.md` và `CLAUDE.md` dùng tiếng Anh.
- Cả hai file giữ rule: `Respond to the user and write project documentation in Vietnamese.`
- Không chuyển file khác sang tiếng Anh.
- Không thay source, tool config, permission, note Obsidian hoặc Git workflow.
- Hai file target đang có thay đổi chưa commit; không tự động stage hoặc commit chúng.

## 6. Kiểm chứng

- Xác nhận không còn heading hoặc instruction tiếng Việt trong hai file, ngoại trừ tên file/path tiếng Việt cần giữ nguyên.
- Xác nhận `AGENTS.md` có đủ `Accept`, `Partially accept`, `Challenge` và counter-review schema.
- Xác nhận `CLAUDE.md` có đủ `UPHOLD`, `REVISE`, `WITHDRAW` và không chứa instruction implementer.
- Xác nhận common project, CodeGraph/Graphify và RTK rules không drift ngoài khác biệt theo vai trò.
- Chạy placeholder scan và `git diff --check` trên đúng hai file.
