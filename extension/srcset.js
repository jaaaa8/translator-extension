// Chọn nguồn ảnh full-res. currentSrc có thể trỏ biến thể srcset NHỎ khi trang
// hiển thị ảnh trong khung nhỏ → OCR nhận pixel thấp → vỡ chữ. Ưu tiên ứng viên
// srcset có descriptor lớn nhất; ngược lại img.src (URL gốc, không descriptor).
function bestSource(img) {
  const set = img.srcset || (img.getAttribute && img.getAttribute("srcset"));
  if (set) {
    let best = null;
    let bestW = -1;
    for (const part of set.split(",")) {
      const [url, desc] = part.trim().split(/\s+/);
      if (!url) continue;
      const wt = desc ? parseFloat(desc) : 1; // "1280w"/"2x" → 1280/2; không desc → 1
      if (wt > bestW) {
        bestW = wt;
        best = url;
      }
    }
    if (best) return new URL(best, img.baseURI || "http://localhost/").href;
  }
  if (img.parentElement && img.parentElement.tagName === "PICTURE" && img.currentSrc) return img.currentSrc;
  return img.src || img.currentSrc;
}

function eligible(img, minSize = 400) {
  return img.naturalWidth >= minSize && img.naturalHeight >= minSize && Boolean(bestSource(img));
}

function isViewportVisible(img, viewportWidth, viewportHeight) {
  const rect = img.getBoundingClientRect();
  return Boolean(
    img.getClientRects().length &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < viewportHeight &&
      rect.left < viewportWidth
  );
}

function isCurrentSource(img, source) {
  return img.isConnected && bestSource(img) === source;
}

function selectCandidates(images, scope, translated, viewportWidth, viewportHeight, minSize = 400) {
  if (scope !== "loaded" && scope !== "visible") throw new Error(`scope không hỗ trợ: ${scope}`);

  const jobs = [];
  for (const img of images) {
    if (!img.complete || !eligible(img, minSize)) continue;
    const source = bestSource(img);
    if (translated.get(img) === source) continue;
    if (scope === "visible" && !isViewportVisible(img, viewportWidth, viewportHeight)) continue;
    jobs.push({ img, source });
  }
  return jobs;
}

if (typeof module !== "undefined") {
  module.exports = { bestSource, eligible, isViewportVisible, isCurrentSource, selectCandidates };
}
