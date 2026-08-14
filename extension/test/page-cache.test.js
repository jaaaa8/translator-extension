const assert = require("assert");
const test = require("node:test");
const { PageCache, CacheFullError } = require("../page-cache.js");

function fakeStorage(seed = {}) {
  const rows = { ...seed };
  return {
    rows,
    getAllCalls: 0,
    async get(key) {
      if (key === null) {
        this.getAllCalls++;
        return { ...rows };
      }
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
    schema_version: "page-v2",
    page_artifact_key: key,
    src_lang: "ja",
    state,
    versions: { prompt: "v2" },
    blocks: [{
      block_id: "b",
      bbox: [1, 2, 3, 4],
      src_text: "source",
      trans_text: text,
      kind: "text",
      vertical: false,
      reading_order: 0,
      state: "translated",
    }],
    last_accessed_at: access,
    updated_at: access,
  };
}

const LIVE_VERSIONS = {
  detector: "detector-v1",
  dedupe: "dedupe-v1",
  prep: "prep-v1",
  region_resolver: "resolver-v1",
  recognizers: { ja: "ja-v1", es: "es-v1", pt: "pt-v1" },
  translator_model: "translator-v1",
  prompt: "prompt-v1",
  policy: "full-page-v1",
  layout_order: "reading-order-v1",
  page_schema: "page-v2",
};

const LIVE_PATCH_VERSIONS = {
  cleaner: "cleaner-v1",
  render_encoding: "png-rgba-v1",
  render_schema: "render-v1",
};

function fullPageRow(key = "page-full") {
  return {
    schema_version: "page-v2",
    versions: structuredClone(LIVE_VERSIONS),
    patch_versions: structuredClone(LIVE_PATCH_VERSIONS),
    page_artifact_key: key,
    analysis_key: "analysis-1",
    ocr_key: "ocr-1",
    render_artifact_key: "render-1",
    source_content_hash: "a".repeat(64),
    src_lang: "ja",
    dst_lang: "vi",
    reading_direction: "rtl",
    state: "complete",
    analysis_known: true,
    ocr_done: true,
    image_w: 800,
    image_h: 1200,
    source_url: "https://example.test/page.png",
    natural_width: 800,
    natural_height: 1200,
    crop: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 },
    created_at: 1699999999000,
    updated_at: 1699999999100,
    last_accessed_at: 1699999999200,
    last_error: null,
    blocks: [
      {
        block_id: "text-1",
        bbox: [10, 20, 200, 80],
        src_text: "こんにちは",
        trans_text: "Xin chào",
        kind: "text",
        vertical: true,
        reading_order: 0,
        state: "translated",
      },
      {
        block_id: "sfx-1",
        bbox: [300, 40, 100, 120],
        src_text: "ドン",
        trans_text: null,
        kind: "sfx",
        vertical: false,
        reading_order: 1,
        state: "translated",
      },
    ],
    manifest_ids: ["text-1"],
    manifest_mismatch_count: 1,
    render: {
      schema_version: "render-page-v1",
      render_artifact_key: "render-1",
      patch_versions: structuredClone(LIVE_PATCH_VERSIONS),
      layout_fit_version: "dom-fit-10px-v1",
      breaker_open: false,
      blocks: [{
        block_id: "text-1",
        render_mode: "in_place",
        patch_id: "patch-1",
        patch_bbox: [8, 18, 204, 84],
        fit_bbox: [12, 22, 196, 76],
        layout_profile: { font_px: 18, line_height: 1.2 },
        reason: null,
        patch_rgba: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      }],
    },
  };
}

test("catches page-v2 allowlist loss: full put/get round-trips metadata with a fixed clock", async () => {
  const fixedNow = 1700000000000;
  const storage = fakeStorage();
  const cache = new PageCache(storage, { now: () => fixedNow });

  await cache.putPage(fullPageRow());
  const roundTripped = await cache.getPage("page-full");

  assert.deepStrictEqual(roundTripped, {
    schema_version: "page-v2",
    updated_at: fixedNow,
    last_accessed_at: fixedNow,
    page_artifact_key: "page-full",
    analysis_key: "analysis-1",
    ocr_key: "ocr-1",
    render_artifact_key: "render-1",
    source_content_hash: "a".repeat(64),
    src_lang: "ja",
    dst_lang: "vi",
    reading_direction: "rtl",
    state: "complete",
    source_url: "https://example.test/page.png",
    natural_width: 800,
    natural_height: 1200,
    image_w: 800,
    image_h: 1200,
    created_at: 1699999999000,
    analysis_known: true,
    ocr_done: true,
    last_error: null,
    versions: {
      detector: "detector-v1",
      dedupe: "dedupe-v1",
      prep: "prep-v1",
      region_resolver: "resolver-v1",
      recognizers: { ja: "ja-v1", es: "es-v1", pt: "pt-v1" },
      translator_model: "translator-v1",
      prompt: "prompt-v1",
      policy: "full-page-v1",
      layout_order: "reading-order-v1",
      page_schema: "page-v2",
    },
    patch_versions: {
      cleaner: "cleaner-v1",
      render_encoding: "png-rgba-v1",
      render_schema: "render-v1",
    },
    crop: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 },
    blocks: [
      {
        block_id: "text-1",
        bbox: [10, 20, 200, 80],
        src_text: "こんにちは",
        trans_text: "Xin chào",
        kind: "text",
        vertical: true,
        reading_order: 0,
        state: "translated",
      },
      {
        block_id: "sfx-1",
        bbox: [300, 40, 100, 120],
        src_text: "ドン",
        trans_text: null,
        kind: "sfx",
        vertical: false,
        reading_order: 1,
        state: "translated",
      },
    ],
    manifest_ids: ["text-1"],
    manifest_mismatch_count: 1,
    render: {
      schema_version: "render-page-v1",
      render_artifact_key: "render-1",
      patch_versions: {
        cleaner: "cleaner-v1",
        render_encoding: "png-rgba-v1",
        render_schema: "render-v1",
      },
      layout_fit_version: "dom-fit-10px-v1",
      breaker_open: false,
      blocks: [{
        block_id: "text-1",
        render_mode: "in_place",
        patch_id: "patch-1",
        patch_bbox: [8, 18, 204, 84],
        fit_bbox: [12, 22, 196, 76],
        layout_profile: { font_px: 18, line_height: 1.2 },
        reason: null,
      }],
    },
  });
  assert.strictEqual(roundTripped.analysis_known, true);
  assert.strictEqual(roundTripped.image_w, 800);
  assert.strictEqual(roundTripped.image_h, 1200);
  assert.strictEqual(roundTripped.render.blocks[0].patch_rgba, undefined);

  const noManifest = fullPageRow("no-manifest");
  delete noManifest.manifest_ids;
  delete noManifest.render;
  await cache.putPage(noManifest);
  const withoutManifest = await cache.getPage("no-manifest");
  assert.strictEqual(Object.hasOwn(withoutManifest, "manifest_ids"), false);

  const allSfxRow = fullPageRow("all-sfx");
  allSfxRow.blocks = [allSfxRow.blocks[1]];
  allSfxRow.manifest_ids = [];
  delete allSfxRow.render;
  await cache.putPage(allSfxRow);
  const allSfx = await cache.getPage("all-sfx");
  assert.deepStrictEqual(allSfx.manifest_ids, []);
});

test("catches validator weakening at the page-v2 persistence boundary", async (t) => {
  const mutations = [
    ["accepting an unknown translation kind", (row) => { row.blocks[0].kind = "dialogue"; }],
    ["dropping required vertical metadata", (row) => { delete row.blocks[0].vertical; }],
    ["accepting non-boolean vertical metadata", (row) => { row.blocks[0].vertical = 1; }],
    ["accepting a negative reading_order", (row) => { row.blocks[0].reading_order = -1; }],
    ["accepting a non-integer reading_order", (row) => { row.blocks[0].reading_order = 0.5; }],
    ["accepting in_place without a measured layout", (row) => { row.render.blocks[0].layout_profile = null; }],
    ["accepting skip without a capability reason", (row) => {
      Object.assign(row.render.blocks[0], {
        render_mode: "skip",
        patch_id: null,
        patch_bbox: null,
        layout_profile: null,
        reason: null,
      });
    }],
    ["accepting a ready render whose IDs differ from manifest_ids", (row) => { row.manifest_ids.push("text-2"); }],
    ["accepting a breaker sentinel with persisted blocks", (row) => { row.render.breaker_open = true; }],
    ["accepting an SFX block as a ready in-place render target", (row) => {
      row.manifest_ids = ["sfx-1"];
      row.render.blocks[0].block_id = "sfx-1";
    }],
    ["accepting a manifest ID without a translation block", (row) => {
      row.manifest_ids = ["missing"];
      row.render.blocks[0].block_id = "missing";
    }],
    ["accepting a manifest ID mapped to a null-kind block", (row) => { row.blocks[0].kind = null; }],
    ["accepting a manifest ID mapped to an OCR-complete block", (row) => { row.blocks[0].state = "ocr_complete"; }],
    ["accepting a manifest ID mapped to a failed block", (row) => { row.blocks[0].state = "failed"; }],
    ["accepting a manifest ID mapped to null trans_text", (row) => { row.blocks[0].trans_text = null; }],
    ["accepting a manifest ID mapped to empty trans_text", (row) => { row.blocks[0].trans_text = ""; }],
    ["accepting a manifest ID mapped to whitespace-only trans_text", (row) => { row.blocks[0].trans_text = " \t\n"; }],
    ["accepting a manifest ID mapped to duplicate translation blocks", (row) => {
      row.blocks.push(structuredClone(row.blocks[0]));
    }],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(`catches production mutation: ${name}`, async () => {
      const row = fullPageRow(`invalid-${name}`);
      mutate(row);
      await assert.rejects(new PageCache(fakeStorage()).putPage(row), TypeError);
    });
  }

  await t.test("catches production mutation: persisting patch_rgba/base64 PNG bytes", async () => {
    const storage = fakeStorage();
    await new PageCache(storage).putPage(fullPageRow("no-patch-bytes"));
    const serialized = JSON.stringify(storage.rows);
    const savedRender = storage.rows["mt:page:no-patch-bytes"].render;
    assert.ok(savedRender, "render subrecord must persist before its byte allowlist can be checked");
    assert.strictEqual(Object.hasOwn(savedRender.blocks[0], "patch_rgba"), false);
    assert.strictEqual(serialized.includes("patch_rgba"), false);
    assert.strictEqual(serialized.includes("iVBORw0KGgo"), false);
  });
});

test("catches version-domain mutations: purge only the stale domain", async (t) => {
  await t.test("catches whole recognizer-map comparison: ES bump preserves a JA PageRow", async () => {
    const storage = fakeStorage();
    const cache = new PageCache(storage);
    const row = fullPageRow("ja-survives-es-bump");
    row.versions.recognizers.es = "es-v0";
    await cache.putPage(row);

    assert.strictEqual(await cache.purgeIncompatible(LIVE_VERSIONS, LIVE_PATCH_VERSIONS, "dom-fit-10px-v1"), 0);
    assert.ok(await cache.getPage("ja-survives-es-bump"));
  });

  await t.test("catches whole-row patch invalidation: cleaner bump strips render but keeps translation", async () => {
    const storage = fakeStorage();
    const cache = new PageCache(storage);
    const row = fullPageRow("cleaner-bump");
    row.patch_versions.cleaner = "cleaner-v0";
    row.render.patch_versions.cleaner = "cleaner-v0";
    await cache.putPage(row);
    assert.ok(storage.rows["mt:page:cleaner-bump"].render, "precondition: stale render was persisted");

    assert.strictEqual(await cache.purgeIncompatible(LIVE_VERSIONS, LIVE_PATCH_VERSIONS, "dom-fit-10px-v1"), 0);
    const preserved = await cache.getPage("cleaner-bump");
    assert.strictEqual(preserved.render, undefined);
    assert.strictEqual(preserved.blocks[0].trans_text, "Xin chào");
    assert.ok(storage.rows["mt:page:cleaner-bump"]);
  });

  await t.test("catches stale layout reuse: runtime drops only the old layout profile", async () => {
    const storage = fakeStorage();
    const cache = new PageCache(storage);
    const row = fullPageRow("layout-fit-bump");
    row.render.layout_fit_version = "dom-fit-10px-v0";
    await cache.putPage(row);

    assert.strictEqual(await cache.purgeIncompatible(LIVE_VERSIONS, LIVE_PATCH_VERSIONS, "dom-fit-10px-v1"), 0);
    const [runtimePage] = (await cache.rehydrate()).pages;
    assert.ok(runtimePage.render, "render patch metadata must survive a layout-only bump");
    assert.strictEqual(runtimePage.render.blocks[0].patch_id, "patch-1");
    assert.deepStrictEqual(runtimePage.render.blocks[0].fit_bbox, [12, 22, 196, 76]);
    assert.strictEqual(runtimePage.render.blocks[0].layout_profile, null);
    assert.deepStrictEqual(
      storage.rows["mt:page:layout-fit-bump"].render.blocks[0].layout_profile,
      { font_px: 18, line_height: 1.2 }
    );
  });

  await t.test("catches scalar-version omissions: schema, prompt, and layout-order mismatches purge PageRows", async () => {
    const storage = fakeStorage();
    const cache = new PageCache(storage);
    const oldSchema = fullPageRow("old-storage-schema");
    const oldPrompt = fullPageRow("old-prompt");
    oldPrompt.versions.prompt = "prompt-v0";
    const oldLayout = fullPageRow("old-layout-order");
    oldLayout.versions.layout_order = "reading-order-v0";
    await cache.putPage(oldSchema);
    await cache.putPage(oldPrompt);
    await cache.putPage(oldLayout);
    storage.rows["mt:page:old-storage-schema"].schema_version = "page-v1";

    assert.strictEqual(await cache.purgeIncompatible(LIVE_VERSIONS, LIVE_PATCH_VERSIONS, "dom-fit-10px-v1"), 3);
    assert.deepStrictEqual(Object.keys(storage.rows), []);
  });
});

test("OCR recovery claim is durable, exact, and succeeds once under concurrency", async () => {
  const storage = fakeStorage();
  const cache = new PageCache(storage);
  await cache.putPage({ ...page("protected", "partial", 1), ocr_key: "ocr-shared" });

  const claims = await Promise.all([
    cache.claimOcrRecovery("ocr-shared", "protected"),
    cache.claimOcrRecovery("ocr-shared", "protected"),
  ]);

  assert.deepStrictEqual(claims, [true, false]);
  assert.deepStrictEqual(storage.rows["mt:ocr-recovery:ocr-shared"], {
    schema_version: "ocr-recovery-v1",
  });
  assert.strictEqual(
    await new PageCache(storage).claimOcrRecovery("ocr-shared", "protected"),
    false,
  );
});

test("ordinary PageRow rewrites do not scan storage again for orphan-ledger GC", async () => {
  const row = { ...page("same-page", "partial", 1), ocr_key: "same-ocr" };
  const storage = fakeStorage({
    "mt:page:same-page": row,
    "mt:ocr-recovery:same-ocr": { schema_version: "ocr-recovery-v1" },
  });
  const cache = new PageCache(storage);

  await cache.putPage({ ...row, last_error: "ocr_incomplete" });

  assert.strictEqual(storage.getAllCalls, 1);
  assert.deepStrictEqual(storage.rows["mt:ocr-recovery:same-ocr"], {
    schema_version: "ocr-recovery-v1",
  });
});

test("rehydrate purges malformed OCR recovery ledgers but retains the exact schema", async () => {
  const storage = fakeStorage({
    "mt:page:valid-ledger-page": { ...page("valid-ledger-page", "partial", 1), ocr_key: "valid-ledger" },
    "mt:page:wrong-ledger-page": { ...page("wrong-ledger-page", "partial", 2), ocr_key: "wrong-ledger" },
    "mt:page:extra-ledger-page": { ...page("extra-ledger-page", "partial", 3), ocr_key: "extra-ledger" },
    "mt:ocr-recovery:valid-ledger": { schema_version: "ocr-recovery-v1" },
    "mt:ocr-recovery:wrong-ledger": { schema_version: "ocr-recovery-v0" },
    "mt:ocr-recovery:extra-ledger": { schema_version: "ocr-recovery-v1", extra: true },
  });

  await new PageCache(storage).rehydrate();

  assert.deepStrictEqual(storage.rows["mt:ocr-recovery:valid-ledger"], {
    schema_version: "ocr-recovery-v1",
  });
  assert.strictEqual(storage.rows["mt:ocr-recovery:wrong-ledger"], undefined);
  assert.strictEqual(storage.rows["mt:ocr-recovery:extra-ledger"], undefined);
});

test("OCR recovery ledgers count toward budget without becoming eviction candidates", async () => {
  const budgetBytes = 8 * 1024 * 1024;
  const seed = {
    "mt:page:protected": { ...page("protected", "partial", 1, "p".repeat(120)), ocr_key: "ocr-new" },
    "mt:page:evictable": { ...page("evictable", "complete", 2, "e".repeat(120)), ocr_key: "ocr-evictable" },
    "mt:page:active": { ...page("active", "running", 3, "a".repeat(120)), ocr_key: "ocr-existing" },
    "mt:ocr-recovery:ocr-existing": { schema_version: "ocr-recovery-v1" },
  };
  const seededBytes = new TextEncoder().encode(JSON.stringify(seed)).byteLength;
  seed["mt:page:evictable"].blocks[0].trans_text += "e".repeat(budgetBytes - seededBytes - 32);
  const storage = fakeStorage(seed);
  const cache = new PageCache(storage);

  assert.strictEqual(await cache.claimOcrRecovery("ocr-new", "protected"), true);

  assert.ok(storage.rows["mt:page:protected"]);
  assert.ok(storage.rows["mt:page:active"]);
  assert.strictEqual(storage.rows["mt:page:evictable"], undefined);
  assert.deepStrictEqual(storage.rows["mt:ocr-recovery:ocr-existing"], {
    schema_version: "ocr-recovery-v1",
  });
  assert.deepStrictEqual(storage.rows["mt:ocr-recovery:ocr-new"], {
    schema_version: "ocr-recovery-v1",
  });
});

test("OCR recovery claim fails without evicting its protected page", async () => {
  const seed = {
    "mt:page:protected-only": {
      ...page("protected-only", "partial", 1, "p".repeat(120)),
      ocr_key: "ocr-protected-only",
    },
  };
  const storage = fakeStorage(seed);
  const cache = new PageCache(storage, {
    budgetBytes: new TextEncoder().encode(JSON.stringify(seed)).byteLength,
  });

  await assert.rejects(
    cache.claimOcrRecovery("ocr-protected-only", "protected-only"),
    CacheFullError,
  );
  assert.ok(storage.rows["mt:page:protected-only"]);
  assert.strictEqual(storage.rows["mt:ocr-recovery:ocr-protected-only"], undefined);
});

test("OCR recovery ledger is collected only after its last PageRow disappears", async (t) => {
  await t.test("explicit removal keeps a shared ledger until the second page is removed", async () => {
    const storage = fakeStorage();
    const cache = new PageCache(storage);
    await cache.putPage({ ...page("shared-a", "partial", 1), ocr_key: "ocr-shared" });
    await cache.putPage({ ...page("shared-b", "partial", 2), ocr_key: "ocr-shared" });
    await cache.claimOcrRecovery("ocr-shared", "shared-a");

    await cache.removePage("shared-a");
    assert.ok(storage.rows["mt:ocr-recovery:ocr-shared"]);
    await cache.removePage("shared-b");
    assert.strictEqual(storage.rows["mt:ocr-recovery:ocr-shared"], undefined);
  });

  await t.test("version purge removes the ledger orphaned by its last stale page", async () => {
    const storage = fakeStorage();
    const cache = new PageCache(storage);
    await cache.putPage({ ...page("stale", "partial", 1), ocr_key: "ocr-stale", versions: { prompt: "v1" } });
    await cache.claimOcrRecovery("ocr-stale", "stale");

    assert.strictEqual(await cache.purgeIncompatible({ prompt: "v2" }), 1);
    assert.strictEqual(storage.rows["mt:ocr-recovery:ocr-stale"], undefined);
  });

  await t.test("budget eviction also collects the evicted page's orphan ledger", async () => {
    const seed = {
      "mt:page:protected": { ...page("protected", "partial", 2, "p".repeat(120)), ocr_key: "ocr-new" },
      "mt:page:old": { ...page("old", "complete", 1, "o".repeat(120)), ocr_key: "ocr-old" },
      "mt:ocr-recovery:ocr-old": { schema_version: "ocr-recovery-v1" },
    };
    const storage = fakeStorage(seed);
    const cache = new PageCache(storage, {
      budgetBytes: new TextEncoder().encode(JSON.stringify(seed)).byteLength,
    });

    await cache.claimOcrRecovery("ocr-new", "protected");

    assert.strictEqual(storage.rows["mt:page:old"], undefined);
    assert.strictEqual(storage.rows["mt:ocr-recovery:ocr-old"], undefined);
  });
});

(async () => {
  const storage = fakeStorage();
  const cache = new PageCache(storage, { budgetBytes: 1300, now: () => 10 });
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
    versions: { prompt: "p1", recognizers: { es: "es1", ja: "ja2" }, detector: "d1" },
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

  const activeOnly = new PageCache(fakeStorage(), { budgetBytes: 1300 });
  await activeOnly.putPage(page("active-1", "queued", 1, "a".repeat(120)));
  await activeOnly.putPage(page("active-2", "running", 2, "b".repeat(120)));
  await assert.rejects(activeOnly.putJob({
    job_id: "full",
    state: "queued",
    descriptor: { source_url: `https://x/${"c".repeat(1200)}`, crop: "full" },
  }), CacheFullError);
  assert.ok(await activeOnly.getPage("active-1"));
  assert.ok(await activeOnly.getPage("active-2"));

  const safeStorage = fakeStorage();
  const safeCache = new PageCache(safeStorage);
  await safeCache.putPage({
    ...page("safe", "complete", 1),
    source_url: "https://x/page.jpg",
    crop: "full",
    blocks: [{
      block_id: "b1",
      bbox: [1, 2, 3, 4],
      src_text: "hola",
      trans_text: "xin chao",
      kind: "text",
      vertical: false,
      reading_order: 0,
      state: "translated",
    }],
    image_bytes: new Uint8Array([1, 2, 3]),
    prepared_crop: "data:image/png;base64,AAAA",
  });
  const saved = safeStorage.rows["mt:page:safe"];
  assert.deepStrictEqual(saved.blocks, [{
    block_id: "b1",
    bbox: [1, 2, 3, 4],
    src_text: "hola",
    trans_text: "xin chao",
    kind: "text",
    vertical: false,
    reading_order: 0,
    state: "translated",
  }]);
  assert.strictEqual(saved.image_bytes, undefined);
  assert.strictEqual(saved.prepared_crop, undefined);

  const resumableBlock = {
    block_id: "b2",
    bbox: [5, 6, 7, 8],
    src_text: "hola",
    trans_text: null,
    kind: null,
    vertical: false,
    reading_order: null,
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
  const lruCache = new PageCache(fakeStorage(), { budgetBytes: 1300, now: () => tick });
  await lruCache.putPage(page("frequently-found", "complete", 1, "a".repeat(150)));
  await lruCache.putPage(page("less-recent", "complete", 2, "b".repeat(150)));
  await lruCache.findPage((row) => row.page_artifact_key === "frequently-found");
  await lruCache.putPage(page("incoming", "complete", 3, "c".repeat(150)));
  assert.ok(await lruCache.getPage("frequently-found"));
  assert.strictEqual(await lruCache.getPage("less-recent"), null);

  let readOnlyTick = 2;
  const readOnlyStorage = fakeStorage();
  const readOnlyCache = new PageCache(readOnlyStorage, { now: () => readOnlyTick });
  await readOnlyCache.putPage(page("read-only-find", "complete", 1));
  const readOnlyFound = await readOnlyCache.findPage(
    (row) => row.page_artifact_key === "read-only-find",
    { touch: false },
  );
  assert.strictEqual(readOnlyFound.last_accessed_at, 1);
  assert.strictEqual(readOnlyStorage.rows["mt:page:read-only-find"].last_accessed_at, 1);

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
