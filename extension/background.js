const SERVER = "http://127.0.0.1:8910";
const MAX_CONCURRENT = 2;

// ponytail: cache OCR trong memory của service worker — mất khi worker ngủ,
// nâng lên chrome.storage.session nếu thấy OCR lại nhiều
const ocrCache = new Map(); // key: url|src -> payload
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

async function ocrImage({ url, srcLang }) {
  const key = `${url}|${srcLang}`;
  if (ocrCache.has(key)) return { ok: true, ...ocrCache.get(key) };

  const imgResp = await fetch(url);
  if (!imgResp.ok) throw new Error(`fetch ảnh: HTTP ${imgResp.status}`);
  const blob = await imgResp.blob();

  const form = new FormData();
  form.append("image", blob, "page.png");
  form.append("src_lang", srcLang);

  const data = await postJson(`${SERVER}/ocr`, form);
  ocrCache.set(key, data);
  return { ok: true, ...data };
}

// 1 call Gemini cho toàn bộ text của trang — không retry phía extension
// (translator phía server đã tự retry khi JSON lệch; 429 thì retry vô ích)
async function translateTexts({ texts, srcLang, dstLang }) {
  const data = await postJson(`${SERVER}/translate-texts`, null, {
    texts,
    src_lang: srcLang,
    target_lang: dstLang,
  });
  chrome.action.setBadgeText({ text: "" }); // thành công → xóa cảnh báo
  return { ok: true, ...data };
}

async function postJson(url, form, json) {
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      body: form || JSON.stringify(json),
      headers: form ? undefined : { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60000), // spec: timeout 60s
    });
  } catch (e) {
    badge();
    throw e;
  }
  const data = await resp.json();
  if (!resp.ok) {
    badge();
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return data;
}

function badge() {
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#d33" });
}
