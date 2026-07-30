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
  return a.tier - b.tier || a.distance - b.distance || a.sequence - b.sequence;
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
    fetch(`${SERVER}/health`)
      .then((r) => r.json())
      .then((d) => sendResponse({ ok: true, ...d }))
      .catch(() => sendResponse({ ok: false }));
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

function releaseRequest() {}

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
