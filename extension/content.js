const MIN_SIZE = 400; // lọc banner/avatar/icon theo spec

let enabled = true;
let srcLang = "ja";
let dstLang = "vi";

const processed = new WeakSet(); // ảnh đã gửi dịch (kể cả kết quả rỗng — không gửi lại)
const overlays = new Map(); // img -> { container, data }

chrome.storage.local.get(["enabled", "srcLang", "dstLang"]).then((v) => {
  enabled = v.enabled !== false;
  srcLang = v.srcLang || "ja";
  dstLang = v.dstLang || "vi";
  if (enabled) start();
});

chrome.storage.onChanged.addListener((ch) => {
  if (ch.srcLang) srcLang = ch.srcLang.newValue;
  if (ch.dstLang) dstLang = ch.dstLang.newValue;
  if (ch.enabled) {
    enabled = ch.enabled.newValue;
    if (enabled) start();
    else stop();
  }
});

// ---- phát hiện ảnh ----

const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        io.unobserve(e.target);
        translateImage(e.target);
      }
    }
  },
  { rootMargin: "800px 0px" } // spec: dịch trước khi ảnh vào màn hình
);

const mo = new MutationObserver((muts) => {
  for (const m of muts)
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.tagName === "IMG") watch(n);
      else if (n.querySelectorAll) for (const img of n.querySelectorAll("img")) watch(img);
    }
});

function eligible(img) {
  return img.naturalWidth >= MIN_SIZE && img.naturalHeight >= MIN_SIZE && (img.currentSrc || img.src);
}

function watch(img) {
  if (processed.has(img)) return;
  if (img.complete) {
    if (eligible(img)) io.observe(img);
  } else {
    img.addEventListener("load", () => watch(img), { once: true });
  }
}

function start() {
  for (const img of document.querySelectorAll("img")) watch(img);
  mo.observe(document.body, { childList: true, subtree: true });
}

function stop() {
  io.disconnect();
  mo.disconnect();
  for (const { container } of overlays.values()) container.remove();
  overlays.clear();
}

// ---- dịch + overlay ----

async function translateImage(img) {
  if (processed.has(img)) return;
  processed.add(img);
  const res = await chrome.runtime.sendMessage({
    type: "translateImage",
    url: img.currentSrc || img.src,
    srcLang,
    dstLang,
  });
  if (!enabled || !res || !res.ok) {
    if (res && !res.ok) console.warn("[MangaTranslator]", res.error);
    return;
  }
  if (res.blocks.length) renderOverlay(img, res);
}

function renderOverlay(img, data) {
  const container = document.createElement("div");
  container.className = "mt-overlay";
  for (const b of data.blocks) {
    const el = document.createElement("div");
    el.className = "mt-bubble";
    el.textContent = b.trans_text;
    container.appendChild(el);
  }
  document.body.appendChild(container);
  overlays.set(img, { container, data });
  position(img);
  new ResizeObserver(() => position(img)).observe(img);
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

// Layout trang xê dịch (trang chèn nội dung, đổi cỡ cửa sổ) → reposition tất cả
new ResizeObserver(() => {
  for (const img of overlays.keys()) position(img);
}).observe(document.documentElement);
window.addEventListener("resize", () => {
  for (const img of overlays.keys()) position(img);
});
