import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event

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
        reply = self.replies.pop(0)
        if callable(reply):
            reply = reply()
        if isinstance(reply, Exception):
            raise reply
        return FakeResp(reply)


class FakeClient:
    def __init__(self, replies):
        self.models = FakeModels(replies)


class QuotaError(RuntimeError):
    """Giống google.genai.errors.APIError: mang mã HTTP ở thuộc tính .code."""

    code = 429


def make_with_clients(monkeypatch, replies, secondary_replies=None):
    monkeypatch.setattr(tr.config, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(
        tr.config,
        "GEMINI_API_KEY_SECONDARY",
        "secondary-key" if secondary_replies is not None else "",
    )
    reply_sets = {"test-key": replies, "secondary-key": secondary_replies}
    clients = []

    def fake_client(api_key):
        client = FakeClient(reply_sets[api_key])
        clients.append(client)
        return client

    monkeypatch.setattr(tr.genai, "Client", fake_client)
    return tr.GeminiTranslator(), clients


def make(monkeypatch, replies):
    return make_with_clients(monkeypatch, replies)[0]


def test_happy_path(monkeypatch):
    t = make(monkeypatch, [json.dumps(["xin chào", "tạm biệt"])])
    assert t.translate(["こんにちは", "さようなら"], "ja", "vi") == ["xin chào", "tạm biệt"]


def test_prompt_contains_numbered_lines_and_langs(monkeypatch):
    t, clients = make_with_clients(monkeypatch, [json.dumps(["hi"])])
    t.translate(["hola"], "es", "en")
    prompt = clients[0].models.calls[0]["contents"]
    assert "1. hola" in prompt
    assert "Spanish" in prompt and "English" in prompt


def test_portuguese_prompt_uses_display_name(monkeypatch):
    t, clients = make_with_clients(monkeypatch, [json.dumps(["olá"])])
    t.translate(["olá"], "pt", "en")
    prompt = clients[0].models.calls[0]["contents"]
    assert "from Portuguese" in prompt
    assert "from pt" not in prompt


def test_generate_uses_exported_temperature(monkeypatch):
    monkeypatch.setattr(tr, "GENERATION_TEMPERATURE", 0.37)
    t, clients = make_with_clients(monkeypatch, [json.dumps(["hi"])])

    t.translate(["hola"], "es", "en")

    assert clients[0].models.calls[0]["config"]["temperature"] == 0.37


def test_retry_on_length_mismatch(monkeypatch):
    t, clients = make_with_clients(
        monkeypatch,
        [json.dumps(["only-one"]), json.dumps(["a", "b"])],
        [json.dumps(["unused"])],
    )
    assert t.translate(["x", "y"], "ja", "vi") == ["a", "b"]
    assert [len(client.models.calls) for client in clients] == [2, 0]


def test_raises_after_two_failures(monkeypatch):
    t, clients = make_with_clients(
        monkeypatch,
        ["not json at all", "still not json", json.dumps(["too late"])],
        [json.dumps(["unused"])],
    )
    with pytest.raises(tr.TranslateError):
        t.translate(["x"], "ja", "vi")
    assert [len(client.models.calls) for client in clients] == [2, 0]


def test_429_fails_over_and_promotes_secondary(monkeypatch):
    t, clients = make_with_clients(
        monkeypatch,
        [QuotaError("429 primary quota")],
        [json.dumps(["first"]), json.dumps(["second"])],
    )

    assert t.translate(["x"], "ja", "vi") == ["first"]
    assert t.translate(["y"], "ja", "vi") == ["second"]
    assert [len(client.models.calls) for client in clients] == [1, 2]


def test_non_429_retries_primary_without_using_secondary(monkeypatch):
    t, clients = make_with_clients(
        monkeypatch,
        [RuntimeError("503 unavailable"), json.dumps(["ok"])],
        [json.dumps(["unused"])],
    )

    assert t.translate(["x"], "ja", "vi") == ["ok"]
    assert [len(client.models.calls) for client in clients] == [2, 0]


def test_two_429s_raise_secondary_error_after_two_calls(monkeypatch):
    t, clients = make_with_clients(
        monkeypatch,
        [QuotaError("429 primary quota")],
        [QuotaError("429 secondary quota")],
    )

    with pytest.raises(tr.TranslateError, match="429 secondary quota"):
        t.translate(["x"], "ja", "vi")
    assert [len(client.models.calls) for client in clients] == [1, 1]


def test_single_key_429_raises_without_second_call(monkeypatch):
    t, clients = make_with_clients(monkeypatch, [QuotaError("429 primary quota")])

    with pytest.raises(tr.TranslateError, match="429 primary quota"):
        t.translate(["x"], "ja", "vi")
    assert [len(client.models.calls) for client in clients] == [1]


def test_decode_error_mentioning_429_does_not_use_secondary(monkeypatch):
    malformed = '{"a": ' + " " * 422 + "X"
    with pytest.raises(json.JSONDecodeError) as decode_error:
        json.loads(malformed)
    assert "429" in str(decode_error.value)  # tiền đề của bẫy này: lỗi parse có chứa "429"

    t, clients = make_with_clients(
        monkeypatch,
        [malformed, json.dumps(["ok"])],
        [json.dumps(["unused"])],
    )

    assert t.translate(["x"], "ja", "vi") == ["ok"]
    assert [len(client.models.calls) for client in clients] == [2, 0]


def test_two_decoder_errors_with_429_message_preserve_invalid_response_kind(monkeypatch):
    malformed = '{"a": ' + " " * 422 + "X"
    t, clients = make_with_clients(monkeypatch, [malformed, malformed])

    with pytest.raises(tr.TranslateError) as raised:
        t.translate(["x"], "ja", "vi")

    assert raised.value.error_kind == "invalid_response"
    assert raised.value.code is None
    assert [len(client.models.calls) for client in clients] == [2]


def test_sdk_429_preserves_rate_limited_kind(monkeypatch):
    t = make(monkeypatch, [QuotaError("quota")])

    with pytest.raises(tr.TranslateError) as raised:
        t.translate(["x"], "ja", "vi")

    assert raised.value.error_kind == "rate_limited"
    assert raised.value.code == 429


def test_promoted_secondary_429_fails_back_and_promotes_primary(monkeypatch):
    t, clients = make_with_clients(
        monkeypatch,
        [QuotaError("429 primary quota"), json.dumps(["primary"]), json.dumps(["primary again"])],
        [json.dumps(["secondary"]), QuotaError("429 secondary quota")],
    )

    assert t.translate(["x"], "ja", "vi") == ["secondary"]
    assert t.translate(["y"], "ja", "vi") == ["primary"]
    assert t.translate(["z"], "ja", "vi") == ["primary again"]
    assert [len(client.models.calls) for client in clients] == [3, 2]


def test_older_primary_success_does_not_overwrite_fallback_promotion(monkeypatch):
    primary_started = Event()
    release_primary = Event()

    def delayed_primary_success():
        primary_started.set()
        assert release_primary.wait(2)
        return json.dumps(["older"])

    t, clients = make_with_clients(
        monkeypatch,
        [delayed_primary_success, QuotaError("429 primary quota"), json.dumps(["wrong client"])],
        [json.dumps(["fallback"]), json.dumps(["promoted"])],
    )

    with ThreadPoolExecutor(max_workers=1) as pool:
        older = pool.submit(t.translate, ["older"], "ja", "vi")
        assert primary_started.wait(2)
        try:
            assert t.translate(["fallback"], "ja", "vi") == ["fallback"]
        finally:
            release_primary.set()
        assert older.result() == ["older"]

    assert t.translate(["next"], "ja", "vi") == ["promoted"]
    assert [len(client.models.calls) for client in clients] == [2, 2]


def test_empty_input_returns_empty_without_calling_api(monkeypatch):
    t = make(monkeypatch, [])
    assert t.translate([], "ja", "vi") == []


def test_missing_api_key_raises(monkeypatch):
    monkeypatch.setattr(tr.config, "GEMINI_API_KEY", "")
    with pytest.raises(tr.TranslateError):
        tr.GeminiTranslator()


def test_translate_items_accepts_reordered_exact_ids(monkeypatch):
    reply = json.dumps([
        {"id": "b2", "translation": "hai"},
        {"id": "b1", "translation": "mot"},
    ])
    translator = make(monkeypatch, [reply])
    assert translator.translate_items(
        [{"id": "b1", "text": "one"}, {"id": "b2", "text": "two"}],
        "en",
        "vi",
    ) == [
        {"id": "b1", "translation": "mot"},
        {"id": "b2", "translation": "hai"},
    ]


def test_translate_items_strips_fields_outside_http_prompt_contract(monkeypatch):
    reply = json.dumps([{"id": "b1", "translation": "một"}])
    translator, clients = make_with_clients(monkeypatch, [reply])

    assert translator.translate_items(
        [
            {
                "id": "b1",
                "text": "one",
                "reading_order": 0,
                "bbox": [1, 2, 3, 4],
                "kind": "dialogue",
            }
        ],
        "en",
        "vi",
    ) == [{"id": "b1", "translation": "một"}]

    prompt = clients[0].models.calls[0]["contents"]
    assert '"id": "b1"' in prompt
    assert '"text": "one"' in prompt
    assert '"reading_order"' not in prompt
    assert '"bbox"' not in prompt
    assert '"kind"' not in prompt


@pytest.mark.parametrize(
    "reply",
    [
        [{"id": "b1", "translation": "x"}],
        [{"id": "b1", "translation": "x"}, {"id": "foreign", "translation": "y"}],
        [{"id": "b1", "translation": "x"}, {"id": "b1", "translation": "y"}],
    ],
)
def test_translate_items_rejects_missing_foreign_or_duplicate_ids(monkeypatch, reply):
    translator = make(monkeypatch, [json.dumps(reply), json.dumps(reply)])
    with pytest.raises(tr.TranslateError):
        translator.translate_items(
            [{"id": "b1", "text": "one"}, {"id": "b2", "text": "two"}],
            "en",
            "vi",
        )
