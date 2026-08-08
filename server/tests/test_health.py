from fastapi.testclient import TestClient

from server import config
from server.main import app


def test_health():
    client = TestClient(app)
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["langs"] == ["ja", "es", "pt"]
    assert "device" in body
    assert body["versions"] == config.PIPELINE_VERSIONS
    assert all(lang in body["versions"]["recognizers"] for lang in body["langs"])
    assert body["versions"]["recognizers"]["es"] == body["versions"]["recognizers"]["pt"]
