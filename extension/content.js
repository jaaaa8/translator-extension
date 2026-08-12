const MIN_SIZE = 400;
let enabled = true;
let srcLang = "ja";
let dstLang = "vi";
let readingDirection = "rtl";
let currentRequestId = null;
let port = null;
let pruneFrame = 0;
const overlays = new Map();
const imageRequests = new WeakMap();
const jobBindings = new Map();
const pendingScopes = new Map();
const activeScopeMessages = new Map();
const completedScopeIds = new Set();

function uiDirection(value) {
  return value === "ltr" ? "ltr" : "rtl";
}

chrome.storage.local.get(["enabled", "srcLang", "dstLang", "readingDirection"]).then((value) => {
  enabled = value.enabled !== false;
  srcLang = value.srcLang || "ja";
  dstLang = value.dstLang || "vi";
  readingDirection = uiDirection(value.readingDirection);
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.srcLang) srcLang = changes.srcLang.newValue;
  if (changes.dstLang) dstLang = changes.dstLang.newValue;
  if (changes.readingDirection) readingDirection = uiDirection(changes.readingDirection.newValue);
  if (changes.enabled) {
    enabled = changes.enabled.newValue;
    for (const { container } of overlays.values()) container.style.display = enabled ? "" : "none";
  }
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "translatePage") {
    translatePage(message.scope, message.srcLang, message.dstLang, message.readingDirection).then(sendResponse);
    return true;
  }
  if (message.type === "prewarmPage") {
    prewarmPage(message.srcLang);
    sendResponse({ ok: true });
  }
});

function cleanupRequest(requestId, result) {
  const pending = pendingScopes.get(requestId);
  pendingScopes.delete(requestId);
  activeScopeMessages.delete(requestId);
  if (result?.ok === true) completedScopeIds.add(requestId);
  else completedScopeIds.delete(requestId);
  for (const [jobId, binding] of jobBindings) if (binding.requestId === requestId) jobBindings.delete(jobId);
  if (pending && result) pending.resolve(result);
}

function translationPort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: "translation" });
  port.onMessage.addListener(handleEvent);
  port.onDisconnect.addListener(() => {
    port = null;
    queueMicrotask(() => {
      if (port) return;
      const requestId = currentRequestId;
      const message = activeScopeMessages.get(requestId);
      if (message && pendingScopes.has(requestId)) translationPort().postMessage({ ...message, replaces_request_id: null });
    });
  });
  return port;
}

function snapshotJobs(scope, requestId, requestSrcLang, requestDstLang) {
  const images = [...document.querySelectorAll("img")];
  const candidates = selectCandidates(images, scope, innerWidth, innerHeight, MIN_SIZE);
  for (const img of images) {
    if (scope !== "loaded" && !isViewportVisible(img, innerWidth, innerHeight)) continue;
    imageRequests.set(img, requestId);
    const overlay = overlays.get(img);
    if (overlay && (overlay.srcLang !== requestSrcLang || overlay.dstLang !== requestDstLang || sourceSignature(img) !== overlay.sourceSignature)) removeOverlay(img);
  }
  return candidates.map((candidate) => {
    const jobId = crypto.randomUUID();
    const cropSignature = JSON.stringify(candidate.crop || "full");
    const overlay = overlays.get(candidate.img);
    if (overlay && overlay.cropSignature !== cropSignature) removeOverlay(candidate.img);
    jobBindings.set(jobId, { img: candidate.img, requestId, source: candidate.source, sourceSignature: candidate.source_signature, cropSignature, scope, srcLang: requestSrcLang, dstLang: requestDstLang });
    return { job_id: jobId, source_url: candidate.source, crop: candidate.crop, natural_width: candidate.natural_width, natural_height: candidate.natural_height, distance: candidate.distance, priority: isViewportVisible(candidate.img, innerWidth, innerHeight) ? 0 : 1 };
  });
}

function translatePage(scope, requestSrcLang = srcLang, requestDstLang = dstLang, requestDirection = readingDirection) {
  const requestId = crypto.randomUUID();
  const replacesRequestId = currentRequestId;
  const requestReadingDirection = uiDirection(requestDirection);
  if (replacesRequestId) cleanupRequest(replacesRequestId, { ok: false, error: "superseded" });
  currentRequestId = requestId;
  srcLang = requestSrcLang;
  dstLang = requestDstLang;
  let jobs;
  try { jobs = snapshotJobs(scope, requestId, srcLang, dstLang); }
  catch (error) { return Promise.resolve({ ok: false, error: error.message || String(error) }); }
  const done = new Promise((resolve) => pendingScopes.set(requestId, { resolve, startedAt: performance.now(), firstOverlayMs: null, firstOverlayByJob: new Map() }));
  const message = { type: "start_scope", request_id: requestId, replaces_request_id: replacesRequestId, scope, src_lang: srcLang, dst_lang: dstLang, reading_direction: requestReadingDirection, jobs };
  activeScopeMessages.set(requestId, message);
  translationPort().postMessage(message);
  return done;
}

function validBinding(event, completedBinding = null) {
  const binding = jobBindings.get(event.job_id) || (completedScopeIds.has(event.request_id) ? completedBinding : null);
  if (!binding || binding.requestId !== event.request_id) return null;
  if (imageRequests.get(binding.img) !== event.request_id || !binding.img.isConnected) return null;
  if (!isCurrentSource(binding.img, binding.source, binding.scope) || sourceSignature(binding.img) !== binding.sourceSignature) return null;
  return binding.srcLang === srcLang && binding.dstLang === dstLang ? binding : null;
}

function handleEvent(event) {
  if (event.type === "translation") { const binding = validBinding(event); if (binding) void upsertOverlayBlock(binding.img, binding, event).catch((error) => console.error("[MangaTranslator] overlay render failed", { request_id: event.request_id, job_id: event.job_id, block_id: event.block_id }, error)); return; }
  if (event.type === "image_done") { const binding = validBinding(event); if (binding && event.translated === 0) removeOverlay(binding.img); return; }
  if (event.type === "scope_error") return cleanupRequest(event.request_id, { ok: false, error: event.code || event.error });
  if (event.type === "scope_done") {
    const pending = pendingScopes.get(event.request_id);
    if (!pending) return;
    const pageMetrics = (event.page_metrics || []).map((row) => pending.firstOverlayByJob.has(row.job_id)
      ? { ...row, first_overlay_ms: pending.firstOverlayByJob.get(row.job_id) } : row);
    const metrics = pending.firstOverlayMs == null ? event.metrics : { ...(event.metrics || {}), first_overlay_ms: Number.isFinite(event.metrics?.first_overlay_ms) ? Math.min(event.metrics.first_overlay_ms, pending.firstOverlayMs) : pending.firstOverlayMs };
    cleanupRequest(event.request_id, { ok: true, images: event.images, blocks: event.translated, failed: event.failed, cacheHit: event.cache_hit === true, first_overlay_ms: pending.firstOverlayMs, metrics, page_metrics: pageMetrics });
  }
}

function ensureOverlay(img, binding, event) {
  let overlay = overlays.get(img);
  if (overlay && overlay.requestId !== binding.requestId) {
    if (overlay.source === binding.source && overlay.sourceSignature === binding.sourceSignature && overlay.cropSignature === binding.cropSignature && overlay.srcLang === binding.srcLang && overlay.dstLang === binding.dstLang) overlay.requestId = binding.requestId;
    else { removeOverlay(img); overlay = null; }
  }
  if (overlay) return overlay;
  const container = document.createElement("div");
  container.className = "mt-overlay";
  if (!enabled) container.style.display = "none";
  document.body.appendChild(container);
  overlay = { container, source: binding.source, sourceSignature: binding.sourceSignature, cropSignature: binding.cropSignature, scope: binding.scope, requestId: binding.requestId, srcLang: binding.srcLang, dstLang: binding.dstLang, imageW: event.image_w, imageH: event.image_h, blocks: new Map(), resizeObserver: new ResizeObserver(() => position(img)) };
  overlays.set(img, overlay);
  overlay.resizeObserver.observe(img);
  return overlay;
}

function boxStyle(bbox, scaleX, scaleY, originX = 0, originY = 0) {
  const [x, y, width, height] = bbox;
  return { left: (x - originX) * scaleX + "px", top: (y - originY) * scaleY + "px", width: width * scaleX + "px", height: height * scaleY + "px" };
}

function renderBlockGeometry(rect, imageW, imageH, patchBbox, fitBbox) {
  const scaleX = rect.width / imageW;
  const scaleY = rect.height / imageH;
  const [patchX, patchY] = patchBbox;
  return {
    wrapper: boxStyle(patchBbox, scaleX, scaleY),
    patch: boxStyle(patchBbox, scaleX, scaleY, patchX, patchY),
    text: boxStyle(fitBbox, scaleX, scaleY, patchX, patchY),
  };
}

function applyBlockGeometry(block, geometry) {
  Object.assign(block.element.style, geometry.wrapper);
  Object.assign(block.patch.style, geometry.patch);
  Object.assign(block.text.style, geometry.text);
}

function validLayoutHint(hint) {
  return hint && Number.isInteger(hint.font_px) && hint.font_px >= 10 && hint.font_px <= 18 && Number.isFinite(hint.line_height) && hint.line_height > 0;
}

function fitText(element, hint = null) {
  const cached = validLayoutHint(hint) ? hint : null;
  const lineHeight = cached?.line_height ?? 1.2;
  element.style.lineHeight = String(lineHeight);
  for (let size = cached?.font_px ?? 18; size >= 10; size--) {
    element.style.fontSize = size + "px";
    if (element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth) return { font_px: size, line_height: lineHeight };
  }
  return null;
}

function measureTextProfile(element, hint) {
  const probe = document.createElement("div");
  probe.className = element.className;
  probe.textContent = element.textContent;
  Object.assign(probe.style, {
    position: "fixed", left: "-100000px", top: "0", width: element.style.width, height: element.style.height,
    visibility: "hidden", pointerEvents: "none", writingMode: element.style.writingMode,
  });
  document.body.appendChild(probe);
  let profile;
  try { profile = fitText(probe, hint); }
  finally { probe.remove(); }
  if (profile) Object.assign(element.style, { fontSize: profile.font_px + "px", lineHeight: String(profile.line_height) });
  return profile;
}

function postRenderMetric(binding, event, painted, reason, layoutProfile, firstOverlayMs = null) {
  const metric = {
    type: "render_metric", request_id: binding.requestId, job_id: event.job_id,
    page_artifact_key: event.page_artifact_key, render_artifact_key: event.render_artifact_key,
    layout_fit_version: event.layout_fit_version, block_id: event.block_id,
    painted, reason, layout_profile: layoutProfile,
  };
  if (firstOverlayMs != null) metric.first_overlay_ms = firstOverlayMs;
  try { translationPort().postMessage(metric); } catch {}
}

function positionOverlay(img, overlay) {
  const rect = renderedImageRect(img);
  Object.assign(overlay.container.style, { left: rect.left + scrollX + "px", top: rect.top + scrollY + "px", width: rect.width + "px", height: rect.height + "px" });
  return rect;
}

async function upsertOverlayBlock(img, binding, event) {
  const element = document.createElement("div");
  element.className = "mt-render-block";
  const patch = document.createElement("img");
  patch.className = "mt-clean-patch";
  patch.src = `data:${event.patch_mime};base64,${event.patch_rgba}`;
  const text = document.createElement("div");
  text.className = "mt-translated-text";
  text.textContent = event.trans_text;
  text.style.writingMode = event.vertical === true ? "vertical-rl" : "horizontal-tb";
  element.appendChild(patch);
  element.appendChild(text);
  try { await patch.decode(); }
  catch { return; }
  if (!validBinding(event, binding)) return;
  const overlay = ensureOverlay(img, binding, event);
  overlay.imageW = event.image_w;
  overlay.imageH = event.image_h;
  const geometry = renderBlockGeometry(positionOverlay(img, overlay), overlay.imageW, overlay.imageH, event.patch_bbox, event.fit_bbox);
  const block = { element, patch, text, patchBbox: [...event.patch_bbox], fitBbox: [...event.fit_bbox], profile: null, binding, event };
  applyBlockGeometry(block, geometry);
  const profile = measureTextProfile(text, event.layout_hint);
  if (!validBinding(event, binding)) return;
  if (!profile) { postRenderMetric(binding, event, false, "fit_failed", null); return; }
  block.profile = profile;
  overlay.blocks.get(event.block_id)?.element.remove();
  overlay.container.appendChild(element);
  overlay.blocks.set(event.block_id, block);
  const pending = pendingScopes.get(binding.requestId);
  let firstOverlayMs = null;
  if (pending && !pending.firstOverlayByJob.has(event.job_id)) {
    firstOverlayMs = Math.round(performance.now() - pending.startedAt);
    pending.firstOverlayByJob.set(event.job_id, firstOverlayMs);
    if (pending.firstOverlayMs == null || firstOverlayMs < pending.firstOverlayMs) pending.firstOverlayMs = firstOverlayMs;
  }
  postRenderMetric(binding, event, true, null, profile, firstOverlayMs);
}

function removeOverlay(img) { const overlay = overlays.get(img); if (!overlay) return; overlay.resizeObserver.disconnect(); overlay.container.remove(); overlays.delete(img); }
function pruneOverlays() { for (const [img, overlay] of overlays) if (!img.isConnected || sourceSignature(img) !== overlay.sourceSignature || !isCurrentSource(img, overlay.source, overlay.scope)) removeOverlay(img); }
function schedulePrune() { if (!pruneFrame) pruneFrame = requestAnimationFrame(() => { pruneFrame = 0; pruneOverlays(); }); }
function position(img) {
  const overlay = overlays.get(img);
  if (!overlay) return;
  const rect = positionOverlay(img, overlay);
  for (const [blockId, block] of overlay.blocks) {
    applyBlockGeometry(block, renderBlockGeometry(rect, overlay.imageW, overlay.imageH, block.patchBbox, block.fitBbox));
    const profile = fitText(block.text, block.profile);
    if (profile) { block.profile = profile; continue; }
    block.element.remove();
    overlay.blocks.delete(blockId);
    if (validBinding(block.event, block.binding)) postRenderMetric(block.binding, block.event, false, "fit_failed", null);
  }
}
function repositionOverlays() { schedulePrune(); for (const img of overlays.keys()) position(img); }
async function prewarmPage(requestSrcLang) { if (typeof location !== "undefined" && (location.hostname === "127.0.0.1" || location.hostname === "localhost") && location.port === "8910" && new URL(location.href).searchParams.has("acceptance")) return; try { const jobs = selectCandidates(document.querySelectorAll("img"), "visible", innerWidth, innerHeight, MIN_SIZE); const selected = jobs.sort((a, b) => visibleArea(b.img, innerWidth, innerHeight) - visibleArea(a.img, innerWidth, innerHeight))[0]; if (selected) await chrome.runtime.sendMessage({ type: "prewarmJob", source_url: selected.source, crop: selected.crop, natural_width: selected.natural_width, natural_height: selected.natural_height, src_lang: requestSrcLang }); } catch (error) { console.warn("[MangaTranslator] prewarm:", error); } }
new MutationObserver(schedulePrune).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset", "sizes", "media", "type"] });
new ResizeObserver(repositionOverlays).observe(document.documentElement);
window.addEventListener("resize", repositionOverlays);
