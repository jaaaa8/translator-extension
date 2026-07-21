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


class GeminiTranslator:
    def __init__(self):
        if not config.GEMINI_API_KEY:
            raise TranslateError("GEMINI_API_KEY chưa được đặt trong .env")
        self._client = genai.Client(api_key=config.GEMINI_API_KEY)

    def translate(self, texts: list[str], src: str, dst: str) -> list[str]:
        if not texts:
            return []
        prompt = PROMPT.format(
            src=LANG_NAMES.get(src, src),
            dst=LANG_NAMES.get(dst, dst),
            n=len(texts),
            lines="\n".join(f"{i + 1}. {t}" for i, t in enumerate(texts)),
        )
        last_err = "unknown"
        for _ in range(2):  # 1 lần + 1 retry theo spec
            try:
                resp = self._client.models.generate_content(
                    model=config.GEMINI_MODEL,
                    contents=prompt,
                    config={"temperature": 0.2, "response_mime_type": "application/json"},
                )
                out = json.loads(resp.text)
                if isinstance(out, list) and len(out) == len(texts):
                    return [str(x) for x in out]
                last_err = f"expected {len(texts)} items, got: {str(out)[:80]}"
            except Exception as e:
                last_err = str(e)
        raise TranslateError(last_err)
