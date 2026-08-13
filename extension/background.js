if (typeof importScripts === "function") {
  importScripts("page-cache.js", "reading-order.js", "source-fetch.js");
}

const SERVER = "http://127.0.0.1:8910";
const MAX_CONCURRENT = 2;
const MAX_SOURCE_FETCH = 2;
const MAX_OUTSTANDING_PER_REQUEST = 4;
const LAYOUT_FIT_VERSION = "dom-fit-10px-v1";
const PRIORITY = Object.freeze({ foreground: 0, background: 1, prewarm: 2 });
const metricSamples = [];
const metricSamplesByRequest = new Map();

function now() { return typeof performance === "undefined" ? Date.now() : performance.now(); }
function mark(producer, name) { producer.timings[name] ??= now(); }
function emptyPageMetrics() {
  return {
    overlay_semantics: "atomic_patch_v1", partial_replay: false, cache_hit: false,
    queue_wait_ms: null, fetch_ms: null, analysis_ms: null, analysis_cache_hit: null,
    first_ocr_ms: null, ocr_done_ms: null, first_translation_ms: null,
    final_translation_ms: null, first_overlay_ms: null, accepted_offset_ms: null, total_ms: null,
    render_wait_after_translation_ms: null, render_coverage: null, render_reason_counts: {},
    manifest_mismatch: false, source_unavailable: false, painted: null, error_code: null,
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
    render_ready_ms: elapsed("render_ready"),
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
  const pageRows = metricSamples.flatMap((sample) => sample.page_metrics || []);
  const atomic = pageRows.filter((row) => row.overlay_semantics === "atomic_patch_v1");
  const summarizeRows = (rows, fields) => ({
    sample_count: rows.length,
    ...Object.fromEntries(fields.map((field) => {
      const values = rows.map((row) => row[field]).filter(Number.isFinite);
      return [field, { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }];
    })),
  });
  summary.atomic_patch_v1 = {
    warm: summarizeRows(
      atomic.filter((row) => row.cache_hit === true && Number.isFinite(row.first_overlay_ms)),
      ["first_overlay_ms"],
    ),
    cold: summarizeRows(
      atomic.filter((row) => row.cache_hit === false && row.partial_replay === false && row.analysis_cache_hit === false && Number.isFinite(row.first_overlay_ms)),
      ["first_overlay_ms", "render_wait_after_translation_ms"],
    ),
  };
  return summary;
}

function canonicalCrop(crop) {
  if (!crop || crop === "full") return "full";
  const rounded = Object.fromEntries(
    ["left", "top", "right", "bottom"].map((key) => [
      key, Math.round(crop[key] * 1e6) / 1e6,
    ])
  );
  return rounded.left === 0 && rounded.top === 0 &&
    rounded.right === 1 && rounded.bottom === 1 ? "full" : rounded;
}

function normalizeReadingDirection(value) {
  if (value == null) return "rtl";
  if (value === "rtl" || value === "ltr") return value;
  throw new Error("invalid reading_direction");
}

async function hashValue(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildKeys(job, sourceIdentity, versions, patchVersions) {
  const crop = canonicalCrop(job.crop);
  const sourceContentHash = sourceIdentity.sourceContentHash;
  const analysisKey = await hashValue([
    sourceContentHash, crop, versions.detector, versions.dedupe, versions.prep,
    versions.region_resolver,
  ]);
  const ocrKey = await hashValue([
    analysisKey, job.src_lang, versions.recognizers[job.src_lang],
  ]);
  const pageArtifactKey = await hashValue([
    ocrKey, job.dst_lang, job.reading_direction, versions.layout_order,
    versions.translator_model, versions.prompt, versions.policy,
    versions.page_schema,
  ]);
  return {
    sourceContentHash,
    analysisKey,
    ocrKey,
    pageArtifactKey,
    renderArtifactKey: await hashValue([
      analysisKey, patchVersions.cleaner, patchVersions.render_encoding,
      patchVersions.render_schema,
    ]),
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
    ready.then(() => {
      const source = msg.job || msg;
      return acceptScope(null, {
        request_id: `prewarm:${Date.now()}`,
        scope: "prewarm",
        src_lang: msg.src_lang,
        dst_lang: msg.dst_lang,
        reading_direction: source.reading_direction,
        jobs: [source],
      });
    }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

function ocrKey({ url, srcLang, crop }) {
  return `${url}|${srcLang}|${crop ? `${crop.left},${crop.top},${crop.right},${crop.bottom}` : "full"}`;
}

async function fetchOcr({ url, srcLang, crop }) {
  const acquisition = sourcePool.acquire(url);
  try {
    const { blob } = await acquisition.promise;
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
  } finally {
    acquisition.release();
  }
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
      error.errorCode = data.error_code || null;
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
const renderOutcomeCollectors = new Map();
const pageWriteTails = new Map();
const offlineJobs = [];
const sourcePool = MangaSourceFetch.create({
  fetchImpl: (...args) => fetch(...args),
  cryptoImpl: crypto,
  maxConcurrent: MAX_SOURCE_FETCH,
});
let serverVersions = null;
let serverPatchVersions = null;

function lruSet(map, key, value, limit) {
  map.delete(key); map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}
function serializePageWrite(pageKey, write) {
  const previous = pageWriteTails.get(pageKey) || Promise.resolve();
  const run = previous.then(write, write);
  const tail = run.catch(() => {});
  pageWriteTails.set(pageKey, tail);
  void tail.then(() => {
    if (pageWriteTails.get(pageKey) === tail) pageWriteTails.delete(pageKey);
  });
  return run;
}
async function findPageForReuse(predicate) {
  const candidate = await pageCache?.findPage(predicate, { touch: false });
  if (!candidate) return null;
  return serializePageWrite(candidate.page_artifact_key, async () => {
    const current = await pageCache?.getPage(candidate.page_artifact_key);
    return current && predicate(current) ? current : null;
  });
}

async function refreshServerVersions(resume = true) {
  const response = await fetch(`${SERVER}/health`);
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  const data = await response.json();
  serverVersions = data.versions;
  serverPatchVersions = data.patch_versions;
  await pageCache?.purgeIncompatible(
    serverVersions,
    serverPatchVersions,
    LAYOUT_FIT_VERSION,
  );
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
    void resumeOfflineJobs();
    pumpTasks();
  } catch {
    for (const job of jobs) if (job.scope === "visible") restoreProducer(job);
  }
})();

function sourceCropKey(descriptor) {
  return JSON.stringify([descriptor.source_url, canonicalCrop(descriptor.crop)]);
}
function consumerKey(requestId, jobId) {
  return JSON.stringify([requestId, jobId]);
}

function createRequest(port, message) {
  const expectedJobIds = new Set((message.jobs || []).map((row) => row.job_id));
  const request = { requestId: message.request_id, scope: message.scope, srcLang: message.src_lang, dstLang: message.dst_lang, port, jobs: new Map(), jobsBySourceCrop: new Map(), sourceAcquisitions: new Map(), sourceDescriptors: new Map(), cancelledSourceJobs: new Set(), expectedJobIds, deliveredByJob: new Map([...expectedJobIds].map((jobId) => [jobId, new Set()])), partialReplayJobs: new Set(), renderMetricsByJob: new Map(), pendingJobs: [], outstanding: 0, connected: true, done: new Set(), hits: 0, translated: 0, failed: 0, acceptedAt: now(), firstOverlayMs: null, firstOverlayByJob: new Map(), metricRows: [], counters: { translation_calls: 0, rate_limited: 0, stale_work: 0 }, countedCounterProducers: new Set(), cancelLatencyMs: null };
  for (const row of message.jobs || []) request.jobsBySourceCrop.set(sourceCropKey(row), row);
  return request;
}
function releasePendingSource(request, jobId) {
  const acquisition = request.sourceAcquisitions.get(jobId);
  if (!acquisition) return;
  request.sourceAcquisitions.delete(jobId);
  request.sourceDescriptors.delete(jobId);
  acquisition.release();
}
function releaseMatchingPendingSources(request, replacement) {
  for (const [jobId] of request.sourceAcquisitions) {
    const descriptor = request.sourceDescriptors.get(jobId);
    if (!descriptor || !replacement.jobsBySourceCrop.has(sourceCropKey(descriptor))) continue;
    request.cancelledSourceJobs.add(jobId);
    releasePendingSource(request, jobId);
    void pageCache?.removeJob(jobId);
  }
}
function postTo(request, jobId, port, payload) {
  if (!request?.connected || request.done.has(jobId) || !port) return false;
  try { port.postMessage(payload); return true; } catch { return false; }
}
function emit(producer, type, extra = {}) {
  for (const consumer of producer.consumers.values()) {
    const request = requests.get(consumer.requestId);
    if (!request?.connected || request.done.has(consumer.jobId) || !consumer.port) continue;
    const payload = { ...extra, type, request_id: consumer.requestId, job_id: consumer.jobId, page_artifact_key: producer.pageKey };
    if (postTo(request, consumer.jobId, consumer.port, payload) && type === "translation") {
      request.deliveredByJob.get(consumer.jobId).add(extra.block_id);
    }
  }
}
function persist(producer) {
  if (!producer.persistUntilDone || !pageCache) return Promise.resolve();
  if (producer.ocrRecovery && !producer.ocrRecovery.committing) return Promise.resolve();
  producer.persistChain = producer.persistChain.then(() => serializePageWrite(producer.pageKey, async () => {
    const current = await pageCache.getPage(producer.pageKey);
    if (current && (current.render_artifact_key !== producer.page.render_artifact_key ||
        !metadataEqual(current.patch_versions, producer.page.patch_versions))) return;
    if (producer.ocrRecovery) {
      const currentRender = current?.render;
      delete producer.page.render;
      if (sameManifest(current?.manifest_ids, producer.page.manifest_ids) &&
          currentRender?.render_artifact_key === producer.page.render_artifact_key &&
          currentRender.layout_fit_version === LAYOUT_FIT_VERSION &&
          metadataEqual(currentRender.patch_versions, producer.page.patch_versions)) {
        producer.page.render = currentRender;
      }
    }
    await pageCache.putPage(producer.page);
  })).catch(() => { producer.page.last_error = "cache_failed"; });
  return producer.persistChain;
}
function releaseProducerSource(producer) {
  if (!producer.sourceAcquisition) return;
  producer.sourceAcquisition.release();
  producer.sourceAcquisition = null;
}
function createProducer(descriptor, keys, page, sourceIdentity, sourceAcquisition = null) {
  const createdAt = Date.now();
  const record = page || { schema_version: serverVersions.page_schema, page_artifact_key: keys.pageArtifactKey, analysis_key: keys.analysisKey, ocr_key: keys.ocrKey, render_artifact_key: keys.renderArtifactKey, source_content_hash: keys.sourceContentHash, source_url: descriptor.source_url, crop: keys.crop, natural_width: descriptor.natural_width, natural_height: descriptor.natural_height, src_lang: descriptor.src_lang, dst_lang: descriptor.dst_lang, reading_direction: descriptor.reading_direction, versions: serverVersions, patch_versions: serverPatchVersions, state: "queued", analysis_known: false, ocr_done: false, image_w: null, image_h: null, blocks: [], manifest_mismatch_count: 0, created_at: createdAt, updated_at: createdAt, last_accessed_at: createdAt, last_error: null };
  return { pageKey: keys.pageArtifactKey, analysisKey: keys.analysisKey, ocrKey: keys.ocrKey, ocrStageKey: keys.ocrKey, renderArtifactKey: keys.renderArtifactKey, sourceIdentity, sourceAcquisition, descriptor, page: record, consumers: new Map(), jobIds: new Set(), persistUntilDone: false, prewarmOnly: descriptor.scope === "prewarm", state: "queued", translationReady: null, renderReady: null, renderArtifact: null, translationBatchTrace: [], persistChain: Promise.resolve(), cancelled: false, retired: false, timings: { accepted: now() }, durations: { fetch_ms: descriptor.source_fetch_ms ?? null, analysis_ms: null }, analysisCacheHit: null, ocrSummary: null, counters: { translation_calls: 0, rate_limited: 0, stale_work: 0 } };
}
function resetProducerForOcrRecovery(producer, artifact, delivered) {
  const baseline = JSON.parse(JSON.stringify(producer.page));
  producer.ocrRecovery = { baseline, artifact, delivered, committing: false };
  producer.page = JSON.parse(JSON.stringify(baseline));
  producer.page.state = "queued";
  producer.page.ocr_done = false;
  producer.page.blocks = [];
  producer.page.last_error = null;
  delete producer.page.manifest_ids;
  delete producer.page.render;
  producer.translationReady = null;
  producer.renderReady = null;
  producer.renderArtifact = null;
  producer.forceTranslationNetwork = true;
}
function reusableProducer(producer, keys, page = null) {
  return producer && !producer.cancelled && !producer.retired &&
    producer.renderArtifactKey === keys.renderArtifactKey &&
    producer.page?.render_artifact_key === keys.renderArtifactKey &&
    metadataEqual(producer.page?.patch_versions, serverPatchVersions) &&
    (!page || (page.render_artifact_key === producer.page.render_artifact_key &&
      metadataEqual(page.patch_versions, producer.page.patch_versions)));
}
async function attachProducerConsumer(request, descriptor, ledger, producer, sourceAcquisition, releaseSource) {
  request.sourceAcquisitions.delete(descriptor.job_id);
  request.sourceDescriptors.delete(descriptor.job_id);
  if (releaseSource) sourceAcquisition.release();
  if (!producer.page.ocr_done) {
    producer.ocrStage = attachStage(ocrStages, producer.ocrStageKey, producer);
    producer.analysisStage = attachStage(analysisStages, producer.analysisKey, producer);
  }
  producer.consumers.set(consumerKey(request.requestId, descriptor.job_id), { requestId: request.requestId, jobId: descriptor.job_id, port: request.port });
  producer.jobIds.add(descriptor.job_id);
  if (request.scope !== "prewarm") producer.prewarmOnly = false;
  if (request.scope === "visible") producer.persistUntilDone = true;
  request.jobs.set(descriptor.job_id, producer); request.pendingJobs.push(producer);
  if (request.scope === "visible") {
    await pageCache?.putJob({ ...ledger, page_artifact_key: producer.pageKey, waiting_for_health: false });
  }
  accepted(request, descriptor, producer.page, false, producer.renderArtifact);
}
async function attachDescriptor(request, descriptor, ledger, sourceIdentity, sourceAcquisition) {
  if (request.cancelledSourceJobs.has(descriptor.job_id)) { releasePendingSource(request, descriptor.job_id); return; }
  if (!serverVersions) {
    if (request.scope === "visible") await pageCache.putJob({ ...ledger, waiting_for_health: true });
    request.sourceAcquisitions.delete(descriptor.job_id);
    request.sourceDescriptors.delete(descriptor.job_id);
    offlineJobs.push({ request, descriptor, ledger, sourceIdentity, sourceAcquisition });
    return;
  }
  const keys = await buildKeys(descriptor, sourceIdentity, serverVersions, serverPatchVersions); descriptor.page_artifact_key = keys.pageArtifactKey;
  if (request.cancelledSourceJobs.has(descriptor.job_id)) { releasePendingSource(request, descriptor.job_id); return; }
  request.jobsBySourceCrop.set(sourceCropKey(descriptor), descriptor);
  const activeProducer = producers.get(keys.pageArtifactKey);
  if (reusableProducer(activeProducer, keys)) {
    await attachProducerConsumer(request, descriptor, ledger, activeProducer, sourceAcquisition, true);
    return;
  }
  const cachedOcr = request.scope === "prewarm"
    ? await findPageForReuse((p) => p.ocr_key === keys.ocrKey && p.ocr_done === true)
    : null;
  if (cachedOcr) {
    request.sourceAcquisitions.delete(descriptor.job_id);
    request.sourceDescriptors.delete(descriptor.job_id);
    sourceAcquisition.release();
    completeJob(request, descriptor.job_id, 0, 0, true, null, null, null, {
      pageKey: cachedOcr.page_artifact_key,
    });
    return;
  }
  let page = request.scope === "visible"
    ? await serializePageWrite(keys.pageArtifactKey, () => pageCache.getPage(keys.pageArtifactKey))
    : null;
  if (!page && request.scope === "visible") {
    const analysis = await findPageForReuse(
      (p) => p.analysis_key === keys.analysisKey && p.analysis_known === true
    );
    const sibling = await findPageForReuse((p) => p.ocr_key === keys.ocrKey && p.ocr_done === true);
    page = createProducer(descriptor, keys, null, sourceIdentity).page;
    const geometry = analysis || sibling;
    page.analysis_known = !!geometry; page.ocr_done = sibling?.ocr_done === true;
    if (geometry) { page.image_w = geometry.image_w; page.image_h = geometry.image_h; }
    if (sibling) page.blocks = sibling.blocks.map((block) => ({ block_id: block.block_id, bbox: [...block.bbox], src_text: block.src_text, trans_text: null, kind: block.kind, vertical: block.vertical, reading_order: block.reading_order, state: "ocr_complete" }));
    page = await serializePageWrite(keys.pageArtifactKey, async () => {
      const current = await pageCache.getPage(keys.pageArtifactKey);
      if (current) return current;
      await pageCache.putPage(page);
      return page;
    });
  }
  if (page && request.scope === "visible" &&
      (page.render_artifact_key !== keys.renderArtifactKey || !metadataEqual(page.patch_versions, serverPatchVersions))) {
    page = await serializePageWrite(keys.pageArtifactKey, async () => {
      const current = await pageCache.getPage(keys.pageArtifactKey);
      if (!current) return page;
      if (current.render_artifact_key !== keys.renderArtifactKey ||
          !metadataEqual(current.patch_versions, serverPatchVersions)) {
        current.render_artifact_key = keys.renderArtifactKey;
        current.patch_versions = serverPatchVersions;
        delete current.render;
        await pageCache.putPage(current);
      }
      return current;
    });
  }
  if (request.cancelledSourceJobs.has(descriptor.job_id)) { releasePendingSource(request, descriptor.job_id); return; }
  if (page && freshBreakerSentinel(page)) {
    request.sourceAcquisitions.delete(descriptor.job_id);
    request.sourceDescriptors.delete(descriptor.job_id);
    postTo(request, descriptor.job_id, request.port, { type: "page_job_accepted", request_id: request.requestId, job_id: descriptor.job_id, page_artifact_key: page.page_artifact_key, state: "complete" });
    terminalJob(request, descriptor.job_id, request.port, 0, true, page.blocks.length, { recognized: page.blocks.length, failed: 0 }, null, null, { pageKey: page.page_artifact_key });
    sourceAcquisition.release();
    await pageCache?.removeJob(descriptor.job_id);
    return;
  }
  const hasManifest = page != null && Object.hasOwn(page, "manifest_ids");
  const incompleteOcrReplay = hasManifest && page.state === "partial" && page.ocr_done === false;
  if (incompleteOcrReplay) {
    const producer = createProducer(descriptor, keys, page, sourceIdentity, sourceAcquisition);
    let artifact;
    let delivered;
    try {
      artifact = await fetchRenderArtifact(producer);
      postTo(request, descriptor.job_id, request.port, { type: "page_job_accepted", request_id: request.requestId, job_id: descriptor.job_id, page_artifact_key: page.page_artifact_key, state: page.state });
      delivered = replayPage(request, descriptor.job_id, page, true, artifact);
      request.partialReplayJobs.add(descriptor.job_id);
    } catch (error) {
      if (error?.errorCode !== "manifest_mismatch") throw error;
      const action = await handleManifestMismatch(producer);
      request.sourceAcquisitions.delete(descriptor.job_id);
      request.sourceDescriptors.delete(descriptor.job_id);
      if (action === "recover") {
        producer.persistUntilDone = true;
        producer.prewarmOnly = false;
        producer.consumers.set(consumerKey(request.requestId, descriptor.job_id), { requestId: request.requestId, jobId: descriptor.job_id, port: request.port });
        producer.jobIds.add(descriptor.job_id);
        request.jobs.set(descriptor.job_id, producer);
        request.pendingJobs.push(producer);
        producers.set(producer.pageKey, producer);
        return;
      }
      terminalJob(request, descriptor.job_id, request.port, 0, true, page.blocks.length, { recognized: page.blocks.length, failed: 0 }, null, null, { pageKey: page.page_artifact_key, manifestMismatch: true });
      releaseProducerSource(producer);
      await pageCache.removeJob(descriptor.job_id);
      return;
    }
    const claimed = await pageCache.claimOcrRecovery(keys.ocrKey, keys.pageArtifactKey);
    request.sourceAcquisitions.delete(descriptor.job_id);
    request.sourceDescriptors.delete(descriptor.job_id);
    if (!claimed) {
      terminalJob(request, descriptor.job_id, request.port, 0, true, page.blocks.length, { recognized: page.blocks.length, failed: 0 }, null, null, { pageKey: page.page_artifact_key });
      releaseProducerSource(producer);
      await pageCache.removeJob(descriptor.job_id);
      return;
    }
    resetProducerForOcrRecovery(producer, artifact, delivered);
    producer.ocrStage = attachStage(ocrStages, producer.ocrStageKey, producer);
    producer.analysisStage = attachStage(analysisStages, producer.analysisKey, producer);
    producer.persistUntilDone = true;
    producer.prewarmOnly = false;
    producer.consumers.set(consumerKey(request.requestId, descriptor.job_id), { requestId: request.requestId, jobId: descriptor.job_id, port: request.port });
    producer.jobIds.add(descriptor.job_id);
    request.jobs.set(descriptor.job_id, producer);
    request.pendingJobs.push(producer);
    producers.set(producer.pageKey, producer);
    return;
  }
  const terminalHit = hasManifest && page.state === "complete" && page.ocr_done === true;
  if (terminalHit) {
    request.sourceAcquisitions.delete(descriptor.job_id);
    request.sourceDescriptors.delete(descriptor.job_id);
    const producer = createProducer(descriptor, keys, page, sourceIdentity, sourceAcquisition);
    producer.translationReady = Promise.resolve({ translated: page.blocks.length, failed: 0 });
    postTo(request, descriptor.job_id, request.port, { type: "page_job_accepted", request_id: request.requestId, job_id: descriptor.job_id, page_artifact_key: page.page_artifact_key, state: "complete" });
    let recoveryQueued = false;
    try {
      producer.renderReady = fetchRenderArtifact(producer);
      const artifact = await producer.renderReady;
      replayPage(request, descriptor.job_id, page, true, artifact);
      terminalJob(request, descriptor.job_id, request.port, 0, true, page.blocks.length, { recognized: page.blocks.length, failed: 0 }, null, null, { pageKey: page.page_artifact_key });
    } catch (error) {
      if (error?.errorCode === "manifest_mismatch") {
        try {
          const action = await handleManifestMismatch(producer);
          if (action === "recover") {
            producer.persistUntilDone = true;
            producer.prewarmOnly = false;
            producer.consumers.set(consumerKey(request.requestId, descriptor.job_id), { requestId: request.requestId, jobId: descriptor.job_id, port: request.port });
            producer.jobIds.add(descriptor.job_id);
            request.jobs.set(descriptor.job_id, producer);
            request.pendingJobs.push(producer);
            producers.set(producer.pageKey, producer);
            recoveryQueued = true;
            return;
          }
          terminalJob(request, descriptor.job_id, request.port, 0, true, page.blocks.length, { recognized: page.blocks.length, failed: 0 }, null, null, { pageKey: page.page_artifact_key, manifestMismatch: true });
          return;
        } catch (claimError) {
          error = claimError;
        }
      }
      page.last_error = String(error);
      page.state = "partial";
      await serializePageWrite(page.page_artifact_key, async () => {
        const current = await pageCache?.getPage(page.page_artifact_key);
        if (!current || current.render_artifact_key !== page.render_artifact_key ||
            !metadataEqual(current.patch_versions, page.patch_versions)) return;
        current.last_error = page.last_error;
        current.state = page.state;
        await pageCache?.putPage(current);
      }).catch(() => {});
      terminalJob(request, descriptor.job_id, request.port, 1, false, page.blocks.length, { recognized: page.blocks.length, failed: 1 }, null, null, { pageKey: page.page_artifact_key, errorCode: error.errorCode || "render_failed", manifestMismatch: producer.manifestMismatch === true });
    } finally {
      if (!recoveryQueued) {
        releaseProducerSource(producer);
        await pageCache?.removeJob(descriptor.job_id);
      }
    }
    return;
  }
  let producer = producers.get(keys.pageArtifactKey);
  const joinsProducer = reusableProducer(producer, keys, page);
  if (!joinsProducer) {
    producer = createProducer(descriptor, keys, page, sourceIdentity, sourceAcquisition);
    producers.set(keys.pageArtifactKey, producer);
  }
  await attachProducerConsumer(request, descriptor, ledger, producer, sourceAcquisition, joinsProducer);
}
function accepted(request, descriptor, page, cacheHit, artifact = null) {
  postTo(request, descriptor.job_id, request.port, { type: "page_job_accepted", request_id: request.requestId, job_id: descriptor.job_id, page_artifact_key: page.page_artifact_key, state: cacheHit ? "complete" : page.state });
  replayPage(request, descriptor.job_id, page, cacheHit, artifact);
}
function replayPage(request, jobId, page, cacheHit, artifact = null) {
  if (page.image_w) postTo(request, jobId, request.port, { type: "progress", request_id: request.requestId, job_id: jobId, image_w: page.image_w, image_h: page.image_h });
  if (!artifact || !Object.hasOwn(page, "manifest_ids")) return 0;
  const events = renderableTranslationEvents(page, artifact);
  prepareRenderOutcomeCollector(page, artifact, [{ requestId: request.requestId, jobId, port: request.port }]);
  for (const event of events) {
    if (!postTo(request, jobId, request.port, { ...event, type: "translation", request_id: request.requestId, job_id: jobId, page_artifact_key: page.page_artifact_key, cache_hit: cacheHit === true })) break;
    request.deliveredByJob.get(jobId).add(event.block_id);
  }
  return request.deliveredByJob.get(jobId).size;
}
async function acceptScope(port, message) {
  await ready;
  let readingDirection;
  try {
    readingDirection = normalizeReadingDirection(message.reading_direction);
  } catch (error) {
    port?.postMessage({ type: "scope_error", request_id: message.request_id, code: "invalid_request", error: String(error) });
    return;
  }
  const request = createRequest(port, message); requests.set(request.requestId, request);
  if (!message.jobs?.length) { if (message.replaces_request_id) releaseRequest(message.replaces_request_id, request); scopeDone(request); return; }
  if (!serverVersions) try { await refreshServerVersions(false); } catch {}
  const rows = message.jobs.map((row) => {
    const descriptor = { ...row, src_lang: request.srcLang, dst_lang: request.dstLang, scope: request.scope, reading_direction: readingDirection };
    const sourceStartedAt = now();
    const sourceAcquisition = sourcePool.acquire(descriptor.source_url);
    request.sourceAcquisitions.set(descriptor.job_id, sourceAcquisition);
    request.sourceDescriptors.set(descriptor.job_id, descriptor);
    return { descriptor, sourceStartedAt, sourceAcquisition };
  });
  for (const { descriptor } of rows) request.jobsBySourceCrop.set(sourceCropKey(descriptor), descriptor);
  const replacedRequest = message.replaces_request_id
    ? requests.get(message.replaces_request_id)
    : null;
  const replacementAttachKeys = new Set();
  if (replacedRequest) {
    releaseMatchingPendingSources(replacedRequest, request);
    for (const producer of new Set(replacedRequest.jobs.values())) {
      const key = sourceCropKey(producer.descriptor);
      if (request.jobsBySourceCrop.has(key)) replacementAttachKeys.add(key);
    }
  }
  let replacementReleased = false;
  const releaseReplacement = () => {
    if (replacementReleased || !message.replaces_request_id) return;
    replacementReleased = true;
    releaseRequest(message.replaces_request_id, request);
  };
  if (!replacedRequest || replacementAttachKeys.size === 0) releaseReplacement();
  for (const row of rows) {
    const { descriptor, sourceStartedAt, sourceAcquisition } = row;
    const ledger = { job_id: descriptor.job_id, request_id: request.requestId, scope: request.scope, src_lang: request.srcLang, dst_lang: request.dstLang, descriptor, state: "queued", created_at: Date.now() };
    try {
      if (request.scope === "visible") await pageCache?.putJob(ledger);
    } catch (error) {
      releasePendingSource(request, descriptor.job_id);
      if (request.cancelledSourceJobs.has(descriptor.job_id)) continue;
      const code = typeof CacheFullError !== "undefined" && error instanceof CacheFullError ? "cache_full" : "request_failed";
      request.port?.postMessage({ type: "job_error", request_id: request.requestId, job_id: descriptor.job_id, code, error: String(error) });
      completeJob(request, descriptor.job_id, 0, 1, false, null, null, null, { pageKey: descriptor.page_artifact_key, errorCode: code });
      continue;
    }
    let sourceIdentity;
    try {
      sourceIdentity = await sourceAcquisition.promise;
    } catch (error) {
      releasePendingSource(request, descriptor.job_id);
      if (request.cancelledSourceJobs.has(descriptor.job_id)) continue;
      request.port?.postMessage({ type: "job_error", request_id: request.requestId, job_id: descriptor.job_id, code: "source_unavailable", error: String(error) });
      completeJob(request, descriptor.job_id, 0, 1, false, { fetch_ms: Math.max(0, now() - sourceStartedAt) }, null, null, { pageKey: null, errorCode: "source_unavailable" });
      continue;
    }
    descriptor.source_fetch_ms = Math.max(0, now() - sourceStartedAt);
    if (request.cancelledSourceJobs.has(descriptor.job_id)) { releasePendingSource(request, descriptor.job_id); continue; }
    try {
      await attachDescriptor(request, descriptor, ledger, sourceIdentity, sourceAcquisition);
      if (!request.cancelledSourceJobs.has(descriptor.job_id)) admitRequestJobs(request);
      replacementAttachKeys.delete(sourceCropKey(descriptor));
      if (replacementAttachKeys.size === 0) releaseReplacement();
    } catch (error) {
      releasePendingSource(request, descriptor.job_id);
      if (request.cancelledSourceJobs.has(descriptor.job_id)) continue;
      const code = typeof CacheFullError !== "undefined" && error instanceof CacheFullError ? "cache_full" : "request_failed";
      request.port?.postMessage({ type: "job_error", request_id: request.requestId, job_id: descriptor.job_id, code, error: String(error) });
      completeJob(request, descriptor.job_id, 0, 1, false, null, null, null, { pageKey: descriptor.page_artifact_key, errorCode: code });
    }
  }
  releaseReplacement();
  admitRequestJobs(request);
}
function terminalJob(request, jobId, port, failed, hit, recognized, metrics = null, counters = null, counterProducer = null, meta = {}) {
  if (!request || request.done.has(jobId)) return;
  const translated = request.deliveredByJob.get(jobId).size;
  postTo(request, jobId, port, { type: "image_done", request_id: request.requestId, job_id: jobId, page_artifact_key: meta.pageKey ?? null, translated, recognized, failed });
  completeJob(request, jobId, translated, failed, hit, metrics, counters, counterProducer, meta);
}
function completeJob(request, jobId, translated, failed, hit, metrics = null, counters = null, counterProducer = null, meta = {}) {
  if (!request) return;
  translated = request.deliveredByJob.get(jobId).size;
  if (request.done.has(jobId)) return; request.done.add(jobId); request.translated += translated; request.failed += failed; if (hit) request.hits++;
  const finalTranslationMs = metrics?.final_translation_ms;
  const renderReadyMs = metrics?.render_ready_ms;
  const renderWait = Number.isFinite(finalTranslationMs) && Number.isFinite(renderReadyMs)
    ? Math.max(0, renderReadyMs - finalTranslationMs) : null;
  const { render_ready_ms: _renderReadyMs, ...publicMetrics } = metrics || {};
  request.metricRows.push({
    job_id: jobId,
    page_artifact_key: meta.pageKey ?? null,
    ...emptyPageMetrics(),
    ...publicMetrics,
    ...(request.renderMetricsByJob.get(jobId) || {}),
    partial_replay: request.partialReplayJobs.has(jobId),
    cache_hit: hit,
    render_wait_after_translation_ms: renderWait,
    manifest_mismatch: meta.manifestMismatch === true || meta.errorCode === "manifest_mismatch",
    source_unavailable: meta.errorCode === "source_unavailable",
    error_code: meta.errorCode ?? null,
    first_overlay_ms: request.firstOverlayByJob.get(jobId) ?? null,
    accepted_offset_ms: Number.isFinite(meta.acceptedAt) ? Math.round(meta.acceptedAt - request.acceptedAt) : null,
  });
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
async function requestRenderArtifact(producer, includeImage) {
  const form = new FormData();
  form.append("analysis_key", producer.analysisKey);
  form.append("render_artifact_key", producer.renderArtifactKey);
  form.append("source_content_hash", producer.sourceIdentity.sourceContentHash);
  appendCrop(form, producer.descriptor.crop);
  if (includeImage) form.append("image", producer.sourceIdentity.blob, "page.png");
  const response = await fetch(`${SERVER}/render-artifact`, { method: "POST", body: form });
  const data = await response.json();
  return { response, data };
}
async function fetchRenderArtifact(producer) {
  let result = await requestRenderArtifact(producer, false);
  if (result.response.status === 409 && result.data?.error === "artifact_missing") {
    result = await requestRenderArtifact(producer, true);
  }
  if (!result.response.ok) {
    const error = new Error(result.data?.error || `render-artifact HTTP ${result.response.status}`);
    error.status = result.response.status;
    error.errorCode = result.data?.error_code || result.data?.error || "render_failed";
    throw error;
  }
  const artifact = result.data;
  if (artifact?.schema_version !== serverPatchVersions.render_schema ||
      artifact.render_artifact_key !== producer.renderArtifactKey ||
      artifact.analysis_key !== producer.analysisKey || artifact.image_w !== producer.page.image_w ||
      artifact.image_h !== producer.page.image_h || !Array.isArray(artifact.blocks)) {
    const error = new Error("render artifact identity mismatch");
    error.errorCode = "render_artifact_mismatch";
    throw error;
  }
  return artifact;
}
function validRenderBbox(bbox) {
  return Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite) &&
    bbox[0] >= 0 && bbox[1] >= 0 && bbox[2] > 0 && bbox[3] > 0;
}
const RENDER_CAPABILITY_REASONS = new Set(["clean_failed", "layout_failed", "fit_failed", "unsupported_region"]);
function freshBreakerSentinel(page) {
  return page.render?.breaker_open === true && page.render.render_artifact_key === page.render_artifact_key &&
    page.render.layout_fit_version === LAYOUT_FIT_VERSION &&
    metadataEqual(page.render.patch_versions, serverPatchVersions);
}
function renderOutcomeKey(pageKey, renderKey, layoutFitVersion) {
  return JSON.stringify([pageKey, renderKey, layoutFitVersion]);
}
function sameManifest(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((blockId, index) => blockId === right[index]);
}
function renderCollectorMatchesPage(collector, page) {
  return page?.page_artifact_key === collector.pageKey &&
    page.render_artifact_key === collector.renderKey &&
    sameManifest(page.manifest_ids, collector.manifestIds) &&
    metadataEqual(page.patch_versions, collector.patchVersions);
}
function readyRenderFromCollector(collector) {
  return {
    schema_version: "render-page-v1",
    render_artifact_key: collector.renderKey,
    patch_versions: collector.patchVersions,
    layout_fit_version: collector.layoutFitVersion,
    breaker_open: false,
    blocks: collector.manifestIds.map((blockId) => collector.blocks.get(blockId)),
  };
}
function persistCompletedRender(collector) {
  if (collector.persisting || collector.blocks.size !== collector.manifestIds.length) return;
  collector.persisting = true;
  let removeCollector = false;
  void serializePageWrite(collector.pageKey, async () => {
    if (renderOutcomeCollectors.get(collector.key) !== collector) return;
    const activeProducer = collector.producer && producers.get(collector.pageKey) === collector.producer
      ? collector.producer : null;
    const page = await pageCache?.getPage(collector.pageKey);
    if (renderOutcomeCollectors.get(collector.key) !== collector) return;
    if (!page || !renderCollectorMatchesPage(collector, page)) {
      removeCollector = true;
      return;
    }
    const render = readyRenderFromCollector(collector);
    page.render = render;
    await pageCache?.putPage(page);
    if (activeProducer && renderCollectorMatchesPage(collector, activeProducer.page)) activeProducer.page.render = render;
    removeCollector = true;
  }).catch(() => {
    if (renderOutcomeCollectors.get(collector.key) === collector) collector.persisting = false;
  }).finally(() => {
    if (removeCollector && renderOutcomeCollectors.get(collector.key) === collector) renderOutcomeCollectors.delete(collector.key);
  });
}
function prepareRenderOutcomeCollector(page, artifact, consumers, producer = null) {
  if (!pageCache || !Object.hasOwn(page, "manifest_ids")) return;
  if (page.render?.render_artifact_key === artifact.render_artifact_key &&
      page.render.layout_fit_version === LAYOUT_FIT_VERSION &&
      metadataEqual(page.render.patch_versions, serverPatchVersions)) return;
  const key = renderOutcomeKey(page.page_artifact_key, artifact.render_artifact_key, LAYOUT_FIT_VERSION);
  let collector = renderOutcomeCollectors.get(key);
  if (!collector || !sameManifest(collector.manifestIds, page.manifest_ids)) {
    const artifactById = new Map(artifact.blocks.map((block) => [block.block_id, block]));
    collector = {
      key,
      pageKey: page.page_artifact_key,
      renderKey: artifact.render_artifact_key,
      layoutFitVersion: LAYOUT_FIT_VERSION,
      patchVersions: serverPatchVersions,
      manifestIds: [...page.manifest_ids],
      artifactById,
      blocks: new Map(),
      consumers: new Map(),
      producer,
      persisting: false,
    };
    for (const blockId of collector.manifestIds) {
      const block = artifactById.get(blockId);
      const reason = block?.reason === null &&
        (!validRenderBbox(block.patch_bbox) || !validRenderBbox(block.fit_bbox))
        ? "layout_failed"
        : block?.reason;
      if (!RENDER_CAPABILITY_REASONS.has(reason)) continue;
      collector.blocks.set(blockId, {
        block_id: blockId,
        render_mode: "skip",
        patch_id: null,
        patch_bbox: null,
        fit_bbox: validRenderBbox(block.fit_bbox) ? [...block.fit_bbox] : null,
        layout_profile: null,
        reason,
      });
    }
    lruSet(renderOutcomeCollectors, key, collector, 128);
  } else if (producer) {
    collector.producer = producer;
  }
  for (const consumer of consumers) {
    if (!consumer?.port) continue;
    collector.consumers.set(consumerKey(consumer.requestId, consumer.jobId), consumer);
    updateRenderMetric(collector, consumer);
  }
  persistCompletedRender(collector);
}
function validLayoutProfile(profile) {
  return profile && typeof profile === "object" && !Array.isArray(profile) &&
    Number.isFinite(profile.font_px) && Number.isFinite(profile.line_height);
}
function renderMetricFromCollector(collector) {
  if (collector.blocks.size !== collector.manifestIds.length) return null;
  const rendered = [...collector.blocks.values()].filter((row) => row.render_mode === "in_place").length;
  const render_reason_counts = {};
  for (const row of collector.blocks.values()) {
    if (row.reason) render_reason_counts[row.reason] = (render_reason_counts[row.reason] || 0) + 1;
  }
  return {
    render_coverage: collector.manifestIds.length ? rendered / collector.manifestIds.length : null,
    render_reason_counts,
    painted: collector.manifestIds.length ? rendered > 0 : null,
  };
}
function updateRenderMetric(collector, consumer) {
  const metric = renderMetricFromCollector(collector);
  if (!metric) return;
  const request = requests.get(consumer.requestId);
  if (request) {
    request.renderMetricsByJob.set(consumer.jobId, metric);
    const row = request.metricRows.find((item) => item.job_id === consumer.jobId);
    if (row) Object.assign(row, metric);
    return;
  }
  const row = metricSamplesByRequest.get(consumer.requestId)?.page_metrics
    ?.find((item) => item.job_id === consumer.jobId);
  if (row) Object.assign(row, metric);
}
function collectRenderOutcome(port, message) {
  const key = renderOutcomeKey(message.page_artifact_key, message.render_artifact_key, message.layout_fit_version);
  const collector = renderOutcomeCollectors.get(key);
  const consumer = collector?.consumers.get(consumerKey(message.request_id, message.job_id));
  if (!collector || consumer?.port !== port || !collector.manifestIds.includes(message.block_id) || collector.blocks.has(message.block_id)) return;
  const artifactBlock = collector.artifactById.get(message.block_id);
  let block;
  if (message.painted === true && message.reason === null && validLayoutProfile(message.layout_profile) &&
      artifactBlock?.reason === null && typeof artifactBlock.patch_id === "string" &&
      validRenderBbox(artifactBlock.patch_bbox) && validRenderBbox(artifactBlock.fit_bbox)) {
    block = {
      block_id: message.block_id,
      render_mode: "in_place",
      patch_id: artifactBlock.patch_id,
      patch_bbox: [...artifactBlock.patch_bbox],
      fit_bbox: [...artifactBlock.fit_bbox],
      layout_profile: { font_px: message.layout_profile.font_px, line_height: message.layout_profile.line_height },
      reason: null,
    };
  } else if (message.painted === false && message.reason === "fit_failed" && artifactBlock) {
    block = {
      block_id: message.block_id,
      render_mode: "skip",
      patch_id: null,
      patch_bbox: null,
      fit_bbox: validRenderBbox(artifactBlock.fit_bbox) ? [...artifactBlock.fit_bbox] : null,
      layout_profile: null,
      reason: "fit_failed",
    };
  }
  if (!block) return;
  collector.blocks.set(message.block_id, block);
  updateRenderMetric(collector, consumer);
  lruSet(renderOutcomeCollectors, key, collector, 128);
  persistCompletedRender(collector);
}
function invalidateRenderOutcomeConsumers({ requestId = null, port = null } = {}) {
  for (const [key, collector] of renderOutcomeCollectors) {
    for (const [consumerId, consumer] of collector.consumers) {
      if ((requestId !== null && consumer.requestId === requestId) || (port !== null && consumer.port === port)) {
        collector.consumers.delete(consumerId);
      }
    }
    if (!collector.consumers.size && !collector.persisting) renderOutcomeCollectors.delete(key);
  }
}
function invalidateRenderOutcomePage(pageKey) {
  for (const [key, collector] of renderOutcomeCollectors) {
    if (collector.pageKey === pageKey) renderOutcomeCollectors.delete(key);
  }
}
function renderableTranslationEvents(page, artifact) {
  if (!Object.hasOwn(page, "manifest_ids")) return [];
  const artifactById = new Map();
  for (const block of artifact.blocks) {
    if (!block || typeof block.block_id !== "string" || artifactById.has(block.block_id)) {
      const error = new Error("render artifact block IDs must be unique strings");
      error.errorCode = "manifest_mismatch";
      throw error;
    }
    artifactById.set(block.block_id, block);
  }
  if (!page.manifest_ids.every((blockId) => artifactById.has(blockId))) {
    const error = new Error("render artifact does not cover manifest_ids");
    error.errorCode = "manifest_mismatch";
    throw error;
  }
  const cachedLayouts = new Map((page.render?.blocks || []).map((block) => [block.block_id, block]));
  const events = [];
  for (const blockId of page.manifest_ids) {
    const translation = page.blocks.find((block) => block.block_id === blockId);
    const render = artifactById.get(blockId);
    if (!translation || translation.kind !== "text" || typeof translation.trans_text !== "string" || !translation.trans_text.trim()) continue;
    if (render.reason !== null || typeof render.patch_id !== "string" || typeof render.patch_rgba !== "string" ||
        typeof render.patch_mime !== "string" || !validRenderBbox(render.patch_bbox) || !validRenderBbox(render.fit_bbox)) continue;
    const cached = cachedLayouts.get(blockId);
    events.push({
      block_id: blockId,
      bbox: [...translation.bbox],
      src_text: translation.src_text,
      trans_text: translation.trans_text,
      text: translation.trans_text,
      image_w: page.image_w,
      image_h: page.image_h,
      render_artifact_key: artifact.render_artifact_key,
      patch_id: render.patch_id,
      patch_rgba: render.patch_rgba,
      patch_mime: render.patch_mime,
      patch_bbox: [...render.patch_bbox],
      fit_bbox: [...render.fit_bbox],
      vertical: translation.vertical === true,
      layout_fit_version: LAYOUT_FIT_VERSION,
      layout_hint: cached?.patch_id === render.patch_id ? cached.layout_profile : null,
    });
  }
  return events;
}
async function openOcrStream(producer, image) { const form = new FormData(); form.append("analysis_key", producer.analysisKey); form.append("ocr_key", producer.ocrKey); form.append("render_artifact_key", producer.renderArtifactKey); form.append("src_lang", producer.descriptor.src_lang); appendCrop(form, producer.descriptor.crop); if (image) form.append("image", producer.sourceIdentity.blob, "page.png"); return fetch(`${SERVER}/ocr-stream`, { method: "POST", body: form, signal: producer.ocrStage.controller.signal }); }
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
  producer.ocrStage = attachStage(ocrStages, producer.ocrStageKey, producer);
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
      if (response.status === 409 && !producer.ocrRecovery && !producer.retriedAnalysis) {
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
function ocrBlockFromEvent(event) { return { block_id: event.block_id, bbox: event.bbox, src_text: event.src_text ?? event.text, trans_text: null, kind: event.kind ?? null, vertical: event.vertical === true, reading_order: null, state: "ocr_complete" }; }
function sameOcrSnapshot(left, right) {
  const fallbackKinds = new Map(left.map((block) => [block.block_id, block.kind ?? null]));
  const snapshot = (blocks) => blocks.map((block) => ({
    block_id: block.block_id,
    bbox: block.bbox,
    src_text: block.src_text,
    kind: block.kind ?? fallbackKinds.get(block.block_id) ?? null,
    vertical: block.vertical === true,
  })).sort((a, b) => a.block_id < b.block_id ? -1 : a.block_id > b.block_id ? 1 : 0);
  return JSON.stringify(snapshot(left)) === JSON.stringify(snapshot(right));
}
async function applyOcrBlock(producer, event) { const block = ocrBlockFromEvent(event); mark(producer, "first_ocr"); if (!producer.page.blocks.some((row) => row.block_id === block.block_id)) producer.page.blocks.push(block); await persist(producer); }
async function translationKeyForBatch(producer, blocks, block) {
  const contextHash = await hashValue(blocks.map((block, reading_order) => ({
    reading_order,
    block_id: block.block_id,
    src_text: block.src_text,
  })));
  return hashValue([
    producer.ocrKey,
    block.block_id,
    await hashValue(block.src_text),
    contextHash,
    producer.descriptor.dst_lang,
    producer.descriptor.reading_direction,
    producer.page.versions.layout_order,
    producer.page.versions.translator_model,
    producer.page.versions.prompt,
    producer.page.versions.policy,
  ]);
}
function applyTranslation(producer, item) {
  const keys = item && typeof item === "object" ? Object.keys(item).sort() : [];
  const validShape = keys.length === 3 && keys[0] === "id" && keys[1] === "kind" && keys[2] === "translation";
  const validText = item?.kind === "text" && typeof item.translation === "string" && item.translation.trim().length > 0;
  const validSfx = item?.kind === "sfx" && item.translation === null;
  if (!validShape || (!validText && !validSfx)) {
    const error = new Error("invalid translation item");
    error.errorCode = "invalid_response";
    throw error;
  }
  const block = producer.page.blocks.find((row) => row.block_id === item.id);
  if (!block) {
    const error = new Error("translation id set mismatch");
    error.errorCode = "invalid_response";
    throw error;
  }
  block.kind = item.kind;
  block.trans_text = item.translation;
  mark(producer, "first_translation");
  producer.timings.final_translation = now();
  block.state = "translated";
}
function isRateLimited(error) { return error.status === 429 || error.errorCode === "rate_limited"; }
function translationItemsForBlocks(data, blocks) {
  if (!Array.isArray(data?.items)) {
    const error = new Error("translation items must be an array");
    error.errorCode = "invalid_response";
    throw error;
  }
  const expected = new Set(blocks.map((block) => block.block_id));
  const rows = new Map();
  for (const item of data.items) {
    const keys = item && typeof item === "object" ? Object.keys(item).sort() : [];
    const validShape = keys.length === 3 && keys[0] === "id" && keys[1] === "kind" && keys[2] === "translation";
    const validText = item?.kind === "text" && typeof item.translation === "string" && item.translation.trim().length > 0;
    const validSfx = item?.kind === "sfx" && item.translation === null;
    if (!validShape || (!validText && !validSfx) || typeof item.id !== "string" || !expected.has(item.id) || rows.has(item.id)) {
      const error = new Error("translation id set mismatch");
      error.errorCode = "invalid_response";
      throw error;
    }
    rows.set(item.id, item);
  }
  if (rows.size !== blocks.length) {
    const error = new Error("translation id set mismatch");
    error.errorCode = "invalid_response";
    throw error;
  }
  return blocks.map((block) => rows.get(block.block_id));
}
async function translateFullPage(producer, orderedBlocks) {
  if (!orderedBlocks.length) {
    producer.page.manifest_ids = [];
    return { translated: 0, failed: 0 };
  }
  const keyed = await Promise.all(orderedBlocks.map(async (block) => ({
    block,
    key: await translationKeyForBatch(producer, orderedBlocks, block),
  })));
  if (producer.retired || producer.cancelled) return { translated: 0, failed: 0 };
  const cached = keyed.map(({ key }) => hotTranslations.get(key));
  const forceNetwork = producer.forceTranslationNetwork === true;
  producer.forceTranslationNetwork = false;
  if (!forceNetwork && cached.every((item) => item !== undefined)) {
    cached.forEach((item, index) => applyTranslation(producer, { id: keyed[index].block.block_id, ...item }));
    producer.page.manifest_ids = orderedBlocks
      .filter((block) => producer.page.blocks.find((row) => row.block_id === block.block_id)?.kind === "text")
      .map((block) => block.block_id);
    return { translated: orderedBlocks.length, failed: 0 };
  }
  if (producer.retired || producer.cancelled) return { translated: 0, failed: 0 };
  try {
    producer.counters.translation_calls++;
    const started = now();
    const trace = { batch_id: 1, phase: "full_page", block_ids: orderedBlocks.map((block) => block.block_id), block_count: orderedBlocks.length, started_ms: Math.round(started - producer.timings.accepted), duration_ms: null, status: null, cache_hit: false, error_code: null };
    producer.translationBatchTrace.push(trace);
    let translatedItems;
    try {
      const data = await postJson(`${SERVER}/translate-items`, {
        src_lang: producer.descriptor.src_lang,
        dst_lang: producer.descriptor.dst_lang,
        items: orderedBlocks.map((block, reading_order) => ({
          id: block.block_id,
          text: block.src_text,
          reading_order,
          bbox: [...block.bbox],
        })),
        page_width: producer.page.image_w,
        page_height: producer.page.image_h,
        reading_direction: producer.descriptor.reading_direction,
      }, 300000);
      translatedItems = translationItemsForBlocks(data, orderedBlocks);
      trace.status = "success";
    } catch (error) {
      trace.status = isRateLimited(error) ? "rate_limited" : error.errorCode === "invalid_response" ? "invalid_response" : "failed";
      trace.error_code = error.errorCode || (trace.status === "rate_limited" ? "rate_limited" : trace.status === "invalid_response" ? "invalid_response" : "translation_failed");
      throw error;
    } finally {
      trace.duration_ms = Math.max(0, Math.round(now() - started));
    }
    if (producer.cancelled && !producer.retired) return { translated: 0, failed: 0 };
    for (let index = 0; index < translatedItems.length; index++) lruSet(hotTranslations, keyed[index].key, {
      kind: translatedItems[index].kind,
      translation: translatedItems[index].translation,
    }, 2048);
    if (producer.retired || producer.cancelled) return { translated: 0, failed: 0 };
    for (const item of translatedItems) applyTranslation(producer, item);
    producer.page.manifest_ids = orderedBlocks
      .filter((block) => producer.page.blocks.find((row) => row.block_id === block.block_id)?.kind === "text")
      .map((block) => block.block_id);
    return { translated: orderedBlocks.length, failed: 0 };
  } catch (error) {
    if (isRateLimited(error)) producer.counters.rate_limited++;
    if (producer.retired || producer.cancelled) return { translated: 0, failed: 0 };
    producer.page.last_error = String(error);
    for (const block of orderedBlocks) {
      const stored = producer.page.blocks.find((row) => row.block_id === block.block_id);
      if (stored) stored.state = "failed";
      emit(producer, "block_error", { block_id: block.block_id, stage: "translation", code: "translation_failed" });
    }
    return { translated: 0, failed: orderedBlocks.length };
  }
}
function resetProducerForManifestRecovery(producer) {
  releaseProducerStages(producer);
  producer.ocrStageKey = `${producer.ocrKey}:manifest-recovery`;
  producer.ocrStage = null;
  producer.analysisStage = null;
  producer.translationReady = null;
  producer.renderReady = null;
  producer.renderArtifact = null;
  producer.cancelled = false;
  producer.forceTranslationNetwork = true;
  const page = producer.page;
  page.state = "queued";
  page.analysis_known = false;
  page.ocr_done = false;
  page.image_w = null;
  page.image_h = null;
  page.blocks = [];
  delete page.manifest_ids;
  delete page.render;
  page.last_error = null;
}
async function handleManifestMismatch(producer) {
  producer.manifestMismatch = true;
  return serializePageWrite(producer.pageKey, async () => {
    const page = await pageCache.getPage(producer.pageKey);
    if (!page) throw new Error("manifest mismatch page missing from cache");
    if (page.render_artifact_key !== producer.renderArtifactKey ||
        !metadataEqual(page.patch_versions, producer.page.patch_versions)) return "stale";
    if (page.manifest_mismatch_count === 0) {
      page.manifest_mismatch_count = 1;
      await pageCache.putPage(page);
      invalidateRenderOutcomePage(page.page_artifact_key);
      producer.page = page;
      resetProducerForManifestRecovery(producer);
      return "recover";
    }
    producer.page.manifest_mismatch_count = page.manifest_mismatch_count;
    producer.page.render = {
      schema_version: "render-page-v1",
      render_artifact_key: producer.renderArtifactKey,
      patch_versions: serverPatchVersions,
      layout_fit_version: LAYOUT_FIT_VERSION,
      breaker_open: true,
      blocks: [],
    };
    await pageCache.putPage(producer.page);
    invalidateRenderOutcomePage(page.page_artifact_key);
    return "breaker";
  });
}
async function runProducer(producer) {
  mark(producer, "started");
  producer.state = producer.page.state = "running";
  try {
    if (!producer.page.ocr_done) await consumeOcr(producer);
    if (producer.retired) return;
    if (producer.ocrRecovery &&
        (!producer.page.ocr_done || (producer.blockErrors || 0) > 0 || (producer.ocrSummary?.failed || 0) > 0)) {
      const error = new Error("OCR recovery incomplete");
      error.errorCode = "ocr_incomplete";
      throw error;
    }
    if (producer.prewarmOnly) {
      releaseProducerStages(producer);
      producers.delete(producer.pageKey);
      releaseProducerSource(producer);
      producer.jobIds.clear();
      return;
    }
    if (!Number.isInteger(producer.page.image_w) || producer.page.image_w <= 0 ||
        !Number.isInteger(producer.page.image_h) || producer.page.image_h <= 0) {
      const error = new Error("invalid page dimensions");
      error.errorCode = "invalid_page_dimensions";
      throw error;
    }
    let ordered;
    try {
      ordered = MangaReadingOrder.orderPage({
        blocks: producer.page.blocks,
        image_w: producer.page.image_w,
        image_h: producer.page.image_h,
        reading_direction: producer.descriptor.reading_direction,
      });
    } catch (error) {
      error.errorCode ||= "reading_order_failed";
      throw error;
    }
    if (producer.ocrRecovery && sameOcrSnapshot(producer.ocrRecovery.baseline.blocks, producer.page.blocks)) {
      const recovered = producer.page;
      producer.page = JSON.parse(JSON.stringify(producer.ocrRecovery.baseline));
      producer.page.analysis_known = recovered.analysis_known;
      producer.page.ocr_done = true;
      producer.page.image_w = recovered.image_w;
      producer.page.image_h = recovered.image_h;
      producer.page.last_error = null;
      producer.renderArtifact = producer.ocrRecovery.artifact;
      await finishProducer(producer, { translated: producer.ocrRecovery.delivered, failed: 0 });
      return;
    }
    ordered.blocks.forEach((block, readingOrder) => {
      const stored = producer.page.blocks.find((row) => row.block_id === block.block_id);
      if (stored) stored.reading_order = readingOrder;
    });
    producer.renderReady = fetchRenderArtifact(producer)
      .then((artifact) => { producer.timings.render_ready = now(); return artifact; })
      .catch((error) => {
        producer.cancelled = true;
        throw error;
      });
    producer.translationReady = Object.hasOwn(producer.page, "manifest_ids")
      ? Promise.resolve({ translated: producer.page.blocks.length, failed: 0 })
      : translateFullPage(producer, ordered.blocks);
    const [artifact, summary] = await Promise.all([producer.renderReady, producer.translationReady]);
    if (producer.retired) return;
    producer.renderArtifact = artifact;
    const events = renderableTranslationEvents(producer.page, artifact);
    prepareRenderOutcomeCollector(producer.page, artifact, [...producer.consumers.values()], producer);
    for (const event of events) emit(producer, "translation", event);
    await finishProducer(producer, summary);
  } catch (error) {
    if (!producer.retired && !producer.ocrRecovery && error?.errorCode === "manifest_mismatch") {
      try {
        const action = await handleManifestMismatch(producer);
        if (action === "recover") {
          await runProducer(producer);
          return;
        }
        await finishProducer(producer, {
          translated: producer.page.blocks.filter((block) => block.state === "translated").length,
          failed: 0,
        });
        return;
      } catch (claimError) {
        error = claimError;
      }
    }
    if (!producer.retired) await failProducer(producer, error);
  }
}
async function removeProducerJobs(producer) {
  await Promise.all([...producer.jobIds].map((jobId) => pageCache?.removeJob(jobId)));
  producer.jobIds.clear();
}
async function finishProducer(producer, summary) {
  const failed = summary.failed + (producer.blockErrors || 0);
  if (producer.ocrRecovery && failed) {
    await failOcrRecovery(producer, new Error("OCR recovery incomplete"));
    return;
  }
  producer.page.state = failed ? "partial" : "complete";
  if (producer.ocrRecovery) producer.ocrRecovery.committing = true;
  await persist(producer);
  await producer.persistChain;
  if (producer.retired) return;
  const metrics = producerMetrics(producer);
  const recognized = producer.ocrSummary?.recognized ?? producer.page.blocks.length;
  for (const consumer of producer.consumers.values()) terminalJob(requests.get(consumer.requestId), consumer.jobId, consumer.port, failed, false, recognized, metrics, producer.counters, producer, { pageKey: producer.pageKey, acceptedAt: producer.timings.accepted, manifestMismatch: producer.manifestMismatch === true });
  releaseProducerStages(producer);
  if (producers.get(producer.pageKey) === producer) producers.delete(producer.pageKey);
  releaseProducerSource(producer);
  await removeProducerJobs(producer);
}
async function failOcrRecovery(producer, error) {
  const recovery = producer.ocrRecovery;
  producer.page = recovery.baseline;
  if (producer.retired) return;
  const metrics = producerMetrics(producer);
  const errorCode = error?.errorCode || "request_failed";
  const recognized = producer.ocrSummary?.recognized ?? producer.page.blocks.length;
  for (const consumer of producer.consumers.values()) terminalJob(requests.get(consumer.requestId), consumer.jobId, consumer.port, 1, false, recognized, metrics, producer.counters, producer, { pageKey: producer.pageKey, errorCode, acceptedAt: producer.timings.accepted, manifestMismatch: producer.manifestMismatch === true });
  releaseProducerStages(producer);
  if (producers.get(producer.pageKey) === producer) producers.delete(producer.pageKey);
  releaseProducerSource(producer);
  await removeProducerJobs(producer);
}
async function failProducer(producer, error) {
  if (producer.ocrRecovery) {
    await failOcrRecovery(producer, error);
    return;
  }
  producer.page.last_error = String(error);
  producer.page.state = producer.page.analysis_known || producer.page.blocks.length ? "partial" : "failed";
  await persist(producer);
  if (producer.retired) return;
  const metrics = producerMetrics(producer);
  const errorCode = error?.errorCode || "request_failed";
  const recognized = producer.ocrSummary?.recognized ?? producer.page.blocks.length;
  for (const consumer of producer.consumers.values()) terminalJob(requests.get(consumer.requestId), consumer.jobId, consumer.port, 1, false, recognized, metrics, producer.counters, producer, { pageKey: producer.pageKey, errorCode, acceptedAt: producer.timings.accepted, manifestMismatch: producer.manifestMismatch === true });
  releaseProducerStages(producer);
  if (producers.get(producer.pageKey) === producer) producers.delete(producer.pageKey);
  releaseProducerSource(producer);
  await removeProducerJobs(producer);
}
function removeQueuedTasks(producer) { for (const task of taskQueue) if (task.producer === producer) task.cancelled = () => true; }
function demoteQueuedTasks(producer) {
  for (const task of taskQueue) if (task.producer === producer) task.tier = PRIORITY.background;
  taskQueue.sort(compareTasks);
}
function releaseStage(map, key, pageKey) { const stage = map.get(key); if (!stage) return; stage.consumers.delete(pageKey); if (!stage.consumers.size) { stage.controller.abort(); map.delete(key); } }
function releaseOcrConsumer(producer) {
  const stageKey = producer.ocrStageKey || producer.ocrKey;
  const stage = ocrStages.get(stageKey);
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
  ocrStages.delete(stageKey);
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
  removeQueuedTasks(producer);
  releaseProducerStages(producer);
  releaseProducerSource(producer);
  if (producers.get(producer.pageKey) === producer) producers.delete(producer.pageKey);
  if (pageCache && persistArtifact && !producer.ocrRecovery) {
    const page = producer.page;
    const useful = page.analysis_known || page.blocks.length;
    void producer.persistChain.then(() => serializePageWrite(producer.pageKey, async () => {
      const current = await pageCache.getPage(producer.pageKey);
      if (!current || current.render_artifact_key !== producer.renderArtifactKey ||
          !metadataEqual(current.patch_versions, page.patch_versions)) return;
      if (useful) await pageCache.putPage({ ...page, state: "partial" });
      else await pageCache.removePage(producer.pageKey);
    }))
      .catch(() => {})
      .finally(() => removeProducerJobs(producer));
  } else {
    producer.jobIds.clear();
  }
}
function releaseRequest(requestId, replacement = null) {
  invalidateRenderOutcomeConsumers({ requestId });
  const request = requests.get(requestId);
  if (!request) return;
  const cancelStartedAt = now();
  request.connected = false;
  for (const [jobId] of request.sourceAcquisitions) {
    const descriptor = request.sourceDescriptors.get(jobId);
    const replacementDescriptor = descriptor && replacement?.jobsBySourceCrop.get(sourceCropKey(descriptor));
    if (request.scope === "visible" && !replacementDescriptor) continue;
    request.cancelledSourceJobs.add(jobId);
    releasePendingSource(request, jobId);
    if (replacementDescriptor) void pageCache?.removeJob(jobId);
  }
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
    row.request.cancelledSourceJobs.add(row.descriptor.job_id);
    row.sourceAcquisition?.release();
    void pageCache?.removeJob(row.descriptor.job_id);
  }
  request.cancelLatencyMs = Math.round(now() - cancelStartedAt);
  recordMetrics(request.requestId, { ...scopeMetrics(request), cancel_latency_ms: request.cancelLatencyMs, page_metrics: request.metricRows, counter_records: new Set([...request.countedCounterProducers, ...releasedProducers].map((producer) => producer.counters)) });
  request.port = null;
  requests.delete(requestId);
}
function disconnectPort(port) { ports.delete(port); invalidateRenderOutcomeConsumers({ port }); for (const request of requests.values()) if (request.port === port) releaseRequest(request.requestId); }
function offlineLedger(job) {
  job.descriptor.reading_direction = normalizeReadingDirection(job.descriptor.reading_direction);
  let request = requests.get(job.request_id);
  if (!request) {
    request = createRequest(null, { request_id: job.request_id, scope: "visible", src_lang: job.src_lang, dst_lang: job.dst_lang, jobs: [job.descriptor] });
    request.connected = false;
    requests.set(request.requestId, request);
  } else {
    request.expectedJobIds.add(job.descriptor.job_id);
    if (!request.deliveredByJob.has(job.descriptor.job_id)) request.deliveredByJob.set(job.descriptor.job_id, new Set());
    request.jobsBySourceCrop.set(sourceCropKey(job.descriptor), job.descriptor);
  }
  return { request, descriptor: job.descriptor, ledger: job };
}
function restoreProducer(job) { try { offlineJobs.push(offlineLedger(job)); } catch { void pageCache?.removeJob(job.job_id); } }
async function resumeOfflineJobs() {
  const jobs = offlineJobs.splice(0);
  for (const row of jobs) {
    row.sourceStartedAt ??= now();
    row.sourceAcquisition ??= sourcePool.acquire(row.descriptor.source_url);
    row.request.sourceAcquisitions.set(row.descriptor.job_id, row.sourceAcquisition);
    row.request.sourceDescriptors.set(row.descriptor.job_id, row.descriptor);
  }
  for (const row of jobs) {
    try {
      row.sourceIdentity ??= await row.sourceAcquisition.promise;
      row.descriptor.source_fetch_ms = Math.max(0, now() - row.sourceStartedAt);
      await attachDescriptor(row.request, row.descriptor, row.ledger, row.sourceIdentity, row.sourceAcquisition);
      admitRequestJobs(row.request);
    } catch (error) {
      releasePendingSource(row.request, row.descriptor.job_id);
      if (row.request.cancelledSourceJobs.has(row.descriptor.job_id)) continue;
      const code = row.sourceIdentity ?
        (typeof CacheFullError !== "undefined" && error instanceof CacheFullError ? "cache_full" : "request_failed") :
        "source_unavailable";
      completeJob(row.request, row.descriptor.job_id, 0, 1, false,
        code === "source_unavailable" ? { fetch_ms: Math.max(0, now() - row.sourceStartedAt) } : null,
        null, null, { pageKey: row.descriptor.page_artifact_key, errorCode: code });
    }
  }
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
      if (message.type === "render_metric") {
        collectRenderOutcome(port, message);
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
