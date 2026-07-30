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

  await cache.putJob({ job_id: "j1", state: "running", created_at: 1 });
  const rehydrated = await cache.rehydrate();
  assert.strictEqual(rehydrated.jobs[0].state, "queued");

  const tiny = new PageCache(fakeStorage(), { budgetBytes: 20 });
  await assert.rejects(tiny.putPage(page("too-large", "running", 1, "x".repeat(100))), CacheFullError);

  const activeOnly = new PageCache(fakeStorage(), { budgetBytes: 800 });
  await activeOnly.putPage(page("active-1", "queued", 1, "a".repeat(120)));
  await activeOnly.putPage(page("active-2", "running", 2, "b".repeat(120)));
  await assert.rejects(activeOnly.putJob({ job_id: "full", state: "queued", descriptor: "c".repeat(300) }), CacheFullError);
  assert.ok(await activeOnly.getPage("active-1"));
  assert.ok(await activeOnly.getPage("active-2"));

  console.log("page-cache.test.js OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
