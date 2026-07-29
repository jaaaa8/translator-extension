// Chọn nguồn ảnh full-res. currentSrc có thể trỏ biến thể srcset NHỎ khi trang
// hiển thị ảnh trong khung nhỏ → OCR nhận pixel thấp → vỡ chữ. Ưu tiên ứng viên
// srcset có descriptor lớn nhất; ngược lại img.src (URL gốc, không descriptor).
function bestSource(img) {
  const picture = img.parentElement && img.parentElement.tagName === "PICTURE" ? img.parentElement : null;
  const current = picture && img.currentSrc && new URL(img.currentSrc, img.baseURI || "http://localhost/").href;
  const elements = picture && picture.querySelectorAll ? [...picture.querySelectorAll("source"), img] : [img];
  for (const element of elements) {
    const set = element.srcset || (element.getAttribute && element.getAttribute("srcset"));
    if (!set) continue;
    let best = null;
    let bestW = -1;
    let selected = false;
    for (const part of set.split(",")) {
      const [url, desc] = part.trim().split(/\s+/);
      if (!url) continue;
      const resolved = new URL(url, element.baseURI || img.baseURI || "http://localhost/").href;
      if (resolved === current) selected = true;
      const wt = desc ? parseFloat(desc) : 1; // "1280w"/"2x" → 1280/2; không desc → 1
      if (wt > bestW) {
        bestW = wt;
        best = resolved;
      }
    }
    if (best && (!picture || selected)) return best;
  }
  if (picture && current) return current;
  return img.src || img.currentSrc;
}

function eligible(img, minSize = 400) {
  return img.naturalWidth >= minSize && img.naturalHeight >= minSize && Boolean(bestSource(img));
}

function sourceForScope(img, scope) {
  return scope === "visible" ? img.currentSrc || img.src : bestSource(img);
}

function visibleArea(img, viewportWidth, viewportHeight) {
  if (!img.getClientRects().length) return 0;
  const rect = img.getBoundingClientRect();
  const width = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  return width * height;
}

function normalized(value) {
  return Math.round(Math.max(0, Math.min(1, value)) * 1e6) / 1e6;
}

function viewportCrop(img, viewportWidth, viewportHeight, padding = 0.1) {
  const rect = img.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewportWidth, rect.right);
  const bottom = Math.min(viewportHeight, rect.bottom);
  if (!img.getClientRects().length || right <= left || bottom <= top || rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const padX = (right - left) * padding;
  const padY = (bottom - top) * padding;
  const crop = {
    left: normalized((Math.max(rect.left, left - padX) - rect.left) / rect.width),
    top: normalized((Math.max(rect.top, top - padY) - rect.top) / rect.height),
    right: normalized((Math.min(rect.right, right + padX) - rect.left) / rect.width),
    bottom: normalized((Math.min(rect.bottom, bottom + padY) - rect.top) / rect.height),
  };
  if (crop.left === 0 && crop.top === 0 && crop.right === 1 && crop.bottom === 1) return null;
  return crop;
}

function jobKey(source, srcLang, crop) {
  return `${source}|${srcLang}|${crop ? `${crop.left},${crop.top},${crop.right},${crop.bottom}` : "full"}`;
}

function isViewportVisible(img, viewportWidth, viewportHeight) {
  return visibleArea(img, viewportWidth, viewportHeight) > 0;
}

function isCurrentSource(img, source, scope = "loaded") {
  return img.isConnected && sourceForScope(img, scope) === source;
}

function selectCandidates(images, scope, translated, viewportWidth, viewportHeight, srcLang, minSize = 400) {
  if (scope !== "loaded" && scope !== "visible") throw new Error(`scope không hỗ trợ: ${scope}`);

  const jobs = [];
  for (const img of images) {
    if (!img.complete || !eligible(img, minSize)) continue;
    if (scope === "visible" && !isViewportVisible(img, viewportWidth, viewportHeight)) continue;
    const source = sourceForScope(img, scope);
    const crop = scope === "visible" ? viewportCrop(img, viewportWidth, viewportHeight) : null;
    const key = jobKey(source, srcLang, crop);
    if (translated.get(img) === key) continue;
    jobs.push({ img, source, crop, key });
  }
  return jobs;
}

if (typeof module !== "undefined") {
  module.exports = {
    bestSource,
    eligible,
    sourceForScope,
    visibleArea,
    viewportCrop,
    jobKey,
    isViewportVisible,
    isCurrentSource,
    selectCandidates,
  };
}
