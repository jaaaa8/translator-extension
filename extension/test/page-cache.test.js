const assert = require("assert");
const { PageCache, CacheFullError } = require("../page-cache.js");

function fakeStorage(seed = {}) {
  const rows = { ...seed };
  return {
    rows,
    async get(key) {
      if (key === null) return { ...rows };
      if (typeof key === "string") return key in rows ? { [key]: rows[key] } : {};
      return Object.fromEntries(key.filter((name) => name in rows).map((name) => [name, rows[name]]));
    },
    async set(values) { Object.assign(rows, values); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete rows[key];
    },
    async getBytesInUse() {
      return new TextEncoder().encode(JSON.stringify(rows)).byteLength;
    },
  };
}

function page(key, state, access, text = "x") {
  return {
    schema_version: "page-v1",
    page_artifact_key: key,
    state,
    versions: { prompt: "v2" },
    blocks: [{ block_id: "b", trans_text: text }],
    last_accessed_at: access,
    updated_at: access,
  };
}

(async () => {
  const storage = fakeStorage();
  const cache = new PageCache(storage, { budgetBytes: 800, now: () => 10 });
  await cache.putPage(page("active", "running", 1, "a".repeat(150)));
  await cache.putPage(page("old", "complete", 2, "b".repeat(150)));
  await cache.putPage(page("new", "complete", 3, "c".repeat(150)));
  assert.ok(await cache.getPage("active"));
  assert.strictEqual(await cache.getPage("old"), null);
  assert.ok(await cache.getPage("new"));

  await cache.putPage({ ...page("wrong-version", "complete", 4), versions: { prompt: "v1" } });
  assert.strictEqual(await cache.purgeIncompatible({ prompt: "v2" }), 1);
  assert.strictEqual(await cache.getPage("wrong-version"), null);

  const migrationStorage = fakeStorage();
  const migrationCache = new PageCache(migrationStorage);
  await migrationCache.putPage({
    ...page("old-layout", "complete", 1),
    versions: { prompt: "v2", layout_order: "reading-order-v0" },
  });
  await migrationCache.putJob({ job_id: "layout-ledger", state: "queued" });
  assert.strictEqual(await migrationCache.purgeIncompatible({ prompt: "v2", layout_order: "reading-order-v1" }), 1);
  assert.strictEqual(await migrationCache.getPage("old-layout"), null);
  assert.ok((await migrationCache.rehydrate()).jobs.some((job) => job.job_id === "layout-ledger"));

  const versionStorage = fakeStorage();
  const versionCache = new PageCache(versionStorage);
  const currentVersions = {
    detector: "d1",
    recognizers: { ja: "ja1", es: "es1" },
    prompt: "p1",
  };
  await versionCache.putPage({
    ...page("reordered-version", "complete", 1),
    versions: { prompt: "p1", recognizers: { es: "es1", ja: "ja1" }, detector: "d1" },
  });
  assert.strictEqual(await versionCache.purgeIncompatible(currentVersions), 0);
  assert.ok(await versionCache.getPage("reordered-version"));
  await versionCache.putPage({
    ...page("changed-recognizer", "complete", 2),
    versions: { prompt: "p1", recognizers: { es: "es2", ja: "ja1" }, detector: "d1" },
  });
  assert.strictEqual(await versionCache.purgeIncompatible(currentVersions), 1);
  assert.strictEqual(await versionCache.getPage("changed-recognizer"), null);
  assert.ok(await versionCache.getPage("reordered-version"));

  await cache.putJob({ job_id: "j1", state: "running", created_at: 1 });
  const rehydrated = await cache.rehydrate();
  assert.strictEqual(rehydrated.jobs[0].state, "queued");

  const descriptorCache = new PageCache(fakeStorage());
  await descriptorCache.putJob({ job_id: "new", descriptor: { reading_direction: "ltr" } });
  assert.strictEqual((await descriptorCache.rehydrate()).jobs.find((job) => job.job_id === "new").descriptor.reading_direction, "ltr");
  await descriptorCache.putJob({ job_id: "legacy", descriptor: { src_lang: "ja" } });
  assert.strictEqual((await descriptorCache.rehydrate()).jobs.find((job) => job.job_id === "legacy").descriptor.reading_direction, undefined);

  const tiny = new PageCache(fakeStorage(), { budgetBytes: 20 });
  await assert.rejects(tiny.putPage(page("too-large", "running", 1, "x".repeat(100))), CacheFullError);

  const activeOnly = new PageCache(fakeStorage(), { budgetBytes: 800 });
  await activeOnly.putPage(page("active-1", "queued", 1, "a".repeat(120)));
  await activeOnly.putPage(page("active-2", "running", 2, "b".repeat(120)));
  await assert.rejects(activeOnly.putJob({
    job_id: "full",
    state: "queued",
    descriptor: { source_url: `https://x/${"c".repeat(300)}`, crop: "full" },
  }), CacheFullError);
  assert.ok(await activeOnly.getPage("active-1"));
  assert.ok(await activeOnly.getPage("active-2"));

  const safeStorage = fakeStorage();
  const safeCache = new PageCache(safeStorage);
  await safeCache.putPage({
    ...page("safe", "complete", 1),
    source_url: "https://x/page.jpg",
    crop: "full",
    blocks: [{ block_id: "b1", bbox: [1, 2, 3, 4], src_text: "hola", trans_text: "xin chao" }],
    image_bytes: new Uint8Array([1, 2, 3]),
    prepared_crop: "data:image/png;base64,AAAA",
  });
  const saved = safeStorage.rows["mt:page:safe"];
  assert.deepStrictEqual(saved.blocks, [{ block_id: "b1", bbox: [1, 2, 3, 4], src_text: "hola", trans_text: "xin chao" }]);
  assert.strictEqual(saved.image_bytes, undefined);
  assert.strictEqual(saved.prepared_crop, undefined);

  const resumableBlock = {
    block_id: "b2",
    bbox: [5, 6, 7, 8],
    src_text: "hola",
    trans_text: null,
    state: "ocr_complete",
  };
  await safeCache.putPage({ ...page("resumable", "running", 2), blocks: [resumableBlock] });
  assert.deepStrictEqual(safeStorage.rows["mt:page:resumable"].blocks, [resumableBlock]);

  await assert.rejects(
    safeCache.putPage({ ...page("image-crop", "complete", 2), crop: "data:image/png;base64,AAAA" }),
    TypeError
  );
  await assert.rejects(
    safeCache.putPage({ ...page("image-source", "complete", 2), source_url: "data:image/png;base64,AAAA" }),
    TypeError
  );
  await assert.rejects(
    safeCache.putPage({ ...page("nested-image-source", "complete", 2), source_url: "blob:data:image/png;base64,AAAA" }),
    TypeError
  );
  assert.strictEqual(safeStorage.rows["mt:page:nested-image-source"], undefined);
  await assert.rejects(
    safeCache.putPage({ ...page("object-source", "complete", 2), source_url: new Uint8Array([1]) }),
    TypeError
  );
  await assert.rejects(
    safeCache.putPage({ ...page("object-width", "complete", 2), natural_width: { pixels: 1200 } }),
    TypeError
  );
  await assert.rejects(
    safeCache.putPage({ ...page("binary-access-time", "complete", 2), last_accessed_at: new Uint8Array([1]) }),
    TypeError
  );
  assert.strictEqual(safeStorage.rows["mt:page:binary-access-time"], undefined);
  await assert.rejects(
    safeCache.putPage({ ...page("binary-block", "complete", 2), blocks: [{ block_id: "b", src_text: new Uint8Array([1]) }] }),
    TypeError
  );
  await safeCache.putPage(page("default-crop", "complete", 2));
  assert.strictEqual((await safeCache.getPage("default-crop")).crop, "full");
  const canonicalCrop = { left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 };
  await safeCache.putPage({ ...page("canonical-crop", "complete", 3), crop: canonicalCrop });
  assert.deepStrictEqual((await safeCache.getPage("canonical-crop")).crop, canonicalCrop);

  await safeCache.putJob({
    job_id: "safe-job",
    scope: "page",
    descriptor: { source_url: "https://x/page.jpg", crop: "full", prepared_crop: "data:image/png;base64,AAAA" },
    image_bytes: new Uint8Array([1, 2, 3]),
  });
  const savedJob = safeStorage.rows["mt:job:safe-job"];
  assert.strictEqual(savedJob.image_bytes, undefined);
  assert.strictEqual(savedJob.descriptor.prepared_crop, undefined);
  const descriptorCrop = { left: 0.2, top: 0.3, right: 0.7, bottom: 0.8 };
  await safeCache.putJob({ job_id: "rect-job", descriptor: { source_url: "blob:https://x/id", crop: descriptorCrop } });
  assert.deepStrictEqual(safeStorage.rows["mt:job:rect-job"].descriptor.crop, descriptorCrop);
  await safeCache.putJob({ job_id: "default-job-crop", descriptor: { source_url: "https://x/page.jpg", crop: null } });
  assert.strictEqual(safeStorage.rows["mt:job:default-job-crop"].descriptor.crop, "full");
  await assert.rejects(
    safeCache.putJob({ job_id: "data-source-job", descriptor: { source_url: "data:image/png;base64,AAAA" } }),
    TypeError
  );
  await assert.rejects(
    safeCache.putJob({ job_id: "nested-data-source-job", descriptor: { source_url: "blob:data:image/png;base64,AAAA" } }),
    TypeError
  );
  assert.strictEqual(safeStorage.rows["mt:job:nested-data-source-job"], undefined);
  await assert.rejects(
    safeCache.putJob({ job_id: "object-source-job", descriptor: { source_url: { href: "https://x/page.jpg" } } }),
    TypeError
  );
  await assert.rejects(
    safeCache.putJob({
      job_id: "bad-job",
      descriptor: { source_url: "https://x/page.jpg", crop: "data:image/png;base64,AAAA" },
    }),
    TypeError
  );
  assert.strictEqual(safeStorage.rows["mt:job:bad-job"], undefined);

  let tick = 3;
  const lruCache = new PageCache(fakeStorage(), { budgetBytes: 800, now: () => tick });
  await lruCache.putPage(page("frequently-found", "complete", 1, "a".repeat(150)));
  await lruCache.putPage(page("less-recent", "complete", 2, "b".repeat(150)));
  await lruCache.findPage((row) => row.page_artifact_key === "frequently-found");
  await lruCache.putPage(page("incoming", "complete", 3, "c".repeat(150)));
  assert.ok(await lruCache.getPage("frequently-found"));
  assert.strictEqual(await lruCache.getPage("less-recent"), null);

  let unsafeNow = 2;
  const unsafeClockStorage = fakeStorage();
  const unsafeClockCache = new PageCache(unsafeClockStorage, { now: () => unsafeNow });
  await unsafeClockCache.putPage(page("unsafe-get", "complete", 1));
  await unsafeClockCache.putPage(page("unsafe-find", "complete", 1));
  unsafeNow = new Uint8Array([1]);
  assert.strictEqual((await unsafeClockCache.getPage("unsafe-get")).last_accessed_at, 1);
  assert.strictEqual(unsafeClockStorage.rows["mt:page:unsafe-get"].last_accessed_at, 1);
  assert.strictEqual((await unsafeClockCache.findPage((row) => row.page_artifact_key === "unsafe-find")).last_accessed_at, 1);
  assert.strictEqual(unsafeClockStorage.rows["mt:page:unsafe-find"].last_accessed_at, 1);

  console.log("page-cache.test.js OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
