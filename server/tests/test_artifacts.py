import numpy as np

from server.artifacts import (
    AnalysisArtifact,
    BoundedLru,
    PreparedRegion,
    stable_block_id,
)


def artifact(key, size):
    crop = np.zeros((size, 1, 1), np.uint8)
    region = PreparedRegion("b", (1, 2, 3, 4), crop)
    return AnalysisArtifact(key, 100, 200, (region,), crop.nbytes)


def test_stable_block_id_changes_only_with_identity_inputs():
    a = stable_block_id("analysis-a", (1, 2, 3, 4), 0)
    assert a == stable_block_id("analysis-a", (1, 2, 3, 4), 0)
    assert a != stable_block_id("analysis-a", (1, 2, 3, 4), 1)
    assert a != stable_block_id("analysis-b", (1, 2, 3, 4), 0)


def test_lru_evicts_by_count_and_touch():
    cache = BoundedLru(max_items=2)
    cache.put("a", 1)
    cache.put("b", 2)
    assert cache.get("a") == 1
    assert cache.put("c", 3) == ["b"]
    assert cache.peek("a") == 1


def test_lru_evicts_by_bytes():
    cache = BoundedLru(max_items=32, max_bytes=5, size_of=lambda value: value.byte_size)
    cache.put("a", artifact("a", 3))
    assert cache.put("b", artifact("b", 3)) == ["a"]
