const MIN_SIZE = 400; // lọc banner/avatar/icon theo spec

let enabled = true;
let srcLang = "ja";
let dstLang = "vi";

const translated = new WeakMap(); // img -> bestSource đã hoàn tất
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
});

// Nút "Dịch trang này": OCR mọi ảnh đã load (local, miễn phí) rồi gom toàn bộ
// text vào MỘT call Gemini duy nhất — không bao giờ chạm rate limit nữa.
async function translatePage(scope) {
  let jobs;
  try {
    jobs = selectCandidates(
      document.querySelectorAll("img"),
      scope,
      translated,
      innerWidth,
      innerHeight,
      MIN_SIZE
    );
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  if (!jobs.length) return { ok: true, images: 0, blocks: 0 };

  // background giới hạn 2 request /ocr đồng thời
  const ocrResults = await Promise.all(
    jobs.map(({ source }) =>
      chrome.runtime.sendMessage({
        type: "ocrImage",
        url: source,
        srcLang,
      })
    )
  );

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
      if (!isCurrentSource(slot.img, slot.source)) continue;
      translated.set(slot.img, slot.source);
      images++;
    }
    return { ok: true, images, blocks: 0 };
  }

  const tr = await chrome.runtime.sendMessage({ type: "translateTexts", texts, srcLang, dstLang });
  if (!tr || !tr.ok) return { ok: false, error: tr ? tr.error : "mất kết nối background" };

  let images = 0;
  let blocks = 0;
  for (const slot of slots) {
    if (!isCurrentSource(slot.img, slot.source)) continue;
    slot.data.blocks.forEach((block, i) => (block.trans_text = tr.translations[slot.indices[i]]));
    if (slot.data.blocks.length) renderOverlay(slot.img, slot.data, slot.source, scope);
    translated.set(slot.img, slot.source);
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
    if (!isCurrentSource(img, overlay.source)) removeOverlay(img);
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

  const scale = r.width / img.naturalWidth; // bbox theo pixel ảnh gốc (spec)
  o.data.blocks.forEach((b, i) => {
    const [x, y, w, h] = b.bbox;
    const el = o.container.children[i];
    el.style.left = x * scale + "px";
    el.style.top = y * scale + "px";
    el.style.width = w * scale + "px";
    el.style.height = h * scale + "px";
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
