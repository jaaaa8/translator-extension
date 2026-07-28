const assert = require("assert");
const { bestSource } = require("../srcset.js");

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

console.log("srcset.test.js OK");
