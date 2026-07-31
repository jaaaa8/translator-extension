import asyncio
import ipaddress
import json
import struct
import zlib
from collections import deque
from hashlib import sha256
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

PAGES = frozenset("ABCD")
STAGES = frozenset({"source", "ocr", "translation"})
FAULTS = frozenset({"source_after_load", "ocr_block", "translation_batch"})
EVENT_LIMIT = 500
ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "extension" / "test" / "fixture.html"
BASE_PNG = (ROOT / "extension" / "test" / "ja_page.png").read_bytes()
ASSET_HEADERS = {"Cache-Control": "no-store"}

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


class TranslateItem(BaseModel):
    id: str
    text: str


class TranslateItemsBody(BaseModel):
    items: list[TranslateItem]
    src_lang: str
    dst_lang: str = "vi"


def page_png(page: str) -> bytes:
    if page not in PAGES:
        raise KeyError(page)
    chunk_type = b"tEXt"
    chunk_data = f"acceptance-page\0{page}".encode()
    chunk = (
        struct.pack(">I", len(chunk_data))
        + chunk_type
        + chunk_data
        + struct.pack(">I", zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF)
    )
    iend = BASE_PNG.rfind(b"\x00\x00\x00\x00IEND")
    if iend < 0:
        raise RuntimeError("fixture PNG has no IEND chunk")
    return BASE_PNG[:iend] + chunk + BASE_PNG[iend:]


PAGE_BY_DIGEST = {sha256(page_png(page)).hexdigest(): page for page in PAGES}


class AcceptanceState:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.config = AcceptanceConfig()
        self.gates: dict[tuple[str, str], asyncio.Event] = {}
        self.counts = dict.fromkeys(COUNTER_KEYS, 0)
        self.events: deque[dict[str, object]] = deque(maxlen=EVENT_LIMIT)
        self.sequence = 0
        self.analysis_pages: dict[str, str] = {}
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
        "versions": {
            "detector": "acceptance-detector-v1",
            "dedupe": "acceptance-dedupe-v1",
            "prep": "acceptance-prep-v1",
            "recognizers": {
                "ja": "acceptance-recognizer-ja-v1",
                "es": "acceptance-recognizer-es-v1",
            },
            "translator_model": "acceptance-translator-v1",
            "prompt": "acceptance-prompt-v1",
            "policy": "acceptance-policy-v1",
            "page_schema": "acceptance-page-v1",
        },
    }


@app.get("/fixture.html")
async def fixture():
    return FileResponse(FIXTURE)


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
                return Response(status_code=499, headers=ASSET_HEADERS)
            if await state.fails("source_after_load", page):
                await state.record("source", page, "failed", generation)
                return Response(status_code=500, headers=ASSET_HEADERS)
            await state.record("source", page, "completed", generation)
        finally:
            await state.leave_source(generation)
    return Response(
        content=page_png(page),
        media_type="image/png",
        headers=ASSET_HEADERS,
    )


@app.post("/ocr-stream")
async def ocr_stream(
    request: Request,
    analysis_key: str = Form(...),
    ocr_key: str = Form(...),
    src_lang: str = Form(...),
    image: UploadFile | None = File(None),
):
    if src_lang not in {"ja", "es"}:
        return JSONResponse(status_code=422, content={"error": "unsupported src_lang"})
    if image is None:
        page = await state.analysis_page(analysis_key)
        if page is None:
            return JSONResponse(status_code=409, content={"error": "analysis_missing"})
    else:
        page = PAGE_BY_DIGEST.get(sha256(await image.read()).hexdigest())
        if page is None:
            return JSONResponse(status_code=422, content={"error": "unknown synthetic image"})
        await state.remember_analysis(analysis_key, page)

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


@app.post("/translate-items")
async def translate_items(body: TranslateItemsBody, request: Request):
    if body.src_lang not in {"ja", "es"}:
        return JSONResponse(status_code=422, content={"error": "unsupported src_lang"})
    if len({item.id for item in body.items}) != len(body.items):
        return JSONResponse(status_code=422, content={"error": "duplicate input id"})
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
            {"id": item.id, "translation": f"{body.dst_lang}:{item.text}"}
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
