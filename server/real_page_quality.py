import hashlib
import json
import time
from pathlib import Path


SOURCE_FIELDS = {
    "id",
    "role",
    "image",
    "sha256",
    "src_lang",
    "source_name",
    "reading_direction",
    "page_kind",
    "width",
    "height",
    "regions",
    "term_groups",
    "known_order_failures",
}
REGION_FIELDS = {"fixture_block_id", "bbox", "reading_order", "kind", "src_text", "required"}
REFERENCE_FIELDS = {"id", "role", "image", "sha256", "source_page", "labels"}
TERM_GROUP_FIELDS = {"canonical", "accepted_source_forms", "fixture_block_ids"}
KINDS = {"dialogue", "sfx", "sign"}
CANONICAL_IMAGES = {
    "mangadex_pt.png",
    "s-manga_ja_1.png",
    "s-manga_ja_2.png",
    "references/mangadex_pt_overlay_partial_and_crop.png",
    "references/s-manga_ja_overlay_1.png",
    "references/s-manga_ja_overlay_2.png",
}
QUALITY_ARMS = ("batch_control", "ordered_microbatch", "full_page")
PROMPT_VERSION = "comic-page-eval-v1"
POLICY_VERSION = "real-page-policy-v1"


def load_manifest(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def source_pages(manifest):
    return [item for item in manifest["fixtures"] if item["role"] == "source_page"]


def prompt_items(page):
    return [
        {
            "id": region["fixture_block_id"],
            "text": region["src_text"],
            "reading_order": region["reading_order"],
            "bbox": region["bbox"],
        }
        for region in page["regions"]
    ]


def _validate_baseline(items, baseline_batches):
    if not isinstance(baseline_batches, list) or not all(isinstance(batch, list) and batch for batch in baseline_batches):
        raise ValueError("baseline batches khÃ´ng há»£p lá»‡")
    baseline_ids = [item_id for batch in baseline_batches for item_id in batch]
    item_ids = [item["id"] for item in items]
    if len(baseline_ids) != len(set(baseline_ids)) or set(baseline_ids) != set(item_ids):
        raise ValueError("baseline ids khÃ´ng khá»›p manifest")


def policy_batches(page, arm, baseline_batches):
    items = prompt_items(page)
    items_by_id = {item["id"]: item for item in items}
    if len(items_by_id) != len(items):
        raise ValueError("fixture block id trÃ¹ng")
    if arm == "full_page":
        return [sorted(items, key=lambda item: item["reading_order"])]
    if arm not in {"batch_control", "ordered_microbatch"}:
        raise ValueError(f"quality arm khÃ´ng há»£p lá»‡: {arm}")
    _validate_baseline(items, baseline_batches)
    if arm == "batch_control":
        return [[items_by_id[item_id] for item_id in batch] for batch in baseline_batches]
    ordered = sorted(items, key=lambda item: item["reading_order"])
    sizes = [len(batch) for batch in baseline_batches]
    batches = []
    offset = 0
    for size in sizes:
        batches.append(ordered[offset : offset + size])
        offset += size
    return batches


def build_eval_prompt(page, items):
    return """You are evaluating translations for blocks from one manga/comic page.
Prompt version: {prompt_version}
Source language: {source_language}
Destination language: Vietnamese
Page width/height: {width}/{height}
Reading direction: {reading_direction}
Use reading order to keep translations consistent across this page. Translate naturally and concisely.
Return ONLY a JSON array of objects with exactly these keys:
{{\"id\":\"the input id\",\"translation\":\"translated text\"}}.
Return every input id exactly once; do not invent ids.

{items}""".format(
        prompt_version=PROMPT_VERSION,
        source_language=page["source_name"],
        width=page["width"],
        height=page["height"],
        reading_direction=page["reading_direction"],
        items=json.dumps(items, ensure_ascii=False),
    )


def decode_eval_items(raw, expected_ids):
    try:
        out = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("invalid_response: invalid JSON") from error
    if not isinstance(out, list):
        raise ValueError("invalid_response: expected an array")
    rows = {}
    for item in out:
        if not isinstance(item, dict) or set(item) != {"id", "translation"}:
            raise ValueError("invalid_response: invalid translation item")
        item_id = str(item["id"])
        if item_id in rows:
            raise ValueError(f"invalid_response: duplicate id: {item_id}")
        rows[item_id] = str(item["translation"])
    if set(rows) != set(expected_ids):
        raise ValueError("invalid_response: translation id set mismatch")
    return [{"id": item_id, "translation": rows[item_id]} for item_id in expected_ids]


def classify_probe_error(error):
    if isinstance(error, ValueError) or str(error).startswith("invalid_response:"):
        return "invalid_response", "invalid_response"
    if getattr(error, "code", None) == 429 or "429" in str(error) or "RESOURCE_EXHAUSTED" in str(error):
        return "rate_limited", "rate_limited"
    return "failed", "generation_error"


def capture_call(batch_id, batch, started, ended, status, error_code):
    return {
        "batch_id": batch_id,
        "fixture_block_ids": [item["id"] for item in batch],
        "started": started,
        "duration": ended - started,
        "status": status,
        "error_code": error_code,
    }


def capture_attempt(page, arm, attempt, calls, translations):
    return {
        "page_id": page["id"],
        "arm": arm,
        "attempt": attempt,
        "calls": calls,
        "responses": {item["id"]: item["translation"] for item in translations},
    }


def build_capture(manifest, baseline, rows):
    return {
        "schema_version": 1,
        "prompt_version": PROMPT_VERSION,
        "policy_version": POLICY_VERSION,
        "fixture_sha256": {page["id"]: page.get("sha256") for page in source_pages(manifest)},
        "baseline": baseline,
        "attempts": rows,
    }


def run_quality_probe(manifest, baseline, generate, attempts=3, clock=time.perf_counter):
    rows = []
    for page in source_pages(manifest):
        for arm in QUALITY_ARMS:
            batches = policy_batches(page, arm, baseline.get(page["id"], []))
            for attempt in range(1, attempts + 1):
                calls, translations = [], []
                for batch_id, batch in enumerate(batches, 1):
                    started = clock()
                    try:
                        decoded = generate(
                            build_eval_prompt(page, batch),
                            lambda raw, ids=[item["id"] for item in batch]: decode_eval_items(raw, ids),
                        )
                        status, error_code = "success", None
                        translations.extend(decoded)
                    except Exception as error:
                        status, error_code = classify_probe_error(error)
                    calls.append(capture_call(batch_id, batch, started, clock(), status, error_code))
                rows.append(capture_attempt(page, arm, attempt, calls, translations))
    return build_capture(manifest, baseline, rows)


def _require_fields(item, fields, label):
    missing = fields - set(item)
    if missing:
        raise ValueError(f"{label} thiếu {sorted(missing)}")


def _valid_text(value):
    return isinstance(value, str) and bool(value.strip())


def validate_manifest(path, image_root=None):
    data = load_manifest(path)
    if data.get("schema_version") != 1 or not isinstance(data.get("fixtures"), list):
        raise ValueError("manifest schema_version/fixtures không hợp lệ")
    fixtures = data["fixtures"]
    if len(fixtures) != 6:
        raise ValueError("manifest phải có đúng sáu fixture")
    images = [item.get("image") for item in fixtures]
    if len(set(images)) != len(images):
        raise ValueError("image trùng trong manifest")
    if set(images) != CANONICAL_IMAGES:
        raise ValueError("manifest phải liệt kê đúng sáu image canonical")
    fixture_ids = [item.get("id") for item in fixtures]
    if not all(_valid_text(fixture_id) for fixture_id in fixture_ids):
        raise ValueError("fixture id không hợp lệ")
    if len(set(fixture_ids)) != len(fixture_ids):
        raise ValueError("fixture id trùng trong manifest")

    root = Path(image_root) if image_root else Path(path).parent
    source_ids = set()
    references = []
    for item in fixtures:
        role = item.get("role")
        if role not in {"source_page", "failure_reference"}:
            raise ValueError(f"role không hợp lệ: {role}")
        fields = SOURCE_FIELDS if role == "source_page" else REFERENCE_FIELDS
        _require_fields(item, fields, role or "fixture")
        image = root / item["image"]
        if not image.is_file():
            raise ValueError(f"image không tồn tại: {item['image']}")
        image_bytes = image.read_bytes()
        if hashlib.sha256(image_bytes).hexdigest() != item["sha256"]:
            raise ValueError(f"sha256 không khớp: {item['image']}")
        if role == "source_page" and (
            int.from_bytes(image_bytes[16:20], "big"), int.from_bytes(image_bytes[20:24], "big")
        ) != (item["width"], item["height"]):
            raise ValueError(f"width/height không khớp PNG: {item['image']}")

        if role == "failure_reference":
            if not isinstance(item["labels"], list) or not item["labels"] or not all(
                _valid_text(label) for label in item["labels"]
            ):
                raise ValueError(f"labels không hợp lệ: {item['id']}")
            references.append(item)
            continue
        source_ids.add(item["id"])
        if not all(_valid_text(item[name]) for name in ("id", "src_lang", "source_name")):
            raise ValueError(f"source text metadata không hợp lệ: {item.get('id')}")
        if item["reading_direction"] not in {"ltr", "rtl"}:
            raise ValueError(f"reading_direction không hợp lệ: {item['id']}")
        if item["page_kind"] not in {"single", "spread"}:
            raise ValueError(f"page_kind không hợp lệ: {item['id']}")
        if not all(isinstance(item[name], int) and item[name] > 0 for name in ("width", "height")):
            raise ValueError(f"width/height không hợp lệ: {item['id']}")
        if not isinstance(item["term_groups"], list) or not isinstance(item["known_order_failures"], list):
            raise ValueError(f"term_groups/known_order_failures không hợp lệ: {item['id']}")
        if not all(_valid_text(failure) for failure in item["known_order_failures"]):
            raise ValueError(f"known_order_failures không hợp lệ: {item['id']}")
        if not isinstance(item["regions"], list) or not item["regions"]:
            raise ValueError(f"regions không hợp lệ: {item['id']}")

        orders = []
        region_ids = set()
        for region in item["regions"]:
            _require_fields(region, REGION_FIELDS, f"region {item['id']}")
            if not _valid_text(region["fixture_block_id"]):
                raise ValueError("fixture_block_id không hợp lệ")
            if region["fixture_block_id"] in region_ids:
                raise ValueError(f"fixture_block_id trùng: {region['fixture_block_id']}")
            region_ids.add(region["fixture_block_id"])
            bbox = region["bbox"]
            if (
                not isinstance(bbox, list)
                or len(bbox) != 4
                or not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in bbox)
                or bbox[0] <= 0
                or bbox[1] <= 0
                or bbox[2] <= 0
                or bbox[3] <= 0
                or bbox[0] + bbox[2] > item["width"]
                or bbox[1] + bbox[3] > item["height"]
            ):
                raise ValueError(f"bbox không hợp lệ: {region.get('fixture_block_id')}")
            if region["kind"] not in KINDS:
                raise ValueError(f"kind không hợp lệ: {region.get('fixture_block_id')}")
            if not _valid_text(region["src_text"]):
                raise ValueError(f"src_text không hợp lệ: {region.get('fixture_block_id')}")
            if type(region["required"]) is not bool:
                raise ValueError(f"required không hợp lệ: {region.get('fixture_block_id')}")
            if not isinstance(region["reading_order"], int):
                raise ValueError(f"reading_order không hợp lệ: {region.get('fixture_block_id')}")
            orders.append(region["reading_order"])
        if sorted(orders) != list(range(len(orders))):
            raise ValueError(f"reading_order không liên tục: {item['id']}")

        canonicals = set()
        for group in item["term_groups"]:
            if not isinstance(group, dict) or set(group) != TERM_GROUP_FIELDS:
                raise ValueError(f"term_group sai field: {item['id']}")
            canonical = group["canonical"]
            if not _valid_text(canonical):
                raise ValueError("term_group canonical không hợp lệ")
            if canonical in canonicals:
                raise ValueError(f"term_group canonical trùng: {canonical}")
            canonicals.add(canonical)
            source_forms = group["accepted_source_forms"]
            if (
                not isinstance(source_forms, list)
                or not source_forms
                or not all(_valid_text(form) for form in source_forms)
            ):
                raise ValueError("accepted_source_forms không hợp lệ")
            block_ids = group["fixture_block_ids"]
            if (
                not isinstance(block_ids, list)
                or not all(_valid_text(block_id) for block_id in block_ids)
                or len(set(block_ids)) < 2
            ):
                raise ValueError("term_group phải lặp ở ít nhất hai block khác nhau")
            if not set(block_ids) <= region_ids:
                raise ValueError("term_group tham chiếu fixture_block_id không tồn tại")

    for reference in references:
        if reference["source_page"] not in source_ids:
            raise ValueError(f"source_page không tồn tại: {reference['source_page']}")
    return data


def _iou(left, right):
    lx, ly, lw, lh = left
    rx, ry, rw, rh = right
    overlap_w = max(0, min(lx + lw, rx + rw) - max(lx, rx))
    overlap_h = max(0, min(ly + lh, ry + rh) - max(ly, ry))
    intersection = overlap_w * overlap_h
    union = lw * lh + rw * rh - intersection
    return intersection / union if union else 0


def match_required_regions(expected, detected, min_iou=0.5):
    required = [region for region in expected if region.get("required", True)]
    candidates = []
    for expected_index, region in enumerate(required):
        for detected_index, candidate in enumerate(detected):
            score = _iou(region["bbox"], candidate["bbox"])
            if score > min_iou:
                candidates.append((score, expected_index, detected_index))

    matched_expected = set()
    matched_detected = set()
    matches = {}
    for _, expected_index, detected_index in sorted(candidates, key=lambda pair: (-pair[0], pair[1], pair[2])):
        if expected_index in matched_expected or detected_index in matched_detected:
            continue
        matched_expected.add(expected_index)
        matched_detected.add(detected_index)
        matches[required[expected_index]["fixture_block_id"]] = detected_index

    duplicate = []
    for expected_index, region in enumerate(required):
        indices = [detected_index for _, index, detected_index in candidates if index == expected_index]
        if len(indices) > 1:
            duplicate.append({"fixture_block_id": region["fixture_block_id"], "detected_indices": indices})
    for detected_index in range(len(detected)):
        ids = [
            required[expected_index]["fixture_block_id"]
            for _, expected_index, index in candidates
            if index == detected_index
        ]
        if len(ids) > 1:
            duplicate.append({"detected_index": detected_index, "fixture_block_ids": ids})

    return {
        "matches": matches,
        "missing": [
            region["fixture_block_id"]
            for index, region in enumerate(required)
            if index not in matched_expected
        ],
        "duplicate": duplicate,
        "unexpected": [index for index in range(len(detected)) if index not in matched_detected],
    }
