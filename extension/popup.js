const $ = (id) => document.getElementById(id);
let srcLang = "ja";
let settingsLoaded = false;
let healthLoaded = false;
let serverHealthy = false;
let initialPrewarmed = false;

function uiDirection(value) {
  return value === "ltr" ? "ltr" : "rtl";
}

function refreshCurrentLanguages() {
  $("currentLanguages").textContent = `${$("srcLang").value.toUpperCase()} → ${$("dstLang").value.toUpperCase()} · ${$("readingDirection").value.toUpperCase()}`;
}

function prewarmPage(requestSrcLang) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: "prewarmPage", srcLang: requestSrcLang }, () => void chrome.runtime.lastError);
  });
}

function prewarmInitialPage() {
  if (initialPrewarmed || !settingsLoaded || !healthLoaded || !serverHealthy) return;
  initialPrewarmed = true;
  prewarmPage(srcLang);
}

chrome.storage.local.get(["enabled", "srcLang", "dstLang", "readingDirection"]).then((v) => {
  $("enabled").checked = v.enabled !== false;
  srcLang = v.srcLang || "ja";
  $("srcLang").value = srcLang;
  $("dstLang").value = v.dstLang || "vi";
  $("readingDirection").value = uiDirection(v.readingDirection);
  refreshCurrentLanguages();
  settingsLoaded = true;
  prewarmInitialPage();
});

$("enabled").onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
$("srcLang").onchange = (e) => {
  srcLang = e.target.value;
  chrome.storage.local.set({ srcLang });
  refreshCurrentLanguages();
  if (serverHealthy) prewarmPage(srcLang);
};
$("dstLang").onchange = (e) => {
  chrome.storage.local.set({ dstLang: e.target.value });
  refreshCurrentLanguages();
};
$("readingDirection").onchange = (e) => {
  const readingDirection = uiDirection(e.target.value);
  $("readingDirection").value = readingDirection;
  chrome.storage.local.set({ readingDirection });
  refreshCurrentLanguages();
};

chrome.runtime.sendMessage({ type: "health" }).then((res) => {
  const ok = res && res.ok;
  healthLoaded = true;
  serverHealthy = ok;
  $("status").textContent = ok ? `● server: ${res.device}` : "● server offline";
  $("status").style.color = ok ? "#2a2" : "#d33";
  prewarmInitialPage();
});

async function refreshPageStatus() {
  const state = await chrome.runtime.sendMessage({ type: "pageStatus" });
  const value = state || { background: 0, cached: 0, failed: 0 };
  $("cacheStatus").textContent =
    `Đang dịch nền: ${value.background} · Đã cache: ${value.cached} · Lỗi: ${value.failed}`;
}

refreshPageStatus();

let actionSequence = 0;

function translate(scope) {
  const action = ++actionSequence;
  const message = {
    type: "translatePage",
    scope,
    srcLang: $("srcLang").value,
    dstLang: $("dstLang").value,
    readingDirection: $("readingDirection").value,
  };
  $("result").textContent = "đang dịch…";
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, message, (res) => {
      if (action !== actionSequence) return;
      if (chrome.runtime.lastError) {
        $("result").textContent = "không kết nối được trang — F5 trang rồi thử lại";
        return;
      }
      if (res && res.ok && res.cacheHit) {
        $("result").textContent = "Khôi phục từ cache";
      } else {
        $("result").textContent = res && res.ok
          ? `xong: ${res.images} ảnh, ${res.blocks} thoại, ${res.failed || 0} lỗi`
          : `lỗi: ${res ? res.error : "?"}`;
      }
      void refreshPageStatus();
    });
  });
}

$("translateLoaded").onclick = () => translate("loaded");
$("translateVisible").onclick = () => translate("visible");
