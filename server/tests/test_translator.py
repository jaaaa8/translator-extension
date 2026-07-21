import json

import pytest

import server.translator as tr


class FakeResp:
    def __init__(self, text):
        self.text = text


class FakeModels:
    def __init__(self, replies):
        self.replies = replies
        self.calls = []

    def generate_content(self, **kw):
        self.calls.append(kw)
        return FakeResp(self.replies.pop(0))


class FakeClient:
    def __init__(self, replies):
        self.models = FakeModels(replies)


def make(monkeypatch, replies):
    monkeypatch.setattr(tr.config, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(tr.genai, "Client", lambda api_key: FakeClient(replies))
    return tr.GeminiTranslator()


def test_happy_path(monkeypatch):
    t = make(monkeypatch, [json.dumps(["xin chào", "tạm biệt"])])
    assert t.translate(["こんにちは", "さようなら"], "ja", "vi") == ["xin chào", "tạm biệt"]


def test_prompt_contains_numbered_lines_and_langs(monkeypatch):
    t = make(monkeypatch, [json.dumps(["hi"])])
    t.translate(["hola"], "es", "en")
    prompt = t._client.models.calls[0]["contents"]
    assert "1. hola" in prompt
    assert "Spanish" in prompt and "English" in prompt


def test_retry_on_length_mismatch(monkeypatch):
    t = make(monkeypatch, [json.dumps(["only-one"]), json.dumps(["a", "b"])])
    assert t.translate(["x", "y"], "ja", "vi") == ["a", "b"]


def test_raises_after_two_failures(monkeypatch):
    t = make(monkeypatch, ["not json at all", "still not json"])
    with pytest.raises(tr.TranslateError):
        t.translate(["x"], "ja", "vi")


def test_empty_input_returns_empty_without_calling_api(monkeypatch):
    t = make(monkeypatch, [])
    assert t.translate([], "ja", "vi") == []


def test_missing_api_key_raises(monkeypatch):
    monkeypatch.setattr(tr.config, "GEMINI_API_KEY", "")
    with pytest.raises(tr.TranslateError):
        tr.GeminiTranslator()
