const $ = (id) => document.getElementById(id);
let srcLang = "ja";
let settingsLoaded = false;
let healthLoaded = false;
let serverHealthy = false;
let initialPrewarmed = false;

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

chrome.storage.local.get(["enabled", "srcLang", "dstLang"]).then((v) => {
  $("enabled").checked = v.enabled !== false;
  srcLang = v.srcLang || "ja";
  $("srcLang").value = srcLang;
  $("dstLang").value = v.dstLang || "vi";
  settingsLoaded = true;
  prewarmInitialPage();
});

$("enabled").onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
$("srcLang").onchange = (e) => {
  srcLang = e.target.value;
  chrome.storage.local.set({ srcLang });
  if (serverHealthy) prewarmPage(srcLang);
};
$("dstLang").onchange = (e) => chrome.storage.local.set({ dstLang: e.target.value });

chrome.runtime.sendMessage({ type: "health" }).then((res) => {
  const ok = res && res.ok;
  healthLoaded = true;
  serverHealthy = ok;
  $("status").textContent = ok ? `● server: ${res.device}` : "● server offline";
  $("status").style.color = ok ? "#2a2" : "#d33";
  prewarmInitialPage();
});

const actions = [$("translateLoaded"), $("translateVisible")];

function setActionsDisabled(disabled) {
  for (const button of actions) button.disabled = disabled;
}

function translate(scope) {
  setActionsDisabled(true);
  $("result").textContent = "đang dịch… (OCR local + 1 call Gemini)";
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.tabs.sendMessage(tab.id, { type: "translatePage", scope }, (res) => {
      setActionsDisabled(false);
      if (chrome.runtime.lastError) {
        $("result").textContent = "không kết nối được trang — F5 trang rồi thử lại";
        return;
      }
      $("result").textContent =
        res && res.ok ? `xong: ${res.images} ảnh, ${res.blocks} thoại` : `lỗi: ${res ? res.error : "?"}`;
    });
  });
}

$("translateLoaded").onclick = () => translate("loaded");
$("translateVisible").onclick = () => translate("visible");
