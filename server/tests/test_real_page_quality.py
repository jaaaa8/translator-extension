import copy
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from server.real_page_quality import (
    CAPTURE_METADATA_FIELDS,
    build_eval_prompt,
    context_score,
    decode_eval_items,
    evaluate_gate,
    load_manifest,
    match_required_regions,
    policy_batches,
    prompt_items,
    run_quality_probe,
    validate_capture,
    validate_manifest,
)
from server.run_real_page_probe import main as run_probe_main


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "real_pages"
MANIFEST = FIXTURE_DIR / "manifest.json"
REPO_ROOT = Path(__file__).resolve().parents[2]
EXPECTED_IMAGES = {
    "mangadex_pt.png": "8c25aea5e76a9264d83698ee4953b4e037593a49c05b2517de4ebd14a1d84c60",
    "s-manga_ja_1.png": "267ac9ea29bdf0bfbb3686e2806a77b0c52d1178f2810c426ba357b277976023",
    "s-manga_ja_2.png": "7d6867a5c37db97d1f6ce32d5e5fd082d3bf3ac8e9f6914a2497b51f1fd0b9b0",
    "references/mangadex_pt_overlay_partial_and_crop.png": "2f1a89dda583183971c891bf945d583394887191bb816f8dbbe686002aba40d2",
    "references/s-manga_ja_overlay_1.png": "e10082842e79b116bc2e4fc3a5c354dce2f05567672c9023a15ac61fd0dd8f40",
    "references/s-manga_ja_overlay_2.png": "9e5c9c6952786e2e5c8263e46677bf14568df5a7c060b660b9501330c103c3a4",
}
EVALUATOR_CASES = FIXTURE_DIR / "captures" / "evaluator_cases.json"


def _evaluator_cases():
    return json.loads(EVALUATOR_CASES.read_text(encoding="utf-8"))


def _evaluator_case(name):
    data = _evaluator_cases()
    case = data["cases"][name]
    attempts, scores = [], []
    for page in data["manifest"]["fixtures"]:
        for arm in ("batch_control", "ordered_microbatch", "full_page"):
            valid_attempts = case.get("valid_attempts", {}).get(arm, {}).get(page["id"], 3)
            batches = [["b1"], ["b2"]] if case.get("split_batches") and arm != "full_page" else [["b1", "b2"]]
            for attempt in range(1, 4):
                valid = attempt <= valid_attempts
                attempts.append(
                    {
                        "page_id": page["id"],
                        "arm": arm,
                        "attempt": attempt,
                        "calls": [
                            {
                                "batch_id": batch_id,
                                "fixture_block_ids": batch,
                                "started": 0,
                                "duration": case.get("failed_latency", {}).get(arm, case.get("latency", {}).get(arm, 1)) if not valid else case.get("latency", {}).get(arm, 1),
                                "status": "success" if valid else "failed",
                                "error_code": None if valid else "generation_error",
                            }
                            for batch_id, batch in enumerate(batches, 1)
                        ],
                        "responses": {"b1": "một", "b2": "hai"} if valid else {},
                    }
                )
                if not valid:
                    continue
                values = case["scores"].get(arm, {}).get(page["id"], {})
                scores.append(
                    {
                        "page_id": page["id"],
                        "arm": arm,
                        "attempt": attempt,
                        "correctness": values.get("correctness", 2),
                        "terms": values.get("terms", "not_applicable" if page["src_lang"] == "pt" else 2),
                        "pronouns": values.get("pronouns", "not_applicable" if page["src_lang"] == "pt" else 2),
                        "tone": values.get("tone", 2),
                        "coherence": values.get("coherence", "not_applicable" if page["src_lang"] == "pt" else 2),
                        "conciseness": values.get("conciseness", 2),
                        "critical_error": [arm, page["id"], attempt] in case.get("critical_errors", []),
                        "reviewer": "reviewer-a",
                        "note": "fixture score",
                        "term_forms": values.get(
                            "term_forms",
                            {
                                group["canonical"]: {
                                    block_id: "Anh hùng" for block_id in group["fixture_block_ids"]
                                }
                                for group in page["term_groups"]
                            },
                        ),
                    }
                )
    capture = {
        "schema_version": 1,
        "prompt_version": "comic-page-eval-v1",
        "policy_version": "real-page-policy-v1",
        "fixture_sha256": {page["id"]: page["sha256"] for page in data["manifest"]["fixtures"]},
        "baseline": {page["id"]: [["b1"], ["b2"]] if case.get("split_batches") else [["b1", "b2"]] for page in data["manifest"]["fixtures"]},
        "attempts": attempts,
        "metadata": {
            "captured_at": "2026-08-02T03:00:00+00:00",
            "commit": "commit-x",
            "device": "device-x",
            "model": "model-x",
            "temperature": 0.37,
        },
    }
    return data["manifest"], capture, scores


def _invalid_capture(name):
    manifest, capture, _ = _evaluator_case("pt")
    case = _evaluator_cases()["invalid_captures"][name]
    row = capture["attempts"][0]
    if name == "missing":
        row["responses"].pop("b2")
    elif name == "duplicate":
        row["calls"][0]["fixture_block_ids"] = ["b1", "b1"]
    elif name == "invented":
        row["responses"] = {"b1": "một", "invented": "hai"}
    else:
        row["responses"]["b2"] = ""
    return manifest, capture, case["error"]


def _policy_page():
    return {
        "id": "page-1",
        "role": "source_page",
        "src_lang": "es",
        "source_name": "Portuguese",
        "width": 300,
        "height": 400,
        "reading_direction": "rtl",
        "regions": [
            {
                "fixture_block_id": "b3",
                "src_text": "third",
                "reading_order": 2,
                "bbox": [30, 30, 10, 10],
                "kind": "dialogue",
            },
            {
                "fixture_block_id": "b1",
                "src_text": "first",
                "reading_order": 0,
                "bbox": [10, 10, 10, 10],
                "kind": "sign",
            },
            {
                "fixture_block_id": "b2",
                "src_text": "second",
                "reading_order": 1,
                "bbox": [20, 20, 10, 10],
                "kind": "sfx",
            },
        ],
    }


def _ids(batches):
    return [[item["id"] for item in batch] for batch in batches]


def test_policy_prompt_allowlist_and_membership_use_expected_reading_order():
    page = _policy_page()

    assert set(prompt_items(page)[0]) == {"id", "text", "reading_order", "bbox"}
    assert "kind" not in prompt_items(page)[0]
    assert _ids(policy_batches(page, "batch_control", [["b3"], ["b1", "b2"]])) == [
        ["b3"],
        ["b1", "b2"],
    ]
    assert _ids(policy_batches(page, "ordered_microbatch", [["b3"], ["b1", "b2"]])) == [
        ["b1"],
        ["b2", "b3"],
    ]
    assert len(policy_batches(page, "full_page", [])) == 1
    assert "Portuguese" in build_eval_prompt(page, prompt_items(page))


@pytest.mark.parametrize(
    "response",
    [
        '[]',
        '[{"id":"b1","translation":"one"},{"id":"b1","translation":"again"}]',
        '[{"id":"invented","translation":"no"}]',
    ],
)
def test_eval_decoder_rejects_missing_duplicate_and_invented_ids(response):
    with pytest.raises(ValueError):
        decode_eval_items(response, ["b1"])


def test_eval_decoder_treats_missing_response_text_as_invalid_response():
    with pytest.raises(ValueError, match="invalid_response"):
        decode_eval_items(None, ["b1"])


@pytest.mark.parametrize("translation", [None, 42, "", "   "])
def test_eval_decoder_rejects_non_text_or_empty_item_translation(translation):
    response = json.dumps([{"id": "b1", "translation": translation}])

    with pytest.raises(ValueError, match="invalid_response"):
        decode_eval_items(response, ["b1"])


def test_quality_probe_records_three_attempts_per_page_and_policy_arm_without_api_key():
    page = _policy_page()
    manifest = {"fixtures": [page]}
    baseline = {"page-1": [["b3"], ["b1", "b2"]]}
    calls = []
    expected_calls = (
        [["b3"], ["b1", "b2"]] * 3
        + [["b1"], ["b2", "b3"]] * 3
        + [["b1", "b2", "b3"]] * 3
    )

    def generate(_, decode):
        ids = expected_calls[len(calls)]
        calls.append(ids)
        if len(calls) == 1:
            return decode('[]')
        if len(calls) == 2:
            return decode('[{"id":"b1","translation":"one"},{"id":"b1","translation":"again"}]')
        if len(calls) == 3:
            return decode('[{"id":"invented","translation":"no"}]')
        return decode(json.dumps([{"id": item_id, "translation": item_id} for item_id in ids]))

    ticks = iter(range(100))
    capture = run_quality_probe(manifest, baseline, generate, clock=lambda: next(ticks))

    assert len(capture["attempts"]) == 9
    assert calls == expected_calls
    assert {call["error_code"] for row in capture["attempts"] for call in row["calls"]} >= {
        "invalid_response"
    }


def test_quality_probe_records_call_start_relative_to_probe():
    expected_calls = [["b3"], ["b1", "b2"], ["b1"], ["b2", "b3"], ["b1", "b2", "b3"]]
    call_index = 0

    def generate(_, decode):
        nonlocal call_index
        ids = expected_calls[call_index]
        call_index += 1
        return decode(json.dumps([{"id": item_id, "translation": item_id} for item_id in ids]))

    ticks = iter(range(100, 200))
    capture = run_quality_probe(
        {"fixtures": [_policy_page()]},
        {"page-1": [["b3"], ["b1", "b2"]]},
        generate,
        attempts=1,
        clock=lambda: next(ticks),
    )
    calls = [call for row in capture["attempts"] for call in row["calls"]]

    assert [call["started"] for call in calls] == [1, 3, 5, 7, 9]
    assert [call["duration"] for call in calls] == [1, 1, 1, 1, 1]


def test_quality_probe_classifies_decoder_errors_wrapped_by_generate_as_invalid_response():
    def generate(_, decode):
        try:
            decode("[]")
        except ValueError as error:
            raise RuntimeError(str(error)) from error

    capture = run_quality_probe(
        {"fixtures": [_policy_page()]},
        {"page-1": [["b3"], ["b1", "b2"]]},
        generate,
        attempts=1,
    )

    assert {
        (call["status"], call["error_code"])
        for row in capture["attempts"]
        for call in row["calls"]
    } == {("invalid_response", "invalid_response")}


def test_quality_probe_classifies_gemini_429_as_rate_limited():
    class RateLimitError(Exception):
        code = 429

    def generate(_, __):
        raise RateLimitError("RESOURCE_EXHAUSTED")

    capture = run_quality_probe(
        {"fixtures": [_policy_page()]},
        {"page-1": [["b3"], ["b1", "b2"]]},
        generate,
        attempts=1,
    )

    assert {
        (call["status"], call["error_code"])
        for row in capture["attempts"]
        for call in row["calls"]
    } == {("rate_limited", "rate_limited")}


@pytest.mark.parametrize(
    ("baseline", "message"),
    [
        ([], "baseline batches không hợp lệ"),
        ([["b3"], ["b1", "b1"]], "baseline ids không khớp manifest"),
    ],
)
def test_quality_probe_rejects_invalid_baseline_before_calling_generate(baseline, message):
    def generate(_, __):
        pytest.fail("generate must not be called for an invalid baseline")

    with pytest.raises(ValueError, match=message):
        run_quality_probe({"fixtures": [_policy_page()]}, {"page-1": baseline}, generate, attempts=1)


def test_quality_probe_includes_supplied_metadata():
    metadata = {
        "captured_at": "2026-08-02T03:00:00+00:00",
        "commit": "commit-x",
        "device": "device-x",
        "model": "model-x",
        "temperature": 0.37,
    }

    capture = run_quality_probe(
        {"fixtures": []},
        {},
        lambda *_: pytest.fail("empty manifest must not call Gemini"),
        metadata=metadata,
    )

    assert capture == {
        "schema_version": 1,
        "prompt_version": "comic-page-eval-v1",
        "policy_version": "real-page-policy-v1",
        "fixture_sha256": {},
        "baseline": {},
        "attempts": [],
        "metadata": metadata,
    }


def test_capture_validator_requires_exact_metadata_fields():
    manifest, capture, _ = _evaluator_case("pt")
    capture["metadata"].pop("device")

    with pytest.raises(ValueError, match="metadata"):
        validate_capture(manifest, capture)

    assert CAPTURE_METADATA_FIELDS == ("captured_at", "commit", "device", "model", "temperature")


def test_capture_validator_accepts_utc_capture_timestamp_and_gate_echoes_it():
    manifest, capture, scores = _evaluator_case("pt")
    capture["metadata"]["captured_at"] = "2026-08-02T03:00:00+00:00"

    assert evaluate_gate(manifest, capture, scores)["captured_at"] == capture["metadata"]["captured_at"]


@pytest.mark.parametrize(
    "captured_at",
    ["not-a-time", "2026-08-02T03:00:00", "2026-08-02T10:00:00+07:00"],
)
def test_capture_validator_rejects_non_utc_capture_timestamp(captured_at):
    manifest, capture, _ = _evaluator_case("pt")
    capture["metadata"]["captured_at"] = captured_at

    with pytest.raises(ValueError, match="metadata"):
        validate_capture(manifest, capture)


def test_capture_validator_rejects_boolean_schema_version():
    manifest, capture, _ = _evaluator_case("pt")
    capture["schema_version"] = True

    with pytest.raises(ValueError, match="schema"):
        validate_capture(manifest, capture)


def test_capture_validator_rejects_boolean_attempt():
    manifest, capture, _ = _evaluator_case("pt")
    capture["attempts"][0]["attempt"] = True

    with pytest.raises(ValueError, match="attempt key"):
        validate_capture(manifest, capture)


@pytest.mark.parametrize("fixture_block_ids", [[{}], [[]]])
def test_capture_validator_rejects_non_string_fixture_block_ids(fixture_block_ids):
    manifest, capture, _ = _evaluator_case("pt")
    capture["attempts"][0]["calls"][0]["fixture_block_ids"] = fixture_block_ids

    with pytest.raises(ValueError, match="fixture_block_ids"):
        validate_capture(manifest, capture)


def test_manual_score_validator_rejects_boolean_attempt_before_membership_lookup():
    manifest, capture, scores = _evaluator_case("pt")
    scores[0]["attempt"] = True

    with pytest.raises(ValueError, match="manual score key"):
        evaluate_gate(manifest, capture, scores)


@pytest.mark.parametrize("name", ["missing", "duplicate", "invented", "empty_translation"])
def test_capture_validator_rejects_invalid_response_membership(name):
    manifest, capture, error = _invalid_capture(name)

    with pytest.raises(ValueError, match=error):
        validate_capture(manifest, capture)


def test_context_score_and_offline_gate_cases():
    manifest, capture, scores = _evaluator_case("no_headroom")

    assert context_score({"terms": 2, "pronouns": 1, "coherence": 2}) == 5
    assert evaluate_gate(manifest, capture, scores)["decision"] == "no_context_headroom"


@pytest.mark.parametrize(
    ("name", "decision", "selected"),
    [
        ("pt", "selected", "ordered_microbatch"),
        ("candidate_critical_error", "blocked", None),
        ("candidate_safety_zero", "blocked", None),
        ("two_valid_responses", "selected", "ordered_microbatch"),
        ("inconclusive", "inconclusive", None),
        ("blocked_regression", "blocked", None),
        ("tie_break_calls_then_latency", "selected", "full_page"),
        ("tie_break_latency", "selected", "full_page"),
        ("tie_break_failed_attempt_cost", "selected", "full_page"),
    ],
)
def test_offline_gate_decisions_are_deterministic(name, decision, selected):
    manifest, capture, scores = _evaluator_case(name)
    result = evaluate_gate(manifest, capture, scores)

    assert result["decision"] == decision
    assert result.get("selected") == selected


def test_offline_gate_marks_portuguese_context_not_applicable_and_checks_term_surfaces():
    manifest, capture, scores = _evaluator_case("pt")
    result = evaluate_gate(manifest, capture, scores)

    assert result["pages"]["mangadex_pt"]["context_score"] == "not_applicable"
    assert {
        arm["context_score"]
        for arm in result["pages"]["mangadex_pt"]["arms"].values()
    } == {"not_applicable"}
    conflict_manifest, conflict_capture, conflict_scores = _evaluator_case("term_surface_conflict")
    with pytest.raises(ValueError, match="term"):
        evaluate_gate(conflict_manifest, conflict_capture, conflict_scores)
    broken_manifest = copy.deepcopy(manifest)
    broken_manifest["fixtures"][0]["reading_direction"] = "ltr"
    with pytest.raises(ValueError, match="PT reading_direction"):
        evaluate_gate(broken_manifest, capture, scores)


def test_portuguese_rtl_is_checked_even_without_valid_response_or_score():
    manifest, capture, scores = _evaluator_case("pt_without_scores")
    manifest["fixtures"][0]["reading_direction"] = "ltr"

    with pytest.raises(ValueError, match="PT reading_direction"):
        evaluate_gate(manifest, capture, scores)


def test_blocked_arm_reports_safety_failures_from_every_page():
    manifest, capture, scores = _evaluator_case("pt")
    for score in scores:
        if score["arm"] != "ordered_microbatch":
            continue
        if score["page_id"] == "mangadex_pt" and score["attempt"] == 1:
            score["critical_error"] = True
        if score["page_id"] == "s-manga_ja_1":
            score["correctness"] = 0

    reasons = evaluate_gate(manifest, capture, scores)["arms"]["ordered_microbatch"]["reasons"]

    assert reasons == [
        "mangadex_pt: critical_error",
        "s-manga_ja_1: safety median 0",
    ]


def test_inconclusive_arm_still_reports_observed_critical_errors():
    manifest, capture, scores = _evaluator_case("inconclusive")
    score = next(
        row
        for row in scores
        if row["page_id"] == "s-manga_ja_2"
        and row["arm"] == "ordered_microbatch"
        and row["attempt"] == 1
    )
    score["critical_error"] = True

    arm = evaluate_gate(manifest, capture, scores)["arms"]["ordered_microbatch"]

    assert arm == {
        "status": "inconclusive",
        "reasons": [
            "s-manga_ja_1: dưới hai response hợp lệ",
            "s-manga_ja_2: critical_error",
        ],
    }


def test_inconclusive_arm_allows_pages_with_no_valid_responses():
    manifest, capture, scores = _evaluator_case("pt_without_scores")

    result = evaluate_gate(manifest, capture, scores)

    assert result["decision"] == "inconclusive"
    assert result["arms"]["ordered_microbatch"] == {
        "status": "inconclusive",
        "reasons": ["mangadex_pt: dưới hai response hợp lệ"],
    }


@pytest.mark.parametrize(
    ("name", "mutate", "message"),
    [
        ("extra-field", lambda call: call.update(extra=True), "call schema"),
        ("missing-field", lambda call: call.pop("started"), "call schema"),
        ("batch-id", lambda call: call.update(batch_id=0), "batch_id"),
        ("batch-id-bool", lambda call: call.update(batch_id=True), "batch_id"),
        ("started-bool", lambda call: call.update(started=True), "call started"),
        ("started-infinite", lambda call: call.update(started=float("inf")), "call started"),
        ("started-negative", lambda call: call.update(started=-1), "call started"),
        ("duration-bool", lambda call: call.update(duration=True), "call duration"),
        ("duration-infinite", lambda call: call.update(duration=float("inf")), "call duration"),
        ("duration-negative", lambda call: call.update(duration=-1), "call duration"),
        ("success-error", lambda call: call.update(error_code="generation_error"), "call error_code"),
        ("failed-error", lambda call: call.update(status="failed", error_code=None), "call error_code"),
        ("rate-error", lambda call: call.update(status="rate_limited", error_code="generation_error"), "call error_code"),
        ("invalid-error", lambda call: call.update(status="invalid_response", error_code="generation_error"), "call error_code"),
    ],
)
def test_capture_validator_rejects_malformed_call_schema(name, mutate, message):
    manifest, capture, _ = _evaluator_case("pt")
    mutate(capture["attempts"][0]["calls"][0])

    with pytest.raises(ValueError, match=message):
        validate_capture(manifest, capture)


@pytest.mark.parametrize("responses", [{}, {"b2": "hai"}])
def test_capture_validator_requires_responses_for_exact_successful_call_membership(responses):
    manifest, capture, _ = _evaluator_case("tie_break_calls_then_latency")
    row = capture["attempts"][0]
    row["calls"][1].update(status="failed", error_code="generation_error")
    row["responses"] = responses

    with pytest.raises(ValueError, match="successful call membership"):
        validate_capture(manifest, capture)


def test_capture_validator_allows_only_the_successful_batch_response_in_partial_attempt():
    manifest, capture, _ = _evaluator_case("tie_break_calls_then_latency")
    row = capture["attempts"][0]
    row["calls"][1].update(status="failed", error_code="generation_error")
    row["responses"] = {"b1": "một"}

    assert ("mangadex_pt", "batch_control", 1) not in validate_capture(manifest, capture)["valid_attempts"]


def test_capture_validator_wraps_invalid_baseline_as_capture_error():
    manifest, capture, _ = _evaluator_case("pt")
    capture["baseline"]["mangadex_pt"] = []

    with pytest.raises(ValueError, match="^capture không hợp lệ:"):
        validate_capture(manifest, capture)


def test_term_surface_forms_may_differ_between_attempts_but_not_within_one_response():
    manifest, capture, scores = _evaluator_case("pt")
    score = next(
        row
        for row in scores
        if row["page_id"] == "s-manga_ja_1" and row["arm"] == "batch_control" and row["attempt"] == 2
    )
    score["term_forms"] = {"Hero": {"b1": "Hiệp sĩ", "b2": "Hiệp sĩ"}}

    assert evaluate_gate(manifest, capture, scores)["decision"] == "selected"


def test_preview_latency_is_rejected_until_a_future_gate_selects_full_page(capsys):
    with pytest.raises(SystemExit):
        run_probe_main(["--manifest", "x", "--baseline", "x", "--out", "x", "--preview-latency"])

    assert "unavailable until Task 6 selects full_page" in capsys.readouterr().err


def test_probe_cli_rejects_attempt_count_other_than_three(capsys):
    with pytest.raises(SystemExit):
        run_probe_main(
            [
                "run",
                "--manifest",
                "x",
                "--baseline",
                "x",
                "--out",
                "x",
                "--attempts",
                "2",
            ]
        )

    assert "invalid choice" in capsys.readouterr().err


def test_probe_cli_creates_output_parent_before_running_probe(tmp_path, monkeypatch):
    class FakeTranslator:
        def _generate(self, *_):
            pytest.fail("empty manifest must not call Gemini")

    monkeypatch.setattr(
        "server.run_real_page_probe.validate_manifest", lambda _: {"fixtures": []}
    )
    monkeypatch.setattr("server.run_real_page_probe.load_manifest", lambda _: {})
    monkeypatch.setattr("server.translator.GeminiTranslator", FakeTranslator)
    monkeypatch.setattr("server.translator.GENERATION_TEMPERATURE", 0.37)
    monkeypatch.setattr("server.config.GEMINI_MODEL", "model-x")
    monkeypatch.setattr("server.run_real_page_probe._commit", lambda: "commit-x")
    monkeypatch.setattr("server.run_real_page_probe.platform.platform", lambda: "device-x")
    out = tmp_path / "new" / "captures" / "probe.json"

    def fake_probe(*_, **kwargs):
        assert out.parent.is_dir()
        captured_at = kwargs["metadata"]["captured_at"]
        assert datetime.fromisoformat(captured_at).utcoffset() == timedelta(0)
        return {
            "schema_version": 1,
            "prompt_version": "comic-page-eval-v1",
            "policy_version": "real-page-policy-v1",
            "fixture_sha256": {},
            "baseline": {},
            "attempts": [],
            "metadata": kwargs["metadata"],
        }

    monkeypatch.setattr("server.run_real_page_probe.run_quality_probe", fake_probe)

    run_probe_main(["run", "--manifest", "manifest.json", "--baseline", "baseline.json", "--out", str(out)])

    capture = json.loads(out.read_text(encoding="utf-8"))
    assert capture["attempts"] == []
    assert capture["metadata"] == {
        "captured_at": capture["metadata"]["captured_at"],
        "commit": "commit-x",
        "device": "device-x",
        "model": "model-x",
        "temperature": 0.37,
    }


def test_evaluate_cli_runs_offline_without_importing_translator(tmp_path, monkeypatch):
    manifest, capture, scores = _evaluator_case("pt")
    manifest_path = tmp_path / "manifest.json"
    capture_path = tmp_path / "capture.json"
    scores_path = tmp_path / "scores.json"
    out = tmp_path / "out" / "decision.json"
    for path, value in ((manifest_path, manifest), (capture_path, capture), (scores_path, scores)):
        path.write_text(json.dumps(value), encoding="utf-8")
    monkeypatch.setitem(sys.modules, "server.translator", None)
    monkeypatch.setattr("server.run_real_page_probe.validate_manifest", lambda _: manifest)

    run_probe_main(
        [
            "evaluate",
            "--manifest",
            str(manifest_path),
            "--capture",
            str(capture_path),
            "--scores",
            str(scores_path),
            "--out",
            str(out),
        ]
    )

    assert json.loads(out.read_text(encoding="utf-8"))["decision"] == "selected"


def test_evaluate_cli_help_uses_offline_subcommand():
    result = subprocess.run(
        [sys.executable, "-m", "server.run_real_page_probe", "evaluate", "--help"],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )

    assert result.returncode == 0
    assert "--capture" in result.stdout and "--scores" in result.stdout


def test_reviewed_manifest_and_six_canonical_images_are_valid():
    manifest = validate_manifest(MANIFEST)
    sources = {item["id"]: item for item in manifest["fixtures"] if item["role"] == "source_page"}
    references = [item for item in manifest["fixtures"] if item["role"] == "failure_reference"]

    assert set(sources) == {"mangadex_pt", "s-manga_ja_1", "s-manga_ja_2"}
    assert {item["image"] for item in manifest["fixtures"]} == set(EXPECTED_IMAGES)
    assert [len(sources[name]["regions"]) for name in sources] == [7, 21, 17]
    assert all(region["required"] is True for source in sources.values() for region in source["regions"])
    assert sources["mangadex_pt"]["src_lang"] == "pt"
    assert sources["mangadex_pt"]["reading_direction"] == "rtl"
    ja1 = sources["s-manga_ja_1"]
    assert ja1["regions"][1] == {
        "fixture_block_id": "b02",
        "bbox": [824, 173, 133, 19],
        "reading_order": 1,
        "kind": "sign",
        "src_text": "新人ヒーロー募集中！くわしくはＨＰへ",
        "required": True,
    }
    assert [region["bbox"] for region in ja1["regions"][:6]] == [
        [1010, 50, 58, 154],
        [824, 173, 133, 19],
        [659, 45, 30, 60],
        [596, 162, 54, 127],
        [963, 362, 117, 145],
        [770, 353, 76, 147],
    ]
    assert [region["reading_order"] for region in ja1["regions"][:6]] == list(range(6))
    order = {region["src_text"]: region["reading_order"] for region in ja1["regions"]}
    assert order["ＣＭによるイメージ向上と"] < order["ここで暮らす富豪達からの信頼も回復できた"]
    assert order["ＣＭによるイメージ向上と"] < order[
        "周辺被害を「タツマキによる鬼怪人集団の撃退」によるものと報道することで"
    ]
    assert ja1["term_groups"] == [
        {
            "canonical": "マッコイ",
            "accepted_source_forms": ["マッコイ", "マッコイ氏"],
            "fixture_block_ids": ["b07", "b20"],
        },
        {
            "canonical": "タツマキ",
            "accepted_source_forms": ["タツマキ"],
            "fixture_block_ids": ["b05", "b19"],
        },
    ]
    assert len(references) == 3
    assert set(references[0]) >= {"id", "role", "image", "sha256", "source_page", "labels"}
    labels = {item["source_page"]: set(item["labels"]) for item in references}
    assert labels == {
        "mangadex_pt": {
            "partial_translation",
            "overlay_missing",
            "white_bbox_exposes_source",
            "text_clipped",
        },
        "s-manga_ja_1": {
            "fragmented_blocks",
            "text_clipped",
            "oversized_text",
            "source_text_exposed",
        },
        "s-manga_ja_2": {"fragmented_blocks", "text_clipped", "source_text_exposed"},
    }
    assert "detector_missing_bubble" not in labels["mangadex_pt"]


def test_manifest_validator_requires_portuguese_rtl(tmp_path):
    manifest = load_manifest(MANIFEST)
    portuguese = next(item for item in manifest["fixtures"] if item.get("src_lang") == "pt")
    portuguese["reading_direction"] = "ltr"
    path = tmp_path / "invalid-pt-direction.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(ValueError, match="PT reading_direction"):
        validate_manifest(path, image_root=FIXTURE_DIR)


def test_manifest_validator_rejects_broken_source_region_and_reference_schema(tmp_path):
    original = load_manifest(MANIFEST)
    source_index = next(i for i, item in enumerate(original["fixtures"]) if item["role"] == "source_page")
    reference_index = next(i for i, item in enumerate(original["fixtures"]) if item["role"] == "failure_reference")
    cases = [
        (lambda data: data["fixtures"][source_index].pop("source_name"), "source_name"),
        (lambda data: data["fixtures"][source_index].update(regions={}), "regions"),
        (
            lambda data: data["fixtures"][source_index]["regions"][0].update(fixture_block_id=""),
            "fixture_block_id",
        ),
        (lambda data: data["fixtures"][source_index]["regions"][0].update(bbox=[0, 1, 10, 10]), "bbox"),
        (lambda data: data["fixtures"][source_index]["regions"][0].update(reading_order=2), "reading_order"),
        (lambda data: data["fixtures"][source_index]["regions"][0].update(kind="caption"), "kind"),
        (lambda data: data["fixtures"][source_index]["regions"][0].update(src_text=""), "src_text"),
        (lambda data: data["fixtures"][source_index]["regions"][0].update(required=1), "required"),
        (lambda data: data["fixtures"][source_index].update(role="source_pag"), "role không hợp lệ"),
        (lambda data: data["fixtures"][reference_index].update(source_page="missing"), "source_page"),
        (lambda data: data["fixtures"][reference_index].update(labels=[]), "labels"),
    ]

    for mutate, message in cases:
        data = copy.deepcopy(original)
        mutate(data)
        path = tmp_path / f"invalid-{message}.json"
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        with pytest.raises(ValueError, match=message):
            validate_manifest(path, image_root=FIXTURE_DIR)


@pytest.mark.parametrize(
    ("name", "mutate", "message"),
    [
        (
            "term-group-type",
            lambda source: source.update(term_groups=[123]),
            "term_group sai field",
        ),
        (
            "term-group-fields",
            lambda source: source["term_groups"][0].update(extra="x"),
            "term_group sai field",
        ),
        (
            "term-group-canonical",
            lambda source: source["term_groups"][0].update(canonical=""),
            "canonical",
        ),
        (
            "term-group-source-forms",
            lambda source: source["term_groups"][0].update(accepted_source_forms=[]),
            "accepted_source_forms",
        ),
        (
            "term-group-single-block",
            lambda source: source["term_groups"][0].update(fixture_block_ids=["b07"]),
            "ít nhất hai block",
        ),
        (
            "term-group-duplicate-block",
            lambda source: source["term_groups"][0].update(fixture_block_ids=["b07", "b07"]),
            "ít nhất hai block",
        ),
        (
            "term-group-missing-block",
            lambda source: source["term_groups"][0].update(fixture_block_ids=["b07", "missing"]),
            "fixture_block_id không tồn tại",
        ),
        (
            "term-group-duplicate-canonical",
            lambda source: source["term_groups"].append(copy.deepcopy(source["term_groups"][0])),
            "canonical trùng",
        ),
        (
            "known-order-failure",
            lambda source: source.update(known_order_failures=[""]),
            "known_order_failures",
        ),
    ],
)
def test_manifest_validator_rejects_invalid_term_groups_and_known_order_failures(
    tmp_path, name, mutate, message
):
    original = load_manifest(MANIFEST)
    source_index = next(i for i, item in enumerate(original["fixtures"]) if item["id"] == "s-manga_ja_1")
    data = copy.deepcopy(original)
    source = data["fixtures"][source_index]
    mutate(source)
    path = tmp_path / f"invalid-{name}.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match=message):
        validate_manifest(path, image_root=FIXTURE_DIR)


def test_manifest_validator_rejects_fixture_hash_drift(tmp_path):
    data = load_manifest(MANIFEST)
    data["fixtures"][0]["sha256"] = "0" * 64
    path = tmp_path / "hash-drift.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(ValueError, match="sha256"):
        validate_manifest(path, image_root=FIXTURE_DIR)


def test_manifest_validator_rejects_png_dimension_drift(tmp_path):
    data = load_manifest(MANIFEST)
    data["fixtures"][0].update(width=9999, height=9999)
    path = tmp_path / "dimension-drift.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(ValueError, match="width/height"):
        validate_manifest(path, image_root=FIXTURE_DIR)


def test_manifest_validator_rejects_duplicate_fixtures_images_and_ids(tmp_path):
    original = load_manifest(MANIFEST)
    source = next(item for item in original["fixtures"] if item["role"] == "source_page")
    cases = [
        ("fixture-count", lambda data: data["fixtures"].append(copy.deepcopy(data["fixtures"][0])), "sáu"),
        (
            "image",
            lambda data: data["fixtures"][1].update(image=data["fixtures"][0]["image"]),
            "image trùng",
        ),
        (
            "fixture-id",
            lambda data: data["fixtures"][1].update(id=data["fixtures"][0]["id"]),
            "fixture id trùng",
        ),
        (
            "region-id",
            lambda data: next(item for item in data["fixtures"] if item["id"] == source["id"])[
                "regions"
            ][1].update(fixture_block_id=source["regions"][0]["fixture_block_id"]),
            "fixture_block_id trùng",
        ),
    ]

    for name, mutate, message in cases:
        data = copy.deepcopy(original)
        mutate(data)
        path = tmp_path / f"duplicate-{name}.json"
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        with pytest.raises(ValueError, match=message):
            validate_manifest(path, image_root=FIXTURE_DIR)


def test_canonical_images_are_tracked_once_by_sha():
    tracked = subprocess.run(
        ["git", "ls-files", "--full-name", "--", "*.png"],
        check=True,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    ).stdout.splitlines()
    sha_paths = {}
    for name in tracked:
        path = REPO_ROOT / name
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        sha_paths.setdefault(digest, []).append(name)

    for relative, digest in EXPECTED_IMAGES.items():
        canonical = f"server/tests/fixtures/real_pages/{relative}"
        assert sha_paths.get(digest) == [canonical]


def test_match_required_regions_reports_missing_duplicate_and_unexpected():
    expected = [
        {"fixture_block_id": "b01", "bbox": [0, 0, 10, 10], "required": True},
        {"fixture_block_id": "b02", "bbox": [20, 0, 10, 10], "required": True},
    ]
    detected = [
        {"bbox": [0, 0, 10, 10]},
        {"bbox": [100, 100, 10, 10]},
    ]

    result = match_required_regions(expected, detected)

    assert result["missing"] == ["b02"]
    assert result["unexpected"] == [1]
    assert result["duplicate"] == []

    duplicate = match_required_regions(
        [{"fixture_block_id": "b01", "bbox": [0, 0, 10, 10], "required": True}],
        [{"bbox": [0, 0, 10, 10]}, {"bbox": [0, 0, 10, 10]}],
    )
    assert duplicate["duplicate"]
    assert duplicate["unexpected"] == [1]


def test_match_required_regions_accepts_one_to_one_matches():
    expected = [
        {"fixture_block_id": "b01", "bbox": [0, 0, 10, 10], "required": True},
        {"fixture_block_id": "b02", "bbox": [20, 0, 10, 10], "required": True},
    ]
    detected = [{"bbox": [1, 1, 10, 10]}, {"bbox": [20, 0, 10, 10]}]

    result = match_required_regions(expected, detected)

    assert result == {
        "matches": {"b01": 0, "b02": 1},
        "missing": [],
        "duplicate": [],
        "unexpected": [],
    }


def test_match_required_regions_reports_one_detection_overlapping_two_anchors():
    expected = [
        {"fixture_block_id": "b01", "bbox": [0, 0, 10, 10], "required": True},
        {"fixture_block_id": "b02", "bbox": [5, 0, 10, 10], "required": True},
    ]

    result = match_required_regions(expected, [{"bbox": [2, 0, 11, 10]}])

    assert result["missing"] == ["b02"]
    assert result["unexpected"] == []
    assert result["duplicate"] == [
        {"detected_index": 0, "fixture_block_ids": ["b01", "b02"]}
    ]


def test_match_required_regions_rejects_iou_exactly_at_threshold():
    expected = [{"fixture_block_id": "b01", "bbox": [0, 0, 10, 10], "required": True}]

    result = match_required_regions(expected, [{"bbox": [0, 0, 5, 10]}], min_iou=0.5)

    assert result == {
        "matches": {},
        "missing": ["b01"],
        "duplicate": [],
        "unexpected": [0],
    }
