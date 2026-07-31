# Overlay contain fix report

## Root cause

Chrome reports the reader `<img>` element box as 1228.8 x 511.35 while its 800 x 1200 pixels are rendered with `object-fit: contain` and centered `object-position`. `content.position` scaled OCR coordinates independently against the full element width and height, so overlays stretched into the horizontal letterbox. The same element-box assumption also affected visible-area selection, viewport visibility/crop, and viewport distance in `srcset.js`.

## RED / GREEN

- RED: the 800 x 1200 image in a 1200 x 600 box produced an overlay at left 100 with width 1200; expected the rendered-pixel rect at left 500 with width 400. The new geometry test also failed because `renderedImageRect` did not exist.
- GREEN: one shared `renderedImageRect` now calculates contained or scale-down pixels for computed two-percentage `object-position`. Missing style data, unsupported positions, and ordinary fill preserve the element rect.
- The shared rect is used for overlay placement/scaling, visible area, viewport crop/visibility, prewarm ranking through visible area, and viewport distance.

## Files

- `extension/srcset.js`
- `extension/content.js`
- `extension/test/srcset.test.js`
- `extension/test/content.test.js`

## Test evidence

- Focused: `node extension/test/srcset.test.js` and `node extension/test/content.test.js` passed.
- Full Node gate: all 8 files in `extension/test` passed.
- Full Python gate: repository venv reported `69 passed, 3 warnings`.
- `git diff --check` passed.

## Concerns

- Deliberately supports only the requested computed percentage pair for `object-position`; other CSS position serializations fall back to prior element-box behavior instead of introducing a speculative parser.
- The initial system-Python test attempt could not import `google.genai`; the repository venv completed the full suite successfully.
- Browser acceptance must be rerun against the real reader; acceptance worklogs were not edited.
