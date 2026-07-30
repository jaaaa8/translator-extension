if (typeof importScripts === "function") importScripts("page-cache.js");

const SERVER = "http://127.0.0.1:8910";
const MAX_CONCURRENT = 2;

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
    const data = await postJson(`${SERVER}/translate-texts`, null, {
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

async function postJson(url, form, json, timeout = 60000) {
  const resp = await fetch(url, {
    method: "POST",
    body: form || JSON.stringify(json),
    headers: form ? undefined : { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeout),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

function badge() {
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#d33" });
}
