# Paced Quality-Gate Rerun Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm pacing 10 giây cho runner quality probe, chạy đúng một fresh capture có provenance sạch, rồi ghi quyết định gate mới mà không sửa evidence ngày 2026-08-01.

**Architecture:** `run_quality_probe()` sở hữu khoảng nghỉ giữa các logical call vì đây là nơi duy nhất có thể đặt sleep trước cửa sổ `started`/`ended`. CLI chỉ parse, validate và truyền `call_delay_seconds`; production `GeminiTranslator._generate` giữ nguyên. Code, capture và quyết định cuối được tách thành ba task/commit với user-review checkpoint bắt buộc giữa chúng.

**Tech Stack:** Python 3.12, pytest, argparse, Gemini SDK hiện có, PowerShell, Git, Obsidian CLI.

## Global Constraints

- Mọi lệnh repo chạy từ isolated worktree
  `D:\MangaTranslator\.worktrees\spec-a-telemetry-quality-gate`, không chạy từ main
  worktree đang có thay đổi riêng của người dùng.
- `--call-delay-seconds` mặc định `0`; live rerun dùng đúng `10`.
- Delay áp dụng toàn cục giữa mọi logical call, kể cả sau 429; call đầu không sleep.
- Sleep nằm trước `started = clock()` và không được tính vào `duration`.
- `call_delay_seconds` và `sleep` là keyword-only trong `run_quality_probe()`.
- CLI reject giá trị âm, `nan`, `inf` bằng
  `parser.error("--call-delay-seconds phải là số hữu hạn không âm")` ngay sau
  `parse_args`, trước manifest/Gemini/output I/O.
- Không sửa `GeminiTranslator._generate`, retry/failover, prompt, policy, evaluator, `CAPTURE_METADATA_FIELDS` hoặc capture schema.
- Không chạy bù attempt, không ghép capture và không chạy lần ba nếu fresh capture vẫn `inconclusive`.
- Commit code phải được review trước capture; capture phải được review trước khi `jaa` chấm rubric.
- Capture mới: `server/tests/fixtures/real_pages/captures/2026-08-03-policy-probe-paced.json`.
- Worklog mới: `docs/superpowers/worklogs/2026-08-03-real-page-quality-gate-rerun.json`.
- `docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json` bất biến; telemetry được tham chiếu từ section `telemetry_validation` tại commit `277f9dfe62fda44c47239d86b82ac44c78786f7f`.
- Không triển khai Spec B/C trong kế hoạch này.

---

### Task 1: TDD pacing cho quality-probe runner

**Files:**
- Modify: `server/real_page_quality.py:519-552`
- Modify: `server/run_real_page_probe.py:1-54`
- Test: `server/tests/test_real_page_quality.py:219-350`
- Test: `server/tests/test_real_page_quality.py:624-692`
- Modify: `work-flow.md:63-64`

**Interfaces:**
- Consumes: `run_quality_probe(manifest, baseline, generate, attempts=3, clock=time.perf_counter, *, metadata=None)` và CLI `server.run_real_page_probe run` hiện có.
- Produces: `run_quality_probe(manifest, baseline, generate, attempts=3, clock=time.perf_counter, *, metadata=None, call_delay_seconds=0, sleep=time.sleep)` và CLI option `--call-delay-seconds <finite non-negative float>`.
- Does not produce: capture mới, score mới hoặc thay đổi production translator.

- [ ] **Step 1: Viết failing test cho pacing xuyên biên và sau 429**

Thêm vào `server/tests/test_real_page_quality.py`:

```python
def test_quality_probe_paces_every_logical_call_without_charging_duration():
    class RateLimitError(Exception):
        code = 429

    expected_calls = (
        [["b3"], ["b1", "b2"]] * 2
        + [["b1"], ["b2", "b3"]] * 2
        + [["b1", "b2", "b3"]] * 2
    )
    now = [0]
    generated = []
    sleeps = []

    def clock():
        return now[0]

    def sleep(seconds):
        sleeps.append(seconds)
        now[0] += seconds

    def generate(_, decode):
        ids = expected_calls[len(generated)]
        generated.append(ids)
        now[0] += 2
        if len(generated) == 4:
            raise RateLimitError("RESOURCE_EXHAUSTED")
        return decode(json.dumps([{"id": item_id, "translation": item_id} for item_id in ids]))

    capture = run_quality_probe(
        {"fixtures": [_policy_page()]},
        {"page-1": [["b3"], ["b1", "b2"]]},
        generate,
        attempts=2,
        clock=clock,
        call_delay_seconds=10,
        sleep=sleep,
    )
    calls = [call for row in capture["attempts"] for call in row["calls"]]

    assert generated == expected_calls
    assert sleeps == [10] * 9
    assert [call["started"] for call in calls] == list(range(0, 120, 12))
    assert [call["duration"] for call in calls] == [2] * 10
    assert (calls[3]["status"], calls[3]["error_code"]) == ("rate_limited", "rate_limited")
```

- [ ] **Step 2: Viết failing test cho cả default core và explicit zero**

```python
@pytest.mark.parametrize("delay_kwargs", [{}, {"call_delay_seconds": 0}])
def test_quality_probe_zero_delay_never_sleeps(delay_kwargs):
    expected_calls = [["b3"], ["b1", "b2"], ["b1"], ["b2", "b3"], ["b1", "b2", "b3"]]
    generated = []

    def generate(_, decode):
        ids = expected_calls[len(generated)]
        generated.append(ids)
        return decode(json.dumps([{"id": item_id, "translation": item_id} for item_id in ids]))

    run_quality_probe(
        {"fixtures": [_policy_page()]},
        {"page-1": [["b3"], ["b1", "b2"]]},
        generate,
        attempts=1,
        sleep=lambda _: pytest.fail("zero delay must not sleep"),
        **delay_kwargs,
    )

    assert generated == expected_calls
```

- [ ] **Step 3: Chạy hai test core để xác nhận RED đúng lý do**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_real_page_quality.py -q -k "paces_every_logical_call or zero_delay_never_sleeps"
```

Expected: FAIL vì `run_quality_probe()` chưa nhận `call_delay_seconds`/`sleep`; không chấp nhận failure do fixture hoặc decoder.

- [ ] **Step 4: Implement core pacing tối thiểu**

Đổi signature và đầu hàm trong `server/real_page_quality.py`:

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
    rows = []
    logical_calls = 0
    probe_started = clock()
```

Ngay trong vòng `for batch_id, batch in enumerate(batches, 1)`, trước `started = clock()`:

```python
if logical_calls and call_delay_seconds > 0:
    sleep(call_delay_seconds)
logical_calls += 1
started = clock()
```

Không đổi `try/except`, `capture_call`, decoder hoặc thứ tự vòng lặp.

- [ ] **Step 5: Chạy lại test core để xác nhận GREEN**

Run cùng lệnh Step 3.

Expected: `3 passed` vì test explicit/default zero được parametrize thành hai case.

- [ ] **Step 6: Viết failing test CLI validation và pass-through**

Thêm test validation:

```python
@pytest.mark.parametrize("value", ["-1", "nan", "inf"])
def test_probe_cli_rejects_invalid_call_delay_before_validation(value, monkeypatch, capsys):
    monkeypatch.setattr(
        "server.run_real_page_probe.validate_manifest",
        lambda _: pytest.fail("invalid delay must fail before manifest validation"),
    )

    with pytest.raises(SystemExit) as exit_info:
        run_probe_main(
            [
                "run",
                "--manifest",
                "manifest.json",
                "--baseline",
                "baseline.json",
                "--out",
                "capture.json",
                "--call-delay-seconds",
                value,
            ]
        )

    assert exit_info.value.code == 2
    assert "số hữu hạn không âm" in capsys.readouterr().err
```

Parametrize test `test_probe_cli_creates_output_parent_before_running_probe` hiện có:

```python
@pytest.mark.parametrize(
    ("delay_args", "expected_delay"),
    [([], 0), (["--call-delay-seconds", "10"], 10.0)],
)
def test_probe_cli_creates_output_parent_before_running_probe(
    tmp_path, monkeypatch, delay_args, expected_delay
):
```

Trong `fake_probe`, thêm:

```python
assert kwargs["call_delay_seconds"] == expected_delay
```

Và gọi CLI bằng:

```python
run_probe_main(
    [
        "run",
        "--manifest",
        "manifest.json",
        "--baseline",
        "baseline.json",
        "--out",
        str(out),
        *delay_args,
    ]
)
```

Giữ nguyên các patch hiện có, đặc biệt target `server.translator.GeminiTranslator`.

- [ ] **Step 7: Chạy CLI tests để xác nhận RED đúng lý do**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_real_page_quality.py -q -k "invalid_call_delay or creates_output_parent"
```

Expected: FAIL vì option chưa tồn tại hoặc chưa truyền xuống core. Test invalid phải fail assertion message, không được được coi là GREEN chỉ vì argparse báo “unrecognized arguments”.

- [ ] **Step 8: Implement CLI option, validation và pass-through**

Trong `server/run_real_page_probe.py`, thêm `import math`, thêm argument:

```python
parser.add_argument("--call-delay-seconds", type=float, default=0)
```

Ngay sau `args = parser.parse_args(argv)`, trước guard preview và `validate_manifest`:

```python
if not math.isfinite(args.call_delay_seconds) or args.call_delay_seconds < 0:
    parser.error("--call-delay-seconds phải là số hữu hạn không âm")
```

Truyền tường minh vào core:

```python
capture = run_quality_probe(
    manifest,
    baseline,
    translator._generate,
    attempts=args.attempts,
    metadata=metadata,
    call_delay_seconds=args.call_delay_seconds,
)
```

- [ ] **Step 9: Chạy focused suite và CLI help**

Run:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_real_page_quality.py -q
$env:GEMINI_API_KEY=''
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m server.run_real_page_probe run --help
Remove-Item Env:\GEMINI_API_KEY -ErrorAction SilentlyContinue
```

Expected: toàn bộ `test_real_page_quality.py` PASS; help có `--call-delay-seconds` và không khởi tạo Gemini.

- [ ] **Step 10: Chạy full regression và lấy số thật**

Run Python:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests -q
```

Run đúng chín JS test file:

```powershell
$jsTests = Get-ChildItem extension/test -Filter *.test.js | Sort-Object Name
if ($jsTests.Count -ne 9) { throw "Expected 9 JS test files, got $($jsTests.Count)" }
foreach ($test in $jsTests) {
    & node $test.FullName
    if ($LASTEXITCODE -ne 0) { throw "JS test failed: $($test.Name)" }
}
```

Expected: Python full suite PASS với số mới `188 + N` được đọc từ output; 9/9 JS files exit `0`.

- [ ] **Step 11: Cập nhật regression handoff bằng số đo thật**

Dùng `apply_patch` sửa `work-flow.md:63`, thay `188 passed` bằng đúng số từ Step 10. Giữ nguyên warning count theo output thực; không dự đoán trước con số. Đồng thời thay hai dòng PowerShell trích `telemetry_validation.baseline` tại `work-flow.md:86-87` bằng cùng lệnh Python ghi UTF-8 không BOM ở Task 2 Step 2; giữ nguyên đường dẫn scratch và lệnh replay hiện có.

- [ ] **Step 12: Audit diff trước commit**

Run:

```powershell
git diff --check
git status --short
git diff -- server/real_page_quality.py server/run_real_page_probe.py server/tests/test_real_page_quality.py work-flow.md
```

Expected: chỉ bốn file trong Task 1 thay đổi; không có capture, score, `.tmp-real-pages` hoặc thay đổi production translator.

- [ ] **Step 13: Commit code checkpoint**

```powershell
git add server/real_page_quality.py server/run_real_page_probe.py server/tests/test_real_page_quality.py work-flow.md
git commit -m "feat: pace real-page quality probe"
git status --porcelain
```

Expected: commit thành công và worktree sạch. **Dừng để người dùng review commit code; không chạy Gemini/capture trước khi có PASS.**

---

### Task 2: Chạy và commit đúng một fresh capture

**Files:**
- Read: `docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json`
- Read: `server/tests/fixtures/real_pages/manifest.json`
- Create: `server/tests/fixtures/real_pages/captures/2026-08-03-policy-probe-paced.json`
- Temporary ignored: `.tmp-real-pages/2026-08-01-browser-baseline.json`

**Interfaces:**
- Consumes: commit Task 1 đã được người dùng review; `telemetry_validation.baseline`; CLI `run --call-delay-seconds 10`.
- Produces: một capture schema v1 có 27 attempt row, 75 logical call và metadata commit trỏ đúng code HEAD lúc chạy.
- Does not produce: manual scores, evaluator decision, worklog mới hoặc browser telemetry mới.

- [ ] **Step 1: Xác nhận checkpoint và provenance trước network**

Chỉ chạy sau khi người dùng PASS Task 1:

```powershell
$capturePath = 'server/tests/fixtures/real_pages/captures/2026-08-03-policy-probe-paced.json'
if (Test-Path $capturePath) { throw "Capture path already exists; do not overwrite or rerun" }
if (git status --porcelain) { throw "Worktree must be clean before capture" }
& 'D:\MangaTranslator\venv\Scripts\python.exe' -c "from server import config; assert config.GEMINI_API_KEY"
git log -1 --oneline
```

Expected: path chưa tồn tại, worktree sạch, key được nạp từ môi trường hoặc `.env`, HEAD là commit code đã review.

- [ ] **Step 2: Trích baseline cũ mà không chạy browser**

```powershell
$baselinePath = '.tmp-real-pages/2026-08-01-browser-baseline.json'
New-Item -ItemType Directory -Force (Split-Path $baselinePath) | Out-Null
& 'D:\MangaTranslator\venv\Scripts\python.exe' -c "import json,pathlib; w=json.loads(pathlib.Path('docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json').read_text(encoding='utf-8')); pathlib.Path('.tmp-real-pages/2026-08-01-browser-baseline.json').write_text(json.dumps(w['telemetry_validation']['baseline'], ensure_ascii=False), encoding='utf-8')"
```

Run offline validation trước khi gọi Gemini:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -c "from server.real_page_quality import load_manifest, policy_batches, source_pages, validate_manifest; m=validate_manifest('server/tests/fixtures/real_pages/manifest.json'); b=load_manifest('.tmp-real-pages/2026-08-01-browser-baseline.json'); assert sum(len(policy_batches(p,a,b[p['id']])) for p in source_pages(m) for a in ('batch_control','ordered_microbatch','full_page')) == 25; print('baseline OK')"
```

Expected: `baseline OK`. Một pass ba attempt sẽ tạo `25 × 3 = 75` logical call.

- [ ] **Step 3: Chạy đúng một live capture có pacing**

```powershell
$baselinePath = '.tmp-real-pages/2026-08-01-browser-baseline.json'
$capturePath = 'server/tests/fixtures/real_pages/captures/2026-08-03-policy-probe-paced.json'
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m server.run_real_page_probe run --manifest server/tests/fixtures/real_pages/manifest.json --baseline $baselinePath --out $capturePath --attempts 3 --call-delay-seconds 10
```

Expected: command hoàn tất sau khoảng 13–14 phút và ghi đúng một file. Nếu call lỗi, runner vẫn hoàn tất đủ attempt; không chạy lại command. Stopping rule này chỉ có hiệu lực sau khi run đã thực sự phát Gemini call; lỗi preflight trước network phải được sửa trước khi bắt đầu run duy nhất.
Giữ process hiện hành và báo tiến độ tối đa mỗi 60 giây; không restart chỉ vì chưa có output trung gian.

- [ ] **Step 4: Validate schema, provenance, call count và pacing**

```powershell
@'
import json
import subprocess
from pathlib import Path

from server.real_page_quality import validate_capture, validate_manifest

path = Path("server/tests/fixtures/real_pages/captures/2026-08-03-policy-probe-paced.json")
capture = json.loads(path.read_text(encoding="utf-8"))
manifest = validate_manifest("server/tests/fixtures/real_pages/manifest.json")
validation = validate_capture(manifest, capture)
head = subprocess.run(["git", "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
assert capture["metadata"]["commit"] == head
assert set(capture["metadata"]) == {"captured_at", "commit", "device", "model", "temperature"}
assert len(capture["attempts"]) == 27
calls = [call for row in capture["attempts"] for call in row["calls"]]
assert len(calls) == 75
gaps = [current["started"] - (previous["started"] + previous["duration"]) for previous, current in zip(calls, calls[1:])]
assert len(gaps) == 74 and min(gaps) >= 9.9
print(json.dumps({"attempts": 27, "calls": 75, "valid_attempts": len(validation["valid_attempts"]), "min_gap": min(gaps)}, ensure_ascii=False))
'@ | & 'D:\MangaTranslator\venv\Scripts\python.exe' -
```

Expected: schema hợp lệ; commit đúng; 27 attempts; 75 calls; 74 gaps đều ít nhất 9.9 giây. `valid_attempts` được ghi nhận nhưng không dùng để quyết định rerun.

- [ ] **Step 5: Audit artifact trước commit**

```powershell
$capturePath = 'server/tests/fixtures/real_pages/captures/2026-08-03-policy-probe-paced.json'
git diff --check
git status --short
git diff -- docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json server/tests/fixtures/real_pages/captures/2026-08-01-policy-probe.json
Select-String -LiteralPath $capturePath -Pattern 'GEMINI_API_KEY|AIza|api[_-]?key' -CaseSensitive:$false
```

Expected: chỉ capture mới là untracked; hai artifact 2026-08-01 không đổi; sensitive-data scan không có match.

- [ ] **Step 6: Commit capture checkpoint một mình**

```powershell
git add -- $capturePath
git diff --cached --check
git commit -m "docs: capture paced quality-gate rerun"
git status --porcelain
```

Expected: commit chứa đúng một capture file và worktree sạch. **Dừng để người dùng review capture; chưa tạo manual scores hoặc evaluate.**

---

### Task 3: Human rubric, evaluator và worklog quyết định mới

**Files:**
- Read: `server/tests/fixtures/real_pages/captures/2026-08-03-policy-probe-paced.json`
- Read: `docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json`
- Create: `server/tests/fixtures/real_pages/captures/2026-08-03-manual-scores.json`
- Temporary ignored: `.tmp-real-pages/2026-08-03-policy-evaluation.json`
- Create: `docs/superpowers/worklogs/2026-08-03-real-page-quality-gate-rerun.json`
- Modify: `work-flow.md:91-103`
- External append through Obsidian CLI: `MangaTranslatorBrowser/Tiến độ MangaTranslator.md`

**Interfaces:**
- Consumes: capture Task 2 đã được người dùng review và rubric do `jaa` cung cấp cho đúng mọi valid attempt.
- Produces: manual score file hợp lệ, exact evaluator artifact, worklog mới tham chiếu telemetry 2026-08-01, và nguồn quyết định mới trong `work-flow.md`.
- Does not produce: thay đổi worklog 2026-08-01, capture mới khác, hoặc production Spec B/C.

- [ ] **Step 1: Xác định chính xác rubric rows cần chấm**

Sau khi người dùng PASS capture, chạy:

```powershell
@'
import json
from pathlib import Path
from server.real_page_quality import validate_capture, validate_manifest

capture = json.loads(Path("server/tests/fixtures/real_pages/captures/2026-08-03-policy-probe-paced.json").read_text(encoding="utf-8"))
manifest = validate_manifest("server/tests/fixtures/real_pages/manifest.json")
valid = sorted(validate_capture(manifest, capture)["valid_attempts"])
pages = {page["id"]: page for page in manifest["fixtures"] if page["role"] == "source_page"}
attempts = {(row["page_id"], row["arm"], row["attempt"]): row for row in capture["attempts"]}
packet = []
for key in valid:
    page_id, arm, attempt = key
    page = pages[page_id]
    packet.append({
        "page_id": page_id,
        "arm": arm,
        "attempt": attempt,
        "source_regions": [
            {
                "fixture_block_id": region["fixture_block_id"],
                "src_text": region["src_text"],
                "reading_order": region["reading_order"],
                "kind": region["kind"],
            }
            for region in sorted(page["regions"], key=lambda region: region["reading_order"])
        ],
        "term_groups": page.get("term_groups", []),
        "translations": attempts[key]["responses"],
    })
print(json.dumps(packet, ensure_ascii=False, indent=2))
'@ | & 'D:\MangaTranslator\venv\Scripts\python.exe' -
```

Expected: danh sách exact valid attempts. Gửi đầy đủ source → translation của đúng các row này cho `jaa`; không tự chấm, không bỏ row và không tạo score cho invalid attempt. **Dừng chờ `jaa` trả rubric.**

- [ ] **Step 2: Ghi manual scores đúng dữ liệu reviewer**

Dùng `apply_patch` tạo `2026-08-03-manual-scores.json` từ dữ liệu `jaa` đã xác nhận. Mỗi row phải có exact fields:

- `page_id`, `arm`, `attempt`;
- `correctness`, `terms`, `pronouns`, `tone`, `coherence`, `conciseness`;
- `critical_error`, `reviewer`, `note`, `term_forms`.

Hai trang Nhật dùng điểm nguyên `0..2` cho sáu rubric fields. PT dùng `not_applicable` cho `terms`, `pronouns`, `coherence`; ba safety fields vẫn là `0..2`. `reviewer` phải là `jaa`; không để `null`, chuỗi rỗng hoặc row ngoài valid-attempt set.

- [ ] **Step 3: Evaluate offline và khóa artifact quyết định**

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m server.run_real_page_probe evaluate --manifest server/tests/fixtures/real_pages/manifest.json --capture server/tests/fixtures/real_pages/captures/2026-08-03-policy-probe-paced.json --scores server/tests/fixtures/real_pages/captures/2026-08-03-manual-scores.json --out .tmp-real-pages/2026-08-03-policy-evaluation.json
Get-Content -Raw -Encoding utf8 .tmp-real-pages/2026-08-03-policy-evaluation.json
```

Expected: evaluate thành công với một trong bốn decision hợp lệ. Nếu là `inconclusive`, giữ nguyên và không chạy capture khác.

- [ ] **Step 4: Tạo worklog 2026-08-03, không sao chép telemetry**

Dùng `apply_patch` tạo `docs/superpowers/worklogs/2026-08-03-real-page-quality-gate-rerun.json` với đúng ba phần:

- `telemetry_validation_reference`: exact object `{ "worklog": "docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json", "section": "telemetry_validation", "source_commit": "277f9dfe62fda44c47239d86b82ac44c78786f7f" }`;
- `policy_probe`: `capture_file` trỏ tới capture paced, cộng schema/prompt/policy version, metadata, `attempts: 27`, `calls: 75`, số valid response thực, `rerun_failed_attempts: false`, `call_delay_seconds: 10`;
- `manual_review`: nguyên JSON object từ `.tmp-real-pages/2026-08-03-policy-evaluation.json`, không sửa `captured_at`, decision, reason, pages hoặc arms.

Không thêm `telemetry_validation` copy và không sửa worklog 2026-08-01.

- [ ] **Step 5: Cập nhật nguồn quyết định trong work-flow**

Dùng `apply_patch` sửa `work-flow.md:91-103` trong cùng change set với worklog mới:

- lệnh evaluate dùng capture/scores/output 2026-08-03;
- nguồn quyết định hiện tại là worklog 2026-08-03;
- ghi exact decision/reason từ evaluator;
- nói rõ `telemetry_validation_reference` tái dùng browser telemetry/baseline từ worklog 2026-08-01 tại commit `277f9df`;
- không tuyên bố policy thắng nếu decision không phải `selected`.

- [ ] **Step 6: Verify artifact linkage và regression**

```powershell
@'
import json
from pathlib import Path

evaluation = json.loads(Path(".tmp-real-pages/2026-08-03-policy-evaluation.json").read_text(encoding="utf-8"))
worklog = json.loads(Path("docs/superpowers/worklogs/2026-08-03-real-page-quality-gate-rerun.json").read_text(encoding="utf-8"))
assert worklog["telemetry_validation_reference"] == {
    "worklog": "docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json",
    "section": "telemetry_validation",
    "source_commit": "277f9dfe62fda44c47239d86b82ac44c78786f7f",
}
assert worklog["policy_probe"]["capture_file"] == "server/tests/fixtures/real_pages/captures/2026-08-03-policy-probe-paced.json"
assert worklog["policy_probe"]["attempts"] == 27
assert worklog["policy_probe"]["calls"] == 75
assert worklog["policy_probe"]["rerun_failed_attempts"] is False
assert worklog["policy_probe"]["call_delay_seconds"] == 10
assert worklog["manual_review"] == evaluation
print(evaluation["decision"], evaluation["reason"])
'@ | & 'D:\MangaTranslator\venv\Scripts\python.exe' -

& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_real_page_quality.py -q
git diff --check
git diff -- docs/superpowers/worklogs/2026-08-01-real-page-quality-baseline.json
```

Expected: linkage PASS, focused tests PASS, diff check sạch và worklog 2026-08-01 không đổi.

- [ ] **Step 7: Commit score và quyết định repo**

```powershell
git add server/tests/fixtures/real_pages/captures/2026-08-03-manual-scores.json docs/superpowers/worklogs/2026-08-03-real-page-quality-gate-rerun.json work-flow.md
git diff --cached --check
git commit -m "docs: record paced quality-gate decision"
git status --porcelain
```

Expected: commit không chứa worklog/capture 2026-08-01 hoặc `.tmp-real-pages`; isolated worktree sạch.

- [ ] **Step 8: Append primary Obsidian vault qua CLI**

Primary vault nằm tại `D:\MangaTranslator\MangaTranslatorBrowser`, không phải bản copy trong isolated worktree. Dùng `obsidian:obsidian-cli` append một section ngày 2026-08-03 vào `Tiến độ MangaTranslator.md` gồm:

- commit code pacing và kết quả test thực;
- commit capture, metadata commit, 27 attempts/75 calls/minimum pacing gap và status counts;
- reviewer `jaa`, số rubric rows;
- exact evaluator decision/reason;
- đường dẫn worklog mới và telemetry reference cũ;
- trạng thái Spec B được phép tới đâu; Spec C vẫn hoãn tới checkpoint tiếp theo.

Đọc lại phần cuối note bằng Obsidian CLI. Không stage hoặc ghi đè các thay đổi vault hiện có trong main worktree từ isolated worktree.

- [ ] **Step 9: Dừng tại final gate checkpoint**

Bàn giao ba commit của plan, exact test/capture/evaluator evidence và xác nhận vault append. Không bắt đầu Spec B/C cho tới khi người dùng review kết quả gate.
