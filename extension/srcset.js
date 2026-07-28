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
  return img.src || img.currentSrc;
}

if (typeof module !== "undefined") module.exports = { bestSource };
