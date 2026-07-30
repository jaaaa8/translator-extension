import asyncio
import ipaddress
import struct
import zlib
from collections import deque
from hashlib import sha256
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

PAGES = frozenset("ABCD")
STAGES = frozenset({"source", "ocr", "translation"})
FAULTS = frozenset({"source_after_load", "ocr_block", "translation_batch"})
EVENT_LIMIT = 500
ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "extension" / "test" / "fixture.html"
BASE_PNG = (ROOT / "extension" / "test" / "ja_page.png").read_bytes()

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

    async def record(self, stage: str, page: str, event: str) -> None:
        async with self.lock:
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


@app.get("/health")
async def health():
    return {"status": "ok", "versions": {"page_schema": "acceptance-page-v1"}}


@app.get("/fixture.html")
async def fixture():
    return FileResponse(FIXTURE)


@app.get("/assets/{page}.png")
async def asset(page: str):
    if page not in PAGES:
        raise HTTPException(status_code=404, detail="unknown synthetic page")
    return Response(
        content=page_png(page),
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/__acceptance/reset", dependencies=control_dependencies)
async def reset():
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
async def release(stage: str, page: str):
    if stage not in STAGES or page not in PAGES:
        raise HTTPException(status_code=422, detail="unknown stage or page")
    await state.release(stage, page)
    return await state.snapshot()


@app.get("/__acceptance/state", dependencies=control_dependencies)
async def snapshot():
    return await state.snapshot()
