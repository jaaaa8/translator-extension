import os

from dotenv import load_dotenv

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-latest")
PORT = int(os.getenv("PORT", "8910"))
DEVICE = os.getenv("DEVICE", "cuda")
