const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["enabled", "srcLang", "dstLang"]).then((v) => {
  $("enabled").checked = v.enabled !== false;
  $("srcLang").value = v.srcLang || "ja";
  $("dstLang").value = v.dstLang || "vi";
});

$("enabled").onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
$("srcLang").onchange = (e) => chrome.storage.local.set({ srcLang: e.target.value });
$("dstLang").onchange = (e) => chrome.storage.local.set({ dstLang: e.target.value });

chrome.runtime.sendMessage({ type: "health" }).then((res) => {
  const ok = res && res.ok;
  $("status").textContent = ok ? `● server: ${res.device}` : "● server offline";
  $("status").style.color = ok ? "#2a2" : "#d33";
});

$("go").onclick = () => {
  $("go").disabled = true;
  $("result").textContent = "đang dịch… (OCR local + 1 call Gemini)";
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.tabs.sendMessage(tab.id, { type: "translatePage" }, (res) => {
      $("go").disabled = false;
      if (chrome.runtime.lastError) {
        $("result").textContent = "không kết nối được trang — F5 trang rồi thử lại";
        return;
      }
      $("result").textContent =
        res && res.ok ? `xong: ${res.images} ảnh, ${res.blocks} thoại` : `lỗi: ${res ? res.error : "?"}`;
    });
  });
};
