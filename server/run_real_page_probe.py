import argparse
import json
import platform
import subprocess
from pathlib import Path

from .real_page_quality import load_manifest, run_quality_probe, validate_manifest


def _commit():
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        cwd=Path(__file__).resolve().parents[1],
    )
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Replay real-page translation quality policies.")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--preview-latency", action="store_true")
    args = parser.parse_args(argv)
    if args.preview_latency:
        parser.error("--preview-latency is unavailable until Task 6 selects full_page")
    if args.attempts < 1:
        parser.error("--attempts must be positive")

    manifest = validate_manifest(args.manifest)
    baseline = load_manifest(args.baseline)
    from . import config
    from .translator import GeminiTranslator

    translator = GeminiTranslator()
    capture = run_quality_probe(manifest, baseline, translator._generate, attempts=args.attempts)
    capture["metadata"] = {
        "commit": _commit(),
        "device": platform.platform(),
        "model": config.GEMINI_MODEL,
        "temperature": 0.2,
    }
    Path(args.out).write_text(json.dumps(capture, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
