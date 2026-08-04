import json

from google import genai

from . import config


class TranslateError(Exception):
    def __init__(self, message, *, code=None, error_kind=None):
        super().__init__(message)
        self.code = code
        self.error_kind = error_kind


LANG_NAMES = {"ja": "Japanese", "es": "Spanish", "vi": "Vietnamese", "en": "English"}
HTTP_TRANSLATE_ITEM_PROMPT_FIELDS = ("id", "text")
GENERATION_TEMPERATURE = 0.2

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
    return _normalize_items(out, expected_ids)


def _normalize_items(out, expected_ids):
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
        prompt_items = [
            {field: item[field] for field in HTTP_TRANSLATE_ITEM_PROMPT_FIELDS}
            for item in items
        ]
        prompt = ITEM_PROMPT.format(
            src=LANG_NAMES.get(src, src),
            dst=LANG_NAMES.get(dst, dst),
            items=json.dumps(prompt_items, ensure_ascii=False),
        )
        return self._generate(prompt, lambda raw: _decode_items(raw, ids))

    def _generate(self, prompt, decode):
        last_error = None
        last_kind = "generation_error"
        client_index = self._active_client
        switched = False
        for attempt in range(2):  # 1 lần + 1 retry theo spec
            try:
                resp = self._clients[client_index].models.generate_content(
                    model=config.GEMINI_MODEL,
                    contents=prompt,
                    config={
                        "temperature": GENERATION_TEMPERATURE,
                        "response_mime_type": "application/json",
                    },
                )
                result = decode(resp.text)
                if switched:
                    self._active_client = client_index
                return result
            except Exception as error:
                last_error = error
                if getattr(error, "code", None) == 429:  # google.genai APIError.code
                    last_kind = "rate_limited"
                    if attempt == 0 and len(self._clients) > 1:
                        client_index = 1 - client_index
                        switched = True
                        continue
                    break
                last_kind = "invalid_response" if isinstance(error, ValueError) else "generation_error"
        raise TranslateError(
            str(last_error),
            code=getattr(last_error, "code", None),
            error_kind=last_kind,
        ) from last_error
