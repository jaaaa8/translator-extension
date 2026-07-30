import json

from google import genai

from . import config


class TranslateError(Exception):
    pass


LANG_NAMES = {"ja": "Japanese", "es": "Spanish", "vi": "Vietnamese", "en": "English"}

PROMPT = """You are translating comic/manga dialogue from {src} to {dst}.
Translate each numbered line. Keep pronouns and politeness consistent across
lines (they are speech bubbles from the same page, in reading order). Use
natural spoken style. Return ONLY a JSON array of exactly {n} strings, same
order, no extra text.

{lines}"""

ITEM_PROMPT = """You are translating comic/manga dialogue from {src} to {dst}.
Translate every item. Keep pronouns and politeness consistent inside this batch.
Return ONLY a JSON array of objects with exactly these keys:
{{"id":"the input id","translation":"translated text"}}.
Return each input id exactly once; do not invent ids.

{items}"""


def _decode_items(raw, expected_ids):
    out = json.loads(raw)
    if not isinstance(out, list):
        raise ValueError("expected an array")
    rows = {}
    for item in out:
        if not isinstance(item, dict) or set(item) != {"id", "translation"}:
            raise ValueError("invalid translation item")
        item_id = str(item["id"])
        if item_id in rows:
            raise ValueError(f"duplicate id: {item_id}")
        rows[item_id] = str(item["translation"])
    if set(rows) != set(expected_ids):
        raise ValueError("translation id set mismatch")
    return [{"id": item_id, "translation": rows[item_id]} for item_id in expected_ids]


class GeminiTranslator:
    def __init__(self):
        if not config.GEMINI_API_KEY:
            raise TranslateError("GEMINI_API_KEY chưa được đặt trong .env")
        keys = [config.GEMINI_API_KEY]
        if config.GEMINI_API_KEY_SECONDARY:
            keys.append(config.GEMINI_API_KEY_SECONDARY)
        self._clients = [genai.Client(api_key=key) for key in keys]
        self._active_client = 0

    def translate(self, texts: list[str], src: str, dst: str) -> list[str]:
        if not texts:
            return []
        prompt = PROMPT.format(
            src=LANG_NAMES.get(src, src),
            dst=LANG_NAMES.get(dst, dst),
            n=len(texts),
            lines="\n".join(f"{i + 1}. {t}" for i, t in enumerate(texts)),
        )
        def decode(raw):
            out = json.loads(raw)
            if not isinstance(out, list) or len(out) != len(texts):
                raise ValueError(f"expected {len(texts)} translation strings")
            return [str(value) for value in out]

        return self._generate(prompt, decode)

    def translate_items(self, items: list[dict], src: str, dst: str) -> list[dict]:
        if not items:
            return []
        ids = [str(item["id"]) for item in items]
        if len(ids) != len(set(ids)):
            raise TranslateError("duplicate input id")
        prompt = ITEM_PROMPT.format(
            src=LANG_NAMES.get(src, src),
            dst=LANG_NAMES.get(dst, dst),
            items=json.dumps(items, ensure_ascii=False),
        )
        return self._generate(prompt, lambda raw: _decode_items(raw, ids))

    def _generate(self, prompt, decode):
        last_err = "unknown"
        client_index = self._active_client
        switched = False
        for attempt in range(2):  # 1 lần + 1 retry theo spec
            try:
                resp = self._clients[client_index].models.generate_content(
                    model=config.GEMINI_MODEL,
                    contents=prompt,
                    config={"temperature": 0.2, "response_mime_type": "application/json"},
                )
                result = decode(resp.text)
                if switched:
                    self._active_client = client_index
                return result
            except Exception as e:
                last_err = str(e)
                if getattr(e, "code", None) == 429:  # google.genai APIError.code
                    if attempt == 0 and len(self._clients) > 1:
                        client_index = 1 - client_index
                        switched = True
                        continue
                    break
        raise TranslateError(last_err)
