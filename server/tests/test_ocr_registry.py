import server.ocr as ocr
from server import config


def test_real_registry_shape_does_not_load_models():
    registry = ocr.OcrRegistry("cpu")
    assert registry.langs == list(config.LANGS)
    assert ocr.ENGINES["es"] is ocr.PaddleLatinEngine
    assert ocr.ENGINES["pt"] is ocr.PaddleLatinEngine
    assert registry._cache == {}


def test_es_and_pt_share_one_engine_instance(monkeypatch):
    calls = []

    class FakeLatin:
        def __init__(self, device):
            calls.append(device)

    monkeypatch.setattr(ocr, "ENGINES", {"es": FakeLatin, "pt": FakeLatin})
    registry = ocr.OcrRegistry("cpu")
    assert registry.get("es") is registry.get("pt")
    assert calls == ["cpu"]
