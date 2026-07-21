"""Sinh 2 trang truyện tổng hợp: bóng thoại trắng trên nền xám, chữ đủ to để detect/OCR."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent / "fixtures"


def make_page(path, text, font_path, vertical=False):
    img = Image.new("RGB", (800, 1200), "#c9c9c9")
    d = ImageDraw.Draw(img)
    d.ellipse([100, 100, 520, 420], fill="white", outline="black", width=4)
    font = ImageFont.truetype(font_path, 42)
    if vertical:
        x, y = 290, 140
        for ch in text:
            d.text((x, y), ch, font=font, fill="black")
            y += 46
    else:
        d.text((150, 230), text, font=font, fill="black")
    img.save(path)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    make_page(OUT / "ja_page.png", "こんにちは世界", "C:/Windows/Fonts/msgothic.ttc", vertical=True)
    make_page(OUT / "es_page.png", "Hola amigo", "C:/Windows/Fonts/arialbd.ttf")
    print("fixtures written to", OUT)
