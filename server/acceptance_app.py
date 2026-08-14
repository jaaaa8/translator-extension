import asyncio
import base64
import ipaddress
import json
import struct
import zlib
from collections import deque
from hashlib import sha256
from math import isqrt
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .contracts import TranslateItemsBody, translate_items_validation_error
from . import config

PAGES = frozenset("ABCD")
STAGES = frozenset({"source", "ocr", "translation"})
FAULTS = frozenset({"source_after_load", "ocr_block", "translation_batch"})
EVENT_LIMIT = 500
ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "extension" / "test" / "fixture.html"
BENCHMARK_CONTROLLER = ROOT / "extension" / "test" / "fixture-benchmark.js"
NO_STORE_HEADERS = {"Cache-Control": "no-store"}
IMMUTABLE_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable"}
BENCHMARK_SAMPLES = ("warmup", *(str(index) for index in range(1, 21)))
LONG_TRANSLATION = " ".join(["long acceptance translation"] * 20)
PAGE_A_INK_RECTS = (
    (104, 100, 48, 5),
    (104, 100, 5, 80),
    (147, 100, 5, 80),
    (104, 137, 48, 5),
    (104, 175, 48, 5),
    (180, 100, 5, 80),
    (164, 116, 37, 5),
    (160, 140, 45, 5),
    (168, 160, 5, 20),
    (193, 160, 5, 20),
    (232, 100, 48, 5),
    (232, 100, 5, 80),
    (275, 100, 5, 80),
    (232, 175, 48, 5),
)
PAGE_A_ERASE_PADDING = 3

COUNTER_KEYS = (
    "page_load",
    "source",
    "ocr_stream",
    "translation",
    "source_aborted",
    "ocr_aborted",
    "active_source",
    "peak_source",
)


class HoldConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: set[str] = Field(default_factory=set)
    ocr: set[str] = Field(default_factory=set)
    translation: set[str] = Field(default_factory=set)


class FailConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_after_load: set[str] = Field(default_factory=set)
    ocr_block: set[str] = Field(default_factory=set)
    translation_batch: set[str] = Field(default_factory=set)


class EmptyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AcceptanceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hold: HoldConfig = Field(default_factory=HoldConfig)
    fail: FailConfig = Field(default_factory=FailConfig)
    blocks: dict[str, int] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_labels(self):
        configured = set().union(
            self.hold.source,
            self.hold.ocr,
            self.hold.translation,
            self.fail.source_after_load,
            self.fail.ocr_block,
            self.fail.translation_batch,
            self.blocks,
        )
        if not configured <= PAGES:
            raise ValueError("unknown synthetic page")
        if any(value < 1 or value > 16 for value in self.blocks.values()):
            raise ValueError("block count must be between 1 and 16")
        return self


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def _png(width: int, height: int, color_type: int, pixels: bytes) -> bytes:
    channels = {2: 3, 6: 4}[color_type]
    stride = width * channels
    if len(pixels) != stride * height:
        raise ValueError("pixel payload does not match PNG dimensions")
    scanlines = b"".join(
        b"\x00" + pixels[start:start + stride]
        for start in range(0, len(pixels), stride)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(scanlines))
        + _png_chunk(b"IEND", b"")
    )


def _page_a_source_png() -> bytes:
    width, height = 800, 1200
    pixels = bytearray(b"\xcc\xcc\xcc" * width * height)

    def fill(rect: tuple[int, int, int, int], color: bytes) -> None:
        left, top, rect_width, rect_height = rect
        row = color * rect_width
        for y in range(top, top + rect_height):
            start = (y * width + left) * 3
            pixels[start:start + len(row)] = row

    def fill_ellipse(
        center_x: int,
        center_y: int,
        radius_x: int,
        radius_y: int,
        color: bytes,
    ) -> None:
        radius_x_squared = radius_x * radius_x
        radius_y_squared = radius_y * radius_y
        for y in range(center_y - radius_y, center_y + radius_y + 1):
            delta_y = y - center_y
            half_width = isqrt(
                radius_x_squared
                * (radius_y_squared - delta_y * delta_y)
                // radius_y_squared
            )
            fill((center_x - half_width, y, half_width * 2 + 1, 1), color)

    fill_ellipse(200, 140, 152, 92, b"\x60\x60\x60")
    fill_ellipse(200, 140, 140, 80, b"\xff\xff\xff")
    for rect in PAGE_A_INK_RECTS:
        fill(rect, b"\x00\x00\x00")
    return _png(width, height, 2, bytes(pixels))


PAGE_A_SOURCE_PNG = _page_a_source_png()


def page_png(page: str, benchmark: str | None = None) -> bytes:
    if page not in PAGES:
        raise KeyError(page)
    base_png = PAGE_A_SOURCE_PNG
    chunks = [_png_chunk(b"tEXt", f"acceptance-page\0{page}".encode())]
    if benchmark is not None:
        chunks.append(_png_chunk(b"tEXt", f"acceptance-benchmark\0{benchmark}".encode()))
    iend = base_png.rfind(b"\x00\x00\x00\x00IEND")
    if iend < 0:
        raise RuntimeError("fixture PNG has no IEND chunk")
    return base_png[:iend] + b"".join(chunks) + base_png[iend:]


def patch_png(page: str) -> bytes:
    if page in {"A", "D"}:
        width, height = 240, 120
        rgba = bytearray(b"\xff\xff\xff\x00" * width * height)
        for left, top, rect_width, rect_height in PAGE_A_INK_RECTS:
            left -= PAGE_A_ERASE_PADDING
            top -= PAGE_A_ERASE_PADDING
            rect_width += PAGE_A_ERASE_PADDING * 2
            rect_height += PAGE_A_ERASE_PADDING * 2
            row = b"\xff\xff\xff\xff" * rect_width
            for y in range(top - 80, top - 80 + rect_height):
                start = (y * width + left - 80) * 4
                rgba[start:start + len(row)] = row
        return _png(width, height, 6, bytes(rgba))

    rgba = {
        "B": b"\xff\xff\xff\x00",
        "C": b"\x00\x00\x00\x00",
    }[page]
    return _png(1, 1, 6, rgba)


PAGE_BY_DIGEST = {sha256(page_png(page)).hexdigest(): page for page in PAGES}
PAGE_BY_DIGEST.update({
    sha256(page_png("A", sample)).hexdigest(): "A" for sample in BENCHMARK_SAMPLES
})


class AcceptanceState:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.config = AcceptanceConfig()
        self.gates: dict[tuple[str, str], asyncio.Event] = {}
        self.counts = dict.fromkeys(COUNTER_KEYS, 0)
        self.events: deque[dict[str, object]] = deque(maxlen=EVENT_LIMIT)
        self.sequence = 0
        self.analysis_pages: dict[str, str] = {}
        self.render_pages: dict[str, tuple[str, str]] = {}
        self.consumed_translation_faults: set[str] = set()
        self.generation = 0

    async def configure(self, config: AcceptanceConfig) -> None:
        async with self.lock:
            for gate in self.gates.values():
                gate.set()
            self.config = config.model_copy(deep=True)
            self.gates = {
                (stage, page): asyncio.Event()
                for stage in STAGES
                for page in getattr(self.config.hold, stage)
            }

    async def release(self, stage: str, page: str) -> None:
        async with self.lock:
            getattr(self.config.hold, stage).discard(page)
            gate = self.gates.pop((stage, page), None)
            if gate is not None:
                gate.set()

    async def reset(self) -> None:
        async with self.lock:
            for gate in self.gates.values():
                gate.set()
            self.generation += 1
            self.config = AcceptanceConfig()
            self.gates.clear()
            self.counts = dict.fromkeys(COUNTER_KEYS, 0)
            self.events.clear()
            self.sequence = 0
            self.analysis_pages.clear()
            self.render_pages.clear()
            self.consumed_translation_faults.clear()

    async def snapshot(self) -> dict[str, object]:
        async with self.lock:
            config = self.config.model_dump(mode="json")
            for section in ("hold", "fail"):
                config[section] = {
                    name: sorted(pages) for name, pages in config[section].items()
                }
            config["blocks"] = dict(sorted(config["blocks"].items()))
            return {
                "config": config,
                "counts": self.counts.copy(),
                "events": list(self.events),
            }

    async def gate(self, stage: str, page: str) -> asyncio.Event | None:
        async with self.lock:
            return self.gates.get((stage, page))

    async def current_generation(self) -> int:
        async with self.lock:
            return self.generation

    async def entered(self, stage: str, page: str) -> int:
        async with self.lock:
            generation = self.generation
            counter = {"source": "source", "ocr": "ocr_stream", "translation": "translation"}[stage]
            self.counts[counter] += 1
            if stage == "source":
                self.counts["active_source"] += 1
                self.counts["peak_source"] = max(
                    self.counts["peak_source"], self.counts["active_source"]
                )
        await self.record(stage, page, "entered", generation)
        return generation

    async def leave_source(self, generation: int) -> None:
        async with self.lock:
            if generation == self.generation:
                self.counts["active_source"] -= 1

    async def increment(self, key: str) -> None:
        async with self.lock:
            self.counts[key] += 1

    async def fails(self, fault: str, page: str) -> bool:
        async with self.lock:
            return page in getattr(self.config.fail, fault)

    async def remember_analysis(self, analysis_key: str, page: str) -> None:
        async with self.lock:
            self.analysis_pages[analysis_key] = page

    async def analysis_page(self, analysis_key: str) -> str | None:
        async with self.lock:
            return self.analysis_pages.get(analysis_key)

    async def remember_render(
        self, render_key: str, page: str, analysis_key: str
    ) -> None:
        async with self.lock:
            self.render_pages[render_key] = (page, analysis_key)

    async def render_page(self, render_key: str) -> tuple[str, str] | None:
        async with self.lock:
            return self.render_pages.get(render_key)

    async def block_count(self, page: str) -> int:
        async with self.lock:
            return self.config.blocks.get(page, 1)

    async def consume_translation_fault(self, page: str, generation: int) -> bool:
        async with self.lock:
            if (
                generation != self.generation
                or page not in self.config.fail.translation_batch
                or page in self.consumed_translation_faults
            ):
                return False
            self.consumed_translation_faults.add(page)
            return True

    async def aborted(self, stage: str, page: str, generation: int) -> None:
        async with self.lock:
            if generation != self.generation:
                return
            key = f"{stage}_aborted"
            if key in self.counts:
                self.counts[key] += 1
        await self.record(stage, page, "aborted", generation)

    async def record(
        self,
        stage: str,
        page: str,
        event: str,
        generation: int | None = None,
    ) -> None:
        async with self.lock:
            if generation is not None and generation != self.generation:
                return
            self.sequence += 1
            self.events.append(
                {"seq": self.sequence, "stage": stage, "page": page, "event": event}
            )


async def control_request(request: Request) -> None:
    host = request.client.host if request.client else ""
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    if not loopback:
        raise HTTPException(status_code=403, detail="loopback only")
    if request.method == "POST":
        media_type = request.headers.get("content-type", "").split(";", 1)[0]
        if media_type != "application/json":
            raise HTTPException(status_code=415, detail="application/json required")


app = FastAPI()
app.add_exception_handler(RequestValidationError, translate_items_validation_error)
state = AcceptanceState()
control_dependencies = [Depends(control_request)]


async def wait_gate(
    stage: str,
    page: str,
    request: Request,
    runtime: AcceptanceState = state,
    generation: int | None = None,
) -> bool:
    if generation is None:
        generation = await runtime.current_generation()
    gate = await runtime.gate(stage, page)
    if gate is None:
        return True
    await runtime.record(stage, page, "held", generation)
    while not gate.is_set():
        if await request.is_disconnected():
            await runtime.aborted(stage, page, generation)
            return False
        try:
            await asyncio.wait_for(gate.wait(), timeout=0.05)
        except TimeoutError:
            pass
    await runtime.record(stage, page, "released", generation)
    return True


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "versions": config.PIPELINE_VERSIONS,
        "patch_versions": config.PATCH_VERSIONS,
    }


@app.get("/fixture.html")
async def fixture():
    return FileResponse(FIXTURE)


@app.get("/fixture-benchmark.js")
async def fixture_benchmark():
    return FileResponse(BENCHMARK_CONTROLLER, media_type="application/javascript")


@app.get("/ja_page.png")
async def fixture_ja_page():
    return FileResponse(FIXTURE.parent / "ja_page.png", media_type="image/png", headers=NO_STORE_HEADERS)


@app.get("/es_page.png")
async def fixture_es_page():
    return FileResponse(FIXTURE.parent / "es_page.png", media_type="image/png", headers=NO_STORE_HEADERS)


@app.get("/assets/{page}.png")
async def asset(page: str, request: Request):
    if page not in PAGES:
        raise HTTPException(status_code=404, detail="unknown synthetic page")
    if request.headers.get("sec-fetch-dest") == "image":
        await state.increment("page_load")
    else:
        generation = await state.entered("source", page)
        try:
            if not await wait_gate("source", page, request, generation=generation):
                return Response(status_code=499, headers=NO_STORE_HEADERS)
            if await state.fails("source_after_load", page):
                await state.record("source", page, "failed", generation)
                return Response(status_code=500, headers=NO_STORE_HEADERS)
            await state.record("source", page, "completed", generation)
        finally:
            await state.leave_source(generation)
    return Response(
        content=page_png(page, request.query_params.get("benchmark")),
        media_type="image/png",
        headers=(
            IMMUTABLE_HEADERS
            if request.query_params.get("benchmark") is not None
            else NO_STORE_HEADERS
        ),
    )


@app.post("/ocr-stream")
async def ocr_stream(
    request: Request,
    analysis_key: str = Form(...),
    ocr_key: str = Form(...),
    src_lang: str = Form(...),
    render_artifact_key: str = Form(...),
    image: UploadFile | None = File(None),
):
    if src_lang not in {"ja", "es", "pt"}:
        return JSONResponse(status_code=422, content={"error": "unsupported src_lang"})
    cached_page = await state.analysis_page(analysis_key)
    if image is None:
        page = cached_page
        if page is None:
            return JSONResponse(status_code=409, content={"error": "analysis_missing"})
        analysis_cache_hit = True
    else:
        page = PAGE_BY_DIGEST.get(sha256(await image.read()).hexdigest())
        if page is None:
            return JSONResponse(status_code=422, content={"error": "unknown synthetic image"})
        analysis_cache_hit = cached_page == page
        await state.remember_analysis(analysis_key, page)
    await state.remember_render(render_artifact_key, page, analysis_key)

    block_count = await state.block_count(page)
    block_fault = await state.fails("ocr_block", page)
    generation = await state.entered("ocr", page)

    async def stream():
        yield json.dumps({
            "type": "analysis_ready",
            "analysis_key": analysis_key,
            "image_w": 800,
            "image_h": 1200,
            "regions": block_count,
            "analysis_ms": 0,
            "analysis_cache_hit": analysis_cache_hit,
        }) + "\n"
        if not await wait_gate("ocr", page, request, generation=generation):
            return
        emitted = 1 if block_fault else block_count
        for index in range(1, emitted + 1):
            yield json.dumps({
                "type": "ocr_block",
                "ocr_key": ocr_key,
                "block_id": f"{page}-{index}",
                "bbox": [80, 80, 240, 120],
                "src_text": f"{page}:block-{index}",
                "kind": "text",
                "vertical": False,
            }) + "\n"
        if block_fault:
            yield json.dumps({
                "type": "ocr_block_error",
                "ocr_key": ocr_key,
                "block_id": f"{page}-2",
                "code": "recognizer_failed",
            }) + "\n"
            await state.record("ocr", page, "failed", generation)
        else:
            await state.record("ocr", page, "completed", generation)
        yield json.dumps({
            "type": "image_done",
            "recognized": emitted,
            "failed": int(block_fault),
        }) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.post("/render-artifact")
async def render_artifact(
    analysis_key: str = Form(...),
    render_artifact_key: str = Form(...),
    source_content_hash: str = Form(...),
    image: UploadFile | None = File(None),
):
    cached = await state.render_page(render_artifact_key)
    if cached is not None:
        page, artifact_analysis_key = cached
    else:
        artifact_analysis_key = analysis_key
        if image is None:
            page = await state.analysis_page(analysis_key)
        else:
            data = await image.read()
            digest = sha256(data).hexdigest()
            if digest != source_content_hash:
                return JSONResponse(
                    status_code=409,
                    content={"error": "source_identity_mismatch"},
                )
            page = PAGE_BY_DIGEST.get(digest)
    if page is None:
        return JSONResponse(status_code=409, content={"error": "artifact_missing"})
    await state.remember_analysis(artifact_analysis_key, page)
    await state.remember_render(render_artifact_key, page, artifact_analysis_key)
    block_count = await state.block_count(page)
    reason = "unsupported_region" if page == "C" else None
    blocks = []
    for index in range(1, block_count + 1):
        block_id = f"{page}-{index}"
        blocks.append({
            "block_id": block_id,
            "patch_id": None if reason else f"patch-{block_id}",
            "patch_bbox": None if reason else [80, 80, 240, 120],
            "clean_region": None if reason else [80, 80, 240, 120],
            "fit_bbox": [100, 90, 200, 100] if page == "D" else [80, 80, 240, 120],
            "patch_mime": None if reason else "image/png",
            "patch_rgba": None if reason else base64.b64encode(patch_png(page)).decode("ascii"),
            "reason": reason,
        })
    return {
        "schema_version": config.PATCH_VERSIONS["render_schema"],
        "render_artifact_key": render_artifact_key,
        "analysis_key": artifact_analysis_key,
        "image_w": 800,
        "image_h": 1200,
        "blocks": blocks,
        "byte_size": sum(len(patch_png(page)) for row in blocks if row["patch_rgba"]),
    }


@app.post("/translate-items")
async def translate_items(body: TranslateItemsBody, request: Request):
    if body.src_lang not in {"ja", "es", "pt"}:
        return JSONResponse(status_code=422, content={"error": "unsupported src_lang"})
    pages = {item.text.split(":", 1)[0] for item in body.items}
    if len(pages) != 1 or not pages <= PAGES:
        return JSONResponse(status_code=422, content={"error": "mixed or unknown page"})
    page = pages.pop()

    generation = await state.entered("translation", page)
    if not await wait_gate("translation", page, request, generation=generation):
        return Response(status_code=499)
    if await state.consume_translation_fault(page, generation):
        await state.record("translation", page, "failed", generation)
        return JSONResponse(status_code=502, content={"error": "translation_batch_failed"})
    await state.record("translation", page, "completed", generation)
    return {
        "items": [
            {
                "id": item.id,
                "kind": "sfx" if page == "B" else "text",
                "translation": (
                    None
                    if page == "B"
                    else (
                        f"{body.dst_lang}:{LONG_TRANSLATION}"
                        if page == "D"
                        else f"{body.dst_lang}:{item.text}"
                    )
                ),
            }
            for item in body.items
        ]
    }


@app.post("/__acceptance/reset", dependencies=control_dependencies)
async def reset(_body: EmptyBody):
    await state.reset()
    return await state.snapshot()


@app.post("/__acceptance/config", dependencies=control_dependencies)
async def configure(config: AcceptanceConfig):
    await state.configure(config)
    return await state.snapshot()


@app.post(
    "/__acceptance/release/{stage}/{page}",
    dependencies=control_dependencies,
)
async def release(stage: str, page: str, _body: EmptyBody):
    if stage not in STAGES or page not in PAGES:
        raise HTTPException(status_code=422, detail="unknown stage or page")
    await state.release(stage, page)
    return await state.snapshot()


@app.get("/__acceptance/state", dependencies=control_dependencies)
async def snapshot():
    return await state.snapshot()
