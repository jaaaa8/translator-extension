# Gemini Project Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use an optional Gemini key from a second Google Cloud project when the active project returns 429, while retaining a strict two-call budget and existing single-key behavior.

**Architecture:** Server configuration will expose one optional secondary key and `GeminiTranslator` will create one client per configured key. A translation starts with the remembered active client; its second and final remote call is either the existing same-client retry for malformed/non-429 failures or a one-time alternate-project call for 429. A successful alternate becomes active for later translations.

**Tech Stack:** Python, `google-genai`, `python-dotenv`, pytest.

## Global Constraints

- The two replacement keys belong to different Google Cloud projects; the key previously pasted into chat is exposed and must not be used.
- Keep `GEMINI_API_KEY` required and add optional `GEMINI_API_KEY_SECONDARY`.
- Keys remain server-only environment values and must never appear in extension code, logs, endpoint responses, committed files, or test fixtures resembling real credentials.
- Use at most two Gemini remote calls for one translation.
- Switch projects only after an error string containing `429`; malformed JSON and other exceptions retry the same client once.
- A successful fallback becomes active; no persistence, cooldown, quota polling, round-robin distribution, or third key.
- Preserve `/translate-texts` success and 502 error shapes and the one-batch translation prompt.
- Add no dependency and do not edit `.env`.
- Preserve unrelated dirty-worktree changes; stage only the files named by this task.

---

### Task 1: Add optional secondary-client failover with a two-call ceiling

**Files:**
- Modify: `server/config.py:7-10`
- Modify: `server/translator.py:23-54`
- Modify: `server/tests/test_translator.py`
- Modify: `.env.example:1-4`

**Interfaces:**
- Consumes: `config.GEMINI_API_KEY: str`, `config.GEMINI_API_KEY_SECONDARY: str`, and `config.GEMINI_MODEL: str`.
- Produces: `GeminiTranslator._clients: list[genai.Client]`, `GeminiTranslator._active: int`, and unchanged `translate(texts: list[str], src: str, dst: str) -> list[str]`.
- Error behavior: one active-client 429 may use the other client once; a second 429 raises `TranslateError` and remains HTTP 502 through the existing endpoint.

- [ ] **Step 1: Make the translator fake support multiple clients and raised replies**

Replace the current fake response plumbing in `server/tests/test_translator.py` with:

```python
class FakeResp:
    def __init__(self, text):
        self.text = text


class FakeModels:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def generate_content(self, **kw):
        self.calls.append(kw)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return FakeResp(reply)


class FakeClient:
    def __init__(self, replies):
        self.models = FakeModels(replies)


def make(monkeypatch, *client_replies):
    monkeypatch.setattr(tr.config, "GEMINI_API_KEY", "primary-test-key")
    monkeypatch.setattr(
        tr.config,
        "GEMINI_API_KEY_SECONDARY",
        "secondary-test-key" if len(client_replies) > 1 else "",
        raising=False,
    )
    clients = []

    def build_client(api_key):
        client = FakeClient(client_replies[len(clients)])
        clients.append(client)
        return client

    monkeypatch.setattr(tr.genai, "Client", build_client)
    return tr.GeminiTranslator(), clients
```

Update existing tests to unpack `(translator, clients)`. For example:

```python
def test_happy_path(monkeypatch):
    translator, _clients = make(monkeypatch, [json.dumps(["xin chào", "tạm biệt"])])
    assert translator.translate(["こんにちは", "さようなら"], "ja", "vi") == ["xin chào", "tạm biệt"]


def test_prompt_contains_numbered_lines_and_langs(monkeypatch):
    translator, clients = make(monkeypatch, [json.dumps(["hi"])])
    translator.translate(["hola"], "es", "en")
    prompt = clients[0].models.calls[0]["contents"]
    assert "1. hola" in prompt
    assert "Spanish" in prompt and "English" in prompt
```

Keep the existing happy path, prompt, malformed-length retry, two-failure, empty-input, and missing-primary-key assertions.

- [ ] **Step 2: Add failing quota routing and call-budget cases**

Add these tests to `server/tests/test_translator.py`:

```python
def test_429_falls_back_and_promotes_secondary(monkeypatch):
    translator, clients = make(
        monkeypatch,
        [RuntimeError("429 RESOURCE_EXHAUSTED")],
        [json.dumps(["secondary"]), json.dumps(["still secondary"])],
    )

    assert translator.translate(["one"], "en", "vi") == ["secondary"]
    assert translator.translate(["two"], "en", "vi") == ["still secondary"]
    assert len(clients[0].models.calls) == 1
    assert len(clients[1].models.calls) == 2


def test_non_429_retries_same_client(monkeypatch):
    translator, clients = make(
        monkeypatch,
        [RuntimeError("temporary network error"), json.dumps(["primary retry"])],
        [json.dumps(["must not be used"])],
    )

    assert translator.translate(["one"], "en", "vi") == ["primary retry"]
    assert len(clients[0].models.calls) == 2
    assert len(clients[1].models.calls) == 0


def test_both_projects_exhausted_raises_after_two_calls(monkeypatch):
    translator, clients = make(
        monkeypatch,
        [RuntimeError("429 primary exhausted")],
        [RuntimeError("429 secondary exhausted")],
    )

    with pytest.raises(tr.TranslateError, match="429 secondary exhausted"):
        translator.translate(["one"], "en", "vi")
    assert [len(client.models.calls) for client in clients] == [1, 1]
```

Update `test_missing_api_key_raises` to set both config values explicitly:

```python
def test_missing_api_key_raises(monkeypatch):
    monkeypatch.setattr(tr.config, "GEMINI_API_KEY", "")
    monkeypatch.setattr(tr.config, "GEMINI_API_KEY_SECONDARY", "", raising=False)
    with pytest.raises(tr.TranslateError):
        tr.GeminiTranslator()
```

- [ ] **Step 3: Run the translator tests and confirm secondary configuration is absent**

Run:

```powershell
venv\Scripts\python.exe -m pytest server/tests/test_translator.py -q
```

Expected: FAIL because `GeminiTranslator` still creates only `_client` and breaks immediately on 429.

- [ ] **Step 4: Add the optional environment value and bounded failover loop**

Add the secondary value directly after the primary value in `server/config.py`:

```python
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_API_KEY_SECONDARY = os.getenv("GEMINI_API_KEY_SECONDARY", "")
```

Replace `GeminiTranslator.__init__` and the remote-call loop with:

```python
class GeminiTranslator:
    def __init__(self):
        if not config.GEMINI_API_KEY:
            raise TranslateError("GEMINI_API_KEY chưa được đặt trong .env")
        keys = [config.GEMINI_API_KEY]
        if config.GEMINI_API_KEY_SECONDARY:
            keys.append(config.GEMINI_API_KEY_SECONDARY)
        self._clients = [genai.Client(api_key=key) for key in keys]
        self._active = 0

    def translate(self, texts: list[str], src: str, dst: str) -> list[str]:
        if not texts:
            return []
        prompt = PROMPT.format(
            src=LANG_NAMES.get(src, src),
            dst=LANG_NAMES.get(dst, dst),
            n=len(texts),
            lines="\n".join(f"{i + 1}. {text}" for i, text in enumerate(texts)),
        )
        last_err = "unknown"
        client_index = self._active
        for attempt in range(2):
            try:
                resp = self._clients[client_index].models.generate_content(
                    model=config.GEMINI_MODEL,
                    contents=prompt,
                    config={"temperature": 0.2, "response_mime_type": "application/json"},
                )
                out = json.loads(resp.text)
                if isinstance(out, list) and len(out) == len(texts):
                    self._active = client_index
                    return [str(item) for item in out]
                last_err = f"expected {len(texts)} items, got: {str(out)[:80]}"
            except Exception as error:
                last_err = str(error)
                if "429" in last_err:
                    if attempt == 0 and len(self._clients) > 1:
                        client_index = 1 - client_index
                        continue
                    break
        raise TranslateError(last_err)
```

Add the optional variable to `.env.example` without assigning a real value:

```dotenv
GEMINI_API_KEY=your-key-here
GEMINI_API_KEY_SECONDARY=
GEMINI_MODEL=gemini-flash-latest
PORT=8910
DEVICE=cuda
```

- [ ] **Step 5: Run focused and full sandbox-compatible server tests**

Run:

```powershell
venv\Scripts\python.exe -m pytest server/tests/test_translator.py server/tests/test_translate_endpoint.py -q
venv\Scripts\python.exe -m pytest server/tests --ignore=server/tests/test_ocr.py -q
```

Expected: both commands PASS. The endpoint test confirms `TranslateError` still maps to HTTP 502; `server/tests/test_ocr.py` remains excluded because it loads real external OCR models.

- [ ] **Step 6: Configure only rotated local secrets and smoke-test failover**

1. Revoke the key previously pasted into chat.
2. Put rotated project-specific values in the untracked local `.env` as `GEMINI_API_KEY` and `GEMINI_API_KEY_SECONDARY`.
3. Start `run_server.bat` and verify a normal `/translate-texts` request returns 200.
4. To exercise fallback without exposing secrets, temporarily use a deliberately quota-exhausted project as the active local value, keep the healthy project secondary, restart the server, and verify the request succeeds through the secondary project.
5. Inspect server and extension logs and confirm neither key appears.

- [ ] **Step 7: Commit Gemini failover support**

```powershell
git add server/config.py server/translator.py server/tests/test_translator.py .env.example
git commit -m "feat: fail over Gemini quota projects"
```
