if (typeof importScripts === "function") importScripts("page-cache.js");

const SERVER = "http://127.0.0.1:8910";
const MAX_CONCURRENT = 2;
const MAX_OUTSTANDING_PER_REQUEST = 4;
const PRIORITY = Object.freeze({ foreground: 0, background: 1, prewarm: 2 });

function canonicalCrop(crop) {
  if (!crop) return "full";
  const rounded = Object.fromEntries(
    ["left", "top", "right", "bottom"].map((key) => [
      key, Math.round(crop[key] * 1e6) / 1e6,
    ])
  );
  return rounded.left === 0 && rounded.top === 0 &&
    rounded.right === 1 && rounded.bottom === 1 ? "full" : rounded;
}

async function hashValue(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildKeys(job, versions) {
  const crop = canonicalCrop(job.crop);
  const sourceUrl = new URL(job.source_url);
  sourceUrl.hash = "";
  const sourceRevision = await hashValue([
    sourceUrl.href,
    job.natural_width,
    job.natural_height,
  ]);
  const analysisKey = await hashValue([
    sourceRevision, crop, versions.detector, versions.dedupe, versions.prep,
  ]);
  const ocrKey = await hashValue([
    analysisKey, job.src_lang, versions.recognizers[job.src_lang],
  ]);
  const overlayKey = await hashValue([
    sourceRevision, crop, ocrKey, job.dst_lang,
    versions.translator_model, versions.prompt, versions.policy,
  ]);
  return {
    sourceRevision,
    analysisKey,
    ocrKey,
    overlayKey,
    pageArtifactKey: await hashValue([overlayKey, versions.page_schema]),
    crop,
  };
}

async function* readNdjson(response) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) yield JSON.parse(pending);
}

const taskQueue = [];
let taskSequence = 0;
let activeTasks = 0;

function compareTasks(a, b) {
  const tier = a.tier - b.tier;
  if (tier) return tier;
  return a.tier === PRIORITY.background
    ? a.sequence - b.sequence
    : a.distance - b.distance || a.sequence - b.sequence;
}

function enqueueTask(task) {
  taskQueue.push({ distance: 0, ...task, sequence: ++taskSequence });
  taskQueue.sort(compareTasks);
  pumpTasks();
}

function pumpTasks() {
  while (activeTasks < MAX_CONCURRENT && taskQueue.length) {
    const task = taskQueue.shift();
    if (task.cancelled()) {
      task.done();
      continue;
    }
    activeTasks++;
    Promise.resolve().then(task.run)
      .catch(task.fail)
      .finally(() => {
        activeTasks--;
        task.done();
        pumpTasks();
      });
  }
}

function requestTier(request) {
  return request.connected ? PRIORITY.foreground : PRIORITY.background;
}

function admitRequestJobs(request) {
  while (request.outstanding < MAX_OUTSTANDING_PER_REQUEST && request.pendingJobs.length) {
    const producer = request.pendingJobs.shift();
    request.outstanding++;
    if (producer.enqueued) { request.outstanding--; continue; }
    producer.enqueued = true;
    enqueueTask({
      tier: requestTier(request),
      distance: producer.descriptor.distance || 0,
      cancelled: () => producer.cancelled === true,
      run: () => runProducer(producer),
      fail: (error) => failProducer(producer, error),
      done: () => {
        request.outstanding--;
        admitRequestJobs(request);
      },
    });
  }
}

// ponytail: cache OCR trong memory của service worker — mất khi worker ngủ,
// nâng lên chrome.storage.session nếu thấy OCR lại nhiều
const ocrCache = new Map(); // key: url|srcLang|crop -> payload
const ocrInFlight = new Map();
const queue = [];
let active = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ocrImage") {
    queue.push({ msg, sendResponse });
    pump();
    return true; // giữ kênh trả lời async
  }
  if (msg.type === "translateTexts") {
    translateTexts(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "health") {
    refreshServerVersions()
      .then((d) => sendResponse({ ok: true, ...d }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "pageStatus") {
    ready.then(() => pageCache.status()).then(sendResponse).catch((error) => sendResponse({ error: String(error) }));
    return true;
  }
  if (msg.type === "prewarmJob") {
    ready.then(async () => {
      if (!serverVersions) await refreshServerVersions(false);
      const request = createRequest(null, { request_id: `prewarm:${Date.now()}`, scope: "prewarm", src_lang: msg.src_lang, dst_lang: msg.dst_lang, jobs: [msg.job || msg] });
      await attachDescriptor(request, { ...(msg.job || msg), scope: "prewarm", src_lang: msg.src_lang, dst_lang: msg.dst_lang }, { job_id: `prewarm:${Date.now()}`, state: "queued" });
      admitRequestJobs(request);
    }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    ocrImage(job.msg)
      .then((res) => job.sendResponse(res))
      .catch((e) => job.sendResponse({ ok: false, error: String(e) }))
      .finally(() => {
        active--;
        pump();
      });
  }
}

function ocrKey({ url, srcLang, crop }) {
  return `${url}|${srcLang}|${crop ? `${crop.left},${crop.top},${crop.right},${crop.bottom}` : "full"}`;
}

async function fetchOcr({ url, srcLang, crop }) {

  const imgResp = await fetch(url);
  if (!imgResp.ok) throw new Error(`fetch ảnh: HTTP ${imgResp.status}`);
  const blob = await imgResp.blob();

  const form = new FormData();
  form.append("image", blob, "page.png");
  form.append("src_lang", srcLang);
  if (crop) {
    form.append("crop_left", crop.left);
    form.append("crop_top", crop.top);
    form.append("crop_right", crop.right);
    form.append("crop_bottom", crop.bottom);
  }

  return postJson(`${SERVER}/ocr`, form);
}

async function ocrImage(msg) {
  const key = ocrKey(msg);
  try {
    if (ocrCache.has(key)) return { ok: true, ...ocrCache.get(key) };
    if (!ocrInFlight.has(key)) {
      const pending = fetchOcr(msg)
        .then((data) => {
          ocrCache.set(key, data);
          return data;
        })
        .finally(() => ocrInFlight.delete(key));
      ocrInFlight.set(key, pending);
    }
    return { ok: true, ...(await ocrInFlight.get(key)) };
  } catch (error) {
    if (!msg.prewarm) badge();
    throw error;
  }
}

// 1 call Gemini cho toàn bộ text của trang — không retry phía extension
// (translator phía server đã tự retry khi JSON lệch; 429 thì retry vô ích)
async function translateTexts({ texts, srcLang, dstLang }) {
  try {
    const data = await postJson(`${SERVER}/translate-texts`, {
      texts,
      src_lang: srcLang,
      target_lang: dstLang,
    }, 300000);
    chrome.action.setBadgeText({ text: "" }); // thành công → xóa cảnh báo
    return { ok: true, ...data };
  } catch (error) {
    badge();
    throw error;
  }
}

async function postJson(url, body, timeout = 60000) {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  let timer;
  let signal;
  if (typeof AbortController !== "undefined") {
    const controller = new AbortController();
    signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeout);
  } else if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    signal = AbortSignal.timeout(timeout);
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      body: isForm ? body : JSON.stringify(body),
      headers: isForm ? undefined : { "Content-Type": "application/json" },
      signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function badge() {
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#d33" });
}

const ports = new Set();

// Progressive work is owned here, rather than by the overlay port.  A visible
// request may disappear while its page artifact is still worth finishing.
const pageCache = typeof PageCache === "undefined" ? null : new PageCache(chrome.storage.session);
const requests = new Map();
const producers = new Map();
const analysisStages = new Map();
const ocrStages = new Map();
const hotOcr = new Map();
const hotTranslations = new Map();
const offlineJobs = [];
let serverVersions = null;

function lruSet(map, key, value, limit) {
  map.delete(key); map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

async function refreshServerVersions(resume = true) {
  const response = await fetch(`${SERVER}/health`);
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  const data = await response.json();
  serverVersions = data.versions;
  await pageCache?.purgeIncompatible(serverVersions);
  if (resume) void resumeOfflineJobs();
  return data;
}

const ready = (async () => {
  if (!pageCache) return;
  const { pages, jobs } = await pageCache.rehydrate();
  try {
    await refreshServerVersions(false);
    const byKey = new Map(pages.filter((p) => JSON.stringify(p.versions) === JSON.stringify(serverVersions)).map((p) => [p.page_artifact_key, p]));
    for (const job of jobs) if (job.scope === "visible" && (job.state === "queued" || job.state === "running")) restoreProducer(job, byKey);
    pumpTasks();
  } catch {
    for (const job of jobs) if (job.scope === "visible") offlineJobs.push(offlineLedger(job));
  }
})();

function createRequest(port, message) {
  const request = { requestId: message.request_id, scope: message.scope, srcLang: message.src_lang, dstLang: message.dst_lang, port, jobs: new Map(), jobsBySourceCrop: new Map(), pendingJobs: [], outstanding: 0, connected: true, done: new Set(), hits: 0 };
  for (const row of message.jobs || []) request.jobsBySourceCrop.set(JSON.stringify([row.source_url, canonicalCrop(row.crop)]), row);
  return request;
}
function emit(producer, type, extra = {}) {
  for (const consumer of producer.consumers.values()) if (requests.get(consumer.requestId)?.connected && consumer.port) consumer.port.postMessage({ type, request_id: consumer.requestId, job_id: consumer.jobId, page_artifact_key: producer.pageKey, ...extra });
}
function persist(producer) {
  if (!producer.persistUntilDone || !pageCache) return Promise.resolve();
  producer.persistChain = producer.persistChain.then(() => pageCache.putPage(producer.page).catch(() => { producer.page.last_error = "cache_failed"; }));
  return producer.persistChain;
}
function createProducer(descriptor, keys, page) {
  const now = Date.now();
  const record = page || { schema_version: serverVersions.page_schema, page_artifact_key: keys.pageArtifactKey, analysis_key: keys.analysisKey, ocr_key: keys.ocrKey, overlay_key: keys.overlayKey, source_url: descriptor.source_url, crop: keys.crop, natural_width: descriptor.natural_width, natural_height: descriptor.natural_height, src_lang: descriptor.src_lang, dst_lang: descriptor.dst_lang, versions: serverVersions, state: "queued", analysis_known: false, ocr_done: false, image_w: null, image_h: null, blocks: [], created_at: now, updated_at: now, last_accessed_at: now, last_error: null };
  return { pageKey: keys.pageArtifactKey, analysisKey: keys.analysisKey, ocrKey: keys.ocrKey, descriptor, page: record, consumers: new Map(), persistUntilDone: false, state: "queued", pendingTranslations: new Map(), translationBatches: 0, translationChain: Promise.resolve(), persistChain: Promise.resolve(), cancelled: false };
}
async function attachDescriptor(request, descriptor, ledger) {
  if (!serverVersions) { if (request.scope === "visible") await pageCache.putJob({ ...ledger, waiting_for_health: true }); offlineJobs.push({ request, descriptor, ledger }); return; }
  const keys = await buildKeys(descriptor, serverVersions); descriptor.page_artifact_key = keys.pageArtifactKey;
  let page = request.scope === "visible" ? await pageCache.getPage(keys.pageArtifactKey) : null;
  if (!page && request.scope === "visible") {
    const analysis = await pageCache.findPage((p) => p.analysis_key === keys.analysisKey);
    const sibling = await pageCache.findPage((p) => p.ocr_key === keys.ocrKey && p.blocks.some((b) => b.src_text));
    page = createProducer(descriptor, keys).page;
    page.analysis_known = !!analysis; page.ocr_done = sibling?.ocr_done === true;
    if (sibling) page.blocks = sibling.blocks.map(({ block_id, bbox, src_text }) => ({ block_id, bbox, src_text, trans_text: null, state: "ocr_complete" }));
    await pageCache.putPage(page);
  }
  if (page?.state === "complete") { accepted(request, descriptor, page, true); await pageCache.removeJob(descriptor.job_id); return; }
  let producer = producers.get(keys.pageArtifactKey);
  if (!producer) { producer = createProducer(descriptor, keys, page); producers.set(keys.pageArtifactKey, producer); }
  producer.consumers.set(request.requestId, { requestId: request.requestId, jobId: descriptor.job_id, port: request.port });
  if (request.scope === "visible") producer.persistUntilDone = true;
  request.jobs.set(descriptor.job_id, producer); request.pendingJobs.push(producer);
  await pageCache?.putJob({ ...ledger, page_artifact_key: keys.pageArtifactKey, waiting_for_health: false });
  accepted(request, descriptor, producer.page, false);
}
function accepted(request, descriptor, page, cacheHit) {
  request.port?.postMessage({ type: "page_job_accepted", request_id: request.requestId, job_id: descriptor.job_id, page_artifact_key: page.page_artifact_key, state: cacheHit ? "complete" : page.state });
  replayPage(request, descriptor.job_id, page, cacheHit);
}
function replayPage(request, jobId, page, cacheHit) {
  if (page.image_w) request.port?.postMessage({ type: "progress", request_id: request.requestId, job_id: jobId, image_w: page.image_w, image_h: page.image_h });
  for (const block of page.blocks) if (block.trans_text) request.port?.postMessage({ type: "translation", request_id: request.requestId, job_id: jobId, block_id: block.block_id, bbox: block.bbox, src_text: block.src_text, trans_text: block.trans_text, cache_hit: cacheHit });
  if (cacheHit) completeJob(request, jobId, page.blocks.length, 0, true);
}
async function acceptScope(port, message) {
  await ready; const request = createRequest(port, message); requests.set(request.requestId, request);
  if (!message.jobs?.length) { if (message.replaces_request_id) releaseRequest(message.replaces_request_id, request); scopeDone(request); return; }
  if (!serverVersions) try { await refreshServerVersions(false); } catch {}
  for (const row of message.jobs) { const descriptor = { ...row, src_lang: request.srcLang, dst_lang: request.dstLang, scope: request.scope }; const ledger = { job_id: descriptor.job_id, request_id: request.requestId, scope: request.scope, src_lang: request.srcLang, dst_lang: request.dstLang, descriptor, state: "queued", created_at: Date.now() }; if (request.scope === "visible") await pageCache?.putJob(ledger); await attachDescriptor(request, descriptor, ledger); }
  if (message.replaces_request_id) releaseRequest(message.replaces_request_id, request);
  admitRequestJobs(request);
}
function completeJob(request, jobId, translated, failed, hit) {
  if (!request) return;
  if (request.done.has(jobId)) return; request.done.add(jobId); if (hit) request.hits++;
  void pageCache?.removeJob(jobId);
  if (request.done.size === request.jobsBySourceCrop.size) scopeDone(request);
}
function scopeDone(request) { request.port?.postMessage({ type: "scope_done", request_id: request.requestId, images: request.done.size, translated: 0, failed: 0, cache_hit: request.done.size > 0 && request.hits === request.done.size }); requests.delete(request.requestId); }
function attachStage(map, key, producer) { let stage = map.get(key); if (!stage) { stage = { consumers: new Map(), controller: new AbortController(), promise: null }; map.set(key, stage); } stage.consumers.set(producer.pageKey, producer); return stage; }
function appendCrop(form, crop) { if (crop && crop !== "full") for (const key of ["left", "top", "right", "bottom"]) form.append(`crop_${key}`, crop[key]); }
async function openOcrStream(producer, image) { const form = new FormData(); form.append("analysis_key", producer.analysisKey); form.append("ocr_key", producer.ocrKey); form.append("src_lang", producer.descriptor.src_lang); appendCrop(form, producer.descriptor.crop); if (image) { const response = await fetch(producer.descriptor.source_url, { signal: producer.ocrStage.controller.signal }); if (!response.ok) throw new Error(`fetch image HTTP ${response.status}`); form.append("image", await response.blob(), "page.png"); } return fetch(`${SERVER}/ocr-stream`, { method: "POST", body: form, signal: producer.ocrStage.controller.signal }); }
async function consumeOcr(producer) { producer.ocrStage = attachStage(ocrStages, producer.ocrKey, producer); producer.analysisStage = attachStage(analysisStages, producer.analysisKey, producer); const stage = producer.ocrStage; if (stage.promise) return stage.promise; stage.promise = (async () => { let response = await openOcrStream(producer, !producer.page.analysis_known); if (response.status === 409) response = await openOcrStream(producer, true); if (!response.ok) throw new Error(`ocr-stream HTTP ${response.status}`); for await (const event of readNdjson(response)) { for (const item of stage.consumers.values()) { if (event.type === "analysis_ready") { item.page.analysis_known = true; item.page.image_w = event.image_w; item.page.image_h = event.image_h; emit(item, "progress", event); }
      else if (event.type === "ocr_block") await applyOcrBlock(item, event); else if (event.type === "ocr_block_error") { item.page.last_error = event.code || "ocr_block"; emit(item, "block_error", event); } else if (event.type === "image_done") item.page.ocr_done = true; }
    } })(); return stage.promise; }
function queueTranslation(producer, block) { if (block.trans_text || producer.pendingTranslations.has(block.block_id)) return; producer.pendingTranslations.set(block.block_id, block); const first = producer.translationBatches === 0, limit = first ? 3 : 8, delay = first ? 250 : 500; if (producer.pendingTranslations.size >= limit) void flushTranslations(producer); else if (!producer.translationTimer) producer.translationTimer = setTimeout(() => void flushTranslations(producer), delay); }
async function applyOcrBlock(producer, event) { const block = { block_id: event.block_id, bbox: event.bbox, src_text: event.text, trans_text: null, state: "ocr_complete" }; if (!producer.page.blocks.some((b) => b.block_id === block.block_id)) producer.page.blocks.push(block); lruSet(hotOcr, producer.ocrKey, producer.page.blocks, 256); queueTranslation(producer, block); await persist(producer); }
async function flushTranslations(producer) { producer.translationChain = producer.translationChain.then(async () => { clearTimeout(producer.translationTimer); producer.translationTimer = null; const blocks = [...producer.pendingTranslations.values()]; producer.pendingTranslations.clear(); if (!blocks.length) return; producer.translationBatches++; const data = await postJson(`${SERVER}/translate-items`, { src_lang: producer.descriptor.src_lang, dst_lang: producer.descriptor.dst_lang, items: blocks.map((b) => ({ id: b.block_id, text: b.src_text })) }, 300000); const expected = new Set(blocks.map((b) => b.block_id)), actual = new Set(data.items.map((i) => i.id)); if (actual.size !== data.items.length || actual.size !== expected.size || [...actual].some((id) => !expected.has(id))) throw new Error("translation id set mismatch"); for (const item of data.items) { lruSet(hotTranslations, `${producer.pageKey}:${item.id}`, item, 2048); const block = producer.page.blocks.find((b) => b.block_id === item.id); if (block) { block.trans_text = item.translation || item.text; block.state = "complete"; emit(producer, "translation", { ...block }); } } await persist(producer); }); return producer.translationChain; }
async function runProducer(producer) { producer.state = producer.page.state = "running"; try { if (!producer.page.ocr_done) await consumeOcr(producer); for (const block of producer.page.blocks) queueTranslation(producer, block); await flushTranslations(producer); await finishProducer(producer); } catch (error) { await failProducer(producer, error); } }
async function finishProducer(producer) { const failed = producer.page.blocks.filter((b) => !b.trans_text).length; producer.page.state = failed ? "partial" : "complete"; await persist(producer); await producer.persistChain; emit(producer, "image_done", { translated: producer.page.blocks.length - failed, failed }); for (const consumer of producer.consumers.values()) completeJob(requests.get(consumer.requestId), consumer.jobId, producer.page.blocks.length - failed, failed, false); producers.delete(producer.pageKey); }
async function failProducer(producer, error) { producer.page.last_error = String(error); producer.page.state = producer.page.blocks.length ? "partial" : "failed"; await persist(producer); emit(producer, "image_done", { translated: 0, failed: 1 }); for (const consumer of producer.consumers.values()) completeJob(requests.get(consumer.requestId), consumer.jobId, 0, 1, false); producers.delete(producer.pageKey); }
function releaseRequest(requestId, replacement = null) { const request = requests.get(requestId); if (!request) return; request.connected = false; for (const producer of request.jobs.values()) { producer.consumers.delete(requestId); const replacementJob = replacement?.jobsBySourceCrop.get(JSON.stringify([producer.descriptor.source_url, canonicalCrop(producer.descriptor.crop)])); if (replacementJob) void pageCache?.removeJob(producer.descriptor.job_id); if (!producer.consumers.size && !producer.persistUntilDone) producer.cancelled = true; } requests.delete(requestId); }
function disconnectPort(port) { ports.delete(port); for (const request of requests.values()) if (request.port === port) releaseRequest(request.requestId); }
function offlineLedger(job) { const request = createRequest(null, { request_id: job.request_id, scope: "visible", src_lang: job.src_lang, dst_lang: job.dst_lang, jobs: [job.descriptor] }); request.connected = false; return { request, descriptor: job.descriptor, ledger: job }; }
function restoreProducer(job) { offlineJobs.push(offlineLedger(job)); }
async function resumeOfflineJobs() { const jobs = offlineJobs.splice(0); for (const row of jobs) { await attachDescriptor(row.request, row.descriptor, row.ledger); admitRequestJobs(row.request); } }

function disconnectPort(port) {
  ports.delete(port);
}

if (chrome.runtime.onConnect && chrome.runtime.onConnect.addListener) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "translation") return;
    ports.add(port);
    port.onMessage.addListener((message) => {
      if (message.type === "start_scope") {
        Promise.resolve()
          .then(() => acceptScope(port, message))
          .catch((error) => {
            port.postMessage({
              type: "scope_error",
              request_id: message.request_id,
              code: typeof CacheFullError !== "undefined" && error instanceof CacheFullError
                ? "cache_full" : "request_failed",
              error: String(error),
            });
          });
      }
      if (message.type === "cancel_request") releaseRequest(message.request_id);
    });
    port.onDisconnect.addListener(() => disconnectPort(port));
  });
}
