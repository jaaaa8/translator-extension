# MangaTranslator Worklog Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chuyển vault Obsidian sang `D:\MangaTranslator\docs`, bảo toàn lossless note tiến độ 1.716 dòng, tách lịch sử thành 14 canonical worklog và năm version summary, đồng thời giữ một index + timeline rút gọn dễ theo dõi.

**Architecture:** Thực hiện trên `feat/worklog-archive` bằng ba implementation commit có ranh giới dữ liệu rõ: snapshot note bẩn, pure move vault, rồi split/archive. Commit split dùng source blob của commit move làm nguồn bất biến, áp đúng sáu wikilink replacement trước khi cắt 15 source slice, sau đó kiểm tra bằng validator độc lập và Obsidian CLI đã ghim `vault=docs`.

**Tech Stack:** Git, Windows PowerShell 5.1 Desktop, Obsidian CLI, Obsidian Flavored Markdown, JSON, Markdown frontmatter.

**Source of truth:** `docs/superpowers/specs/2026-08-14-worklog-archive-design.md`.

## Global Constraints

- CWD duy nhất cho Task 0–3 là `D:\MangaTranslator`; branch phải là `feat/worklog-archive`.
- Không chạm, stash, clean hoặc remove `D:\MangaTranslator\.worktrees\spec-c-in-place-overlay-rendering`.
- Không tự merge vào `feat/v5`, không push và không mở PR.
- Planning docs phải được review trước Task 0. Task 0 là planning-only commit; sau đó đúng ba implementation commit là snapshot → move → split.
- Commit snapshot chỉ chứa `MangaTranslatorBrowser/Tiến độ MangaTranslator.md` ở trạng thái 1.716 dòng, SHA-256 `6AAF2B60AF33803E62FF2E7FBCC62C22DB86ACB507AD3F762A40466B862A3983`.
- Commit move giữ note chính byte-for-byte, chỉ move vault và sửa path/config đang hoạt động.
- Commit split không sửa code sản phẩm, test sản phẩm, historical prose/heading/path của specs/plans hoặc nội dung bốn JSON evidence.
- Chỉ đúng sáu wikilink lịch sử trong design spec §8 được đổi target; display label giữ nguyên.
- Source slice phải giữ nguyên byte sau khi normalize line ending và áp sáu replacement; scaffolding chỉ đứng ngoài slice.
- `date_start`, `date_end`, status enum, 14 filename có hậu tố `-worklog`, năm version summary và ownership phải khớp design spec.
- `feat/v4` luôn được mô tả là design/documentation checkpoint, không phải product increment.
- Foundation giữ `status: incomplete`; Spec C giữ `status: incomplete` vì Task 15 browser/manual còn mở.
- Mọi lệnh Obsidian đặt `vault=docs` ở tham số đầu và phải kiểm tra stdout, không chỉ exit code.
- Không chạy test Python/Node sản phẩm: đây là migration tài liệu. Verification bắt buộc là content, Git và Obsidian gates trong Task 3.

---

### Task 0: Chốt planning baseline sau khi plan được duyệt

**Files:**

- Modify: `docs/superpowers/specs/2026-08-14-worklog-archive-design.md`
- Create: `docs/superpowers/plans/2026-08-14-worklog-archive.md`
- Preserve unstaged: `MangaTranslatorBrowser/Tiến độ MangaTranslator.md`

**Interfaces:**

- Consumes: review PASS của design commit `0becd2d` và Minor mô tả thứ tự L10–13.
- Produces: planning HEAD sạch; working tree chỉ còn note tiến độ bẩn để Task 1 snapshot.

- [ ] **Step 1: Xác nhận branch và diff planning**

Run:

```powershell
git branch --show-current
git status --short --branch
git diff -- docs/superpowers/specs/2026-08-14-worklog-archive-design.md
```

Expected:

- Branch là `feat/worklog-archive`.
- Spec chỉ đổi `status` sang `approved`, cập nhật dòng trạng thái review và sửa mô tả L10–13 thành “H1, dòng trống, dòng mô tả dự án và dòng Spec/Plan/Nhánh”.
- Plan là file mới.
- Note tiến độ vẫn modified nhưng chưa stage.

- [ ] **Step 2: Chạy static gate cho hai planning docs**

Run:

```powershell
$planningFiles = @(
  'docs/superpowers/specs/2026-08-14-worklog-archive-design.md',
  'docs/superpowers/plans/2026-08-14-worklog-archive.md'
)
$text = ($planningFiles | ForEach-Object { Get-Content -Raw -Encoding UTF8 -LiteralPath $_ }) -join "`n"
$redFlags = @('T' + 'BD', 'T' + 'ODO', 'FIX' + 'ME', 'X' + 'XX')
foreach ($redFlag in $redFlags) {
  if ($text -match ("(?im)\b" + [regex]::Escape($redFlag) + "\b")) { throw "planning placeholder found: $redFlag" }
}
git diff --check -- $planningFiles
```

Expected: exit 0, không có placeholder hoặc whitespace error.

- [ ] **Step 3: Stage đúng hai planning docs**

Run:

```powershell
git add -- docs/superpowers/specs/2026-08-14-worklog-archive-design.md docs/superpowers/plans/2026-08-14-worklog-archive.md
$staged = @(git -c core.quotePath=false diff --cached --name-only)
$expected = @(
  'docs/superpowers/plans/2026-08-14-worklog-archive.md',
  'docs/superpowers/specs/2026-08-14-worklog-archive-design.md'
)
if (@(Compare-Object ($staged | Sort-Object) ($expected | Sort-Object)).Count -ne 0) {
  throw "unexpected staged planning scope: $($staged -join ', ')"
}
if (@(git diff --cached --name-only -- 'MangaTranslatorBrowser/Tiến độ MangaTranslator.md').Count -ne 0) {
  throw 'progress note must remain unstaged'
}
git diff --cached --check
```

Expected: đúng hai planning docs staged; note tiến độ không staged.

- [ ] **Step 4: Commit planning docs**

Run:

```powershell
git commit -m "docs: plan worklog archive"
git show --stat --oneline HEAD
git status --short --branch
```

Expected: commit chỉ có spec + plan; status còn đúng một modified progress note.

---

### Task 1: Snapshot nguyên trạng progress note

**Files:**

- Modify and commit unchanged-from-working-copy: `MangaTranslatorBrowser/Tiến độ MangaTranslator.md`

**Interfaces:**

- Consumes: planning HEAD của Task 0 và working-copy note đã được bảo toàn qua branch switch.
- Produces: `SNAPSHOT_COMMIT`, nguồn lịch sử nguyên vẹn trước mọi move/split.

- [ ] **Step 1: Kiểm tra precondition snapshot**

Run:

```powershell
$note = 'MangaTranslatorBrowser/Tiến độ MangaTranslator.md'
if ((git branch --show-current) -ne 'feat/worklog-archive') { throw 'wrong branch' }
$status = @(git status --porcelain=v1)
if ($status.Count -ne 1 -or $status[0] -notmatch '^ M ') { throw "unexpected worktree state: $($status -join '; ')" }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $note).Hash -ne '6AAF2B60AF33803E62FF2E7FBCC62C22DB86ACB507AD3F762A40466B862A3983') { throw 'snapshot hash mismatch' }
if ((Get-Content -Encoding UTF8 -LiteralPath $note).Count -ne 1716) { throw 'snapshot line count mismatch' }
git diff --numstat -- $note
git diff --check -- $note
```

Expected: `438 1`, 1.716 dòng, hash trùng, `diff --check` exit 0. Cảnh báo LF→CRLF không phải failure nhưng không được để Git thực sự rewrite nội dung.

- [ ] **Step 2: Stage duy nhất progress note**

Run:

```powershell
git add -- 'MangaTranslatorBrowser/Tiến độ MangaTranslator.md'
$staged = @(git -c core.quotePath=false diff --cached --name-only)
if ($staged.Count -ne 1 -or $staged[0] -ne 'MangaTranslatorBrowser/Tiến độ MangaTranslator.md') {
  throw "unexpected snapshot scope: $($staged -join ', ')"
}
git diff --cached --check
```

Expected: đúng một staged file.

- [ ] **Step 3: Commit snapshot**

Run:

```powershell
git commit -m "docs: snapshot MangaTranslator progress"
$snapshotCommit = git rev-parse HEAD
git show --name-status --stat --oneline $snapshotCommit
git status --short --branch
```

Expected: commit chỉ chứa progress note; working tree sạch.

- [ ] **Step 4: Xác minh blob snapshot sau commit**

Run:

```powershell
$blob = git rev-parse 'HEAD:MangaTranslatorBrowser/Tiến độ MangaTranslator.md'
$v4Blob = git rev-parse 'feat/v4:MangaTranslatorBrowser/Tiến độ MangaTranslator.md'
if ($blob -eq $v4Blob) { throw 'snapshot commit did not capture the dirty note' }
git show --format= --numstat HEAD
```

Expected: snapshot blob khác base v4/v5 cũ; numstat vẫn `438 1`.

---

### Task 2: Pure move vault sang `docs/`

**Files:**

- Move: `MangaTranslatorBrowser/Tiến độ MangaTranslator.md` → `docs/Tiến độ MangaTranslator.md`
- Move: `MangaTranslatorBrowser/.obsidian/app.json` → `docs/.obsidian/app.json`
- Move: `MangaTranslatorBrowser/.obsidian/appearance.json` → `docs/.obsidian/appearance.json`
- Move: `MangaTranslatorBrowser/.obsidian/core-plugins.json` → `docs/.obsidian/core-plugins.json`
- Move: `MangaTranslatorBrowser/.obsidian/graph.json` → `docs/.obsidian/graph.json`
- Modify: `.gitignore`
- Modify: `.graphifyignore`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `GIT-RULES.md`
- Preserve body: every historical file under `docs/superpowers/specs/`, `plans/` and `worklogs/`

**Interfaces:**

- Consumes: snapshot blob from Task 1.
- Produces: `MOVE_COMMIT`; note cùng blob ở path mới; vault config active tại `docs/.obsidian/`; vault sẵn sàng được mở lại trước Task 3.

- [ ] **Step 1: Ghi baseline blob/hash trước move**

Run:

```powershell
$oldNote = 'MangaTranslatorBrowser/Tiến độ MangaTranslator.md'
$newNote = 'docs/Tiến độ MangaTranslator.md'
$beforeBlob = git rev-parse "HEAD:$oldNote"
$beforeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $oldNote).Hash
if ($beforeHash -ne '6AAF2B60AF33803E62FF2E7FBCC62C22DB86ACB507AD3F762A40466B862A3983') { throw 'pre-move hash mismatch' }
```

- [ ] **Step 2: Move note và `.obsidian/`**

Run:

```powershell
git mv -- 'MangaTranslatorBrowser/Tiến độ MangaTranslator.md' 'docs/Tiến độ MangaTranslator.md'
git mv -- 'MangaTranslatorBrowser/.obsidian' 'docs/.obsidian'
```

Nếu local ignored `workspace.json` không đi cùng directory move, dùng `Move-Item -LiteralPath` để chuyển chính file đó sang `docs/.obsidian/workspace.json`; không stage nó.

- [ ] **Step 3: Cập nhật đúng path/config đang hoạt động**

Dùng `apply_patch` với đúng các thay đổi sau:

| File | Cũ | Mới |
|---|---|---|
| `.gitignore` | `MangaTranslatorBrowser/.obsidian/workspace.json` | `docs/.obsidian/workspace.json` |
| `.graphifyignore` | `MangaTranslatorBrowser/.obsidian/` | `docs/.obsidian/` |
| `AGENTS.md` | vault và progress path dưới `MangaTranslatorBrowser/` | vault `docs/`, progress `docs/Tiến độ MangaTranslator.md` |
| `CLAUDE.md` | vault và progress path dưới `MangaTranslatorBrowser/` | vault `docs/`, progress `docs/Tiến độ MangaTranslator.md` |
| `GIT-RULES.md` | ignored workspace path cũ | `docs/.obsidian/workspace.json` |

Không sửa hai historical plans có path cũ.

Thay toàn bộ `docs/.obsidian/app.json` bằng:

```json
{
  "promptDelete": false,
  "showUnsupportedFiles": true
}
```

- [ ] **Step 4: Chứng minh note là pure rename**

Run:

```powershell
$afterHash = (Get-FileHash -Algorithm SHA256 -LiteralPath 'docs/Tiến độ MangaTranslator.md').Hash
if ($afterHash -ne $beforeHash) { throw 'note content changed during move' }
if ((Get-Content -Encoding UTF8 -LiteralPath 'docs/Tiến độ MangaTranslator.md').Count -ne 1716) { throw 'note line count changed during move' }
git diff --summary --find-renames=100%
git diff --check
```

Expected: note hiển thị rename 100%; hash và 1.716 dòng không đổi.

- [ ] **Step 5: Kiểm tra scope move trước commit**

Run:

```powershell
$activeOldPaths = @(rg -n --fixed-strings 'MangaTranslatorBrowser' .gitignore .graphifyignore AGENTS.md CLAUDE.md GIT-RULES.md)
if ($activeOldPaths.Count -ne 0) { throw "active old paths remain: $($activeOldPaths -join '; ')" }

$historicalOldPathFiles = @(
  rg -l --fixed-strings 'MangaTranslatorBrowser' docs/superpowers/plans |
    ForEach-Object { $_.Replace('\', '/') } |
    Sort-Object
)
$expectedHistoricalOldPathFiles = @(
  'docs/superpowers/plans/2026-08-02-optimize-agent-instructions.md',
  'docs/superpowers/plans/2026-08-03-paced-quality-gate-rerun.md',
  'docs/superpowers/plans/2026-08-14-worklog-archive.md'
)
if (@(Compare-Object $historicalOldPathFiles $expectedHistoricalOldPathFiles).Count -ne 0) {
  throw "historical old-path inventory changed: $($historicalOldPathFiles -join ', ')"
}
git status --short
```

Expected:

- Không còn path active cũ trong năm file active.
- Path cũ chỉ còn trong đúng ba plan đã liệt kê và các plan đó không bị sửa.
- Bốn JSON evidence và hai Markdown artifact chưa đổi.

- [ ] **Step 6: Commit move**

Run:

```powershell
git add -- .gitignore .graphifyignore AGENTS.md CLAUDE.md GIT-RULES.md docs/.obsidian
git diff --cached --check
git diff --cached --summary --find-renames=100%
git commit -m "docs: move Obsidian vault to docs"
$moveCommit = git rev-parse HEAD
git show --stat --summary --find-renames=100% $moveCommit
```

Expected: note là rename 100%; commit không tạo canonical worklog hoặc version summary.

- [ ] **Step 7: Pause để đăng ký vault mới trong Obsidian**

Yêu cầu người dùng đóng vault `MangaTranslatorBrowser`, mở `D:\MangaTranslator\docs` một lần và để Obsidian đang chạy. Không bắt đầu Task 3 trước khi bước này xong.

Run sau khi người dùng xác nhận:

```powershell
$vaultPath = (obsidian vault=docs vault info=path | Out-String).Trim()
if ($vaultPath -ne 'D:\MangaTranslator\docs') { throw "wrong Obsidian vault: $vaultPath" }
$jsonCount = [int]((obsidian vault=docs files folder=superpowers/worklogs ext=json total | Out-String).Trim())
if ($jsonCount -ne 4) { throw "Obsidian JSON count=$jsonCount, expected 4" }
```

Expected: exact vault path và đúng bốn JSON. Chưa yêu cầu unresolved=0 ở commit move vì alias `MangaTranslator` được thêm trong Task 3.

---

### Task 3: Tách archive, dựng index và version summaries

**Files:**

- Rewrite: `docs/Tiến độ MangaTranslator.md`
- Create: 14 files `docs/superpowers/worklogs/*-worklog.md` theo bảng dưới
- Create: `docs/superpowers/worklogs/versions/feat-v1.md` … `feat-v5.md`
- Modify frontmatter only: `docs/superpowers/worklogs/2026-07-29-session-handoff.md`
- Modify frontmatter only: `docs/superpowers/worklogs/2026-07-30-progressive-translation-verification.md`
- Preserve byte-for-byte: four existing JSON evidence files
- Temporary ignored validator only: `.superpowers/sdd/worklog-archive/`

**Interfaces:**

- Consumes: immutable progress blob tại `MOVE_COMMIT:docs/Tiến độ MangaTranslator.md` và registered vault `docs`.
- Produces: 14 canonical worklogs, five version summaries, living index, resolved wikilinks và một split commit đã qua mọi gate.

- [ ] **Step 1: Pin immutable source và kiểm lại counts**

Run:

```powershell
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
  throw "Task 3 requires Windows PowerShell 5.1 Desktop; actual=$($PSVersionTable.PSVersion) edition=$($PSVersionTable.PSEdition)"
}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$moveCommit = git rev-parse HEAD
$blobSpec = "${moveCommit}:docs/Tiến độ MangaTranslator.md"
$sourceLines = @(& git show --no-textconv $blobSpec)
if ($LASTEXITCODE -ne 0) { throw 'cannot read move-commit progress blob' }
if ($sourceLines.Count -ne 1716) { throw "source lines=$($sourceLines.Count), expected 1716" }
if (-not (($sourceLines -join "`n").Contains('# Tiến độ MangaTranslator'))) { throw 'move-commit progress blob was not decoded as UTF-8' }
$h2 = @($sourceLines | Where-Object { $_ -match '^## ' })
if ($h2.Count -ne 60 -or @($h2 | Group-Object | Where-Object Count -gt 1).Count -ne 0) { throw 'source H2 inventory changed' }
```

Expected: 1.716 dòng, 60 H2, không H2 trùng.

- [ ] **Step 2: Áp đúng sáu replacement trước khi cắt slice**

Dùng mapping literal sau; mỗi source phải xuất hiện đúng một lần trước replace và bằng 0 sau replace:

```powershell
$replacements = [ordered]@{
  '[[#Backlog rút ra cho v2]]' = '[[2026-07-23-in-bubble-ocr-recall-worklog#Backlog rút ra cho v2]]'
  '[[#Thread A — hành động dịch theo bố cục hoàn tất trên v2 ✅ (2026-07-28)|Thread A]]' = '[[2026-07-23-layout-translation-actions-worklog#Thread A — hành động dịch theo bố cục hoàn tất trên v2 ✅ (2026-07-28)|Thread A]]'
  '[[Tiến độ MangaTranslator#Benchmark production — 20 cold + 20 warm (2026-07-31)|mục benchmark]]' = '[[2026-07-31-cold-benchmark-fixture-worklog#Benchmark production — 20 cold + 20 warm (2026-07-31)|mục benchmark]]'
  '[[Tiến độ MangaTranslator#Cập nhật Task 9–10 — 2026-07-30|mốc Task 9–10 trước]]' = '[[2026-07-29-progressive-translation-worklog#Cập nhật Task 9–10 — 2026-07-30|mốc Task 9–10 trước]]'
  '[[Tiến độ MangaTranslator#Spec A — code review Task 1–3 (2026-08-02)]]' = '[[2026-08-01-telemetry-real-fixture-quality-gate-worklog#Spec A — code review Task 1–3 (2026-08-02)]]'
  '[[Tiến độ MangaTranslator#Spec A — tạm dừng sau Task 2 (2026-08-01)]]' = '[[2026-08-01-telemetry-real-fixture-quality-gate-worklog#Spec A — tạm dừng sau Task 2 (2026-08-01)]]'
}

```

Không thay display label, heading text hoặc số dòng.

- [ ] **Step 3: Tạo 14 canonical worklogs từ 15 source slice**

Dùng bulk mechanical rewrite hoặc `apply_patch`. Nếu cần helper, chỉ tạo dưới `.superpowers/sdd/worklog-archive/` và không stage. Mapping bắt buộc:

| File | Slices | `date_start` → `date_end` | Status | Versions |
|---|---|---|---|---|
| `2026-07-21-manga-translator-foundation-worklog.md` | 15–145 | 07-21 → 07-21 | incomplete | feat-v1 |
| `2026-07-23-in-bubble-ocr-recall-worklog.md` | 146–236, 248–251, 253–273 | 07-23 → 07-28 | done | feat-v1 |
| `2026-07-23-layout-translation-actions-worklog.md` | 237–247, 252, 274–332 | 07-23 → 07-28 | done | feat-v1 |
| `2026-07-29-viewport-ocr-prewarm-gemini-failover-worklog.md` | 333–381 | 07-29 → 07-29 | done | feat-v2 |
| `2026-07-29-progressive-translation-worklog.md` | 382–745 | 07-29 → 07-30 | done | feat-v2 |
| `2026-07-30-browser-acceptance-harness-worklog.md` | 746–809 | 07-30 → 07-31 | done | feat-v2 |
| `2026-07-31-cold-benchmark-fixture-worklog.md` | 810–865 | 07-31 → 07-31 | done | feat-v2 |
| `2026-08-01-telemetry-real-fixture-quality-gate-worklog.md` | 866–1110 | 08-01 → 08-03 | done | feat-v3 |
| `2026-08-03-paced-quality-gate-rerun-worklog.md` | 1111–1120 | 08-03 → 08-03 | done | feat-v3 |
| `2026-08-04-reading-order-full-page-translation-worklog.md` | 1121–1280 | 08-04 → 08-05 | done | feat-v3 |
| `2026-08-02-cross-model-review-protocol-worklog.md` | docs/Git | 08-02 → 08-05 | done | feat-v3, feat-v4 |
| `2026-08-02-rtk-code-intelligence-routing-worklog.md` | docs/Git | 08-02 → 08-05 | done | feat-v3, feat-v4 |
| `2026-08-03-workflow-guide-worklog.md` | docs/Git | 08-03 → 08-05 | done | feat-v4 |
| `2026-08-08-in-place-clean-overlay-rendering-worklog.md` | 1281–1716 | 08-08 → 08-14 | incomplete | feat-v4, feat-v5 |

Mỗi file dùng frontmatter schema trong design spec §5.3. Lists phải cụ thể:

- Foundation: spec `[[2026-07-21-manga-translator-design]]`, plan `[[2026-07-21-manga-translator]]`, artifacts `[]`.
- In-bubble: spec/plan cùng slug `2026-07-23-in-bubble-ocr-recall`, artifacts `[]`.
- Layout: spec `[[2026-07-23-layout-modes-unified-design]]`, plan `[[2026-07-28-layout-translation-actions]]`, artifacts `[]`.
- Viewport/Gemini: spec `[[2026-07-29-viewport-ocr-prewarm-gemini-failover-design]]`, hai plans `[[2026-07-29-viewport-ocr-prewarming]]`, `[[2026-07-29-gemini-project-failover]]`, artifact `[[2026-07-29-session-handoff]]`.
- Progressive: spec `[[2026-07-30-progressive-translation-workflow-design]]`, plan `[[2026-07-30-progressive-translation-session-cache]]`, artifact `[[2026-07-30-progressive-translation-verification]]`.
- Browser acceptance: spec/plan `2026-07-30-browser-acceptance-harness[-design]`, artifacts `[]`.
- Cold benchmark: spec/plan `2026-07-31-cold-benchmark-fixture[-design]`, artifact `[[2026-07-31-cold-warm-benchmark.json]]`.
- Telemetry: spec/plan `2026-08-01-telemetry-real-fixture-quality-gate[-design]`, artifact `[[2026-08-01-real-page-quality-baseline.json]]`.
- Paced rerun: spec/plan `2026-08-03-paced-quality-gate-rerun[-design]`, artifact `[[2026-08-03-real-page-quality-gate-rerun.json]]`.
- Reading order: spec/plan `2026-08-04-reading-order-full-page-translation[-design]`, artifact `[[2026-08-04-reading-order-full-page-translation.json]]`.
- Cross-model: spec `[[2026-08-02-cross-model-review-protocol-design]]`, plan `[[2026-08-02-optimize-agent-instructions]]`, artifacts `[]`.
- RTK routing: spec `[[2026-08-02-rtk-code-intelligence-routing-design]]`, plans/artifacts `[]`.
- Workflow guide: spec `[[2026-08-03-workflow-guide-design]]`, plan `[[2026-08-03-workflow-guide]]`, artifacts `[]`; body nhắc root `workflow-guide.md` bằng inline code.
- Spec C: spec `[[2026-08-08-in-place-clean-overlay-rendering-design]]`, plan `[[2026-08-09-in-place-clean-overlay-rendering]]`, artifacts `[]`.

Mỗi summary callout phải nêu đúng kết luận sau, không suy diễn thêm:

1. Foundation dựng server/extension/pipeline; Tasks 1–7 đóng, Task 8 vẫn mở.
2. In-bubble chẩn đoán B2/B3 và cải thiện full-res/pad/upscale; Thread B đóng.
3. Layout thêm hành động dịch theo layout và hardening stale/responsive races; Thread A đóng.
4. Viewport/Gemini thêm prewarm/dedupe và failover hai project có review concurrency; đóng.
5. Progressive gom latency, dedupe, roadmap, DeepL và triển khai streaming/session cache thành một narrative; đóng.
6. Acceptance harness tạo control plane/faults và đóng các case Chrome có kiểm soát.
7. Cold benchmark chạy 20 cold + 20 warm trên production server và lưu evidence.
8. Telemetry/real fixture đi qua policy probe, offline quality gate và human review; đóng.
9. Paced rerun chọn `full_page`, pace probe và lưu quyết định/evidence.
10. Reading order/full-page thêm direction, Portuguese Latin OCR, strict contract và cleanup fixes; đóng.
11. Cross-model thiết lập evidence-mediated review giữa Codex và Claude, áp dụng tại `5196832`.
12. RTK routing đo truncation và chốt intelligence-first/RTK-last tại `5196832`.
13. Workflow guide nối end-to-end source bằng `workflow-guide.md` và commit `c2de341`.
14. Spec C hoàn tất tới Task 14; Task 15 browser/manual còn mở nên worklog incomplete.

Đặt cross-link Thread A và heading scaffolding đúng design spec §7.1, chỉ giữa slices.

- [ ] **Step 4: Chuẩn hóa hai Markdown artifact hiện có**

Giữ body byte-for-byte. Session handoff giữ title/date/tags/status hiện tại và thêm:

```yaml
note_type: artifact
artifact_type: handoff
work_item: viewport-ocr-prewarm-gemini-failover
date_start: 2026-07-29
date_end: 2026-07-29
versions:
  - "[[feat-v2]]"
```

Progressive verification nhận frontmatter mới:

```yaml
---
title: Progressive translation verification
note_type: artifact
artifact_type: verification
work_item: progressive-translation
date_start: 2026-07-30
date_end: 2026-07-30
status: done
versions:
  - "[[feat-v2]]"
tags:
  - mangatranslator/artifact
---
```

- [ ] **Step 5: Tạo năm version summaries bằng topology Git**

Chạy và lưu facts, không dump toàn log vào note:

```powershell
git log --no-merges --topo-order --reverse feat/v1
git log --merges --topo-order --reverse feat/v1
git log --no-merges --topo-order --reverse feat/v1..feat/v2
git log --no-merges --topo-order --reverse feat/v2..feat/v3
git log --no-merges --topo-order --reverse feat/v3..feat/v4
git log --no-merges --topo-order --reverse feat/v4..feat/v5
```

Frontmatter và kết luận bắt buộc:

| File | Base | Dates | Status | Kết luận |
|---|---|---|---|---|
| `feat-v1.md` | `root` | 07-21 → 07-29 | done | 33 non-merge + merge `62948d7`; nền tảng/OCR/layout, không che Task 8 mở |
| `feat-v2.md` | `feat/v1` | 07-29 → 07-31 | done | 66 non-merge; progressive, acceptance harness, benchmark |
| `feat-v3.md` | `feat/v2` | 07-31 → 08-05 | done | 72 non-merge; telemetry/quality, reading order/full-page |
| `feat-v4.md` | `feat/v3` | 08-05 → 08-09 | checkpoint | 8/8 docs/chore; design/documentation checkpoint |
| `feat-v5.md` | `feat/v4` | 08-09 → 08-14 | incomplete | 25 non-merge; Spec C tới Task 14, Task 15 mở |

Mỗi body có đúng các section: `Kết luận`, `Git facts`, `Work items`, `Vấn đề và cách giải quyết`, `Verification`, `Còn lại`, `Key commits`.

Key commits tối thiểu:

- v1: `b6100ee`, `5cd5b78`, `d3a3776`, `44351ad`, `6084405`, `d016038`.
- v2: `b920fdd`, `36fd4d0`, `770d728`, `91b1553`, `90e88bc`, `4ea75ea`, `daf80e2`.
- v3: `43c0016`, `01d1dfe`, `c6d963b`, `a7c16da`, `1fa3e15`, `665769a`, `04e695e`, `fec60ac`, `a37fbde`, `3fc910d`.
- v4: `5196832`, `c2de341`, `b07d192`, `8fe88c8`; ghi rõ các commit còn lại cũng docs/chore.
- v5: `82c122b`, `5f61499`, `d1e2d1f`, `3719e36`, `3b4397b`, `fc8dbed`, `b1ec9cc`, `6770d74`.

- [ ] **Step 6: Viết living index + timeline rút gọn**

Frontmatter chính xác:

```yaml
---
title: Tiến độ MangaTranslator
aliases:
  - MangaTranslator
date: 2026-07-21
note_type: index
status: active
tags:
  - mangatranslator
  - tien-do
---
```

Ngay sau frontmatter, giữ nguyên liên tục source L10–13 theo thứ tự: H1, dòng trống, dòng mô tả dự án, dòng Spec/Plan/Nhánh.

Body có các section: `Tổng quan hiện tại`, `Hành trình version`, `Việc còn mở`, `Timeline`, `Work items`.

- `Việc còn mở` nêu Foundation Task 8 và Spec C Task 15.
- `Hành trình version` link `[[feat-v1|feat/v1]]` … `[[feat-v5|feat/v5]]`; v4 ghi checkpoint, v5 ghi incomplete.
- `Work items` link đủ 14 canonical worklog.
- `Timeline` có đúng 60 dòng, cùng thứ tự 60 source H2. Mỗi dòng tối đa 30 từ trước link, chỉ dùng facts trong source section, theo mẫu:

```markdown
- 2026-07-29 — Đo latency thật dẫn tới ưu tiên streaming/session cache thay vì đổi model; [[2026-07-29-progressive-translation-worklog#Đo latency thật + phương án tối ưu (2026-07-29)|xem mốc và bằng chứng]].
```

Mỗi H2 nguồn phải xuất hiện đúng một lần làm raw anchor trong timeline. Bốn anchor có backtick giữ nguyên payload.

- [ ] **Step 7: Chạy lossless split validator**

Tạo temporary validator dưới `.superpowers/sdd/worklog-archive/` bằng `apply_patch`; không stage. Validator phải:

1. Resolve move commit theo exact commit subject; đọc source bằng `git cat-file` với UTF-8 chỉ định, giữ newline cuối rồi normalize CRLF/CR thành LF.
2. Assert sáu source link mỗi cái xuất hiện một lần; áp sáu replacement literal.
3. Assert 15 ranges liên tục, tổng 1.702 dòng, kết thúc L1716.
4. Với từng range, assert exact slice xuất hiện liên tục đúng một lần trong đúng owner và đúng một lần trên toàn bộ 14 canonical worklog.
5. Assert source L10–13 xuất hiện nguyên văn liên tục đúng một lần trong index.
6. Assert hai support artifact chỉ đổi frontmatter; body sau closing `---` bằng body nguồn trước Task 3.
7. Assert bốn JSON có Git blob identity bằng `$moveCommit`, tức byte-for-byte không đổi.

Tạo `.superpowers/sdd/worklog-archive/validate-worklog-archive.ps1` với nội dung đầy đủ sau:

```powershell
param(
  [Parameter(Mandatory = $true)][string]$RepositoryRoot,
  [string]$MoveCommit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
  throw "validator requires Windows PowerShell 5.1 Desktop; actual=$($PSVersionTable.PSVersion) edition=$($PSVersionTable.PSEdition)"
}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ([string]::IsNullOrWhiteSpace($MoveCommit)) {
  $MoveCommit = (& git -C $RepositoryRoot log --first-parent -1 --format=%H '--grep=^docs: move Obsidian vault to docs$' | Out-String).Trim()
}
if ([string]::IsNullOrWhiteSpace($MoveCommit)) { throw 'move commit could not be resolved' }
$moveSubject = (& git -C $RepositoryRoot show -s --format=%s $MoveCommit | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $moveSubject -ne 'docs: move Obsidian vault to docs') {
  throw "invalid move commit: $MoveCommit subject=$moveSubject"
}

function Normalize-Newlines([string]$Text) {
  return $Text.Replace("`r`n", "`n").Replace("`r", "`n")
}

function Read-Blob([string]$RelativePath) {
  $gitPath = $RelativePath.Replace('\', '/')
  $blobSpec = "${MoveCommit}:$gitPath"
  if ($blobSpec.Contains('"')) { throw "unsupported quote in blob spec: $blobSpec" }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = 'git.exe'
  $startInfo.WorkingDirectory = $RepositoryRoot
  $startInfo.Arguments = "cat-file blob `"$blobSpec`""
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $exitCode = $process.ExitCode
  }
  finally {
    $process.Dispose()
  }
  if ($exitCode -ne 0) { throw "cannot read blob: $blobSpec; $stderr" }
  return Normalize-Newlines $stdout
}

function Read-WorkspaceFile([string]$RelativePath) {
  $path = Join-Path $RepositoryRoot $RelativePath
  if (-not (Test-Path -LiteralPath $path)) { throw "missing file: $RelativePath" }
  return Normalize-Newlines (Get-Content -Raw -Encoding UTF8 -LiteralPath $path)
}

function Count-Literal([string]$Text, [string]$Literal) {
  return ([regex]::Matches($Text, [regex]::Escape($Literal))).Count
}

function Remove-Frontmatter([string]$Text) {
  $normalized = Normalize-Newlines $Text
  if (-not $normalized.StartsWith("---`n")) { return $normalized }
  $end = $normalized.IndexOf("`n---`n", 4, [StringComparison]::Ordinal)
  if ($end -lt 0) { throw 'unterminated frontmatter' }
  return $normalized.Substring($end + 5)
}

function Get-CodeMask([string]$Text) {
  $mask = [bool[]]::new($Text.Length)
  $lineStart = 0
  $inFence = $false
  $fenceChar = ''
  $fenceLength = 0

  while ($lineStart -lt $Text.Length) {
    $newline = $Text.IndexOf("`n", $lineStart)
    $lineEnd = if ($newline -lt 0) { $Text.Length } else { $newline + 1 }
    $contentEnd = if ($newline -lt 0) { $Text.Length } else { $newline }
    $line = $Text.Substring($lineStart, $contentEnd - $lineStart)
    $fence = [regex]::Match($line, '^[ \t]{0,3}(`{3,}|~{3,})')

    if ($inFence) {
      for ($i = $lineStart; $i -lt $lineEnd; $i++) { $mask[$i] = $true }
      if ($fence.Success -and $fence.Groups[1].Value[0] -eq $fenceChar -and $fence.Groups[1].Value.Length -ge $fenceLength) {
        $inFence = $false
      }
    }
    elseif ($fence.Success) {
      $inFence = $true
      $fenceChar = $fence.Groups[1].Value[0]
      $fenceLength = $fence.Groups[1].Value.Length
      for ($i = $lineStart; $i -lt $lineEnd; $i++) { $mask[$i] = $true }
    }
    else {
      $cursor = $lineStart
      while ($cursor -lt $contentEnd) {
        if ($Text[$cursor] -ne [char]96) { $cursor++; continue }
        $runStart = $cursor
        while ($cursor -lt $contentEnd -and $Text[$cursor] -eq [char]96) { $cursor++ }
        $ticks = ([string][char]96) * ($cursor - $runStart)
        $remaining = $Text.Substring($cursor, $contentEnd - $cursor)
        $relativeClose = $remaining.IndexOf($ticks, [StringComparison]::Ordinal)
        if ($relativeClose -lt 0) { continue }
        $closeEnd = $cursor + $relativeClose + $ticks.Length
        for ($i = $runStart; $i -lt $closeEnd; $i++) { $mask[$i] = $true }
        $cursor = $closeEnd
      }
    }

    $lineStart = $lineEnd
  }

  return ,$mask
}

function Get-RawLinks([string]$Text, [string]$SourcePath) {
  $mask = Get-CodeMask $Text
  $links = [System.Collections.Generic.List[object]]::new()
  foreach ($match in [regex]::Matches($Text, '\[\[[^\]\r\n]+\]\]')) {
    if ($mask[$match.Index]) { continue }
    $links.Add([pscustomobject]@{
      Source = $SourcePath
      Raw = $match.Value
      Payload = $match.Value.Substring(2, $match.Value.Length - 4)
    })
  }
  return $links
}

function Get-Aliases([string]$Text) {
  $aliases = [System.Collections.Generic.List[string]]::new()
  $lines = (Normalize-Newlines $Text) -split "`n"
  if ($lines.Count -eq 0 -or $lines[0] -ne '---') { return $aliases }
  $insideAliases = $false
  for ($i = 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -eq '---') { break }
    if ($lines[$i] -match '^aliases:\s*$') { $insideAliases = $true; continue }
    if ($insideAliases -and $lines[$i] -match '^\s+-\s+(.+?)\s*$') {
      $aliases.Add($Matches[1].Trim('"', "'"))
      continue
    }
    if ($insideAliases -and $lines[$i] -match '^\S') { $insideAliases = $false }
  }
  return $aliases
}

$source = Read-Blob 'docs/Tiến độ MangaTranslator.md'
$sourceLines = $source -split "`n"
if ($sourceLines.Count -ne 1716) { throw "source lines=$($sourceLines.Count), expected 1716" }

$replacements = [ordered]@{
  '[[#Backlog rút ra cho v2]]' = '[[2026-07-23-in-bubble-ocr-recall-worklog#Backlog rút ra cho v2]]'
  '[[#Thread A — hành động dịch theo bố cục hoàn tất trên v2 ✅ (2026-07-28)|Thread A]]' = '[[2026-07-23-layout-translation-actions-worklog#Thread A — hành động dịch theo bố cục hoàn tất trên v2 ✅ (2026-07-28)|Thread A]]'
  '[[Tiến độ MangaTranslator#Benchmark production — 20 cold + 20 warm (2026-07-31)|mục benchmark]]' = '[[2026-07-31-cold-benchmark-fixture-worklog#Benchmark production — 20 cold + 20 warm (2026-07-31)|mục benchmark]]'
  '[[Tiến độ MangaTranslator#Cập nhật Task 9–10 — 2026-07-30|mốc Task 9–10 trước]]' = '[[2026-07-29-progressive-translation-worklog#Cập nhật Task 9–10 — 2026-07-30|mốc Task 9–10 trước]]'
  '[[Tiến độ MangaTranslator#Spec A — code review Task 1–3 (2026-08-02)]]' = '[[2026-08-01-telemetry-real-fixture-quality-gate-worklog#Spec A — code review Task 1–3 (2026-08-02)]]'
  '[[Tiến độ MangaTranslator#Spec A — tạm dừng sau Task 2 (2026-08-01)]]' = '[[2026-08-01-telemetry-real-fixture-quality-gate-worklog#Spec A — tạm dừng sau Task 2 (2026-08-01)]]'
}

# Giữ value rỗng khi raw heading hoạt động trong Obsidian. Chỉ điền block ID
# cho heading tương ứng nếu Step 10 phải dùng fallback đã duyệt trong design spec.
$anchorFallbacks = [ordered]@{
  'Task 5 — Pipeline + `/translate` ✅ (2026-07-21)' = ''
  'Kiểm chứng lại `ocr-manga-extension-roadmap.md` (2026-07-29)' = ''
  '2026-08-03 — Spec A paced quality-gate rerun: chọn `full_page`' = ''
  '2026-08-05 — Spec B post-checkpoint fix `8a4b08d`' = ''
}
$configuredFallbacks = @($anchorFallbacks.GetEnumerator() | Where-Object { -not [string]::IsNullOrWhiteSpace($_.Value) })
$configuredIds = @($configuredFallbacks | ForEach-Object { $_.Value })
if (@($configuredIds | Sort-Object -Unique).Count -ne $configuredIds.Count) {
  throw 'duplicate configured fallback block ID'
}

$rewritten = $source
foreach ($old in $replacements.Keys) {
  if ((Count-Literal $rewritten $old) -ne 1) { throw "replacement source count is not 1: $old" }
  $rewritten = $rewritten.Replace($old, $replacements[$old])
  if ((Count-Literal $rewritten $old) -ne 0) { throw "replacement source remains: $old" }
}
$rewrittenLines = $rewritten -split "`n"

$ranges = @(
  [pscustomobject]@{ Start=15; End=145; File='docs/superpowers/worklogs/2026-07-21-manga-translator-foundation-worklog.md' },
  [pscustomobject]@{ Start=146; End=236; File='docs/superpowers/worklogs/2026-07-23-in-bubble-ocr-recall-worklog.md' },
  [pscustomobject]@{ Start=237; End=247; File='docs/superpowers/worklogs/2026-07-23-layout-translation-actions-worklog.md' },
  [pscustomobject]@{ Start=248; End=251; File='docs/superpowers/worklogs/2026-07-23-in-bubble-ocr-recall-worklog.md' },
  [pscustomobject]@{ Start=252; End=252; File='docs/superpowers/worklogs/2026-07-23-layout-translation-actions-worklog.md' },
  [pscustomobject]@{ Start=253; End=273; File='docs/superpowers/worklogs/2026-07-23-in-bubble-ocr-recall-worklog.md' },
  [pscustomobject]@{ Start=274; End=332; File='docs/superpowers/worklogs/2026-07-23-layout-translation-actions-worklog.md' },
  [pscustomobject]@{ Start=333; End=381; File='docs/superpowers/worklogs/2026-07-29-viewport-ocr-prewarm-gemini-failover-worklog.md' },
  [pscustomobject]@{ Start=382; End=745; File='docs/superpowers/worklogs/2026-07-29-progressive-translation-worklog.md' },
  [pscustomobject]@{ Start=746; End=809; File='docs/superpowers/worklogs/2026-07-30-browser-acceptance-harness-worklog.md' },
  [pscustomobject]@{ Start=810; End=865; File='docs/superpowers/worklogs/2026-07-31-cold-benchmark-fixture-worklog.md' },
  [pscustomobject]@{ Start=866; End=1110; File='docs/superpowers/worklogs/2026-08-01-telemetry-real-fixture-quality-gate-worklog.md' },
  [pscustomobject]@{ Start=1111; End=1120; File='docs/superpowers/worklogs/2026-08-03-paced-quality-gate-rerun-worklog.md' },
  [pscustomobject]@{ Start=1121; End=1280; File='docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation-worklog.md' },
  [pscustomobject]@{ Start=1281; End=1716; File='docs/superpowers/worklogs/2026-08-08-in-place-clean-overlay-rendering-worklog.md' }
)

$canonicalFiles = @(Get-ChildItem -File -LiteralPath (Join-Path $RepositoryRoot 'docs/superpowers/worklogs') -Filter '*-worklog.md')
if ($canonicalFiles.Count -ne 14) { throw "canonical worklogs=$($canonicalFiles.Count), expected 14" }
$canonicalText = ($canonicalFiles | ForEach-Object { Normalize-Newlines (Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName) }) -join "`n"

$previousEnd = 14
$rangeCount = 0
$rangeTotal = 0
foreach ($range in $ranges) {
  $start = [int]$range.Start
  $end = [int]$range.End
  if ($start -ne $previousEnd + 1) { throw "range gap/overlap at $start" }
  $ownerText = Read-WorkspaceFile $range.File
  $slice = $rewrittenLines[($start - 1)..($end - 1)] -join "`n"
  if ((Count-Literal $ownerText $slice) -ne 1) { throw "owner slice count failed: $($range.File) L$start-L$end" }
  if ((Count-Literal $canonicalText $slice) -ne 1) { throw "global slice count failed: L$start-L$end" }
  $previousEnd = $end
  $rangeCount++
  $rangeTotal += $end - $start + 1
}
if ($rangeCount -ne 15 -or $rangeTotal -ne 1702 -or $previousEnd -ne 1716) { throw 'range inventory failed' }

$index = Read-WorkspaceFile 'docs/Tiến độ MangaTranslator.md'
$indexHead = $sourceLines[9..12] -join "`n"
if ((Count-Literal $index $indexHead) -ne 1) { throw 'index L10-L13 preservation failed' }

$supportFiles = @(
  'docs/superpowers/worklogs/2026-07-29-session-handoff.md',
  'docs/superpowers/worklogs/2026-07-30-progressive-translation-verification.md'
)
foreach ($relativePath in $supportFiles) {
  $beforeBody = Remove-Frontmatter (Read-Blob $relativePath)
  $afterBody = Remove-Frontmatter (Read-WorkspaceFile $relativePath)
  if ($beforeBody -ne $afterBody) { throw "support body changed: $relativePath" }
}

$jsonFiles = @(
  'docs/superpowers/worklogs/2026-07-31-cold-warm-benchmark.json',
  'docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json',
  'docs/superpowers/worklogs/2026-08-03-real-page-quality-gate-rerun.json',
  'docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json'
)
foreach ($relativePath in $jsonFiles) {
  $beforeBlob = (& git -C $RepositoryRoot rev-parse "${MoveCommit}:$relativePath" | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "cannot resolve JSON blob: $relativePath" }
  $currentBlob = (& git -C $RepositoryRoot hash-object -- $relativePath | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "cannot hash JSON: $relativePath" }
  if ($beforeBlob -ne $currentBlob) { throw "JSON changed: $relativePath" }
}

$docsRoot = Join-Path $RepositoryRoot 'docs'
$markdown = @(Get-ChildItem -Recurse -File -Filter '*.md' -LiteralPath $docsRoot)
$duplicates = @($markdown | Group-Object BaseName | Where-Object Count -gt 1)
if ($duplicates.Count -ne 0) { throw "duplicate Markdown basenames: $($duplicates.Name -join ', ')" }
$versions = @(
  Get-ChildItem -File -LiteralPath (Join-Path $docsRoot 'superpowers/worklogs/versions') |
    Where-Object { $_.Name -match '^feat-v[1-5]\.md$' }
)
if ($versions.Count -ne 5) { throw "version summaries=$($versions.Count), expected 5" }

$targets = @{}
$aliases = @{}
foreach ($file in @(Get-ChildItem -Recurse -File -LiteralPath $docsRoot)) {
  $relative = $file.FullName.Substring($docsRoot.Length + 1).Replace('\', '/')
  if ($file.Extension -eq '.md') {
    $targets[$file.BaseName] = @($relative)
    foreach ($alias in (Get-Aliases (Read-WorkspaceFile ("docs/" + $relative)))) {
      if (-not $aliases.ContainsKey($alias)) { $aliases[$alias] = @() }
      $aliases[$alias] += $relative
    }
  }
  else {
    $targets[$file.Name] = @($relative)
  }
}

$allLinks = [System.Collections.Generic.List[object]]::new()
foreach ($file in $markdown) {
  $relative = $file.FullName.Substring($docsRoot.Length + 1).Replace('\', '/')
  $text = Read-WorkspaceFile ("docs/" + $relative)
  foreach ($link in (Get-RawLinks $text $relative)) { $allLinks.Add($link) }
}

$indexAnchors = [System.Collections.Generic.List[string]]::new()
$indexCoveredH2 = [System.Collections.Generic.List[string]]::new()
foreach ($link in $allLinks) {
  $target = ($link.Payload -split '\|', 2)[0]
  $hashIndex = $target.IndexOf('#')
  $filePart = if ($hashIndex -ge 0) { $target.Substring(0, $hashIndex) } else { $target }
  $anchor = if ($hashIndex -ge 0) { $target.Substring($hashIndex + 1) } else { '' }
  if ([string]::IsNullOrWhiteSpace($filePart)) { throw "same-note prose link is forbidden: $($link.Source) $($link.Raw)" }

  $leaf = [IO.Path]::GetFileName($filePart)
  $extension = [IO.Path]::GetExtension($leaf)
  $lookup = if ($extension -eq '.md') { [IO.Path]::GetFileNameWithoutExtension($leaf) } else { $leaf }
  if ($lookup -in @('AGENTS.md','CLAUDE.md','workflow-guide.md','AGENTS','CLAUDE','workflow-guide')) {
    throw "root document used as wikilink: $($link.Raw)"
  }

  $candidates = @()
  if ($targets.ContainsKey($lookup)) { $candidates += $targets[$lookup] }
  if ($aliases.ContainsKey($lookup)) { $candidates += $aliases[$lookup] }
  $candidates = @($candidates | Sort-Object -Unique)
  if ($candidates.Count -ne 1) { throw "unresolved/ambiguous target: $($link.Source) $($link.Raw)" }

  $targetPath = $candidates[0]
  if ($anchor) {
    if (-not $targetPath.EndsWith('.md')) { throw "anchor targets non-Markdown: $($link.Raw)" }
    $targetText = Read-WorkspaceFile ("docs/" + $targetPath)
    if ($anchor.StartsWith('^')) {
      $blockId = [regex]::Escape($anchor.Substring(1))
      $anchorCount = ([regex]::Matches($targetText, "(?m)(?:^|\s)\^${blockId}\s*$" )).Count
    }
    else {
      $anchorCount = 0
      foreach ($heading in [regex]::Matches($targetText, '(?m)^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$')) {
        if ($heading.Groups[1].Value -eq $anchor) { $anchorCount++ }
      }
    }
    if ($anchorCount -ne 1) { throw "missing/ambiguous anchor: $($link.Source) $($link.Raw) count=$anchorCount" }
  }

  if ($link.Source -eq 'Tiến độ MangaTranslator.md' -and $lookup.EndsWith('-worklog') -and $anchor) {
    $indexAnchors.Add($anchor)
    $coveredH2 = $anchor
    if ($anchor.StartsWith('^')) {
      $fallbackMatches = @($configuredFallbacks | Where-Object { $_.Value -eq $anchor.Substring(1) })
      if ($fallbackMatches.Count -ne 1) { throw "unmapped/ambiguous index fallback block ID: $anchor" }
      $coveredH2 = [string]$fallbackMatches[0].Key
    }
    $indexCoveredH2.Add($coveredH2)
  }
}

$sourceH2 = @($sourceLines | Where-Object { $_ -match '^## ' } | ForEach-Object { $_.Substring(3) })
if ($indexAnchors.Count -ne 60) { throw "index canonical anchor links=$($indexAnchors.Count), expected 60" }
if (@($indexAnchors | Sort-Object -Unique).Count -ne 60) { throw 'index canonical anchor links are not unique' }
if ($indexCoveredH2.Count -ne 60 -or @($indexCoveredH2 | Sort-Object -Unique).Count -ne 60) {
  throw 'index source-H2 coverage is not unique'
}
if (@(Compare-Object ($sourceH2 | Sort-Object) ($indexCoveredH2 | Sort-Object)).Count -ne 0) { throw 'index/source H2 coverage mismatch' }
$indexAliasTargets = if ($aliases.ContainsKey('MangaTranslator')) { @($aliases['MangaTranslator']) } else { @() }
if ($indexAliasTargets.Count -ne 1 -or $indexAliasTargets[0] -ne 'Tiến độ MangaTranslator.md') {
  throw 'MangaTranslator alias does not resolve uniquely to index'
}

"canonical_worklogs=14"
"source_ranges=$rangeCount"
"source_lines=$rangeTotal"
"index_head_lines=4"
"allowlisted_rewrites=$($replacements.Count)"
"support_bodies_preserved=$($supportFiles.Count)"
"json_artifacts_preserved=$($jsonFiles.Count)"
"markdown_basename_duplicates=0"
"canonical_worklog_anchor_links=$($indexAnchors.Count)"
"unresolved_files=0"
"missing_or_ambiguous_anchors=0"
"external_root_wikilinks=0"
"lossless_split=PASS"
"raw_link_validator=PASS"
```

Sau khi tạo script bằng `apply_patch`, chuyển encoding cơ học sang UTF-8 có BOM trước lần parse đầu tiên của Windows PowerShell 5.1:

```powershell
$validatorPath = 'D:\MangaTranslator\.superpowers\sdd\worklog-archive\validate-worklog-archive.ps1'
$validatorText = [IO.File]::ReadAllText($validatorPath, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($validatorPath, $validatorText, [Text.UTF8Encoding]::new($true))
$validatorBytes = [IO.File]::ReadAllBytes($validatorPath)
if ($validatorBytes.Length -lt 3 -or $validatorBytes[0] -ne 0xEF -or $validatorBytes[1] -ne 0xBB -or $validatorBytes[2] -ne 0xBF) {
  throw 'validator is not UTF-8 with BOM'
}

powershell.exe -NoProfile -File $validatorPath -RepositoryRoot 'D:\MangaTranslator'
if ($LASTEXITCODE -ne 0) { throw "validator exit=$LASTEXITCODE" }
```

Expected summary:

```text
canonical_worklogs=14
source_ranges=15
source_lines=1702
index_head_lines=4
allowlisted_rewrites=6
support_bodies_preserved=2
json_artifacts_preserved=4
lossless_split=PASS
```

- [ ] **Step 8: Chạy basename và raw wikilink/anchor validator**

Trong cùng validator, parser link phải làm đúng thứ tự:

1. Mark offset ranges của fenced code và inline code trên raw Markdown.
2. Tìm raw `[[...]]` spans mà không sửa text.
3. Chỉ bỏ span có start offset nằm trong code range.
4. Resolve file bằng basename duy nhất hoặc alias frontmatter duy nhất; JSON target giữ extension.
5. Với `#heading`, so raw anchor với raw heading và yêu cầu count=1.
6. Với `#^block-id`, yêu cầu raw block ID count=1.
7. Fail nếu prose wikilink target là `AGENTS.md`, `CLAUDE.md` hoặc `workflow-guide.md`.

Validator đồng thời assert:

- không basename Markdown trùng;
- đúng 14 `*-worklog.md` và năm `versions/feat-vN.md`;
- index có đúng 60 canonical worklog anchor links; mỗi H2 nguồn được phủ đúng một lần bằng raw heading hoặc block ID đã khai báo trong `$anchorFallbacks`;
- alias `MangaTranslator` resolve duy nhất tới `docs/Tiến độ MangaTranslator.md`;
- mọi heading target count=1.

Expected summary:

```text
markdown_basename_duplicates=0
canonical_worklog_anchor_links=60
unresolved_files=0
missing_or_ambiguous_anchors=0
external_root_wikilinks=0
raw_link_validator=PASS
```

- [ ] **Step 9: Chạy Obsidian CLI gates trên đúng vault**

Run:

```powershell
$vaultPath = (obsidian vault=docs vault info=path | Out-String).Trim()
if ($vaultPath -ne 'D:\MangaTranslator\docs') { throw "wrong vault: $vaultPath" }

$jsonCount = [int]((obsidian vault=docs files folder=superpowers/worklogs ext=json total | Out-String).Trim())
if ($jsonCount -ne 4) { throw "JSON count=$jsonCount" }

$unresolved = (obsidian vault=docs unresolved total | Out-String).Trim()
if ($unresolved -ne '0') { throw "unresolved total=$unresolved" }

$evidenceDir = 'D:\MangaTranslator\.superpowers\sdd\worklog-archive'
obsidian vault=docs unresolved verbose format=json | Tee-Object -FilePath "$evidenceDir\unresolved-final.json"
```

Expected: exact path, JSON count 4, unresolved total 0. Evidence nằm trong ignored tool-state directory, không stage.

- [ ] **Step 10: Kiểm tra manual bốn backtick anchors**

Run:

```powershell
obsidian vault=docs open path='Tiến độ MangaTranslator.md'
```

Trong Reading view, click lần lượt bốn timeline link chứa các heading raw sau:

```text
Task 5 — Pipeline + `/translate` ✅ (2026-07-21)
Kiểm chứng lại `ocr-manga-extension-roadmap.md` (2026-07-29)
2026-08-03 — Spec A paced quality-gate rerun: chọn `full_page`
2026-08-05 — Spec B post-checkpoint fix `8a4b08d`
```

Mỗi link phải mở đúng worklog và đúng heading. Nếu một link không nhảy đúng heading:

1. Thêm block ID duy nhất vào summary scaffolding mới của target; không sửa historical heading.
2. Đổi riêng link index sang `#^block-id`.
3. Điền đúng block ID, không có ký tự `^`, vào value của raw H2 tương ứng trong `$anchorFallbacks` của validator.
4. Chạy lại Steps 7–10; source-H2 coverage vẫn phải là 60/60 duy nhất.

- [ ] **Step 11: Kiểm tra final diff và staged scope**

Run:

```powershell
git diff --check
git status --short
git diff --stat
git diff -- docs/superpowers/specs docs/superpowers/plans
git diff -- docs/superpowers/worklogs/2026-07-31-cold-warm-benchmark.json docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json docs/superpowers/worklogs/2026-08-03-real-page-quality-gate-rerun.json docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation.json
```

Expected:

- Không diff trong historical specs/plans.
- Không diff trong bốn JSON.
- Chỉ index, 14 canonical worklogs, năm version summaries và frontmatter của hai support notes thay đổi.
- Temporary validator/evidence không xuất hiện trong status.

- [ ] **Step 12: Stage archive và commit split**

Run:

```powershell
git add -- 'docs/Tiến độ MangaTranslator.md' 'docs/superpowers/worklogs'
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: split MangaTranslator worklog archive"
$splitCommit = git rev-parse HEAD
git show --stat --oneline $splitCommit
```

Expected: commit không chứa source/test/config; bốn JSON không xuất hiện vì không đổi.

- [ ] **Step 13: Chạy post-commit verification đầy đủ**

Run lại Steps 7–10 từ committed files, sau đó:

```powershell
git status --short --branch
git log --follow --oneline -- 'docs/Tiến độ MangaTranslator.md'
$moveCommit = (& git log --first-parent -1 --format=%H '--grep=^docs: move Obsidian vault to docs$' | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($moveCommit)) { throw 'move commit could not be resolved after split' }
git show --summary --find-renames=100% $moveCommit
```

Expected:

- Working tree sạch, ngoại trừ ignored `.superpowers/sdd/worklog-archive/` không hiện trong status.
- `git log --follow` nối qua commit move tới lịch sử note cũ và snapshot commit.
- Commit move vẫn báo rename 100% cho progress note.
- Mọi content/Obsidian gate vẫn PASS sau commit.

Không xóa temporary directory trong cùng turn nếu còn cần làm evidence review. Chỉ xóa sau khi người dùng duyệt kết quả; trước khi xóa phải resolve và kiểm tra exact path nằm dưới `D:\MangaTranslator\.superpowers\sdd\worklog-archive`.

---

## Completion Evidence

Khi bàn giao implementation, báo đúng các dữ kiện sau:

- SHA ba implementation commits: snapshot, move, split.
- `git show --summary --find-renames=100%` của move commit.
- Lossless summary: 15 ranges, 1.702 lines, 6 rewrites, 2 support bodies, 4 JSON hashes.
- Link summary: 0 basename duplicate, 60 timeline anchors, 0 unresolved file/anchor, 0 root-doc wikilink.
- Obsidian evidence: exact vault path, 4 JSON, unresolved total 0, kết quả click bốn backtick anchors.
- Version facts: 33/66/72/8/25 non-merge; v4 checkpoint; v5/Spec C Task 15 còn mở.
- `git status --short --branch` sau commit.

Không báo product tests, Task 15 hoặc toàn bộ Spec C PASS vì migration này không kiểm chứng các phạm vi đó.
