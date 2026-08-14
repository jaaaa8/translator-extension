---
title: Thiết kế kho lưu trữ worklog MangaTranslator
note_type: design-spec
date: 2026-08-14
status: approved
branch: feat/worklog-archive
tags:
  - mangatranslator
  - documentation
  - worklog-archive
---

# Thiết kế kho lưu trữ worklog MangaTranslator

**Nhánh thực hiện:** `feat/worklog-archive`, tách từ tip `feat/v5` tại `6770d74`

**Trạng thái:** review PASS ngày 2026-08-14; Minor mô tả L10–13 đã sửa; sẵn sàng lập implementation plan

## 1. Kết quả cần đạt

Tài liệu tiến độ hiện tại có 1.716 dòng và trộn nhiều loại thông tin: mốc triển khai, điều tra lỗi, quyết định thiết kế, bằng chứng kiểm chứng và trạng thái đóng phiên. Migration phải biến nó thành một kho lịch sử dễ đọc mà không làm mất mạch “vấn đề → quyết định/fix → kết quả”.

Kết quả cuối cùng gồm:

1. Vault Obsidian chuyển từ `D:\MangaTranslator\MangaTranslatorBrowser` sang `D:\MangaTranslator\docs`.
2. `docs/Tiến độ MangaTranslator.md` trở thành index + timeline rút gọn, khoảng 200–250 dòng.
3. Nội dung chi tiết được chia thành đúng 14 canonical worklog theo work item, không ép quan hệ “một spec + một plan” khi dữ liệu thực tế là many-to-many.
4. Năm note `feat-v1.md` đến `feat-v5.md` tóm tắt quá trình của từng version bằng topology Git.
5. Sáu artifact hiện có trong `docs/superpowers/worklogs/` được giữ nguyên vai trò, tên và vị trí.
6. Toàn bộ prose, heading, checklist và bằng chứng lịch sử được bảo toàn, ngoại trừ đúng sáu target wikilink đã duyệt.
7. Các gate tự động chứng minh đủ ba lớp: file/link tồn tại, anchor đúng và duy nhất, nội dung lịch sử không bị mất hoặc nhân đôi.

Không tạo một archive copy thứ hai của note lớn. Snapshot Git trước khi tách là bản lưu nguyên vẹn, tránh nội dung trùng và backlink trùng trong Obsidian.

## 2. Ranh giới và chiến lược Git

### 2.1 Checkout và worktree

- Làm việc tại checkout chính `D:\MangaTranslator` trên nhánh ngắn hạn `feat/worklog-archive`.
- Nhánh được tạo trực tiếp từ commit `6770d74`, là tip hiện tại của `feat/v5` khi bắt đầu công việc.
- `feat/v5` đang được checkout tại `D:\MangaTranslator\.worktrees\spec-c-in-place-overlay-rendering`; không remove, clean, stash hoặc sửa worktree đó trong công việc archive.
- Khi archive hoàn tất và người dùng chọn tích hợp, merge ngược vào `feat/v5` phải chạy bên trong worktree trên. Chạy switch/merge `feat/v5` tại checkout chính sẽ lỗi vì nhánh đã được worktree khác giữ.
- Không tự push, merge hoặc xóa nhánh.

Tại thời điểm ghi thiết kế, linked worktree `feat/v5` có thay đổi chưa commit trong plan Spec C, acceptance app, test và một JSON worklog. Đây là trạng thái ngoài phạm vi, phải được giữ nguyên.

### 2.2 Chuỗi commit

Design spec này là planning commit riêng. Sau khi spec và implementation plan được duyệt, migration dùng đúng ba implementation commit:

1. **Snapshot:** commit riêng nội dung hiện tại của `MangaTranslatorBrowser/Tiến độ MangaTranslator.md` nguyên trạng. Đây là 1.716 dòng, gồm 438 dòng thêm và một dòng thay đổi so với base.
2. **Move vault:** pure move note và `.obsidian/` sang `docs/`, đồng thời chỉ cập nhật các path/config đang hoạt động. Nội dung note chính vẫn byte-for-byte như snapshot để `git log --follow` nhận diện rename.
3. **Split archive:** tạo 14 canonical worklog, năm version summary, index + timeline rút gọn, frontmatter, cross-link và đúng sáu wikilink rewrite; sau đó chạy toàn bộ acceptance gate.

Không gộp move và split trong một commit. Gộp hai bước sẽ làm similarity của note giảm mạnh và biến lịch sử thành “xóa + tạo mới” thay vì rename có thể lần theo.

## 3. Vault và cây file đích

Vault root được chốt là `D:\MangaTranslator\docs`, không phải repo root. Như vậy specs, plans và worklogs cùng nằm trong vault, nhưng Obsidian không index Markdown trong `venv/`, `graphify-out/`, `extension/` hoặc `server/`.

```text
docs/
├── .obsidian/
├── Tiến độ MangaTranslator.md
└── superpowers/
    ├── specs/
    ├── plans/
    └── worklogs/
        ├── YYYY-MM-DD-<work-item>-worklog.md
        ├── 2026-07-29-session-handoff.md
        ├── 2026-07-30-progressive-translation-verification.md
        ├── 2026-07-31-cold-warm-benchmark.json
        ├── 2026-08-01-real-page-quality-baseline.json
        ├── 2026-08-03-real-page-quality-gate-rerun.json
        ├── 2026-08-04-reading-order-full-page-translation.json
        └── versions/
            ├── feat-v1.md
            ├── feat-v2.md
            ├── feat-v3.md
            ├── feat-v4.md
            └── feat-v5.md
```

Sau move, `MangaTranslatorBrowser/` không còn nội dung dự án. Các config `.obsidian` tracked được chuyển sang `docs/.obsidian/`; `workspace.json` tiếp tục là state local bị ignore và không được commit.

### 3.1 File path đang hoạt động phải cập nhật trong commit move

Chỉ cập nhật năm file tracked ngoài vault đang chứa path cũ:

- `.gitignore`
- `.graphifyignore`
- `AGENTS.md`
- `CLAUDE.md`
- `GIT-RULES.md`

Hai plan lịch sử ngày 2026-08-02 và 2026-08-03 có nhắc path cũ nhưng không được sửa. Chúng ghi lại bối cảnh đúng tại thời điểm được viết; sửa chúng sẽ viết lại quá khứ.

`docs/.obsidian/app.json` phải giữ `promptDelete: false` và thêm `showUnsupportedFiles: true`. Setting này cho phép bốn JSON evidence xuất hiện trong vault. Không thêm `.base` ở migration này.

### 3.2 Nguồn ngoài vault

`AGENTS.md`, `CLAUDE.md` và `workflow-guide.md` vẫn ở repo root. Khi worklog nhắc tới chúng, dùng inline-code path, không dùng wikilink, vì chúng nằm ngoài vault `docs/`.

## 4. Quyền sở hữu nội dung và quy tắc bảo toàn lịch sử

### 4.1 Tài liệu lịch sử đã có

Với specs, plans và hai Markdown artifact hiện có, chỉ được thêm/sửa frontmatter hoặc alias. Prose, heading và path trong thân bài giữ nguyên, kể cả khi phát biểu lịch sử không còn đúng ở hiện tại, ngoại trừ đúng một target wikilink được nêu tên và đóng phạm vi trong mục 4.2.

Note tiến độ là ngoại lệ có kiểm soát:

- Nội dung được di chuyển sang các worklog con.
- Mọi prose, heading và checklist nguồn phải giữ nguyên.
- Chỉ đúng sáu wikilink trong mục 8 được đổi target; display label gốc giữ nguyên.
- Scaffolding mới như frontmatter, summary callout, danh sách liên kết và separator chỉ được đặt trước, sau hoặc giữa các source slice; không chen vào bên trong slice.

### 4.2 Sáu artifact sẵn có

Hai Markdown artifact giữ nguyên body:

| File | `work_item` | `artifact_type` | Thao tác |
|---|---|---|---|
| `2026-07-29-session-handoff.md` | `viewport-ocr-prewarm-gemini-failover` | `handoff` | Giữ body ngoài một target wikilink được allowlist; chuẩn hóa frontmatter |
| `2026-07-30-progressive-translation-verification.md` | `progressive-translation` | `verification` | Chỉ thêm frontmatter |

Ngoại lệ đóng duy nhất cho artifact: trong `2026-07-29-session-handoff.md`, đổi target đúng một wikilink `[[MangaTranslator]]` thành `[[Tiến độ MangaTranslator|MangaTranslator]]`. Display label `MangaTranslator` giữ nguyên; phần body còn lại phải byte-identical. Ngoại lệ này không mở rộng sang artifact còn lại hoặc bất kỳ prose/heading/path nào khác.

Bốn JSON giữ nguyên tên, nội dung và vị trí:

| File | Work item sở hữu |
|---|---|
| `2026-07-31-cold-warm-benchmark.json` | `cold-benchmark-fixture` |
| `2026-08-01-real-page-quality-baseline.json` | `telemetry-real-fixture-quality-gate` |
| `2026-08-03-real-page-quality-gate-rerun.json` | `paced-quality-gate-rerun` |
| `2026-08-04-reading-order-full-page-translation.json` | `reading-order-full-page-translation` |

## 5. Quy tắc tên, ngày và frontmatter

### 5.1 Tên canonical worklog

Mọi canonical worklog dùng mẫu:

```text
YYYY-MM-DD-<work-item>-worklog.md
```

Hậu tố `-worklog` là bắt buộc cho cả 14 file. Nếu bỏ hậu tố, bảy worklog sẽ trùng basename với plan và Obsidian có thể resolve một link về chính file nguồn thay vì plan đích trong khi `unresolved total` vẫn bằng 0.

Toàn bộ basename Markdown trong vault phải duy nhất, không chỉ basename của worklog.

### 5.2 Định nghĩa ngày

Với mỗi work item:

```text
date_start = min(
  ngày trong tên spec thuộc work item,
  ngày trong tên plan thuộc work item,
  ngày của source section đầu tiên thuộc work item
)
```

Bỏ qua thành phần không tồn tại. Prefix filename phải bằng `date_start`.

`date_end` là ngày mới nhất của event thực sự được đưa vào worklog. Nó không suy ra trạng thái hoàn thành.

### 5.3 Frontmatter canonical worklog

```yaml
---
title: <tiêu đề đọc được>
note_type: worklog
work_item: <slug ổn định>
date_start: YYYY-MM-DD
date_end: YYYY-MM-DD
status: done
versions:
  - "[[feat-v2]]"
specs:
  - "[[2026-07-30-progressive-translation-workflow-design]]"
plans:
  - "[[2026-07-30-progressive-translation-session-cache]]"
artifacts:
  - "[[2026-07-30-progressive-translation-verification]]"
tags:
  - mangatranslator/worklog
---
```

`versions` luôn là list wikilink tới version summary, không phải plain text. JSON artifact phải được link kèm extension, ví dụ `[[2026-07-31-cold-warm-benchmark.json]]`.

Enum status đóng cho canonical worklog:

- `done`: work item đã đóng với bằng chứng phù hợp.
- `incomplete`: còn task/gate bắt buộc chưa hoàn tất.
- `paused`: dừng có chủ ý và có trạng thái bàn giao.
- `superseded`: nội dung đã bị một work item khác thay thế.

`active` chỉ dành cho living index `Tiến độ MangaTranslator.md`, không dùng cho canonical worklog. Không tự suy diễn `done` từ ngày cuối hoặc focused test xanh.

Hai support note dùng `note_type: artifact`, `artifact_type: handoff | verification`; session handoff có `status: paused`, progressive verification có `status: done`.

### 5.4 Cấu trúc body canonical worklog

Mỗi file gồm:

1. H1.
2. Summary callout theo “vấn đề → quyết định/fix → kết quả hoặc trạng thái mở”.
3. Liên kết tới spec, plan, artifact và version liên quan.
4. Separator.
5. Các source slice lịch sử nguyên khối, theo thứ tự thời gian.

Ba worklog chỉ có nguồn docs/Git được phép tái dựng event có ngày từ spec, plan, diff và commit; không được giả tạo log triển khai mà Git không chứng minh.

## 6. Mapping 14 work item

| # | Canonical worklog | Nguồn progress note | Spec / plan / artifact | Version | Status |
|---|---|---|---|---|---|
| 1 | `2026-07-21-manga-translator-foundation-worklog.md` | L15–145 | spec `2026-07-21-manga-translator-design.md`; plan `2026-07-21-manga-translator.md` | v1 | `incomplete` |
| 2 | `2026-07-23-in-bubble-ocr-recall-worklog.md` | L146–236, L248–251, L253–273 | spec `2026-07-23-in-bubble-ocr-recall-design.md`; plan `2026-07-23-in-bubble-ocr-recall.md` | v1 | `done` |
| 3 | `2026-07-23-layout-translation-actions-worklog.md` | L237–247, L252, L274–332 | spec `2026-07-23-layout-modes-unified-design.md`; plan `2026-07-28-layout-translation-actions.md` | v1 | `done` |
| 4 | `2026-07-29-viewport-ocr-prewarm-gemini-failover-worklog.md` | L333–381 | spec `2026-07-29-viewport-ocr-prewarm-gemini-failover-design.md`; plans `2026-07-29-viewport-ocr-prewarming.md`, `2026-07-29-gemini-project-failover.md`; handoff MD | v2 | `done` |
| 5 | `2026-07-29-progressive-translation-worklog.md` | L382–745 | spec `2026-07-30-progressive-translation-workflow-design.md`; plan `2026-07-30-progressive-translation-session-cache.md`; verification MD | v2 | `done` |
| 6 | `2026-07-30-browser-acceptance-harness-worklog.md` | L746–809 | spec `2026-07-30-browser-acceptance-harness-design.md`; plan `2026-07-30-browser-acceptance-harness.md` | v2 | `done` |
| 7 | `2026-07-31-cold-benchmark-fixture-worklog.md` | L810–865 | spec `2026-07-31-cold-benchmark-fixture-design.md`; plan `2026-07-31-cold-benchmark-fixture.md`; cold/warm JSON | v2 | `done` |
| 8 | `2026-08-01-telemetry-real-fixture-quality-gate-worklog.md` | L866–1110 | spec `2026-08-01-telemetry-real-fixture-quality-gate-design.md`; plan cùng slug; baseline JSON | v3 | `done` |
| 9 | `2026-08-03-paced-quality-gate-rerun-worklog.md` | L1111–1120 | spec `2026-08-03-paced-quality-gate-rerun-design.md`; plan cùng slug; rerun JSON | v3 | `done` |
| 10 | `2026-08-04-reading-order-full-page-translation-worklog.md` | L1121–1280 | spec `2026-08-04-reading-order-full-page-translation-design.md`; plan cùng slug; full-page JSON | v3 | `done` |
| 11 | `2026-08-02-cross-model-review-protocol-worklog.md` | Không có source section | spec `2026-08-02-cross-model-review-protocol-design.md`; plan `2026-08-02-optimize-agent-instructions.md`; các hunk liên quan trong `5196832` | v3 → v4 | `done` |
| 12 | `2026-08-02-rtk-code-intelligence-routing-worklog.md` | Không có source section | spec `2026-08-02-rtk-code-intelligence-routing-design.md`; benchmark trong spec; các hunk RTK trong `5196832`; không gán plan riêng | v3 → v4 | `done` |
| 13 | `2026-08-03-workflow-guide-worklog.md` | Không có source section | spec `2026-08-03-workflow-guide-design.md`; plan `2026-08-03-workflow-guide.md`; root `workflow-guide.md`; commit `c2de341` | v4 | `done` |
| 14 | `2026-08-08-in-place-clean-overlay-rendering-worklog.md` | L1281–1716 | spec `2026-08-08-in-place-clean-overlay-rendering-design.md`; plan `2026-08-09-in-place-clean-overlay-rendering.md` | v4 → v5 | `incomplete` |

Các trạng thái bắt buộc phải nói rõ:

- Foundation giữ Task 8 đang mở; version sau không cung cấp bằng chứng đóng task đó.
- Spec C giữ Task 15 browser/manual acceptance đang mở. Task 14 xanh không đồng nghĩa toàn bộ Spec C hoàn tất.
- Các section latency, dedupe, kiểm chứng roadmap, phân tích DeepL và trạng thái đóng phiên thuộc cùng narrative progressive translation; không tách thành note vụn.

## 7. Index + timeline rút gọn

`docs/Tiến độ MangaTranslator.md` sở hữu phần đầu L1–14 của snapshot và trở thành living index.

Frontmatter mới gồm `note_type: index`, `status: active` và alias `MangaTranslator`. Alias phục vụ quick switcher và search, nhưng không tham gia wikilink resolution của Obsidian. Vì vậy link trong session handoff phải dùng target tường minh `[[Tiến độ MangaTranslator|MangaTranslator]]` theo ngoại lệ đóng tại mục 4.2.

Trong body:

- Giữ nguyên byte nội dung bốn dòng gốc L10–13: H1, dòng trống, dòng mô tả dự án và dòng Spec/Plan/Nhánh. Vị trí dòng trong file mới có thể thay đổi vì frontmatter mới.
- Thêm các section: tổng quan hiện tại, hành trình version, việc còn mở, timeline và danh sách 14 work item.
- Mỗi H2 lịch sử trong snapshot sinh đúng một dòng timeline, theo thứ tự nguồn. Mỗi dòng tóm tắt ngắn “vấn đề → fix/quyết định → kết quả” và link tới H2 nguyên văn trong worklog sở hữu.
- Nguồn hiện có 60 H2 và tất cả duy nhất. Index chỉ link tới H2; không link tới bốn nhóm H3 bị trùng.
- Chi tiết RED/GREEN, fix round, stack trace, lệnh và bằng chứng nằm trong worklog con, không lặp lại ở index.

Bốn nhóm H3 trùng trong nguồn là:

- `Verdict cuối` ×4
- `Chuỗi commit` ×3
- `Verification và trạng thái` ×3
- `Nhật ký lỗi và các fix round` ×3

### 7.1 Ranh giới Thread B và Thread A

Quy tắc này thay thế mọi phát biểu trước đó về việc chèn điều hướng ngay dưới H2 L218:

- Trong in-bubble worklog, đặt cross-link Thread A giữa source slice L146–236 và L248–251. Không chèn vào bên trong L146–236.
- Trong layout worklog, đặt heading scaffolding `### Việc còn lại của Thread A` giữa source slice L237–247 và source slice L252. Không chèn vào bên trong slice.

Cách đặt này giữ từng slice nguyên khối để validator lossless có thể so sánh trực tiếp.

## 8. Sáu wikilink được phép rewrite

Thực hiện rewrite trên snapshot trước khi cắt slice. Chỉ target thay đổi; display label gốc giữ nguyên.

| Dòng nguồn | Target cuối cùng |
|---|---|
| L277 | `2026-07-23-in-bubble-ocr-recall-worklog#Backlog rút ra cho v2` |
| L313 | `2026-07-23-layout-translation-actions-worklog#Thread A — hành động dịch theo bố cục hoàn tất trên v2 ✅ (2026-07-28)` |
| L792 | `2026-07-31-cold-benchmark-fixture-worklog#Benchmark production — 20 cold + 20 warm (2026-07-31)` |
| L795 | `2026-07-29-progressive-translation-worklog#Cập nhật Task 9–10 — 2026-07-30` |
| L899 | `2026-08-01-telemetry-real-fixture-quality-gate-worklog#Spec A — code review Task 1–3 (2026-08-02)` |
| L978 | `2026-08-01-telemetry-real-fixture-quality-gate-worklog#Spec A — tạm dừng sau Task 2 (2026-08-01)` |

Không dùng link cùng-note dạng `[[#heading]]` cho nội dung đã tách. Không rewrite mọi chuỗi `[[...]]` bằng grep thô vì phần lớn occurrence hiện nằm trong code fence hoặc inline code.

## 9. Version summary

Mỗi file `docs/superpowers/worklogs/versions/feat-vN.md` có frontmatter:

```yaml
---
title: feat/vN
note_type: version-summary
version: feat/vN
base: <root hoặc feat/v(N-1)>
date_start: YYYY-MM-DD
date_end: YYYY-MM-DD
status: done
tags:
  - mangatranslator/version
---
```

Enum status riêng cho version summary là `done | checkpoint | incomplete`:

- v1–v3: `done` trong phạm vi delta lịch sử của version, không suy ra mọi backlog dự án đã đóng.
- v4: `checkpoint`, ghi rõ đây là design/documentation checkpoint, không phải product increment.
- v5: `incomplete`, vì Task 15 manual/browser gate còn mở.

Body mỗi note gồm: kết luận, facts từ Git, work item liên quan, vấn đề và cách giải quyết, verification, phần còn lại và key commits. Không dump toàn bộ log.

### 9.1 Nguồn Git chuẩn

v1 không có delta base thích hợp:

```powershell
git log --no-merges --topo-order --reverse feat/v1
git log --merges --topo-order --reverse feat/v1
```

Kết quả chuẩn: 33 non-merge commit; merge `62948d7` được ghi riêng. Không dùng `origin/main..feat/v1`, vì `feat/v1` là ancestor của `origin/main` nên range đó rỗng.

v2–v5 dùng delta theo topology:

```powershell
git log --no-merges --topo-order --reverse feat/v1..feat/v2
git log --no-merges --topo-order --reverse feat/v2..feat/v3
git log --no-merges --topo-order --reverse feat/v3..feat/v4
git log --no-merges --topo-order --reverse feat/v4..feat/v5
```

Các mốc kiểm tra:

| Version | Khoảng thời gian | Non-merge commit | Diễn giải bắt buộc |
|---|---|---:|---|
| v1 | 2026-07-21 → 2026-07-29 | 33 | nền tảng, OCR recall và layout actions |
| v2 | 2026-07-29 → 2026-07-31 | 66 | progressive workflow, acceptance harness và cold benchmark |
| v3 | 2026-07-31 → 2026-08-05 | 72 | telemetry/quality gate, reading order và full-page translation |
| v4 | 2026-08-05 → 2026-08-09 | 8 | 8/8 commit là docs/chore; design/documentation checkpoint |
| v5 | 2026-08-09 → 2026-08-14 | 25 | Spec C implementation tới Task 14; Task 15 còn mở |

Không sort version narrative chỉ bằng author/commit date. Merge có thể kéo commit cũ vào version mới; topology và range branch mới là nguồn thứ tự.

## 10. Acceptance gates

### Gate 1 — Đúng vault

Điều kiện tiên quyết: đóng vault cũ, mở `D:\MangaTranslator\docs` một lần và xác nhận registry có vault tên `docs`.

Mọi lệnh Obsidian phải đặt `vault=docs` ở tham số đầu. Đọc stdout, không chỉ exit code:

```powershell
obsidian vault=docs vault info=path
obsidian vault=docs unresolved total
obsidian vault=docs unresolved verbose format=json
```

Lệnh đầu phải in chính xác `D:\MangaTranslator\docs`; lệnh hai phải in `0`; JSON verbose được lưu làm evidence trong worklog thực hiện. Baseline vault cũ là 0 unresolved và kết quả cuối không được tăng.

### Gate 2 — JSON evidence được Obsidian nhìn thấy

Sau khi `showUnsupportedFiles: true` có hiệu lực và vault được mở lại, xác nhận Obsidian index đúng bốn file `.json` trong `docs/superpowers/worklogs/`, không ít hơn hoặc nhiều hơn.

### Gate 3 — Basename duy nhất

Liệt kê basename của toàn bộ Markdown trong vault và fail nếu bất kỳ basename nào xuất hiện hơn một lần. Sau đó xác nhận:

- đúng 14 file khớp `docs/superpowers/worklogs/*-worklog.md`;
- đúng năm version summary trong `docs/superpowers/worklogs/versions/`.

### Gate 4 — Lossless split

Nguồn chuẩn là blob 1.716 dòng của progress note trong commit move. Normalize line ending, không normalize nội dung khác.

Đầu tiên áp dụng đúng sáu wikilink replacement allowlist. Sau đó dùng 15 range sau:

```text
(15,145)
(146,236)
(237,247)
(248,251)
(252,252)
(253,273)
(274,332)
(333,381)
(382,745)
(746,809)
(810,865)
(866,1110)
(1111,1120)
(1121,1280)
(1281,1716)
```

Các range liên tục, không hở, không chồng và phủ đúng 1.702 dòng từ L15 đến L1716. Với mỗi range, exact slice sau rewrite phải xuất hiện liên tục đúng một lần trong worklog sở hữu. Scaffolding phải nằm ngoài slice.

Bốn dòng nội dung gốc L10–13 phải xuất hiện nguyên văn và liên tục đúng một lần trong index.

### Gate 5 — Resolver file và anchor

Validator tự động:

1. Parse raw Markdown và đánh dấu offset range của code fence cùng inline code.
2. Tìm span raw `[[...]]` trên nguyên văn.
3. Chỉ loại span có start offset nằm trong code range; không biến đổi payload của span.
4. Resolve file bằng basename duy nhất.
5. Với link có heading, so raw anchor với raw heading. Heading phải xuất hiện đúng một lần; 0 hoặc nhiều hơn 1 đều fail.

Bốn H2 chứa backtick phải được kiểm tra click/manual một lần trong Obsidian:

```text
Task 5 — Pipeline + `/translate` ✅ (2026-07-21)
Kiểm chứng lại `ocr-manga-extension-roadmap.md` (2026-07-29)
2026-08-03 — Spec A paced quality-gate rerun: chọn `full_page`
2026-08-05 — Spec B post-checkpoint fix `8a4b08d`
```

Backtick là một phần của raw heading và raw anchor; validator không được strip chúng khỏi payload.

Nếu Obsidian thực tế không resolve một backtick anchor, thêm block ID vào summary scaffolding mới và đổi link index sang block ID. Không sửa heading lịch sử.

### Gate 6 — Allowlist và nguồn ngoài vault

- Xác nhận đúng sáu link lịch sử có target cuối trong mục 8 và không có historical wikilink nào khác bị sửa.
- Xác nhận `AGENTS.md`, `CLAUDE.md` và `workflow-guide.md` chỉ xuất hiện dưới dạng inline-code path, không phải wikilink.
- Chạy resolver Obsidian cuối cùng và yêu cầu unresolved set khớp chính xác hai external-root Markdown link được allowlist dưới đây, gồm cả linkpath và source file; bất kỳ unresolved entry mới nào cũng làm gate fail:
  - `../../../ocr-manga-extension-roadmap-revised-2026-07-30` từ `superpowers/specs/2026-07-30-progressive-translation-workflow-design.md`;
  - `../../../work-flow` từ `superpowers/specs/2026-07-30-progressive-translation-workflow-design.md`.

Hai entry này là Markdown relative link hoạt động trong Git/GitHub/VS Code nhưng trỏ ra ngoài vault root `docs/`; chúng không phải historical wikilink của mục 8 và không mở rộng quy tắc nguồn ngoài vault ở mục 3.2.

### Gate 7 — Git và định dạng

- `MOVE_COMMIT` là commit duy nhất có subject chính xác `docs: move Obsidian vault to docs`; `SPLIT_COMMIT` là commit duy nhất có subject chính xác `docs: split MangaTranslator worklog archive`.
- `git diff --check MOVE_COMMIT SPLIT_COMMIT` được phép exit `2` chỉ với closed allowlist đúng 12 warning header dưới đây; phải so tập chính xác, không được bỏ qua toàn bộ output:
  - `trailing whitespace` tại `docs/superpowers/worklogs/2026-07-29-progressive-translation-worklog.md:197` và `docs/superpowers/worklogs/2026-07-29-progressive-translation-worklog.md:198`; hai dòng payload `+` phải khớp nguyên văn source blob L542–543, gồm hai dấu cách Markdown hard line break cuối dòng;
  - `new blank line at EOF` tại đúng mười file/line:
    - `docs/superpowers/worklogs/2026-07-21-manga-translator-foundation-worklog.md:166`;
    - `docs/superpowers/worklogs/2026-07-23-in-bubble-ocr-recall-worklog.md:156`;
    - `docs/superpowers/worklogs/2026-07-23-layout-translation-actions-worklog.md:110`;
    - `docs/superpowers/worklogs/2026-07-29-progressive-translation-worklog.md:400`;
    - `docs/superpowers/worklogs/2026-07-29-viewport-ocr-prewarm-gemini-failover-worklog.md:86`;
    - `docs/superpowers/worklogs/2026-07-30-browser-acceptance-harness-worklog.md:99`;
    - `docs/superpowers/worklogs/2026-07-31-cold-benchmark-fixture-worklog.md:92`;
    - `docs/superpowers/worklogs/2026-08-01-telemetry-real-fixture-quality-gate-worklog.md:281`;
    - `docs/superpowers/worklogs/2026-08-03-paced-quality-gate-rerun-worklog.md:46`;
    - `docs/superpowers/worklogs/2026-08-04-reading-order-full-page-translation-worklog.md:196`.
- Mười blank-line warning là dòng trống cuối source slice mà từng file sở hữu; hai trailing-whitespace warning cũng là payload lịch sử. Bất kỳ warning mới, warning bị thiếu, hoặc thay đổi path/line/message/payload nào đều làm Gate 7 fail.
- Diff từng commit chỉ chứa đúng phạm vi đã định nghĩa.
- Commit snapshot không chứa design/move/split.
- Commit move giữ note chính byte-for-byte và đủ similarity để `git log --follow` nối lịch sử.
- Commit split không chạm code sản phẩm hoặc thay đổi ngoài tài liệu archive.

## 11. Xử lý lỗi và khả năng quay lại

- Nếu switch branch làm đổi hash hoặc số dòng note bẩn, dừng trước khi ghi file. Baseline đã xác nhận là SHA-256 `6AAF2B60AF33803E62FF2E7FBCC62C22DB86ACB507AD3F762A40466B862A3983`, 1.716 dòng.
- Nếu commit snapshot không chứa đúng một file tiến độ, sửa staging trước khi commit.
- Nếu rename detection không nối lịch sử, không tiếp tục split; kiểm tra lại commit move để loại mọi chỉnh sửa nội dung note.
- Nếu basename trùng hoặc resolver báo target mơ hồ, sửa tên/link trước khi chạy unresolved gate.
- Nếu lossless validator báo thiếu, lặp hoặc slice bị tách, sửa ownership/scaffolding; không bỏ qua gate và không copy tay phần thiếu.
- Nếu Obsidian CLI trả `Vault not found.` hoặc path khác, kết quả không hợp lệ dù exit code là 0.
- Nếu version count lệch, kiểm tra đúng branch tip và range topology; không bù số bằng cách đưa merge vào non-merge count.

Git đã giữ snapshot nguyên vẹn nên rollback nội dung luôn có thể lấy từ commit đầu tiên của chuỗi implementation. Không cần một archive note trùng lặp trong vault.

## 12. Ngoài phạm vi

- Không thay đổi source, test hoặc hành vi sản phẩm MangaTranslator.
- Không hoàn tất hoặc tuyên bố PASS Task 15 của Spec C.
- Không viết lại historical spec/plan để cập nhật path cũ.
- Không tạo Obsidian Base, Canvas, plugin hoặc automation.
- Không xóa linked worktree `feat/v5`.
- Không merge, push hoặc mở PR trong quá trình lập spec/plan.

## 13. Tiêu chí sẵn sàng lập implementation plan

Design spec sẵn sàng chuyển sang implementation planning khi:

1. Người dùng review và duyệt chính file này.
2. Không còn chỗ bỏ ngỏ, mâu thuẫn ownership, tên file mơ hồ hoặc phạm vi chưa quyết định.
3. Branch vẫn là `feat/worklog-archive`, note tiến độ chưa bị stage và worktree `feat/v5` không bị chạm.
4. Implementation plan giữ nguyên ba commit migration và gắn lệnh kiểm chứng cụ thể vào từng gate ở mục 10.
