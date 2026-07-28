# Task 3 Report: OCR crop padding and upscaling

## Implementation

- Added `_prep_crop(crop_rgb: np.ndarray) -> np.ndarray` in `server/pipeline.py`.
- Crops shorter than 48px are enlarged with `cv2.INTER_CUBIC`, then receive an 8px white border on all sides.
- `Pipeline.ocr_image` now passes only the RGB crop through `_prep_crop` before `engine.read`.

## Files changed

- `server/pipeline.py`
- `server/tests/test_pipeline.py`

## TDD evidence

### RED

Command:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_pipeline.py -k prep_crop -v
```

Result: exit 1 during collection, as expected:

```text
ImportError: cannot import name '_prep_crop' from 'server.pipeline'
```

### GREEN

Same focused command after implementation: exit 0.

```text
2 passed, 4 deselected in 0.15s
```

Pipeline suite command:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_pipeline.py -q
```

Result: exit 0.

```text
6 passed in 0.14s
```

## Bbox contract check

`_prep_crop` is applied after `img[y:y2, x:x2]` is extracted and before `engine.read`; the appended block still uses `[x, y, x2 - x, y2 - y]` from original image coordinates. The passing existing pipeline schema tests assert this exact bbox remains `[10, 10, 100, 50]`.

## Self-review

- Minimum requested scope only; no dependencies or vendor files changed.
- Large crops receive exactly 16px total in both dimensions; short crops are resized before padding.
- `git diff --check` returned clean.

## Concerns

- None.
