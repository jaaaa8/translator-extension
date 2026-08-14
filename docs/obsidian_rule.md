---
title: Quy tắc cập nhật Obsidian worklog
aliases:
  - obsidian_rule
note_type: rule
status: active
date: 2026-08-14
tags:
  - mangatranslator/documentation
  - mangatranslator/worklog
---

# Quy tắc cập nhật Obsidian worklog

> [!important] Mục tiêu
> Append đúng work item, giữ nguyên lịch sử cũ và để [[Tiến độ MangaTranslator]] tiếp tục là index + timeline rút gọn. Chi tiết ownership và ngoại lệ archive nằm trong [[2026-08-14-worklog-archive-design]].

## Chọn note sở hữu trước khi append

1. Luôn pin vault `docs` và xác nhận path là `D:\MangaTranslator\docs`.
2. Xác định `work_item` của phiên từ spec, plan, branch và phạm vi evidence.
3. Tìm canonical note trong `docs/superpowers/worklogs/*-worklog.md` có frontmatter `work_item` tương ứng.
4. Nếu đã có owner, append chi tiết vào cuối canonical worklog đó; không append chi tiết vào index, version summary, spec hoặc plan lịch sử.
5. Nếu chưa có owner, dừng để xác định mapping, `date_start`, spec/plan/version và trạng thái trước khi tạo canonical worklog mới. Không chọn note gần tên nhất theo phỏng đoán.
6. JSON/handoff/verification vẫn là artifact evidence; link chúng từ canonical worklog thay vì biến artifact thành worklog thứ hai.

## Cách append một mốc lịch sử

- Dùng H2 mới theo mẫu `## YYYY-MM-DD — <phạm vi>: <mốc>` và đặt sau toàn bộ nội dung cũ.
- Cập nhật `date_end` của canonical worklog thành ngày của mốc vừa append. Chỉ đổi `status` khi có evidence thực sự đóng hoặc mở lại work item, và chỉ dùng enum đóng `done | incomplete | paused | superseded` trong design archive; focused test xanh không đủ để chuyển sang `done` nếu browser/manual gate còn mở.
- Không sửa lại prose, heading, checklist hoặc evidence của phiên trước. Không normalize whitespace lịch sử.
- Ghi theo mạch có thể kiểm chứng: bối cảnh/trạng thái → triệu chứng hoặc vấn đề → root cause → quyết định/fix nhỏ nhất → RED → GREEN → review → phạm vi còn mở.
- Chỉ ghi lệnh, số test, commit và trạng thái đã quan sát thật. Focused test xanh không tự động đóng browser/manual QA hoặc gate ngoài phạm vi.
- Giữ link tới spec, plan, artifact và version ở frontmatter/list hiện có; khi thêm link mới phải dùng basename duy nhất trong vault.

## Khi nào cập nhật index và version summary

- Với mốc đáng theo dõi, thêm đúng một dòng vào `## Timeline` của [[Tiến độ MangaTranslator]] theo thứ tự thời gian: tóm tắt “vấn đề → fix/quyết định → kết quả” và link tới H2 vừa append.
- Chỉ đổi `## Việc còn mở` hoặc trạng thái work item khi có evidence thực sự thay đổi trạng thái. Không chép RED/GREEN, stack trace hoặc fix round chi tiết vào index.
- Chỉ sửa `versions/feat-vN.md` khi ranh giới, kết luận, trạng thái bàn giao hoặc Git facts của version thay đổi; không append mọi session vào version summary.

## Verification bắt buộc

```powershell
$vaultPath = (obsidian vault=docs vault info=path | Out-String).Trim()
if ($vaultPath -ne 'D:\MangaTranslator\docs') { throw "wrong vault: $vaultPath" }
obsidian vault=docs read path='<canonical-worklog-path>'
obsidian vault=docs outline path='<canonical-worklog-path>' format=json
obsidian vault=docs unresolved verbose format=json
```

- Read back phải chứa đúng H2 và nội dung vừa append một lần.
- `outline` phải chứa anchor đích đúng một lần. Với heading có backtick, click link trong Reading view trước khi báo PASS.
- Unresolved set phải khớp exact allowlist hiện hành; bất kỳ entry mới nào đều fail.
- Chạy validator archive khi thay đổi index/link/anchor. Gate whitespace phải dùng closed allowlist ở Gate 7 của design archive; warning mới vẫn fail.
- Không stage/commit/push thay đổi vault nếu người dùng chưa yêu cầu. Không stage `docs/.obsidian/` UI state cùng worklog.
