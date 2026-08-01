if (typeof importScripts === "function") importScripts("page-cache.js");

const SERVER = "http://127.0.0.1:8910";
const MAX_CONCURRENT = 2;
const MAX_OUTSTANDING_PER_REQUEST = 4;
const PRIORITY = Object.freeze({ foreground: 0, background: 1, prewarm: 2 });
const metricSamples = [];
const metricSamplesByRequest = new Map();

function now() { return typeof performance === "undefined" ? Date.now() : performance.now(); }
function mark(producer, name) { producer.timings[name] ??= now(); }
function emptyPageMetrics() {
  return {
    queue_wait_ms: null, fetch_ms: null, analysis_ms: null, analysis_cache_hit: null,
    first_ocr_ms: null, ocr_done_ms: null, first_translation_ms: null,
    final_translation_ms: null, first_overlay_ms: null, accepted_offset_ms: null, total_ms: null,
    recognized: null, failed: null, translation_batches: [],
  };
}
function producerMetrics(producer) {
  const elapsed = (name) => producer.timings[name] == null
    ? null : Math.round(producer.timings[name] - producer.timings.accepted);
  return {
    queue_wait_ms: elapsed("started"),
    fetch_ms: Number.isFinite(producer.durations.fetch_ms) ? Math.round(producer.durations.fetch_ms) : null,
    analysis_ms: Number.isFinite(producer.durations.analysis_ms) ? Math.round(producer.durations.analysis_ms) : null,
    analysis_cache_hit: producer.analysisCacheHit,
    first_ocr_ms: elapsed("first_ocr"),
    ocr_done_ms: elapsed("ocr_done"),
    first_translation_ms: elapsed("first_translation"),
    final_translation_ms: elapsed("final_translation"),
    total_ms: Math.round(now() - producer.timings.accepted),
    recognized: producer.ocrSummary?.recognized ?? null,
    failed: producer.ocrSummary?.failed ?? null,
    translation_batches: producer.translationBatchTrace.map((batch) => ({ ...batch, block_ids: [...batch.block_ids] })),
  };
}
function recordMetrics(requestId, sample) {
  const pageMetrics = sample.page_metrics?.map(({ translation_batches = [], ...row }) => ({ ...row, translation_batches: translation_batches.map((batch) => ({ ...batch, block_ids: [...batch.block_ids] })) }));
  const recorded = pageMetrics ? { ...sample, page_metrics: pageMetrics } : sample;
  metricSamples.push(recorded);
  metricSamplesByRequest.set(requestId, recorded);
  if (metricSamples.length > 100) {
    const removed = metricSamples.shift();
    for (const [id, row] of metricSamplesByRequest) if (row === removed) metricSamplesByRequest.delete(id);
  }
}
function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}
function benchmarkSummary() {
  const summary = Object.fromEntries(
    ["first_overlay_ms", "first_translation_ms", "total_ms", "cancel_latency_ms"].map((field) => {
      const values = metricSamples.map((row) => row[field]).filter(Number.isFinite);
      return [field, { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }];
    })
  );
  summary.counters = Object.fromEntries(
    ["translation_calls", "rate_limited", "stale_work"].map((field) => {
      const records = new Set(metricSamples.flatMap((row) => [...(row.counter_records || [])]));
      return [field, [...records].reduce((total, record) => total + (record[field] || 0), 0)];
    })
  );
  return summary;
}

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
    let running;
    try { running = task.run(); }
    catch (error) { running = Promise.reject(error); }
    Promise.resolve(running)
      .catch(task.fail)
      .finally(() => {
        activeTasks--;
        task.done();
        pumpTasks();
      });
  }
}

function requestTier(request) {
  if (request.scope === "prewarm") return PRIORITY.prewarm;
  return request.connected ? PRIORITY.foreground : PRIORITY.background;
}

function admitRequestJobs(request) {
  while (request.outstanding < MAX_OUTSTANDING_PER_REQUEST && request.pendingJobs.length) {
    const producer = request.pendingJobs.shift();
    request.outstanding++;
    if (producer.enqueued) { request.outstanding--; continue; }
    producer.enqueued = true;
    enqueueTask({
      producer,
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
const ocrInFlight = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ocrImage") {
    enqueueTask({
      tier: msg.prewarm ? PRIORITY.prewarm : PRIORITY.background,
      cancelled: () => false,
      run: () => ocrImage(msg).then(sendResponse),
      fail: (error) => sendResponse({ ok: false, error: String(error) }),
      done() {},
    });
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
  if (msg.type === "benchmarkSummary") {
    sendResponse(benchmarkSummary());
    return;
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
  const key = `legacy:${ocrKey(msg)}`;
  try {
    if (hotOcr.has(key)) return { ok: true, ...hotOcr.get(key) };
    if (!ocrInFlight.has(key)) {
      const pending = fetchOcr(msg)
        .then((data) => {
          lruSet(hotOcr, key, data, 256);
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
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
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
    const byKey = new Map(pages.filter((p) => metadataEqual(p.versions, serverVersions)).map((p) => [p.page_artifact_key, p]));
    for (const job of jobs) if (job.scope === "visible" && (job.state === "queued" || job.state === "running")) restoreProducer(job, byKey);
    await resumeOfflineJobs();
    pumpTasks();
  } catch {
    for (const job of jobs) if (job.scope === "visible") offlineJobs.push(offlineLedger(job));
  }
})();

function sourceCropKey(descriptor) {
  return JSON.stringify([descriptor.source_url, canonicalCrop(descriptor.crop)]);
}
function consumerKey(requestId, jobId) {
  return JSON.stringify([requestId, jobId]);
}

function createRequest(port, message) {
  const request = { requestId: message.request_id, scope: message.scope, srcLang: message.src_lang, dstLang: message.dst_lang, port, jobs: new Map(), jobsBySourceCrop: new Map(), expectedJobIds: new Set((message.jobs || []).map((row) => row.job_id)), pendingJobs: [], outstanding: 0, connected: true, done: new Set(), hits: 0, translated: 0, failed: 0, acceptedAt: now(), firstOverlayMs: null, firstOverlayByJob: new Map(), metricRows: [], counters: { translation_calls: 0, rate_limited: 0, stale_work: 0 }, countedCounterProducers: new Set(), cancelLatencyMs: null };
  for (const row of message.jobs || []) request.jobsBySourceCrop.set(sourceCropKey(row), row);
  return request;
}
function emit(producer, type, extra = {}) {
  for (const consumer of producer.consumers.values()) if (requests.get(consumer.requestId)?.connected && consumer.port) consumer.port.postMessage({ ...extra, type, request_id: consumer.requestId, job_id: consumer.jobId, page_artifact_key: producer.pageKey });
}
function persist(producer) {
  if (!producer.persistUntilDone || !pageCache) return Promise.resolve();
  producer.persistChain = producer.persistChain.then(() => pageCache.putPage(producer.page).catch(() => { producer.page.last_error = "cache_failed"; }));
  return producer.persistChain;
}
function createProducer(descriptor, keys, page) {
  const createdAt = Date.now();
  const record = page || { schema_version: serverVersions.page_schema, page_artifact_key: keys.pageArtifactKey, analysis_key: keys.analysisKey, ocr_key: keys.ocrKey, overlay_key: keys.overlayKey, source_url: descriptor.source_url, crop: keys.crop, natural_width: descriptor.natural_width, natural_height: descriptor.natural_height, src_lang: descriptor.src_lang, dst_lang: descriptor.dst_lang, versions: serverVersions, state: "queued", analysis_known: false, ocr_done: false, image_w: null, image_h: null, blocks: [], created_at: createdAt, updated_at: createdAt, last_accessed_at: createdAt, last_error: null };
  return { pageKey: keys.pageArtifactKey, analysisKey: keys.analysisKey, ocrKey: keys.ocrKey, descriptor, page: record, consumers: new Map(), jobIds: new Set(), persistUntilDone: false, prewarmOnly: descriptor.scope === "prewarm", state: "queued", pendingTranslations: new Map(), attemptedTranslationIds: new Set(), translationBatches: 0, translationBatchTrace: [], translationChain: Promise.resolve(), persistChain: Promise.resolve(), cancelled: false, retired: false, timings: { accepted: now() }, durations: { fetch_ms: null, analysis_ms: null }, analysisCacheHit: null, ocrSummary: null, counters: { translation_calls: 0, rate_limited: 0, stale_work: 0 } };
}
async function attachDescriptor(request, descriptor, ledger) {
  if (!serverVersions) { if (request.scope === "visible") await pageCache.putJob({ ...ledger, waiting_for_health: true }); offlineJobs.push({ request, descriptor, ledger }); return; }
  const keys = await buildKeys(descriptor, serverVersions); descriptor.page_artifact_key = keys.pageArtifactKey;
  request.jobsBySourceCrop.set(sourceCropKey(descriptor), descriptor);
  if (request.scope === "prewarm" && await pageCache?.findPage((p) => p.ocr_key === keys.ocrKey && p.ocr_done === true)) return;
  let page = request.scope === "visible" ? await pageCache.getPage(keys.pageArtifactKey) : null;
  if (!page && request.scope === "visible") {
    const analysis = await pageCache.findPage(
      (p) => p.analysis_key === keys.analysisKey && p.analysis_known === true
    );
    const sibling = await pageCache.findPage((p) => p.ocr_key === keys.ocrKey && p.ocr_done === true);
    page = createProducer(descriptor, keys).page;
    page.analysis_known = !!analysis; page.ocr_done = sibling?.ocr_done === true;
    if (analysis) { page.image_w = analysis.image_w; page.image_h = analysis.image_h; }
    if (sibling) page.blocks = sibling.blocks.map(({ block_id, bbox, src_text }) => ({ block_id, bbox, src_text, trans_text: null, state: "ocr_complete" }));
    await pageCache.putPage(page);
  }
  if (page?.state === "complete") { accepted(request, descriptor, page, true); await pageCache.removeJob(descriptor.job_id); return; }
  let producer = producers.get(keys.pageArtifactKey);
  if (!producer) { producer = createProducer(descriptor, keys, page); producers.set(keys.pageArtifactKey, producer); }
  if (!producer.page.ocr_done) {
    producer.ocrStage = attachStage(ocrStages, producer.ocrKey, producer);
    producer.analysisStage = attachStage(analysisStages, producer.analysisKey, producer);
  }
  producer.consumers.set(consumerKey(request.requestId, descriptor.job_id), { requestId: request.requestId, jobId: descriptor.job_id, port: request.port });
  producer.jobIds.add(descriptor.job_id);
  if (request.scope !== "prewarm") producer.prewarmOnly = false;
  if (request.scope === "visible") producer.persistUntilDone = true;
  request.jobs.set(descriptor.job_id, producer); request.pendingJobs.push(producer);
  if (request.scope === "visible") {
    await pageCache?.putJob({ ...ledger, page_artifact_key: keys.pageArtifactKey, waiting_for_health: false });
  }
  accepted(request, descriptor, producer.page, false);
}
function accepted(request, descriptor, page, cacheHit) {
  request.port?.postMessage({ type: "page_job_accepted", request_id: request.requestId, job_id: descriptor.job_id, page_artifact_key: page.page_artifact_key, state: cacheHit ? "complete" : page.state });
  replayPage(request, descriptor.job_id, page, cacheHit);
}
function replayPage(request, jobId, page, cacheHit) {
  if (page.image_w) request.port?.postMessage({ type: "progress", request_id: request.requestId, job_id: jobId, image_w: page.image_w, image_h: page.image_h });
  for (const block of page.blocks) if (block.trans_text) request.port?.postMessage({ type: "translation", request_id: request.requestId, job_id: jobId, block_id: block.block_id, bbox: block.bbox, src_text: block.src_text, trans_text: block.trans_text, image_w: page.image_w, image_h: page.image_h, cache_hit: cacheHit });
  if (cacheHit) completeJob(request, jobId, page.blocks.length, 0, true, { recognized: page.blocks.length, failed: 0 }, null, null, { pageKey: page.page_artifact_key });
}
async function acceptScope(port, message) {
  await ready; const request = createRequest(port, message); requests.set(request.requestId, request);
  if (!message.jobs?.length) { if (message.replaces_request_id) releaseRequest(message.replaces_request_id, request); scopeDone(request); return; }
  if (!serverVersions) try { await refreshServerVersions(false); } catch {}
  for (const row of message.jobs) { const descriptor = { ...row, src_lang: request.srcLang, dst_lang: request.dstLang, scope: request.scope }; const ledger = { job_id: descriptor.job_id, request_id: request.requestId, scope: request.scope, src_lang: request.srcLang, dst_lang: request.dstLang, descriptor, state: "queued", created_at: Date.now() }; try { if (request.scope === "visible") await pageCache?.putJob(ledger); await attachDescriptor(request, descriptor, ledger); } catch (error) { const code = typeof CacheFullError !== "undefined" && error instanceof CacheFullError ? "cache_full" : "request_failed"; port?.postMessage({ type: "job_error", request_id: request.requestId, job_id: descriptor.job_id, code, error: String(error) }); completeJob(request, descriptor.job_id, 0, 1, false, null, null, null, { pageKey: descriptor.page_artifact_key, errorCode: code }); } }
  if (message.replaces_request_id) releaseRequest(message.replaces_request_id, request);
  admitRequestJobs(request);
}
function completeJob(request, jobId, translated, failed, hit, metrics = null, counters = null, counterProducer = null, meta = {}) {
  if (!request) return;
  if (request.done.has(jobId)) return; request.done.add(jobId); request.translated += translated; request.failed += failed; if (hit) request.hits++;
  request.metricRows.push({ job_id: jobId, page_artifact_key: meta.pageKey ?? null, cache_hit: hit, error_code: meta.errorCode ?? null, ...emptyPageMetrics(), ...(metrics || {}), first_overlay_ms: request.firstOverlayByJob.get(jobId) ?? null, accepted_offset_ms: Number.isFinite(meta.acceptedAt) ? Math.round(meta.acceptedAt - request.acceptedAt) : null });
  if (counters && !request.countedCounterProducers.has(counterProducer)) {
    request.countedCounterProducers.add(counterProducer);
    for (const key of Object.keys(request.counters)) request.counters[key] += counters[key] || 0;
  }
  void pageCache?.removeJob(jobId);
  if (request.done.size === request.expectedJobIds.size) scopeDone(request);
}
function scopeMetrics(request) {
  const rows = request.metricRows;
  const value = (field, fallback = null) => {
    const values = rows.map((row) => row[field]).filter(Number.isFinite);
    return values.length ? Math.max(...values) : fallback;
  };
  return {
    queue_wait_ms: value("queue_wait_ms"), fetch_ms: value("fetch_ms", 0),
    analysis_ms: value("analysis_ms", 0), first_ocr_ms: value("first_ocr_ms"), ocr_done_ms: value("ocr_done_ms"),
    first_translation_ms: value("first_translation_ms"), final_translation_ms: value("final_translation_ms"), first_overlay_ms: request.firstOverlayMs, total_ms: Math.round(now() - request.acceptedAt),
  };
}
function scopeDone(request) {
  const metrics = scopeMetrics(request);
  recordMetrics(request.requestId, { ...metrics, cancel_latency_ms: request.cancelLatencyMs, page_metrics: request.metricRows, counter_records: new Set([...request.countedCounterProducers].map((producer) => producer.counters)) });
  request.port?.postMessage({ type: "scope_done", request_id: request.requestId, images: request.done.size, translated: request.translated, failed: request.failed, cache_hit: request.done.size > 0 && request.hits === request.done.size, metrics, page_metrics: request.metricRows });
  requests.delete(request.requestId);
}
function resetAnalysisDeferred(stage) {
  stage.ready = new Promise((resolve, reject) => {
    stage.resolve = resolve;
    stage.reject = reject;
  });
  stage.ready.catch(() => {});
  stage.failed = false;
}
function attachStage(map, key, producer) {
  let stage = map.get(key);
  if (!stage) {
    stage = { key, consumers: new Map(), controller: new AbortController(), promise: null };
    if (map === analysisStages) {
      stage.owner = null;
      stage.complete = false;
      resetAnalysisDeferred(stage);
    } else if (map === ocrStages) {
      stage.ocrDone = false;
      stage.blocks = new Map();
      stage.blockErrors = [];
    }
    map.set(key, stage);
  }
  if (map === analysisStages && stage.complete) {
    producer.page.analysis_known = true;
    producer.page.image_w = stage.event?.image_w ?? producer.page.image_w;
    producer.page.image_h = stage.event?.image_h ?? producer.page.image_h;
    if (Number.isFinite(stage.event?.analysis_ms)) producer.durations.analysis_ms = stage.event.analysis_ms;
    if (typeof stage.event?.analysis_cache_hit === "boolean") producer.analysisCacheHit = stage.event.analysis_cache_hit;
  } else if (map === ocrStages) {
    for (const block of stage.blocks.values()) {
      if (!producer.page.blocks.some((row) => row.block_id === block.block_id)) {
        producer.page.blocks.push({ ...block });
      }
    }
    producer.blockErrors = Math.max(producer.blockErrors || 0, stage.blockErrors.length);
    if (stage.blockErrors.length) producer.page.last_error = stage.blockErrors[stage.blockErrors.length - 1].code || "ocr_block";
    if (stage.blocks.size) mark(producer, "first_ocr");
    if (stage.ocrDone) {
      producer.page.ocr_done = true;
      producer.ocrSummary = stage.ocrSummary || null;
      mark(producer, "ocr_done");
    }
  }
  stage.consumers.set(producer.pageKey, producer);
  return stage;
}
function appendCrop(form, crop) { if (crop && crop !== "full") for (const key of ["left", "top", "right", "bottom"]) form.append(`crop_${key}`, crop[key]); }
async function openOcrStream(producer, image) { const form = new FormData(); form.append("analysis_key", producer.analysisKey); form.append("ocr_key", producer.ocrKey); form.append("src_lang", producer.descriptor.src_lang); appendCrop(form, producer.descriptor.crop); if (image) { const started = now(); const response = await fetch(producer.descriptor.source_url, { signal: producer.ocrStage.controller.signal }); producer.durations.fetch_ms += now() - started; if (!response.ok) throw new Error(`fetch image HTTP ${response.status}`); form.append("image", await response.blob(), "page.png"); } return fetch(`${SERVER}/ocr-stream`, { method: "POST", body: form, signal: producer.ocrStage.controller.signal }); }
async function needsAnalysisImage(producer, analysis) {
  if (producer.page.analysis_known || analysis.complete) return false;
  while (analysis.owner && analysis.owner !== producer.ocrKey) {
    try {
      await analysis.ready;
      return false;
    } catch {
      // The failed owner released the claim; this producer may become the cold owner.
    }
  }
  if (!analysis.owner) {
    if (analysis.failed) resetAnalysisDeferred(analysis);
    analysis.owner = producer.ocrKey;
  }
  return analysis.owner === producer.ocrKey;
}
function resolveAnalysisStage(stage, event) {
  if (stage.complete) return;
  stage.complete = true;
  stage.event = event;
  stage.resolve(event);
}
function rejectAnalysisStage(stage, error, owner) {
  if (stage.complete || stage.owner !== owner) return;
  stage.owner = null;
  stage.failed = true;
  stage.reject(error);
}
async function consumeOcr(producer) {
  producer.ocrStage = attachStage(ocrStages, producer.ocrKey, producer);
  producer.analysisStage = attachStage(analysisStages, producer.analysisKey, producer);
  const stage = producer.ocrStage;
  if (stage.promise) {
    await stage.promise;
    if (producer.analysisStage.complete && !producer.page.analysis_known) {
      const event = producer.analysisStage.event;
      producer.page.analysis_known = true;
      producer.page.image_w = event?.image_w ?? producer.page.image_w;
      producer.page.image_h = event?.image_h ?? producer.page.image_h;
      if (event) emit(producer, "progress", event);
    }
    if (stage.ocrDone) producer.page.ocr_done = true;
    return;
  }
  stage.promise = (async () => {
    const analysis = producer.analysisStage;
    let includeImage = await needsAnalysisImage(producer, analysis);
    try {
      let response = await openOcrStream(producer, includeImage);
      if (response.status === 409 && !producer.retriedAnalysis) {
        producer.retriedAnalysis = true;
        if (!analysis.owner) {
          if (analysis.failed) resetAnalysisDeferred(analysis);
          analysis.owner = producer.ocrKey;
        }
        includeImage = true;
        response = await openOcrStream(producer, true);
      }
      if (!response.ok) throw new Error(`ocr-stream HTTP ${response.status}`);
      for await (const event of readNdjson(response)) {
        if (event.type === "job_error") throw new Error(`${event.stage}:${event.code}`);
        if (event.type === "analysis_ready") {
          if (Number.isFinite(event.analysis_ms)) producer.durations.analysis_ms = event.analysis_ms;
          if (typeof event.analysis_cache_hit === "boolean") producer.analysisCacheHit = event.analysis_cache_hit;
          resolveAnalysisStage(analysis, event);
          for (const item of stage.consumers.values()) {
            item.page.analysis_known = true;
            item.page.image_w = event.image_w;
            item.page.image_h = event.image_h;
            if (Number.isFinite(event.analysis_ms)) item.durations.analysis_ms = event.analysis_ms;
            if (typeof event.analysis_cache_hit === "boolean") item.analysisCacheHit = event.analysis_cache_hit;
            emit(item, "progress", event);
          }
          if (stage.cancelAfterAnalysis && !stage.consumers.size) {
            stage.controller.abort();
            ocrStages.delete(stage.key);
            return;
          }
          continue;
        }
        if (event.type === "ocr_block") { stage.blocks.set(event.block_id, ocrBlockFromEvent(event)); }
        if (event.type === "ocr_block_error") stage.blockErrors.push(event);
        for (const item of stage.consumers.values()) {
          if (event.type === "ocr_block") await applyOcrBlock(item, event);
          else if (event.type === "ocr_block_error") {
            item.blockErrors = (item.blockErrors || 0) + 1;
            item.page.last_error = event.code || "ocr_block";
            emit(item, "block_error", event);
          } else if (event.type === "image_done") {
            stage.ocrDone = true;
            stage.ocrSummary = {
              recognized: Number.isFinite(event.recognized) ? event.recognized : stage.blocks.size,
              failed: Number.isFinite(event.failed) ? event.failed : stage.blockErrors.length,
            };
            item.page.ocr_done = true;
            item.ocrSummary = stage.ocrSummary;
            mark(item, "ocr_done");
          }
        }
        if (stage.cancelAfterCurrentBlock && !stage.consumers.size) return;
      }
    } catch (error) {
      rejectAnalysisStage(analysis, error, producer.ocrKey);
      throw error;
    }
  })();
  return stage.promise;
}
function queueTranslation(producer, block) { if (producer.prewarmOnly || producer.retired || block.trans_text || producer.attemptedTranslationIds.has(block.block_id) || producer.pendingTranslations.has(block.block_id)) return; producer.pendingTranslations.set(block.block_id, block); const first = producer.translationBatches === 0, limit = first ? 3 : 8, delay = first ? 250 : 500; if (producer.pendingTranslations.size >= limit) void flushTranslations(producer); else if (!producer.translationTimer) producer.translationTimer = setTimeout(() => void flushTranslations(producer), delay); }
function ocrBlockFromEvent(event) { return { block_id: event.block_id, bbox: event.bbox, src_text: event.src_text ?? event.text, trans_text: null, state: "ocr_complete" }; }
async function applyOcrBlock(producer, event) { const block = ocrBlockFromEvent(event); mark(producer, "first_ocr"); if (!producer.page.blocks.some((b) => b.block_id === block.block_id)) producer.page.blocks.push(block); lruSet(hotOcr, producer.ocrKey, producer.page.blocks, 256); queueTranslation(producer, block); await persist(producer); }
async function translationKeyForBatch(producer, blocks, block) {
  const contextHash = await hashValue(blocks.map((row) => ({ blockId: row.block_id, srcText: row.src_text })));
  return hashValue([
    producer.ocrKey,
    block.block_id,
    await hashValue(block.src_text),
    contextHash,
    producer.descriptor.dst_lang,
    producer.page.versions.translator_model,
    producer.page.versions.prompt,
    producer.page.versions.policy,
  ]);
}
function applyTranslation(producer, item) {
  const block = producer.page.blocks.find((row) => row.block_id === item.id);
  if (!block) return;
  block.trans_text = item.translation || item.text;
  mark(producer, "first_translation");
  producer.timings.final_translation = now();
  block.state = "complete";
  emit(producer, "translation", { ...block, image_w: producer.page.image_w, image_h: producer.page.image_h });
}
function isRateLimited(error) { return error.status === 429 || String(error).includes("429"); }
async function flushTranslationBatch(producer) {
  clearTimeout(producer.translationTimer);
  producer.translationTimer = null;
  const blocks = [...producer.pendingTranslations.values()];
  producer.pendingTranslations.clear();
  if (!blocks.length) return;
  for (const block of blocks) producer.attemptedTranslationIds.add(block.block_id);
  producer.translationBatches++;
  try {
    const keyed = await Promise.all(blocks.map(async (block) => ({
      block,
      key: await translationKeyForBatch(producer, blocks, block),
    })));
    const cached = keyed.map(({ key }) => hotTranslations.get(key));
    if (cached.every(Boolean)) {
      if (!producer.retired) for (const item of cached) applyTranslation(producer, item);
      await persist(producer);
      return;
    }
    producer.counters.translation_calls++;
    const started = now();
    const trace = { batch_id: producer.translationBatches, phase: "microbatch", block_ids: blocks.map((block) => block.block_id), block_count: blocks.length, started_ms: Math.round(started - producer.timings.accepted), duration_ms: null, status: null, cache_hit: false, error_code: null };
    producer.translationBatchTrace.push(trace);
    let data;
    try {
      data = await postJson(`${SERVER}/translate-items`, {
        src_lang: producer.descriptor.src_lang,
        dst_lang: producer.descriptor.dst_lang,
        items: blocks.map((block) => ({ id: block.block_id, text: block.src_text })),
      }, 300000);
      const expected = new Set(blocks.map((block) => block.block_id));
      const actual = new Set(data.items.map((item) => item.id));
      if (actual.size !== data.items.length || actual.size !== expected.size || [...actual].some((id) => !expected.has(id))) throw new Error("translation id set mismatch");
      trace.status = "success";
    } catch (error) {
      trace.status = isRateLimited(error) ? "rate_limited" : String(error).includes("translation id set mismatch") ? "invalid_response" : "failed";
      trace.error_code = trace.status === "rate_limited" ? "rate_limited" : trace.status === "invalid_response" ? "invalid_response" : "translation_failed";
      throw error;
    } finally {
      trace.duration_ms = Math.max(0, Math.round(now() - started));
    }
    for (const item of data.items) {
      const key = keyed.find(({ block }) => block.block_id === item.id).key;
      lruSet(hotTranslations, key, item, 2048);
      if (!producer.retired) applyTranslation(producer, item);
    }
  } catch (error) {
    if (isRateLimited(error)) producer.counters.rate_limited++;
    if (producer.retired) return;
    producer.page.last_error = String(error);
    for (const block of blocks) {
      block.state = "translation_failed";
      emit(producer, "block_error", { block_id: block.block_id, stage: "translation", code: "translation_failed" });
    }
  }
  await persist(producer);
}
async function flushTranslations(producer) {
  producer.translationChain = producer.translationChain.then(() => flushTranslationBatch(producer));
  return producer.translationChain;
}
async function runProducer(producer) { mark(producer, "started"); producer.state = producer.page.state = "running"; try { if (!producer.page.ocr_done) await consumeOcr(producer); if (producer.retired) return; if (producer.prewarmOnly) { releaseProducerStages(producer); producers.delete(producer.pageKey); producer.jobIds.clear(); return; } for (const block of producer.page.blocks) queueTranslation(producer, block); await flushTranslations(producer); if (!producer.retired) await finishProducer(producer); } catch (error) { if (!producer.retired) await failProducer(producer, error); } }
async function removeProducerJobs(producer) {
  await Promise.all([...producer.jobIds].map((jobId) => pageCache?.removeJob(jobId)));
  producer.jobIds.clear();
}
async function finishProducer(producer) { const failed = producer.page.blocks.filter((b) => !b.trans_text).length; producer.page.state = failed || producer.blockErrors ? "partial" : "complete"; await persist(producer); await producer.persistChain; emit(producer, "image_done", { translated: producer.page.blocks.length - failed, failed: failed + (producer.blockErrors || 0) }); const metrics = producerMetrics(producer); for (const consumer of producer.consumers.values()) completeJob(requests.get(consumer.requestId), consumer.jobId, producer.page.blocks.length - failed, failed + (producer.blockErrors || 0), false, metrics, producer.counters, producer, { pageKey: producer.pageKey, acceptedAt: producer.timings.accepted }); await removeProducerJobs(producer); releaseProducerStages(producer); producers.delete(producer.pageKey); }
async function failProducer(producer, error) { producer.page.last_error = String(error); producer.page.state = producer.page.analysis_known || producer.page.blocks.length ? "partial" : "failed"; await persist(producer); emit(producer, "image_done", { translated: 0, failed: 1 }); const metrics = producerMetrics(producer); for (const consumer of producer.consumers.values()) completeJob(requests.get(consumer.requestId), consumer.jobId, 0, 1, false, metrics, producer.counters, producer, { pageKey: producer.pageKey, errorCode: "request_failed", acceptedAt: producer.timings.accepted }); await removeProducerJobs(producer); releaseProducerStages(producer); producers.delete(producer.pageKey); }
function removeQueuedTasks(producer) { for (const task of taskQueue) if (task.producer === producer) task.cancelled = () => true; }
function demoteQueuedTasks(producer) {
  for (const task of taskQueue) if (task.producer === producer) task.tier = PRIORITY.background;
  taskQueue.sort(compareTasks);
}
function releaseStage(map, key, pageKey) { const stage = map.get(key); if (!stage) return; stage.consumers.delete(pageKey); if (!stage.consumers.size) { stage.controller.abort(); map.delete(key); } }
function releaseOcrConsumer(producer) {
  const stage = ocrStages.get(producer.ocrKey);
  if (!stage) return;
  stage.consumers.delete(producer.pageKey);
  if (stage.consumers.size) return;
  const analysis = analysisStages.get(producer.analysisKey);
  const hasOtherAnalysisConsumer = analysis && [...analysis.consumers.keys()]
    .some((pageKey) => pageKey !== producer.pageKey);
  if (analysis?.owner === producer.ocrKey && !analysis.complete && hasOtherAnalysisConsumer) {
    stage.cancelAfterAnalysis = true;
    return;
  }
  stage.cancelAfterCurrentBlock = true;
  stage.controller.abort();
  ocrStages.delete(producer.ocrKey);
}
function releaseProducerStages(producer) {
  releaseOcrConsumer(producer);
  releaseStage(analysisStages, producer.analysisKey, producer.pageKey);
}
function retireProducer(producer) {
  if (producer.retired) return;
  const persistArtifact = producer.persistUntilDone;
  producer.retired = true;
  producer.counters.stale_work++;
  producer.cancelled = true;
  producer.persistUntilDone = false;
  clearTimeout(producer.translationTimer);
  producer.translationTimer = null;
  producer.pendingTranslations.clear();
  removeQueuedTasks(producer);
  releaseProducerStages(producer);
  if (producers.get(producer.pageKey) === producer) producers.delete(producer.pageKey);
  if (pageCache && persistArtifact) {
    const useful = producer.page.analysis_known || producer.page.blocks.length;
    void producer.persistChain.then(() => useful
      ? pageCache.putPage({ ...producer.page, state: "partial" })
      : pageCache.removePage(producer.pageKey))
      .catch(() => {})
      .finally(() => removeProducerJobs(producer));
  } else {
    producer.jobIds.clear();
  }
}
function releaseRequest(requestId, replacement = null) {
  const request = requests.get(requestId);
  if (!request) return;
  const cancelStartedAt = now();
  request.connected = false;
  const releasedProducers = new Set(request.jobs.values());
  for (const producer of releasedProducers) {
    const releasedConsumers = [];
    for (const [key, consumer] of producer.consumers) {
      if (consumer.requestId !== requestId) continue;
      releasedConsumers.push(consumer);
      producer.consumers.delete(key);
    }
    const replacementDescriptor = replacement?.jobsBySourceCrop.get(sourceCropKey(producer.descriptor));
    const exactReplacement = replacementDescriptor?.page_artifact_key === producer.pageKey;
    if (replacementDescriptor) for (const consumer of releasedConsumers) void pageCache?.removeJob(consumer.jobId);
    if (exactReplacement) continue;
    if (replacementDescriptor) {
      if (!producer.consumers.size) retireProducer(producer);
      continue;
    }
    if (request.scope === "visible") {
      if (!producer.consumers.size) demoteQueuedTasks(producer);
      continue;
    }
    if (!producer.consumers.size) retireProducer(producer);
  }
  for (let index = offlineJobs.length - 1; index >= 0; index--) {
    const row = offlineJobs[index];
    if (row.request.requestId !== requestId) continue;
    const replaced = replacement?.jobsBySourceCrop.has(sourceCropKey(row.descriptor));
    if (request.scope === "visible" && !replaced) continue;
    offlineJobs.splice(index, 1);
    void pageCache?.removeJob(row.descriptor.job_id);
  }
  request.cancelLatencyMs = Math.round(now() - cancelStartedAt);
  recordMetrics(request.requestId, { ...scopeMetrics(request), cancel_latency_ms: request.cancelLatencyMs, page_metrics: request.metricRows, counter_records: new Set([...request.countedCounterProducers, ...releasedProducers].map((producer) => producer.counters)) });
  requests.delete(requestId);
}
function disconnectPort(port) { ports.delete(port); for (const request of requests.values()) if (request.port === port) releaseRequest(request.requestId); }
function offlineLedger(job) { const request = createRequest(null, { request_id: job.request_id, scope: "visible", src_lang: job.src_lang, dst_lang: job.dst_lang, jobs: [job.descriptor] }); request.connected = false; requests.set(request.requestId, request); return { request, descriptor: job.descriptor, ledger: job }; }
function restoreProducer(job) { offlineJobs.push(offlineLedger(job)); }
async function resumeOfflineJobs() { const jobs = offlineJobs.splice(0); for (const row of jobs) { await attachDescriptor(row.request, row.descriptor, row.ledger); admitRequestJobs(row.request); } }

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
      if (message.type === "render_metric") {
        const request = requests.get(message.request_id);
        if (!Number.isFinite(message.first_overlay_ms) || !message.job_id) return;
        if (request) {
          if (!request.expectedJobIds.has(message.job_id)) return;
          const previous = request.firstOverlayByJob.get(message.job_id);
          const firstOverlayMs = previous == null ? message.first_overlay_ms : Math.min(previous, message.first_overlay_ms);
          request.firstOverlayByJob.set(message.job_id, firstOverlayMs);
          request.firstOverlayMs = request.firstOverlayMs == null ? firstOverlayMs : Math.min(request.firstOverlayMs, firstOverlayMs);
          const row = request.metricRows.find((metric) => metric.job_id === message.job_id);
          if (row) row.first_overlay_ms = firstOverlayMs;
        }
        else {
          const sample = metricSamplesByRequest.get(message.request_id);
          const row = sample?.page_metrics?.find((metric) => metric.job_id === message.job_id);
          if (!row) return;
          row.first_overlay_ms = Number.isFinite(row.first_overlay_ms) ? Math.min(row.first_overlay_ms, message.first_overlay_ms) : message.first_overlay_ms;
          sample.first_overlay_ms = Number.isFinite(sample.first_overlay_ms) ? Math.min(sample.first_overlay_ms, row.first_overlay_ms) : row.first_overlay_ms;
        }
      }
    });
    port.onDisconnect.addListener(() => disconnectPort(port));
  });
}
