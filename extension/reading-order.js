(() => {
  "use strict";
  const SPREAD_RATIO = 1.2;
  const VERTICAL_OVERLAP_THRESHOLD = 0.5;

  function compareTuple(left, right) {
    for (let index = 0; index < left.length; index++) {
      const difference = left[index] - right[index];
      if (difference) return difference;
    }
    return 0;
  }

  function centerX(block) {
    return block.bbox[0] + block.bbox[2] / 2;
  }

  function findGutter(blocks, image_w) {
    const intervals = blocks
      .map((block) => [block.bbox[0], block.bbox[0] + block.bbox[2]])
      .sort(compareTuple);
    if (!intervals.length) return image_w / 2;

    const merged = [intervals[0].slice()];
    for (const interval of intervals.slice(1)) {
      const last = merged[merged.length - 1];
      if (interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
      else merged.push(interval.slice());
    }

    const center = image_w / 2;
    for (let index = 0; index < merged.length - 1; index++) {
      const lo = merged[index][1];
      const hi = merged[index + 1][0];
      if (lo < center && center < hi) return (lo + hi) / 2;
    }
    return center;
  }

  function verticallyConnected(left, right) {
    const overlap = Math.min(left.bbox[1] + left.bbox[3], right.bbox[1] + right.bbox[3])
      - Math.max(left.bbox[1], right.bbox[1]);
    return overlap >= VERTICAL_OVERLAP_THRESHOLD * Math.min(left.bbox[3], right.bbox[3]);
  }

  function compareSignatures(left, right) {
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const difference = compareTuple(left[index], right[index]);
      if (difference) return difference;
    }
    return left.length - right.length;
  }

  function orderBands(blocks, reading_direction) {
    const pending = blocks.slice();
    const bands = [];
    // ponytail: O(n²) pair scan; replace with a sweep index only if dense-page profiling requires it.
    while (pending.length) {
      const band = [pending.shift()];
      for (let cursor = 0; cursor < band.length; cursor++) {
        for (let index = pending.length - 1; index >= 0; index--) {
          if (verticallyConnected(band[cursor], pending[index])) {
            band.push(pending.splice(index, 1)[0]);
          }
        }
      }
      bands.push({
        blocks: band,
        top: Math.min(...band.map((block) => block.bbox[1])),
        signature: band.map((block) => block.bbox).sort(compareTuple),
      });
    }

    const direction = reading_direction === "rtl" ? -1 : 1;
    const key = (block) => [
      direction * block.bbox[0],
      block.bbox[1],
      block.bbox[2],
      block.bbox[3],
    ];
    bands.sort((left, right) => left.top - right.top || compareSignatures(left.signature, right.signature));
    return bands.flatMap((band) => band.blocks.sort((left, right) => compareTuple(key(left), key(right))));
  }

  function orderPage({ blocks, image_w, image_h, reading_direction }) {
    if (new Set(blocks.map((block) => JSON.stringify(block.bbox))).size !== blocks.length) {
      throw new Error("Duplicate bbox geometry");
    }
    const copies = blocks.map((block) => ({ ...block, bbox: [...block.bbox] }));
    const page_kind = image_w / image_h >= SPREAD_RATIO ? "spread" : "single";
    if (page_kind === "single") {
      return { page_kind, gutter_x: null, blocks: orderBands(copies, reading_direction) };
    }
    const gutter_x = findGutter(copies, image_w);
    const left = copies.filter((block) => centerX(block) < gutter_x);
    const right = copies.filter((block) => centerX(block) >= gutter_x);
    const halves = reading_direction === "rtl" ? [right, left] : [left, right];
    return {
      page_kind,
      gutter_x,
      blocks: halves.flatMap((half) => orderBands(half, reading_direction)),
    };
  }

  const api = { orderPage };
  globalThis.MangaReadingOrder = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
