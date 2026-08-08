# Agent Instruction and Cross-Model Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chuyển `AGENTS.md` và `CLAUDE.md` sang instruction tiếng Anh, đồng thời thiết lập vòng review–counter-review dựa trên bằng chứng giữa Codex và Claude.

**Architecture:** `AGENTS.md` định nghĩa Codex là implementation partner có independent judgment; `CLAUDE.md` định nghĩa Claude là reviewer-only. Hai file dùng chung project/tool/RTK rules, nhưng mỗi file có protocol riêng cho review tranh chấp và đều yêu cầu output/tài liệu dự án bằng tiếng Việt.

**Tech Stack:** Markdown, PowerShell static checks, Git diff

## Global Constraints

- Chỉ sửa `AGENTS.md` và `CLAUDE.md`; không sửa source, tool config, permission hoặc note Obsidian.
- Toàn bộ instruction trong hai file dùng tiếng Anh; path có tên tiếng Việt được giữ nguyên.
- Cả hai file chứa đúng câu: `Respond to the user and write project documentation in Vietnamese.`
- Codex kiểm chứng Claude review; không phục tùng hoặc phản đối theo thẩm quyền.
- Claude đánh giá lại counter-review; không bảo vệ finding cũ theo quán tính.
- Người dùng là người quyết định cuối cùng.
- Giữ CodeGraph/Graphify routing và RTK truncation guards hiện có.
- Hai target file đang có thay đổi chưa commit; không tự động stage hoặc commit chúng.

---

### Task 1: Viết AGENTS.md cho Codex independent judgment

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: current Codex working discipline, project rules và tool routing.
- Produces: English instruction cho implementation partner và counter-review schema.

- [ ] **Step 1: Viết role và independent-judgment contract**

Các heading bắt buộc:

```md
## Role: implementation partner with independent judgment
## Independent judgment and review handling
## Working discipline
```

Rule phải cho phép Codex chủ động so sánh phương án tốt hơn trong phạm vi yêu cầu; tối ưu mở rộng phạm vi chỉ được đề xuất, không tự triển khai.

- [ ] **Step 2: Viết Claude-review protocol**

Mỗi finding phải được phân loại `Accept`, `Partially accept` hoặc `Challenge`. Finding tranh chấp có tác động đáng kể phải dừng trước khi áp dụng và tạo counter-review tự chứa theo schema:

```text
Assessment
Evidence
Better alternative
Trade-offs
Recommendation
```

Rule phải nói rõ finding đúng được triển khai và kiểm chứng; disagreement chỉ hợp lệ khi có requirement, source, test hoặc trade-off cụ thể.

- [ ] **Step 3: Chuyển working/project/tool rules sang tiếng Anh**

Giữ Karpathy discipline đã tối ưu, Obsidian, Git, Vietnamese output, CodeGraph/Graphify và RTK routing.

- [ ] **Step 4: Kiểm tra AGENTS.md**

Run:

```powershell
$text = Get-Content -Raw -Encoding UTF8 AGENTS.md
@('Accept','Partially accept','Challenge','Assessment','Evidence','Better alternative','Trade-offs','Recommendation','Respond to the user and write project documentation in Vietnamese.') | ForEach-Object { if (-not $text.Contains($_)) { throw "missing AGENTS contract: $_" } }
```

Expected: exit 0.

### Task 2: Viết CLAUDE.md cho reviewer và counter-review

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: current reviewer contract, severity policy và common project/tool rules.
- Produces: English reviewer-only instruction có protocol đánh giá Codex rebuttal.

- [ ] **Step 1: Giữ reviewer-only và review contract ở đầu file**

Claude không sửa code/tài liệu, commit, branch hoặc PR trừ khi user cho phép ghi file rõ trong chính lượt đó. `Critical` và `Important` chặn PASS; `Minor` không chặn PASS trừ strict review.

- [ ] **Step 2: Viết Codex-counter-review protocol**

Thêm heading:

```md
## Reviewing Codex counterarguments
```

Mỗi finding tranh chấp kết thúc bằng `UPHOLD`, `REVISE` hoặc `WITHDRAW`, kèm evidence. Claude không đổi kết luận chỉ vì Codex phản đối và không giữ kết luận chỉ vì Claude đã nói trước.

- [ ] **Step 3: Chuyển review/project/tool rules sang tiếng Anh**

Giữ review discipline, Obsidian, Git, Vietnamese output, CodeGraph/Graphify và RTK routing. RTK wording phải dùng `source needed for review`, không dùng `code needed for edits`.

- [ ] **Step 4: Kiểm tra CLAUDE.md**

Run:

```powershell
$text = Get-Content -Raw -Encoding UTF8 CLAUDE.md
@('UPHOLD','REVISE','WITHDRAW','Respond to the user and write project documentation in Vietnamese.') | ForEach-Object { if (-not $text.Contains($_)) { throw "missing CLAUDE contract: $_" } }
@('Before implementing','When editing existing code','code needed for edits') | ForEach-Object { if ($text.Contains($_)) { throw "implementer instruction remains: $_" } }
```

Expected: exit 0.

### Task 3: Kiểm chứng language, consistency và scope

**Files:**
- Verify: `AGENTS.md`
- Verify: `CLAUDE.md`

**Interfaces:**
- Consumes: hai file hoàn chỉnh từ Task 1 và Task 2.
- Produces: diff reviewable, không có thay đổi ngoài phạm vi.

- [ ] **Step 1: Kiểm tra tiếng Việt ngoài path và output rule**

Đọc toàn bộ hai file và xác nhận không còn heading hoặc prose instruction tiếng Việt. Tên path `MangaTranslatorBrowser/Tiến độ MangaTranslator.md` được phép giữ nguyên.

- [ ] **Step 2: Kiểm tra placeholder và whitespace**

Run:

```powershell
rg -n 'TBD|TODO|FIXME|PLACEHOLDER' AGENTS.md CLAUDE.md
git -c safe.directory=D:/MangaTranslator diff --check -- AGENTS.md CLAUDE.md
```

Expected: `rg` không có match; `git diff --check` exit 0.

- [ ] **Step 3: Kiểm tra status và không commit**

Run:

```powershell
git -c safe.directory=D:/MangaTranslator diff -- AGENTS.md CLAUDE.md
git -c safe.directory=D:/MangaTranslator status --short
```

Expected: chỉ hai instruction file chứa thay đổi implementation của task; note Obsidian vẫn là thay đổi sẵn có. Bàn giao uncommitted để người dùng review.
