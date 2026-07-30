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

function copyStrings(target, source, fields) {
  for (const field of fields) {
    if (source[field] === undefined) continue;
    if (typeof source[field] !== "string") throw new TypeError(`${field} must be a string`);
    target[field] = source[field];
  }
}

function storedNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  return value;
}

function copyNumbers(target, source, fields, nullable = []) {
  for (const field of fields) {
    if (source[field] === undefined) continue;
    if (source[field] === null && nullable.includes(field)) {
      target[field] = null;
    } else {
      target[field] = storedNumber(source[field], field);
    }
  }
}

function copyBooleans(target, source, fields) {
  for (const field of fields) {
    if (source[field] === undefined) continue;
    if (typeof source[field] !== "boolean") throw new TypeError(`${field} must be a boolean`);
    target[field] = source[field];
  }
}

function storedUrl(value) {
  if (typeof value !== "string") throw new TypeError("source_url must be a string URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("source_url must be a string URL");
  }
  if (!["http:", "https:", "blob:"].includes(url.protocol)) throw new TypeError("source_url must be metadata");
  if (url.protocol === "blob:") {
    let origin;
    try {
      origin = new URL(url.pathname);
    } catch {
      throw new TypeError("source_url must be metadata");
    }
    if (!["http:", "https:", "chrome-extension:"].includes(origin.protocol)) {
      throw new TypeError("source_url must be metadata");
    }
  }
  return value;
}

function storedVersions(versions) {
  if (!versions || Object.getPrototypeOf(versions) !== Object.prototype) throw new TypeError("versions must be metadata");
  const value = {};
  for (const [key, version] of Object.entries(versions)) {
    if (typeof version === "string") value[key] = version;
    else if (version && Object.getPrototypeOf(version) === Object.prototype) value[key] = storedVersions(version);
    else throw new TypeError("versions must contain strings");
  }
  return value;
}

function storedBlock(source) {
  if (!source || Object.getPrototypeOf(source) !== Object.prototype) throw new TypeError("block must be metadata");
  const block = {};
  copyStrings(block, source, ["block_id", "src_text", "state"]);
  if (source.trans_text !== undefined) {
    if (source.trans_text !== null && typeof source.trans_text !== "string") {
      throw new TypeError("trans_text must be a string or null");
    }
    block.trans_text = source.trans_text;
  }
  const { bbox } = source;
  if (bbox !== undefined) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new TypeError("bbox must be four finite numbers");
    }
    block.bbox = [...bbox];
  }
  return block;
}

function storedCrop(crop) {
  if (crop === "full") return crop;
  if (!crop || Object.getPrototypeOf(crop) !== Object.prototype ||
    Object.keys(crop).length !== 4 || !["left", "top", "right", "bottom"].every((key) => key in crop) ||
    !Object.values(crop).every((value) => typeof value === "number" && Number.isFinite(value)) ||
    crop.left < 0 || crop.top < 0 || crop.right > 1 || crop.bottom > 1 ||
    crop.left >= crop.right || crop.top >= crop.bottom) {
    throw new TypeError("crop must be normalized metadata");
  }
  return { left: crop.left, top: crop.top, right: crop.right, bottom: crop.bottom };
}

function storedPage(record, now) {
  const value = {
    schema_version: PAGE_SCHEMA,
    updated_at: storedNumber(now, "updated_at"),
    last_accessed_at: storedNumber(record.last_accessed_at ?? now, "last_accessed_at"),
  };
  copyStrings(value, record, ["page_artifact_key", "analysis_key", "ocr_key", "overlay_key", "src_lang", "dst_lang", "state"]);
  if (record.source_url !== undefined) value.source_url = storedUrl(record.source_url);
  copyNumbers(value, record, ["natural_width", "natural_height", "image_w", "image_h", "created_at"], ["image_w", "image_h"]);
  copyBooleans(value, record, ["analysis_known", "ocr_done"]);
  if (record.last_error !== undefined) {
    if (record.last_error !== null && typeof record.last_error !== "string") throw new TypeError("last_error must be a string");
    value.last_error = record.last_error;
  }
  if (record.versions !== undefined) value.versions = storedVersions(record.versions);
  value.crop = storedCrop(record.crop ?? "full");
  value.blocks = (record.blocks || []).map(storedBlock);
  return value;
}

function storedDescriptor(descriptor) {
  if (descriptor === undefined) return undefined;
  if (!descriptor || Object.getPrototypeOf(descriptor) !== Object.prototype) throw new TypeError("descriptor must be metadata");
  const value = {};
  copyStrings(value, descriptor, ["job_id", "request_id", "src_lang", "dst_lang", "scope", "page_artifact_key"]);
  if (descriptor.source_url !== undefined) value.source_url = storedUrl(descriptor.source_url);
  copyNumbers(value, descriptor, ["natural_width", "natural_height", "priority", "distance"]);
  value.crop = storedCrop(descriptor.crop ?? "full");
  return value;
}

function storedJob(record) {
  const value = {};
  copyStrings(value, record, ["job_id", "request_id", "scope", "src_lang", "dst_lang", "state", "page_artifact_key"]);
  copyNumbers(value, record, ["created_at"]);
  copyBooleans(value, record, ["waiting_for_health"]);
  const descriptor = storedDescriptor(record.descriptor);
  if (descriptor !== undefined) value.descriptor = descriptor;
  return value;
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

  async _touch(key, row) {
    try {
      const touched = { ...row, last_accessed_at: storedNumber(this.now(), "last_accessed_at") };
      await this.storage.set({ [key]: touched });
      return touched;
    } catch {
      return row;
    }
  }

  async getPage(pageKey) {
    const key = pageStorageKey(pageKey);
    const row = (await this.storage.get(key))[key];
    if (!row || row.schema_version !== PAGE_SCHEMA) return null;
    return this._touch(key, row);
  }

  async findPage(predicate) {
    const rows = await this._all();
    for (const [key, row] of Object.entries(rows)) {
      if (key.startsWith(PAGE_PREFIX) && row.schema_version === PAGE_SCHEMA && predicate(row)) {
        return this._touch(key, row);
      }
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
    const value = storedPage(record, this.now());
    return this._put(pageStorageKey(record.page_artifact_key), value);
  }

  async putJob(record) {
    return this._put(jobStorageKey(record.job_id), storedJob(record));
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
