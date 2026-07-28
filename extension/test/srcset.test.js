const assert = require("assert");
const {
  bestSource,
  eligible,
  isViewportVisible,
  isCurrentSource,
  selectCandidates,
} = require("../srcset.js");

// srcset nhiều biến thể → chọn URL có descriptor lớn nhất
assert.strictEqual(
  bestSource({
    srcset: "https://x/small.jpg 320w, https://x/big.jpg 1280w, https://x/mid.jpg 640w",
    src: "https://x/fallback.jpg",
    baseURI: "https://x/",
  }),
  "https://x/big.jpg"
);

// không srcset → dùng img.src (không phải currentSrc biến thể nhỏ)
assert.strictEqual(
  bestSource({ src: "https://x/orig.jpg", currentSrc: "https://x/small.jpg" }),
  "https://x/orig.jpg"
);

// <picture> candidates live on <source>; use the browser's selected candidate.
assert.strictEqual(
  bestSource({
    src: "https://x/fallback.jpg",
    currentSrc: "https://x/large.webp",
    parentElement: { tagName: "PICTURE" },
  }),
  "https://x/large.webp"
);

// A <picture> must keep its selected source set, not switch to the fallback img set.
const sourceAvif = { srcset: "images/page-640.avif 640w, images/page-1600.avif 1600w" };
const sourceWebp = { srcset: "images/page-640.webp 640w, images/page-1600.webp 1600w" };
const picture = { tagName: "PICTURE", querySelectorAll: () => [sourceAvif, sourceWebp] };
const pictureImage = {
  src: "fallback.jpg",
  srcset: "images/page-640.jpg 640w, images/page-4096.jpg 4096w",
  currentSrc: "https://cdn.example.test/chapter/images/page-640.avif",
  baseURI: "https://cdn.example.test/chapter/",
  parentElement: picture,
  isConnected: true,
};
const avifSource = "https://cdn.example.test/chapter/images/page-1600.avif";
const webpSource = "https://cdn.example.test/chapter/images/page-1600.webp";
assert.strictEqual(bestSource(pictureImage), avifSource);
assert.strictEqual(isCurrentSource(pictureImage, avifSource), true);
pictureImage.currentSrc = "https://cdn.example.test/chapter/images/page-640.webp";
assert.strictEqual(bestSource(pictureImage), webpSource);
assert.strictEqual(isCurrentSource(pictureImage, avifSource), false);

const onscreen = { left: 0, top: 0, right: 600, bottom: 500, width: 600, height: 500 };

function fakeImage({
  src = "https://x/page.jpg",
  complete = true,
  naturalWidth = 1000,
  naturalHeight = 1600,
  isConnected = true,
  rect = onscreen,
} = {}) {
  return {
    src,
    currentSrc: "",
    complete,
    naturalWidth,
    naturalHeight,
    isConnected,
    baseURI: "https://x/",
    parentElement: null,
    getAttribute: () => "",
    getBoundingClientRect: () => rect,
    getClientRects: () => (rect.width > 0 && rect.height > 0 ? [rect] : []),
  };
}

const doneImage = fakeImage({ src: "https://x/done.jpg" });
const offscreenImage = fakeImage({
  src: "https://x/offscreen.jpg",
  rect: { left: 0, top: 900, right: 600, bottom: 1400, width: 600, height: 500 },
});
const smallImage = fakeImage({ src: "https://x/icon.jpg", naturalWidth: 100, naturalHeight: 100 });
const incompleteImage = fakeImage({ src: "https://x/loading.jpg", complete: false });
const translated = new WeakMap([[doneImage, doneImage.src]]);

assert.deepStrictEqual(
  selectCandidates([doneImage, offscreenImage, smallImage, incompleteImage], "loaded", translated, 800, 600),
  [{ img: offscreenImage, source: offscreenImage.src }]
);

const visibleImage = fakeImage({ src: "https://x/visible.jpg" });
const partiallyVisibleImage = fakeImage({
  src: "https://x/partial.jpg",
  rect: { left: 0, top: -300, right: 600, bottom: 100, width: 600, height: 400 },
});
const zeroSizeImage = fakeImage({
  src: "https://x/hidden.jpg",
  rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
});
assert.deepStrictEqual(
  selectCandidates([visibleImage, partiallyVisibleImage, offscreenImage], "visible", new WeakMap(), 800, 600),
  [
    { img: visibleImage, source: visibleImage.src },
    { img: partiallyVisibleImage, source: partiallyVisibleImage.src },
  ]
);

doneImage.src = "https://x/new-page.jpg";
assert.deepStrictEqual(
  selectCandidates([doneImage], "loaded", translated, 800, 600),
  [{ img: doneImage, source: doneImage.src }]
);

assert.strictEqual(eligible(visibleImage), true);
assert.strictEqual(eligible(smallImage), false);
assert.strictEqual(isViewportVisible(visibleImage, 800, 600), true);
assert.strictEqual(isViewportVisible(partiallyVisibleImage, 800, 600), true);
assert.strictEqual(isViewportVisible(offscreenImage, 800, 600), false);
assert.strictEqual(isViewportVisible(zeroSizeImage, 800, 600), false);

const currentImage = fakeImage({ src: "https://x/current.jpg" });
assert.strictEqual(isCurrentSource(currentImage, currentImage.src), true);
currentImage.src = "https://x/replaced.jpg";
assert.strictEqual(isCurrentSource(currentImage, "https://x/current.jpg"), false);
currentImage.isConnected = false;
assert.strictEqual(isCurrentSource(currentImage, currentImage.src), false);

assert.throws(
  () => selectCandidates([], "auto", new WeakMap(), 800, 600),
  /scope không hỗ trợ/
);

console.log("srcset.test.js OK");
