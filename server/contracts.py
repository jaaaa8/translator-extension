from typing import Literal

from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, NonNegativeInt, PositiveInt, model_validator


class TranslateItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    text: str
    reading_order: NonNegativeInt
    bbox: tuple[NonNegativeInt, NonNegativeInt, NonNegativeInt, NonNegativeInt]


class TranslateItemsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[TranslateItem]
    src_lang: str
    dst_lang: str
    page_width: PositiveInt
    page_height: PositiveInt
    reading_direction: Literal["rtl", "ltr"]

    @model_validator(mode="after")
    def validate_items(self):
        ids = [item.id for item in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate input id")
        if [item.reading_order for item in self.items] != list(range(len(self.items))):
            raise ValueError("reading_order must match array order 0..n-1")
        return self


async def translate_items_validation_error(request, exc):
    if request.url.path != "/translate-items":
        return await request_validation_exception_handler(request, exc)
    errors = exc.errors()
    message = errors[0].get("msg", "invalid request") if errors else "invalid request"
    message = message.removeprefix("Value error, ")
    return JSONResponse(
        status_code=422,
        content={"error": message, "error_code": "invalid_request"},
    )
