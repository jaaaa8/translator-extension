const MIN_SIZE = 400;
let enabled = true;
let srcLang = "ja";
let dstLang = "vi";
let currentRequestId = null;
let port = null;
let pruneFrame = 0;
const overlays = new Map();
const imageRequests = new WeakMap();
const jobBindings = new Map();
const pendingScopes = new Map();
const activeScopeMessages = new Map();

chrome.storage.local.get(["enabled", "srcLang", "dstLang"]).then((value) => {
  enabled = value.enabled !== false;
  srcLang = value.srcLang || "ja";
  dstLang = value.dstLang || "vi";
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.srcLang) srcLang = changes.srcLang.newValue;
  if (changes.dstLang) dstLang = changes.dstLang.newValue;
  if (changes.enabled) {
    enabled = changes.enabled.newValue;
    for (const { container } of overlays.values()) container.style.display = enabled ? "" : "none";
  }
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "translatePage") {
    translatePage(message.scope, message.srcLang, message.dstLang).then(sendResponse);
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

function translatePage(scope, requestSrcLang = srcLang, requestDstLang = dstLang) {
  const requestId = crypto.randomUUID();
  const replacesRequestId = currentRequestId;
  if (replacesRequestId) cleanupRequest(replacesRequestId, { ok: false, error: "superseded" });
  currentRequestId = requestId;
  srcLang = requestSrcLang;
  dstLang = requestDstLang;
  let jobs;
  try { jobs = snapshotJobs(scope, requestId, srcLang, dstLang); }
  catch (error) { return Promise.resolve({ ok: false, error: error.message || String(error) }); }
  const done = new Promise((resolve) => pendingScopes.set(requestId, { resolve, startedAt: performance.now(), firstOverlayMs: null }));
  const message = { type: "start_scope", request_id: requestId, replaces_request_id: replacesRequestId, scope, src_lang: srcLang, dst_lang: dstLang, jobs };
  activeScopeMessages.set(requestId, message);
  translationPort().postMessage(message);
  return done;
}

function validBinding(event) {
  const binding = jobBindings.get(event.job_id);
  if (!binding || binding.requestId !== event.request_id) return null;
  if (imageRequests.get(binding.img) !== event.request_id || !binding.img.isConnected) return null;
  if (!isCurrentSource(binding.img, binding.source, binding.scope) || sourceSignature(binding.img) !== binding.sourceSignature) return null;
  return binding.srcLang === srcLang && binding.dstLang === dstLang ? binding : null;
}

function handleEvent(event) {
  if (event.type === "translation") { const binding = validBinding(event); if (binding) upsertOverlayBlock(binding.img, binding, event); return; }
  if (event.type === "image_done") { const binding = validBinding(event); if (binding && event.translated === 0) removeOverlay(binding.img); return; }
  if (event.type === "scope_error") return cleanupRequest(event.request_id, { ok: false, error: event.code || event.error });
  if (event.type === "scope_done") {
    const pending = pendingScopes.get(event.request_id);
    if (!pending) return;
    cleanupRequest(event.request_id, { ok: true, images: event.images, blocks: event.translated, failed: event.failed, cacheHit: event.cache_hit === true, first_overlay_ms: pending.firstOverlayMs, metrics: event.metrics });
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

function upsertOverlayBlock(img, binding, event) {
  const overlay = ensureOverlay(img, binding, event);
  overlay.imageW = event.image_w;
  overlay.imageH = event.image_h;
  let block = overlay.blocks.get(event.block_id);
  if (!block) { const element = document.createElement("div"); element.className = "mt-bubble"; overlay.container.appendChild(element); block = { element, bbox: event.bbox }; overlay.blocks.set(event.block_id, block); }
  block.bbox = event.bbox;
  block.element.textContent = event.trans_text;
  position(img);
  const pending = pendingScopes.get(binding.requestId);
  if (pending && pending.firstOverlayMs == null) { pending.firstOverlayMs = Math.round(performance.now() - pending.startedAt); translationPort().postMessage({ type: "render_metric", request_id: binding.requestId, first_overlay_ms: pending.firstOverlayMs }); }
}

function removeOverlay(img) { const overlay = overlays.get(img); if (!overlay) return; overlay.resizeObserver.disconnect(); overlay.container.remove(); overlays.delete(img); }
function pruneOverlays() { for (const [img, overlay] of overlays) if (!img.isConnected || sourceSignature(img) !== overlay.sourceSignature || !isCurrentSource(img, overlay.source, overlay.scope)) removeOverlay(img); }
function schedulePrune() { if (!pruneFrame) pruneFrame = requestAnimationFrame(() => { pruneFrame = 0; pruneOverlays(); }); }
function position(img) { const overlay = overlays.get(img); if (!overlay) return; const rect = renderedImageRect(img); Object.assign(overlay.container.style, { left: rect.left + scrollX + "px", top: rect.top + scrollY + "px", width: rect.width + "px", height: rect.height + "px" }); for (const block of overlay.blocks.values()) { const [x, y, w, h] = block.bbox; Object.assign(block.element.style, { left: x * rect.width / overlay.imageW + "px", top: y * rect.height / overlay.imageH + "px", width: w * rect.width / overlay.imageW + "px", height: h * rect.height / overlay.imageH + "px" }); fitText(block.element); } }
function fitText(element) { let size = 18; element.style.fontSize = size + "px"; while (size > 10 && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)) element.style.fontSize = --size + "px"; }
function repositionOverlays() { schedulePrune(); for (const img of overlays.keys()) position(img); }
async function prewarmPage(requestSrcLang) { try { const jobs = selectCandidates(document.querySelectorAll("img"), "visible", innerWidth, innerHeight, MIN_SIZE); const selected = jobs.sort((a, b) => visibleArea(b.img, innerWidth, innerHeight) - visibleArea(a.img, innerWidth, innerHeight))[0]; if (selected) await chrome.runtime.sendMessage({ type: "prewarmJob", source_url: selected.source, crop: selected.crop, natural_width: selected.natural_width, natural_height: selected.natural_height, src_lang: requestSrcLang }); } catch (error) { console.warn("[MangaTranslator] prewarm:", error); } }
new MutationObserver(schedulePrune).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset", "sizes", "media", "type"] });
new ResizeObserver(repositionOverlays).observe(document.documentElement);
window.addEventListener("resize", repositionOverlays);
