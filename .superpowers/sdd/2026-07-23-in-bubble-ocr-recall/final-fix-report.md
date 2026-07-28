# Final fix report — in-bubble OCR recall

Fix base: `16f975c6f29c7ca9a629e7b9f23a5b123d3c7cc2`

## Scope delivered

- `server/diagnose.py` now calls the pipeline's shared `_prep_crop` before `engine.read`, so B3 diagnostics exercise the same crop padding/upscaling as production OCR.
- `extension/srcset.js` now returns `currentSrc` only when an image has no usable own `srcset` and its direct parent is `PICTURE`; ordinary images retain the existing `src`-before-`currentSrc` fallback.
- No `<source>` media/type parsing or candidate-selection machinery was added, per the accepted minimum scope.

## Files changed

- `server/diagnose.py`
- `server/tests/test_diagnose.py`
- `extension/srcset.js`
- `extension/test/srcset.test.js`
- `docs/superpowers/plans/2026-07-23-in-bubble-ocr-recall.md`

## TDD evidence

### Diagnostic prepared crop

Test added: `test_diagnose_prepares_crop_before_ocr`. It catches a diagnostic path that hands the raw `20x40` crop to OCR instead of the prepared `64x112` crop.

RED command:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_diagnose.py -q
```

RED output:

```text
..F                                                                      [100%]
FAILED server/tests/test_diagnose.py::test_diagnose_prepares_crop_before_ocr
assert (20, 40, 3) == (64, 112, 3)
1 failed, 2 passed in 0.19s
```

Minimal implementation: import `_prep_crop` from `server.pipeline` and call `engine.read(_prep_crop(crop))`.

GREEN command:

```powershell
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_diagnose.py -q
```

GREEN output:

```text
...                                                                      [100%]
3 passed in 0.14s
```

### Picture-backed source selection

Test added: direct `PICTURE` parent, no `img.srcset`, `src` fallback, and browser-selected `currentSrc`. It catches returning the fallback URL instead of the selected picture candidate.

RED command:

```powershell
node extension/test/srcset.test.js
```

RED output:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ 'https://x/fallback.jpg'
- 'https://x/large.webp'
```

Minimal implementation: after trying the image's own `srcset`, return non-empty `currentSrc` when `img.parentElement.tagName === "PICTURE"`; otherwise keep `img.src || img.currentSrc`.

GREEN command:

```powershell
node extension/test/srcset.test.js
```

GREEN output:

```text
srcset.test.js OK
```

## Focused final verification

```text
& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_diagnose.py -q
3 passed in 0.14s

& 'D:\MangaTranslator\venv\Scripts\python.exe' -m pytest server/tests/test_pipeline.py -k prep_crop -q
2 passed, 4 deselected in 0.13s

node extension/test/srcset.test.js
srcset.test.js OK

node --check extension/srcset.js
exit 0, no output

node --check extension/test/srcset.test.js
exit 0, no output

git diff --check
exit 0; no whitespace errors
```

## Plan adaptations

- Architecture and Task 1's consumed interface now state that diagnostic OCR uses `_prep_crop` and receives the prepared crop.
- Task 1's test and implementation examples include the prepared-crop assertion and shared helper import/call.
- Task 2 now defines the precise three-way contract: largest own `img.srcset` candidate, otherwise browser `currentSrc` for a directly picture-backed image, otherwise normal `src` then `currentSrc` fallback.
- Task 2's heading, test example, comments, and `bestSource` example include the picture branch.

## Self-review and concerns

- Mutating the diagnostic call back to `engine.read(crop)` fails the prepared-crop test; removing the picture branch fails the picture assertion. The existing ordinary-image assertion preserves the required `src` preference.
- Deferred minor findings were not changed.
- Git emitted existing Windows LF-to-CRLF conversion warnings during diff checks; `git diff --check` found no whitespace errors. No functional concerns identified.
