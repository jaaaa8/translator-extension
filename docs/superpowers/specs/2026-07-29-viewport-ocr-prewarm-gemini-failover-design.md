# Design: Fast viewport OCR, intent-gated prewarming, and Gemini failover

Date: 2026-07-29 | Branch: `feat/v1` | Approved by user: 2026-07-29

## Context

The extension has two explicit actions:

- `visible`: translate the page currently in the viewport.
- `loaded`: translate all eligible webtoon images already loaded in the DOM.

The `visible` action currently filters out offscreen images but still downloads and OCRs each selected image at full resolution. A tall or high-resolution reader page therefore takes nearly as long as a webtoon image. OCR engines are also created lazily, so the first request for a language pays model-loading cost after the user clicks Translate.

The earlier intermittent 502/60-second behavior stopped after reloading the MV3 extension, which activated the updated service worker and its separate OCR/translation timeouts. This design does not add another generic timeout workaround.

Gemini translation currently has one client. The user has confirmed that the primary and secondary replacement keys belong to different Google Cloud projects, so a secondary client can provide independent quota.

## Decisions

1. `visible` OCR uses only the visible portion of the current image, with small padding.
2. Opening the extension popup speculatively OCRs at most one visible image crop. This happens for both reader pages and webtoons and never calls Gemini.
3. `loaded` webtoon behavior remains full-image OCR for all eligible loaded images. Popup prewarming heats the shared OCR/detector path; it is not allowed to speculatively scan the entire chapter.
4. Completed and in-flight OCR work share the same URL/language/crop key, so a Translate click reuses or joins prewarming when the requested work is identical.
5. Gemini uses an optional second server-side key and switches clients only after a 429 quota response.

No new dependency, automatic scrolling, site-layout heuristic, persistent OCR cache, or dedicated warmup endpoint is added.

## Viewport OCR

### Candidate source

- `loaded` keeps `bestSource(img)` so webtoon translation retains the existing full-resolution behavior.
- `visible` uses `img.currentSrc || img.src`. Crop bounds stay normalized so browser density correction of `naturalWidth`/`naturalHeight` cannot shift the raw decoded-image crop.

### Crop calculation

For `visible`, intersect `img.getBoundingClientRect()` with the browser viewport. Expand that intersection by 10% on each axis to avoid cutting a speech bubble at the viewport edge. Convert the padded bounds to normalized fractions of the displayed image, clamp them to `[0, 1]`, and round to six decimal places for stable job keys.

The job carries optional normalized fields `left`, `top`, `right`, and `bottom`; `/ocr` receives them as `crop_left`, `crop_top`, `crop_right`, and `crop_bottom`. All four are present or absent together, with `0 <= left < right <= 1` and `0 <= top < bottom <= 1`. If the padded crop covers the complete source, canonicalize it as a full-image job with no crop fields. This lets a fully visible page share the same cache entry as `loaded` OCR.

The server decodes the source once, validates the normalized crop, converts starts with `floor` and ends with `ceil` against the raw decoded dimensions, crops before detection/OCR, and offsets each returned bounding box by the crop origin. `image_w` and `image_h` remain the original decoded-source dimensions so overlay coordinates stay in one coordinate system.

Invalid, empty, or out-of-bounds crops return 422. A malformed image remains an OCR error and is never cached.

### State and overlays

An OCR/translation job identity is the source URL, language, and canonical crop. A successful `visible` crop marks only that crop complete; scrolling to a different portion of the same tall source produces a new job. Rendering a later visible crop replaces the previous visible overlay for that image, matching the current "translate what I am viewing" action.

Overlay scaling uses response `image_w` and `image_h`, not an assumption that the selected source equals the DOM image's current natural dimensions. Source-change and disconnected-element guards remain in place so stale results are discarded.

## Intent-gated OCR prewarming

### Trigger

Prewarming starts only after all of these are true:

1. The user opens the extension popup.
2. Stored language settings have loaded.
3. The local server health check succeeds.
4. The active tab has an eligible visible image.

The popup sends the selected source language to the content script. Changing the source language while the popup is open starts one new prewarm for that language.

The content script selects the eligible image with the largest visible intersection and submits exactly one viewport OCR job. It does not render, mark the image translated, or send any text to Gemini.

This same bounded prewarm applies to both actions:

- If the user chooses `visible`, the request normally joins the in-flight job or reads its completed cache result.
- If the user chooses `loaded`, the shared local models are already hot. A fully visible webtoon page also gets an exact cache hit; a long strip or partially visible page continues through the existing full-image loaded job.

This avoids OCR activity on every ordinary webpage and avoids turning popup-open into an unrequested full-chapter scan.

### Deduplication and failure

The background worker keeps:

- the existing completed in-memory OCR cache; and
- an in-flight map from the same canonical OCR key to a Promise.

Concurrent prewarm and manual requests for the same job await one Promise. The Promise is removed from the in-flight map on completion. Only successful responses enter the completed cache, so a failed prewarm cannot poison the later manual retry.

The server's existing pipeline lock serializes lazy engine construction and OCR inference. Therefore a manual request arriving during the first prewarm cannot construct a second shared OCR engine.

Prewarm errors are quiet apart from a console warning. They do not set the red failure badge, disable buttons, or prevent a later explicit OCR attempt. Offline pages, unsupported browser pages, and pages without a candidate simply skip prewarming.

## Gemini project failover

### Configuration

Keep `GEMINI_API_KEY` and add optional `GEMINI_API_KEY_SECONDARY`. Both are read only by the local server from environment configuration. They are never embedded in the extension, returned by an endpoint, logged, committed, or placed in tests.

The key previously pasted into chat is considered exposed and must not be used. The user will configure rotated replacement keys locally.

### Request policy

Create one client per configured key and remember an active client index.

Each translation has a total budget of two remote calls:

1. Call the active client.
2. If it succeeds with the expected JSON array length, return it.
3. If it fails with 429 and another client exists, spend the second call on the other client.
4. If the fallback succeeds, make it active for subsequent translations.
5. For malformed output or a non-429 exception, preserve the existing one retry on the same client; never switch projects for those errors.

The second call is therefore either the existing same-client retry or the quota fallback, never both. With one configured key, behavior remains compatible with the current implementation. If both projects return 429, `/translate-texts` returns the existing 502 error shape with a clear quota message.

The active index needs no persistence or cooldown. A later 429 on the active project naturally tries the other project, which may have recovered. This is the minimum policy that uses both independent quotas without background probes or round-robin spending.

## Data flow

```text
Popup opens
  -> load srcLang + health check
  -> content selects one largest visible candidate
  -> background OCR key: URL + srcLang + canonical crop
  -> completed cache hit, join in-flight Promise, or POST /ocr
  -> server crop -> detect -> OCR
  -> cache successful OCR only; never call Gemini

User clicks visible
  -> OCR each visible crop (prewarmed job is reused)
  -> one /translate-texts request for collected text
  -> render overlays in original-source coordinates

User clicks loaded webtoon
  -> full-image OCR for eligible loaded images
  -> models are already warm; exact full-image prewarm is reused when available
  -> one /translate-texts request for collected text
  -> retain existing webtoon overlays

Gemini translation
  -> active project
  -> only on 429: other project once
  -> successful fallback becomes active
```

## Verification

Automated checks will cover:

- viewport intersection, padding, normalized bounds, raw-decoded-pixel conversion, clamping, and full-crop canonicalization;
- server crop validation, original image dimensions, and bounding-box offsets;
- distinct cache entries for different scroll slices;
- a simultaneous prewarm and Translate request producing one `/ocr` call;
- failed prewarm being retryable and not entering the completed cache;
- popup prewarming at most one visible candidate and never requesting translation;
- webtoon `loaded` selection remaining full-image and unchanged apart from warmed models/cache reuse;
- primary 429 falling back to the secondary client and promoting it;
- non-429 failures not switching projects; and
- both projects exhausted returning `TranslateError`/HTTP 502 without exposing keys.

Run the existing Python and Node extension checks after implementation. Manually verify a single-page reader, a multi-image webtoon, and a very tall single-strip webtoon with the browser extension reloaded so the current service worker is active.

## Out of scope

- OCR on page load or on every scroll event.
- Speculatively OCRing every loaded webtoon image before the user chooses an action.
- Persistent cross-service-worker OCR storage.
- More than two Gemini projects, round-robin distribution, quota polling, or cooldown timers.
- Changing the existing one-batch Gemini translation strategy.
