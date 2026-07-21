const MIN_SIZE = 400; // lọc banner/avatar/icon theo spec

let enabled = true;
let srcLang = "ja";
let dstLang = "vi";

const done = new WeakSet(); // ảnh đã dịch xong — bấm nút lần nữa sẽ bỏ qua; ảnh LỖI không vào đây nên được thử lại
const overlays = new Map(); // img -> { container, data }

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
    translatePage().then(sendResponse);
    return true; // async response
  }
});

function eligible(img) {
  return img.naturalWidth >= MIN_SIZE && img.naturalHeight >= MIN_SIZE && (img.currentSrc || img.src);
}

// Nút "Dịch trang này": OCR mọi ảnh đã load (local, miễn phí) rồi gom toàn bộ
// text vào MỘT call Gemini duy nhất — không bao giờ chạm rate limit nữa.
async function translatePage() {
  const imgs = [...document.querySelectorAll("img")].filter(
    (img) => img.complete && eligible(img) && !done.has(img)
  );
  if (!imgs.length) return { ok: true, images: 0, blocks: 0 };

  // background giới hạn 2 request /ocr đồng thời
  const ocrResults = await Promise.all(
    imgs.map((img) =>
      chrome.runtime.sendMessage({
        type: "ocrImage",
        url: img.currentSrc || img.src,
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
    slots.push({ img: imgs[i], data: res, indices });
  });

  if (!texts.length) {
    for (const s of slots) done.add(s.img); // ảnh không có chữ — xong luôn
    return { ok: true, images: slots.length, blocks: 0 };
  }

  const tr = await chrome.runtime.sendMessage({ type: "translateTexts", texts, srcLang, dstLang });
  if (!tr || !tr.ok) return { ok: false, error: tr ? tr.error : "mất kết nối background" };

  for (const s of slots) {
    s.data.blocks.forEach((b, j) => (b.trans_text = tr.translations[s.indices[j]]));
    if (s.data.blocks.length) renderOverlay(s.img, s.data);
    done.add(s.img);
  }
  return { ok: true, images: slots.length, blocks: texts.length };
}

// ---- overlay ----

function renderOverlay(img, data) {
  const old = overlays.get(img);
  if (old) old.container.remove();

  const container = document.createElement("div");
  container.className = "mt-overlay";
  if (!enabled) container.style.display = "none";
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
