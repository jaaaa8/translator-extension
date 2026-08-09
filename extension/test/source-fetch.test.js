const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const vm = require("vm");
const { createHash, webcrypto } = require("crypto");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function loadApi() {
  const context = { AbortController, Blob, Promise, Uint8Array };
  vm.createContext(context);
  let source;
  try {
    source = fs.readFileSync(path.resolve(__dirname, "../source-fetch.js"), "utf8");
  } catch {
    return undefined;
  }
  vm.runInContext(source, context);
  return context.MangaSourceFetch;
}

function createPool(options) {
  const api = loadApi();
  assert.strictEqual(
    typeof api?.create,
    "function",
    "source fetch pool must expose MangaSourceFetch.create",
  );
  return api.create(options);
}

test("same URL shares one promise and only the final crop consumer aborts", async () => {
  // Mutation caught: keying entries by crop or aborting on the first release.
  const gate = deferred();
  let aborted = false;
  const pool = createPool({
    cryptoImpl: webcrypto,
    maxConcurrent: 2,
    fetchImpl: async (_url, { signal }) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      await gate.promise;
      return { ok: true, blob: async () => new Blob(["page"]) };
    },
  });

  const first = pool.acquire("https://x/page.jpg", { crop: "full" });
  const second = pool.acquire("https://x/page.jpg", {
    crop: { left: 0, top: 0, right: 0.5, bottom: 1 },
  });
  assert.strictEqual(first.promise, second.promise);
  first.release();
  assert.strictEqual(aborted, false);
  second.release();
  assert.strictEqual(aborted, true);
  gate.resolve();
  await assert.rejects(first.promise);
});

test("source scheduler starts at most two URLs and admits queued URLs FIFO", async () => {
  // Mutation caught: sharing producer MAX_CONCURRENT incorrectly or starting queued URLs LIFO.
  const gates = new Map(["A", "B", "C"].map((name) => [name, deferred()]));
  const starts = [];
  let active = 0;
  let peak = 0;
  const pool = createPool({
    cryptoImpl: webcrypto,
    maxConcurrent: 2,
    fetchImpl: async (url) => {
      const name = new URL(url).pathname.slice(1);
      starts.push(name);
      active++;
      peak = Math.max(peak, active);
      await gates.get(name).promise;
      active--;
      return { ok: true, blob: async () => new Blob([name]) };
    },
  });

  const rows = ["A", "B", "C"].map((name) => pool.acquire(`https://x/${name}`));
  await Promise.resolve();
  assert.deepStrictEqual(starts, ["A", "B"]);
  gates.get("B").resolve();
  await rows[1].promise;
  await Promise.resolve();
  assert.deepStrictEqual(starts, ["A", "B", "C"]);
  gates.get("A").resolve();
  gates.get("C").resolve();
  await Promise.all(rows.map((row) => row.promise));
  rows.forEach((row) => row.release());
  assert.strictEqual(peak, 2);
});

test("source identity hashes the exact fetched Blob bytes", async () => {
  // Mutation caught: hashing URL/text/natural dimensions or a decoded/transformed representation.
  const bytes = Uint8Array.from([0, 255, 1, 128, 13, 10, 0]);
  const blob = new Blob([bytes], { type: "image/png" });
  const pool = createPool({
    cryptoImpl: webcrypto,
    maxConcurrent: 2,
    fetchImpl: async () => ({ ok: true, blob: async () => blob }),
  });
  const acquisition = pool.acquire("https://x/exact.png");

  const identity = await acquisition.promise;
  assert.strictEqual(identity.blob, blob);
  assert.strictEqual(
    identity.sourceContentHash,
    createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
  );
  acquisition.release();
});

test("failed URL entry is discarded so a later visit retries", async () => {
  // Mutation caught: retaining a rejected promise in the URL map and poisoning every later visit.
  let attempts = 0;
  const pool = createPool({
    cryptoImpl: webcrypto,
    maxConcurrent: 2,
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) return { ok: false, status: 503 };
      return { ok: true, blob: async () => new Blob(["retry"]) };
    },
  });
  const first = pool.acquire("https://x/retry.jpg");
  await assert.rejects(first.promise, /HTTP 503/);
  first.release();
  const second = pool.acquire("https://x/retry.jpg");
  await second.promise;
  second.release();
  assert.strictEqual(attempts, 2);
});
