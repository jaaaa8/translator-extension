from fastapi.testclient import TestClient

from server import config
from server.main import app


def test_health():
    client = TestClient(app)
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["langs"] == ["ja", "es"]
    assert "device" in body
    assert body["versions"] == config.PIPELINE_VERSIONS
