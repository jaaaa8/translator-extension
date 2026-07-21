const SERVER = "http://127.0.0.1:8910";
const MAX_CONCURRENT = 2;

// ponytail: cache trong memory của service worker — mất khi worker ngủ,
// nâng lên chrome.storage.session nếu thấy dịch lại nhiều
const cache = new Map(); // key: url|src|dst -> payload
const queue = [];
let active = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "translateImage") {
    queue.push({ msg, sendResponse });
    pump();
    return true; // giữ kênh trả lời async
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
    handle(job.msg)
      .then((res) => job.sendResponse(res))
      .catch((e) => job.sendResponse({ ok: false, error: String(e) }))
      .finally(() => {
        active--;
        pump();
      });
  }
}

async function handle({ url, srcLang, dstLang }) {
  const key = `${url}|${srcLang}|${dstLang}`;
  if (cache.has(key)) return { ok: true, ...cache.get(key) };

  const imgResp = await fetch(url);
  if (!imgResp.ok) throw new Error(`fetch ảnh: HTTP ${imgResp.status}`);
  const blob = await imgResp.blob();

  const form = new FormData();
  form.append("image", blob, "page.png");
  form.append("src_lang", srcLang);
  form.append("target_lang", dstLang);

  const data = await postWithRetry(form);
  cache.set(key, data);
  chrome.action.setBadgeText({ text: "" }); // thành công → xóa cảnh báo
  return { ok: true, ...data };
}

async function postWithRetry(form) {
  try {
    return await post(form);
  } catch (e) {
    await new Promise((r) => setTimeout(r, 3000)); // spec: retry 1 lần sau 3s
    try {
      return await post(form);
    } catch (e2) {
      badge();
      throw e2;
    }
  }
}

async function post(form) {
  const resp = await fetch(`${SERVER}/translate`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60000), // spec: timeout 60s/ảnh
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

function badge() {
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#d33" });
}
