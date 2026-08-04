const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { orderPage } = require("../reading-order.js");

const manifest = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../../server/tests/fixtures/real_pages/manifest.json"),
  "utf8",
));

const pages = manifest.fixtures.filter((page) => page.role === "source_page");
assert.strictEqual(pages.length, 3);

function ids(result) {
  return Array.from(result.blocks, (block) => block.block_id);
}

for (const page of pages) {
  const input = page.regions.map((region) => ({
    block_id: region.fixture_block_id,
    bbox: [...region.bbox],
  }));
  const before = structuredClone(input);
  const shuffled = input.slice(1).reverse().concat(input.slice(0, 1));
  const shuffledBefore = structuredClone(shuffled);
  const result = orderPage({
    blocks: shuffled,
    image_w: page.width,
    image_h: page.height,
    reading_direction: page.reading_direction,
  });
  const expected = page.regions
    .slice()
    .sort((left, right) => left.reading_order - right.reading_order)
    .map((region) => region.fixture_block_id);
  assert.deepStrictEqual(result.blocks.map((block) => block.block_id), expected, page.id);
  assert.strictEqual(result.page_kind, page.page_kind, page.id);
  assert.deepStrictEqual(input, before, `${page.id} mutated`);
  assert.deepStrictEqual(shuffled, shuffledBefore, `${page.id} passed blocks mutated`);
  if (page.id === "s-manga_ja_1") {
    assert.ok(515 < result.gutter_x && result.gutter_x < 594, page.id);
  } else if (page.id === "s-manga_ja_2") {
    assert.ok(502 < result.gutter_x && result.gutter_x < 597, page.id);
  } else {
    assert.strictEqual(result.gutter_x, null, page.id);
  }
  console.log(`${page.id}: ${ids(result).join(", ")} | ${result.page_kind} | gutter_x=${result.gutter_x}`);
}

const single = [
  { block_id: "z01", bbox: [20, 20, 80, 40] },
  { block_id: "a01", bbox: [300, 25, 80, 40] },
  { block_id: "m01", bbox: [30, 150, 80, 40] },
  { block_id: "b01", bbox: [280, 155, 80, 40] },
];
const singleRtl = orderPage({ blocks: single, image_w: 500, image_h: 800, reading_direction: "rtl" });
const singleLtr = orderPage({ blocks: single, image_w: 500, image_h: 800, reading_direction: "ltr" });
assert.deepStrictEqual(ids(singleRtl), ["a01", "z01", "b01", "m01"]);
assert.deepStrictEqual(ids(singleLtr), ["z01", "a01", "m01", "b01"]);

const spread = [
  { block_id: "z01", bbox: [20, 100, 80, 40] },
  { block_id: "z02", bbox: [20, 300, 80, 40] },
  { block_id: "a01", bbox: [480, 100, 50, 40] },
  { block_id: "m01", bbox: [900, 100, 80, 40] },
  { block_id: "m02", bbox: [900, 300, 80, 40] },
];
const spreadRtl = orderPage({ blocks: spread, image_w: 1100, image_h: 800, reading_direction: "rtl" });
const spreadLtr = orderPage({ blocks: spread, image_w: 1100, image_h: 800, reading_direction: "ltr" });
assert.deepStrictEqual(ids(spreadRtl), ["m01", "m02", "a01", "z01", "z02"]);
assert.deepStrictEqual(ids(spreadLtr), ["z01", "a01", "z02", "m01", "m02"]);
assert.strictEqual(spreadRtl.gutter_x, 715);
assert.notDeepStrictEqual(ids(spreadLtr), ids(spreadRtl).slice().reverse(), "LTR must not be reverse(RTL)");

const centerCovered = [
  { block_id: "left", bbox: [60, 20, 40, 40] },
  { block_id: "center", bbox: [200, 100, 100, 40] },
  { block_id: "right", bbox: [400, 20, 40, 40] },
];
assert.strictEqual(
  orderPage({ blocks: centerCovered, image_w: 500, image_h: 300, reading_direction: "rtl" }).gutter_x,
  250,
);

const bridge = [
  { block_id: "z-top", bbox: [100, 0, 40, 40] },
  { block_id: "m-bridge", bbox: [200, 30, 40, 80] },
  { block_id: "a-bottom", bbox: [300, 100, 40, 40] },
];
assert.deepStrictEqual(ids(orderPage({ blocks: bridge, image_w: 500, image_h: 800, reading_direction: "rtl" })), ["z-top", "m-bridge", "a-bottom"]);

const duplicateGeometry = [
  { block_id: "z-duplicate", bbox: [100, 100, 40, 40] },
  { block_id: "a-duplicate", bbox: [100, 100, 40, 40] },
];
for (const blocks of [duplicateGeometry, duplicateGeometry.slice().reverse()]) {
  assert.throws(
    () => orderPage({ blocks, image_w: 500, image_h: 800, reading_direction: "rtl" }),
    /Duplicate bbox geometry/,
  );
}
assert.doesNotThrow(() => orderPage({
  blocks: [
    { block_id: "z-size", bbox: [100, 100, 40, 40] },
    { block_id: "a-size", bbox: [100, 100, 50, 40] },
  ],
  image_w: 500,
  image_h: 800,
  reading_direction: "rtl",
}));

const helperPath = path.resolve(__dirname, "../reading-order.js");
const source = fs.readFileSync(helperPath, "utf8");
const lowSource = source.replace(
  "const VERTICAL_OVERLAP_THRESHOLD = 0.5;",
  "const VERTICAL_OVERLAP_THRESHOLD = 0.25;",
);
assert.notStrictEqual(lowSource, source, "threshold constant not replaced");
const lowContext = {};
vm.createContext(lowContext);
vm.runInContext(lowSource, lowContext);
const lowResult = lowContext.MangaReadingOrder.orderPage({
  blocks: bridge,
  image_w: 500,
  image_h: 800,
  reading_direction: "rtl",
});
assert.notDeepStrictEqual(ids(lowResult), ["z-top", "m-bridge", "a-bottom"]);

console.log(`single rtl: ${ids(singleRtl).join(", ")}`);
console.log(`single ltr: ${ids(singleLtr).join(", ")}`);
console.log(`spread rtl: ${ids(spreadRtl).join(", ")} | gutter_x=${spreadRtl.gutter_x}`);
console.log(`spread ltr: ${ids(spreadLtr).join(", ")}`);
console.log(`tall bridge low-threshold: ${ids(lowResult).join(", ")}`);
console.log("reading-order.test.js OK");
