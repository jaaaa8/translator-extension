const PAGE_SCHEMA = "page-v1";
const PAGE_PREFIX = "mt:page:";
const JOB_PREFIX = "mt:job:";
const ACTIVE_STATES = new Set(["queued", "running"]);
const TERMINAL_STATES = new Set(["partial", "complete", "failed"]);

class CacheFullError extends Error {}

function pageStorageKey(key) { return PAGE_PREFIX + key; }
function jobStorageKey(key) { return JOB_PREFIX + key; }
function recordBytes(key, value) {
  return new TextEncoder().encode(JSON.stringify({ [key]: value })).byteLength;
}

class PageCache {
  constructor(storage, { budgetBytes = 8 * 1024 * 1024, now = Date.now } = {}) {
    this.storage = storage;
    this.budgetBytes = budgetBytes;
    this.now = now;
  }

  async _all() {
    return this.storage.get(null);
  }

  async getPage(pageKey) {
    const key = pageStorageKey(pageKey);
    const row = (await this.storage.get(key))[key];
    if (!row || row.schema_version !== PAGE_SCHEMA) return null;
    row.last_accessed_at = this.now();
    try {
      await this.storage.set({ [key]: row });
    } catch {
      // Access-time bookkeeping must not turn a valid hit into a render failure.
    }
    return row;
  }

  async findPage(predicate) {
    const rows = await this._all();
    for (const [key, row] of Object.entries(rows)) {
      if (key.startsWith(PAGE_PREFIX) && row.schema_version === PAGE_SCHEMA && predicate(row)) return row;
    }
    return null;
  }

  async purgeIncompatible(versions) {
    const expected = JSON.stringify(versions);
    const remove = Object.entries(await this._all())
      .filter(([key, row]) => key.startsWith(PAGE_PREFIX) &&
        (row.schema_version !== PAGE_SCHEMA || JSON.stringify(row.versions) !== expected))
      .map(([key]) => key);
    if (remove.length) await this.storage.remove(remove);
    return remove.length;
  }

  async _evictFor(key, value) {
    const rows = await this._all();
    const stale = [];
    const complete = [];
    const otherTerminal = [];
    for (const [name, row] of Object.entries(rows)) {
      if (!name.startsWith(PAGE_PREFIX) || name === key) continue;
      if (!TERMINAL_STATES.has(row.state)) continue;
      if (row.schema_version !== PAGE_SCHEMA) stale.push([name, row]);
      else if (row.state === "complete") complete.push([name, row]);
      else if (row.state === "partial" || row.state === "failed") otherTerminal.push([name, row]);
    }
    const byAccess = (a, b) => (a[1].last_accessed_at || 0) - (b[1].last_accessed_at || 0);
    complete.sort(byAccess);
    otherTerminal.sort(byAccess);
    const candidates = [...stale, ...complete, ...otherTerminal];
    let bytes = await this.storage.getBytesInUse(null);
    bytes = bytes - (rows[key] ? recordBytes(key, rows[key]) : 0) + recordBytes(key, value);
    while (bytes > this.budgetBytes && candidates.length) {
      const [removeKey, removeValue] = candidates.shift();
      await this.storage.remove(removeKey);
      bytes -= recordBytes(removeKey, removeValue);
    }
    if (bytes > this.budgetBytes) throw new CacheFullError("session cache full");
  }

  async _evictOneTerminal(excludeKey) {
    const candidates = Object.entries(await this._all())
      .filter(([key, row]) => key !== excludeKey && key.startsWith(PAGE_PREFIX) && TERMINAL_STATES.has(row.state))
      .sort((a, b) => {
        const tier = (row) => row.schema_version !== PAGE_SCHEMA ? 0 : row.state === "complete" ? 1 : 2;
        return tier(a[1]) - tier(b[1]) || (a[1].last_accessed_at || 0) - (b[1].last_accessed_at || 0);
      });
    if (candidates.length) await this.storage.remove(candidates[0][0]);
  }

  async _put(key, value) {
    await this._evictFor(key, value);
    try {
      await this.storage.set({ [key]: value });
    } catch (firstError) {
      await this._evictOneTerminal(key);
      await this._evictFor(key, value);
      try {
        await this.storage.set({ [key]: value });
      } catch {
        throw new CacheFullError(String(firstError));
      }
    }
    return value;
  }

  async putPage(record) {
    const now = this.now();
    const value = {
      ...record,
      schema_version: PAGE_SCHEMA,
      updated_at: now,
      last_accessed_at: record.last_accessed_at || now,
    };
    return this._put(pageStorageKey(record.page_artifact_key), value);
  }

  async putJob(record) {
    return this._put(jobStorageKey(record.job_id), record);
  }

  async removeJob(jobId) {
    await this.storage.remove(jobStorageKey(jobId));
  }

  async removePage(pageKey) {
    await this.storage.remove(pageStorageKey(pageKey));
  }

  async rehydrate() {
    const pages = [];
    const jobs = [];
    for (const [key, row] of Object.entries(await this._all())) {
      if (key.startsWith(PAGE_PREFIX)) {
        if (row.schema_version !== PAGE_SCHEMA) {
          await this.storage.remove(key);
          continue;
        }
        const page = row.state === "running" ? { ...row, state: "queued" } : row;
        pages.push(page);
        if (page !== row) await this.storage.set({ [key]: page });
      } else if (key.startsWith(JOB_PREFIX)) {
        const job = row.state === "running" ? { ...row, state: "queued" } : row;
        jobs.push(job);
        if (job !== row) await this.storage.set({ [key]: job });
      }
    }
    return { pages, jobs };
  }

  async status() {
    const rows = await this._all();
    const pages = Object.entries(rows)
      .filter(([key, row]) => key.startsWith(PAGE_PREFIX) && row.schema_version === PAGE_SCHEMA)
      .map(([, row]) => row);
    const jobs = Object.entries(rows).filter(([key]) => key.startsWith(JOB_PREFIX)).map(([, row]) => row);
    return {
      background: jobs.filter((row) => ACTIVE_STATES.has(row.state)).length,
      cached: pages.filter((row) => row.state === "complete").length,
      failed: pages.filter((row) => row.state === "failed").length,
    };
  }
}

globalThis.PageCache = PageCache;
globalThis.CacheFullError = CacheFullError;
if (typeof module !== "undefined") module.exports = { PageCache, CacheFullError, PAGE_SCHEMA };
