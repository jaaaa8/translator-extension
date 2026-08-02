import argparse
import json
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from .real_page_quality import evaluate_gate, load_manifest, run_quality_probe, validate_manifest


def _commit():
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        cwd=Path(__file__).resolve().parents[1],
    )
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def _run(argv):
    parser = argparse.ArgumentParser(description="Replay real-page translation quality policies.")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--attempts", type=int, choices=(3,), default=3)
    parser.add_argument("--preview-latency", action="store_true")
    args = parser.parse_args(argv)
    if args.preview_latency:
        parser.error("--preview-latency is unavailable until Task 6 selects full_page")
    manifest = validate_manifest(args.manifest)
    baseline = load_manifest(args.baseline)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    from . import config
    from .translator import GENERATION_TEMPERATURE, GeminiTranslator

    translator = GeminiTranslator()
    metadata = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "commit": _commit(),
        "device": platform.platform(),
        "model": config.GEMINI_MODEL,
        "temperature": GENERATION_TEMPERATURE,
    }
    capture = run_quality_probe(
        manifest,
        baseline,
        translator._generate,
        attempts=args.attempts,
        metadata=metadata,
    )
    out_path.write_text(json.dumps(capture, ensure_ascii=False, indent=2), encoding="utf-8")


def _evaluate(argv):
    parser = argparse.ArgumentParser(description="Evaluate a captured real-page policy probe offline.")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--capture", required=True)
    parser.add_argument("--scores", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    result = evaluate_gate(
        validate_manifest(args.manifest),
        load_manifest(args.capture),
        load_manifest(args.scores),
    )
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


def main(argv=None):
    argv = list(argv) if argv is not None else sys.argv[1:]
    if argv and argv[0] == "evaluate":
        return _evaluate(argv[1:])
    if argv and argv[0] == "run":
        return _run(argv[1:])
    return _run(argv)


if __name__ == "__main__":
    main()
