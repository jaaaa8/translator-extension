from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from hashlib import sha256
import json
from threading import Lock
from typing import Callable, Generic, TypeVar

import numpy as np

K = TypeVar("K")
V = TypeVar("V")
BBox = tuple[int, int, int, int]


@dataclass(frozen=True)
class PreparedFragment:
    bbox: BBox
    crop_rgb: np.ndarray
    vertical: bool


@dataclass(frozen=True)
class PreparedRegion:
    block_id: str
    bbox: BBox
    source_bbox: BBox
    fragments: tuple[PreparedFragment, ...]
    source_rgb: np.ndarray
    raw_mask: np.ndarray
    refined_mask: np.ndarray
    container_mask: np.ndarray | None
    vertical: bool
    bounded: bool


@dataclass(frozen=True)
class AnalysisArtifact:
    key: str
    image_w: int
    image_h: int
    regions: tuple[PreparedRegion, ...]
    byte_size: int


@dataclass(frozen=True)
class RenderBlockArtifact:
    block_id: str
    patch_id: str | None
    patch_bbox: BBox | None
    clean_region: BBox | None
    fit_bbox: BBox | None
    patch_mime: str | None
    patch_png: bytes | None
    reason: str | None


@dataclass(frozen=True)
class RenderArtifact:
    schema_version: str
    render_artifact_key: str
    analysis_key: str
    image_w: int
    image_h: int
    blocks: tuple[RenderBlockArtifact, ...]
    byte_size: int


@dataclass
class OcrArtifact:
    key: str
    analysis_key: str
    completed_ids: set[str] = field(default_factory=set)
    blocks: dict[str, dict] = field(default_factory=dict)
    failures: dict[str, str] = field(default_factory=dict)
    complete: bool = False


def stable_block_id(analysis_key, bbox, ordinal):
    raw = json.dumps([analysis_key, list(bbox), ordinal], separators=(",", ":"))
    return sha256(raw.encode("utf-8")).hexdigest()[:24]


class BoundedLru(Generic[K, V]):
    def __init__(self, max_items, max_bytes=None, size_of: Callable[[V], int] | None = None):
        self.max_items = max_items
        self.max_bytes = max_bytes
        self.size_of = size_of or (lambda value: 1)
        self._items = OrderedDict()
        self._bytes = 0
        self._lock = Lock()

    def __len__(self):
        with self._lock:
            return len(self._items)

    def peek(self, key):
        with self._lock:
            row = self._items.get(key)
            return None if row is None else row[0]

    def get(self, key):
        with self._lock:
            row = self._items.get(key)
            if row is None:
                return None
            self._items.move_to_end(key)
            return row[0]

    def put(self, key: K, value: V) -> list[K] | None:
        size = self.size_of(value)
        if self.max_bytes is not None and size > self.max_bytes:
            return None
        with self._lock:
            if key in self._items:
                _, old_size = self._items.pop(key)
                self._bytes -= old_size
            self._items[key] = (value, size)
            self._bytes += size
            evicted = []
            while len(self._items) > self.max_items or (
                self.max_bytes is not None and self._bytes > self.max_bytes
            ):
                old_key, (_, old_size) = self._items.popitem(last=False)
                self._bytes -= old_size
                evicted.append(old_key)
            return evicted
