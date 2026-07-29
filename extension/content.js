const MIN_SIZE = 400; // lọc banner/avatar/icon theo spec

let enabled = true;
let srcLang = "ja";
let dstLang = "vi";

const translated = new WeakMap(); // img -> bestSource đã hoàn tất
const manualRequests = new WeakMap(); // img -> newest manual action token
const overlays = new Map(); // img -> owned overlay state
let pruneFrame = 0;

chrome.storage.local.get(["enabled", "srcLang", "dstLang"]).then((v) => {
  enabled = v.enabled !== false;
  srcLang = v.srcLang || "ja";
  dstLang = v.dstLang || "vi";
});

chrome.storage.onChanged.addListener((ch) => {
  if (ch.srcLang) srcLang = ch.srcLang.newValue;
  if (ch.dstLang) dstLang = ch.dstLang.newValue;
  if (ch.enabled) {
    enabled = ch.enabled.newValue;
    // ẩn/hiện thay vì xóa — bật lại không tốn call dịch mới
    for (const { container } of overlays.values())
      container.style.display = enabled ? "" : "none";
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "translatePage") {
    translatePage(msg.scope).then(sendResponse);
    return true; // async response
  }
  if (msg.type === "prewarmPage") {
    prewarmPage(msg.srcLang);
    sendResponse({ ok: true });
  }
});

function requestOcr(job, requestSrcLang, prewarm = false) {
  const message = { type: "ocrImage", url: job.source, srcLang: requestSrcLang };
  if (job.crop) message.crop = job.crop;
  if (prewarm) message.prewarm = true;
  return chrome.runtime.sendMessage(message);
}

async function prewarmPage(requestSrcLang) {
  try {
    const jobs = selectCandidates(
      document.querySelectorAll("img"),
      "visible",
      translated,
      innerWidth,
      innerHeight,
      requestSrcLang,
      MIN_SIZE
    );
    let selected = null;
    for (const job of jobs) {
      if (!selected || visibleArea(job.img, innerWidth, innerHeight) > visibleArea(selected.img, innerWidth, innerHeight)) {
        selected = job;
      }
    }
    if (!selected) return;
    const result = await requestOcr(selected, requestSrcLang, true);
    if (!result || !result.ok) console.warn("[MangaTranslator] prewarm:", result && result.error);
  } catch (error) {
    console.warn("[MangaTranslator] prewarm:", error);
  }
}

// Both manual actions batch local OCR results into one Gemini request.
async function translatePage(scope) {
  const requestSrcLang = srcLang;
  const requestDstLang = dstLang;
  const queriedImages = document.querySelectorAll("img");
  let jobs;
  try {
    jobs = selectCandidates(
      queriedImages,
      scope,
      translated,
      innerWidth,
      innerHeight,
      requestSrcLang,
      MIN_SIZE
    );
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  const request = {};
  for (const img of queriedImages) {
    if (scope === "loaded" || isViewportVisible(img, innerWidth, innerHeight)) manualRequests.set(img, request);
  }
  if (!jobs.length) return { ok: true, images: 0, blocks: 0 };

  // background giới hạn 2 request /ocr đồng thời
  const ocrResults = await Promise.all(jobs.map((job) => requestOcr(job, requestSrcLang)));

  const texts = [];
  const slots = []; // ảnh OCR thành công + vị trí text của nó trong mảng chung
  ocrResults.forEach((res, i) => {
    if (!res || !res.ok) {
      if (res) console.warn("[MangaTranslator] ocr:", res.error);
      return; // không done → lần bấm sau thử lại
    }
    const indices = res.blocks.map((b) => texts.push(b.src_text) - 1);
    slots.push({ ...jobs[i], data: res, indices });
  });

  if (!texts.length) {
    let images = 0;
    for (const slot of slots) {
      if (manualRequests.get(slot.img) !== request || !isCurrentSource(slot.img, slot.source, scope)) continue;
      removeOverlay(slot.img);
      translated.set(slot.img, slot.key);
      images++;
    }
    return { ok: true, images, blocks: 0 };
  }

  const tr = await chrome.runtime.sendMessage({
    type: "translateTexts",
    texts,
    srcLang: requestSrcLang,
    dstLang: requestDstLang,
  });
  if (!tr || !tr.ok) return { ok: false, error: tr ? tr.error : "mất kết nối background" };

  let images = 0;
  let blocks = 0;
  for (const slot of slots) {
    if (manualRequests.get(slot.img) !== request || !isCurrentSource(slot.img, slot.source, scope)) continue;
    slot.data.blocks.forEach((block, i) => (block.trans_text = tr.translations[slot.indices[i]]));
    if (slot.data.blocks.length) renderOverlay(slot.img, slot.data, slot.source, scope);
    else removeOverlay(slot.img);
    translated.set(slot.img, slot.key);
    images++;
    blocks += slot.data.blocks.length;
  }
  return { ok: true, images, blocks };
}

// ---- overlay ----

function removeOverlay(img) {
  const overlay = overlays.get(img);
  if (!overlay) return;
  overlay.resizeObserver.disconnect();
  if (overlay.intersectionObserver) overlay.intersectionObserver.disconnect();
  overlay.container.remove();
  overlays.delete(img);
  translated.delete(img);
}

function pruneOverlays() {
  for (const [img, overlay] of overlays) {
    if (!isCurrentSource(img, overlay.source, overlay.scope)) removeOverlay(img);
  }
}

function schedulePrune() {
  if (pruneFrame) return;
  pruneFrame = requestAnimationFrame(() => {
    pruneFrame = 0;
    pruneOverlays();
  });
}

function renderOverlay(img, data, source, scope) {
  removeOverlay(img);

  const container = document.createElement("div");
  container.className = "mt-overlay";
  if (!enabled) container.style.display = "none";
  for (const block of data.blocks) {
    const element = document.createElement("div");
    element.className = "mt-bubble";
    element.textContent = block.trans_text;
    container.appendChild(element);
  }
  document.body.appendChild(container);

  const resizeObserver = new ResizeObserver(() => position(img));
  const intersectionObserver =
    scope === "visible"
      ? new IntersectionObserver(([entry]) => {
          if (
            overlays.get(img)?.intersectionObserver === intersectionObserver &&
            !entry.isIntersecting
          ) removeOverlay(img);
        })
      : null;

  overlays.set(img, { container, data, source, scope, resizeObserver, intersectionObserver });
  position(img);
  resizeObserver.observe(img);
  if (intersectionObserver) intersectionObserver.observe(img);
}

// Định vị theo TỌA ĐỘ TÀI LIỆU (spec): container absolute với top/left = vị trí
// ảnh + scroll hiện tại → trình duyệt tự cuộn overlay cùng ảnh, không cần scroll listener.
function position(img) {
  const o = overlays.get(img);
  if (!o) return;
  const r = img.getBoundingClientRect();
  o.container.style.left = r.left + scrollX + "px";
  o.container.style.top = r.top + scrollY + "px";
  o.container.style.width = r.width + "px";
  o.container.style.height = r.height + "px";

  const scaleX = r.width / o.data.image_w;
  const scaleY = r.height / o.data.image_h;
  o.data.blocks.forEach((b, i) => {
    const [x, y, w, h] = b.bbox;
    const el = o.container.children[i];
    el.style.left = x * scaleX + "px";
    el.style.top = y * scaleY + "px";
    el.style.width = w * scaleX + "px";
    el.style.height = h * scaleY + "px";
    fitText(el);
  });
}

// Auto-fit: giảm font tới khi chữ nằm gọn trong bubble, sàn 10px (spec)
function fitText(el) {
  let size = 18;
  el.style.fontSize = size + "px";
  while (size > 10 && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) {
    size--;
    el.style.fontSize = size + "px";
  }
}

function repositionOverlays() {
  schedulePrune();
  for (const img of overlays.keys()) position(img);
}

new MutationObserver(schedulePrune).observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["src", "srcset", "sizes", "media", "type"],
});

new ResizeObserver(repositionOverlays).observe(document.documentElement);
window.addEventListener("resize", repositionOverlays);
