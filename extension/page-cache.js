const PAGE_SCHEMA = "page-v2";
const PAGE_PREFIX = "mt:page:";
const JOB_PREFIX = "mt:job:";
const OCR_RECOVERY_SCHEMA = "ocr-recovery-v1";
const OCR_RECOVERY_PREFIX = "mt:ocr-recovery:";
const ACTIVE_STATES = new Set(["queued", "running"]);
const TERMINAL_STATES = new Set(["partial", "complete", "failed"]);
const PAGE_STATES = new Set([...ACTIVE_STATES, ...TERMINAL_STATES]);
const TRANSLATION_STATES = new Set(["ocr_complete", "translated", "failed"]);
const RENDER_REASONS = new Set(["clean_failed", "layout_failed", "fit_failed", "unsupported_region"]);
class CacheFullError extends Error {}

function pageStorageKey(key) { return PAGE_PREFIX + key; }
function jobStorageKey(key) { return JOB_PREFIX + key; }
function ocrRecoveryStorageKey(key) { return OCR_RECOVERY_PREFIX + key; }
function recordBytes(key, value) {
  return new TextEncoder().encode(JSON.stringify({ [key]: value })).byteLength;
}

function metadataEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) || Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && metadataEqual(left[key], right[key])
  );
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

function storedBbox(value, field, nullable = false) {
  if (value === null && nullable) return null;
  if (!Array.isArray(value) || value.length !== 4 ||
    !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new TypeError(`${field} must be four finite numbers`);
  }
  return [...value];
}

function storedTranslationBlock(source) {
  if (!source || Object.getPrototypeOf(source) !== Object.prototype) throw new TypeError("block must be metadata");
  const block = {};
  for (const field of ["block_id", "src_text"]) {
    if (typeof source[field] !== "string") throw new TypeError(`${field} must be a string`);
    block[field] = source[field];
  }
  block.bbox = storedBbox(source.bbox, "bbox");
  if (source.trans_text !== null && typeof source.trans_text !== "string") {
    throw new TypeError("trans_text must be a string or null");
  }
  block.trans_text = source.trans_text;
  if (![null, "text", "sfx"].includes(source.kind)) throw new TypeError("kind must be text, sfx, or null");
  block.kind = source.kind;
  if (typeof source.vertical !== "boolean") throw new TypeError("vertical must be a boolean");
  block.vertical = source.vertical;
  if (source.reading_order !== null && (!Number.isInteger(source.reading_order) || source.reading_order < 0)) {
    throw new TypeError("reading_order must be a nonnegative integer or null");
  }
  block.reading_order = source.reading_order;
  if (!TRANSLATION_STATES.has(source.state)) throw new TypeError("state must be translation metadata");
  block.state = source.state;
  if (block.kind === "sfx" && block.trans_text !== null) throw new TypeError("sfx trans_text must be null");
  return block;
}

function storedManifestIds(manifestIds) {
  if (!Array.isArray(manifestIds) || !manifestIds.every((id) => typeof id === "string")) {
    throw new TypeError("manifest_ids must contain strings");
  }
  if (new Set(manifestIds).size !== manifestIds.length) throw new TypeError("manifest_ids must be unique");
  return [...manifestIds];
}

function storedLayoutProfile(profile) {
  if (profile === null) return null;
  if (!profile || Object.getPrototypeOf(profile) !== Object.prototype) {
    throw new TypeError("layout_profile must be metadata or null");
  }
  return {
    font_px: storedNumber(profile.font_px, "layout_profile.font_px"),
    line_height: storedNumber(profile.line_height, "layout_profile.line_height"),
  };
}

function storedRenderBlock(source) {
  if (!source || Object.getPrototypeOf(source) !== Object.prototype) throw new TypeError("render block must be metadata");
  if (typeof source.block_id !== "string") throw new TypeError("block_id must be a string");
  if (!["in_place", "skip"].includes(source.render_mode)) throw new TypeError("render_mode must be in_place or skip");
  if (source.patch_id !== null && typeof source.patch_id !== "string") throw new TypeError("patch_id must be a string or null");
  if (source.reason !== null && !RENDER_REASONS.has(source.reason)) throw new TypeError("reason must be a capability reason or null");
  const block = {
    block_id: source.block_id,
    render_mode: source.render_mode,
    patch_id: source.patch_id,
    patch_bbox: storedBbox(source.patch_bbox, "patch_bbox", true),
    fit_bbox: storedBbox(source.fit_bbox, "fit_bbox", true),
    layout_profile: storedLayoutProfile(source.layout_profile),
    reason: source.reason,
  };
  if (block.render_mode === "in_place" &&
    (block.patch_id === null || block.patch_bbox === null || block.fit_bbox === null ||
      block.layout_profile === null || block.reason !== null)) {
    throw new TypeError("in_place render block requires patch and layout metadata");
  }
  if (block.render_mode === "skip" &&
    (block.patch_id !== null || block.patch_bbox !== null || block.layout_profile !== null || !RENDER_REASONS.has(block.reason))) {
    throw new TypeError("skip render block requires a capability reason without patch metadata");
  }
  return block;
}

function storedRenderSubrecord(source, manifestIds) {
  if (!source || Object.getPrototypeOf(source) !== Object.prototype) throw new TypeError("render must be metadata");
  if (source.schema_version !== "render-page-v1") throw new TypeError("render schema_version must be render-page-v1");
  if (typeof source.render_artifact_key !== "string") throw new TypeError("render_artifact_key must be a string");
  if (typeof source.layout_fit_version !== "string") throw new TypeError("layout_fit_version must be a string");
  if (typeof source.breaker_open !== "boolean") throw new TypeError("breaker_open must be a boolean");
  if (!Array.isArray(source.blocks)) throw new TypeError("render blocks must be an array");
  const value = {
    schema_version: "render-page-v1",
    render_artifact_key: source.render_artifact_key,
    patch_versions: storedVersions(source.patch_versions),
    layout_fit_version: source.layout_fit_version,
    breaker_open: source.breaker_open,
    blocks: source.blocks.map(storedRenderBlock),
  };
  if (value.breaker_open) {
    if (value.blocks.length !== 0) throw new TypeError("breaker sentinel blocks must be empty");
  } else {
    if (manifestIds === undefined) throw new TypeError("ready render requires manifest_ids");
    const blockIds = new Set(value.blocks.map((block) => block.block_id));
    if (blockIds.size !== value.blocks.length || value.blocks.length !== manifestIds.length ||
      !manifestIds.every((id) => blockIds.has(id))) {
      throw new TypeError("ready render block IDs must match manifest_ids");
    }
  }
  return value;
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
  copyStrings(value, record, ["page_artifact_key", "analysis_key", "ocr_key", "render_artifact_key", "source_content_hash", "src_lang", "dst_lang"]);
  if (record.reading_direction !== undefined) {
    if (!["rtl", "ltr"].includes(record.reading_direction)) throw new TypeError("reading_direction must be rtl or ltr");
    value.reading_direction = record.reading_direction;
  }
  if (record.state !== undefined) {
    if (!PAGE_STATES.has(record.state)) throw new TypeError("state must be page metadata");
    value.state = record.state;
  }
  if (record.source_url !== undefined) value.source_url = storedUrl(record.source_url);
  copyNumbers(value, record, ["natural_width", "natural_height", "image_w", "image_h", "created_at"], ["image_w", "image_h"]);
  copyBooleans(value, record, ["analysis_known", "ocr_done"]);
  if (record.last_error !== undefined) {
    if (record.last_error !== null && typeof record.last_error !== "string") throw new TypeError("last_error must be a string");
    value.last_error = record.last_error;
  }
  if (record.versions !== undefined) value.versions = storedVersions(record.versions);
  if (record.patch_versions !== undefined) value.patch_versions = storedVersions(record.patch_versions);
  value.crop = storedCrop(record.crop ?? "full");
  if (!Array.isArray(record.blocks)) throw new TypeError("blocks must be an array");
  value.blocks = record.blocks.map(storedTranslationBlock);
  if (record.manifest_ids !== undefined) value.manifest_ids = storedManifestIds(record.manifest_ids);
  if (value.manifest_ids?.some((id) => {
    const matches = value.blocks.filter((block) => block.block_id === id);
    return matches.length !== 1 || matches[0].kind !== "text" || matches[0].state !== "translated" ||
      typeof matches[0].trans_text !== "string" || matches[0].trans_text.trim().length === 0;
  })) {
    throw new TypeError("manifest_ids must map to exactly one translated text block");
  }
  if (record.manifest_mismatch_count !== undefined) {
    if (![0, 1].includes(record.manifest_mismatch_count)) throw new TypeError("manifest_mismatch_count must be 0 or 1");
    value.manifest_mismatch_count = record.manifest_mismatch_count;
  }
  if (record.render !== undefined) value.render = storedRenderSubrecord(record.render, value.manifest_ids);
  return value;
}

function storedDescriptor(descriptor) {
  if (descriptor === undefined) return undefined;
  if (!descriptor || Object.getPrototypeOf(descriptor) !== Object.prototype) throw new TypeError("descriptor must be metadata");
  const value = {};
  copyStrings(value, descriptor, ["job_id", "request_id", "src_lang", "dst_lang", "scope", "page_artifact_key", "reading_direction"]);
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

function storedOcrRecovery(record) {
  if (!record || Object.getPrototypeOf(record) !== Object.prototype ||
      Object.keys(record).length !== 1 || record.schema_version !== OCR_RECOVERY_SCHEMA) {
    throw new TypeError(`OCR recovery schema_version must be ${OCR_RECOVERY_SCHEMA}`);
  }
  return { schema_version: OCR_RECOVERY_SCHEMA };
}

function pageVersionsEqual(rowVersions, liveVersions, srcLang) {
  if (!rowVersions || !liveVersions || Object.getPrototypeOf(rowVersions) !== Object.prototype ||
    Object.getPrototypeOf(liveVersions) !== Object.prototype) return false;
  const rowKeys = Object.keys(rowVersions).filter((key) => key !== "recognizers");
  const liveKeys = Object.keys(liveVersions).filter((key) => key !== "recognizers");
  if (rowKeys.length !== liveKeys.length || !rowKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(liveVersions, key) &&
    typeof rowVersions[key] === "string" && rowVersions[key] === liveVersions[key])) return false;
  const rowRecognizers = rowVersions.recognizers;
  const liveRecognizers = liveVersions.recognizers;
  if (rowRecognizers === undefined && liveRecognizers === undefined) return true;
  if (!rowRecognizers || !liveRecognizers || Object.getPrototypeOf(rowRecognizers) !== Object.prototype ||
    Object.getPrototypeOf(liveRecognizers) !== Object.prototype || typeof srcLang !== "string") return false;
  return typeof rowRecognizers[srcLang] === "string" && rowRecognizers[srcLang] === liveRecognizers[srcLang];
}

function runtimePage(row, layoutFitVersion) {
  if (layoutFitVersion === undefined || !row.render || row.render.layout_fit_version === layoutFitVersion) return row;
  return {
    ...row,
    render: {
      ...row.render,
      blocks: row.render.blocks.map((block) => ({ ...block, layout_profile: null })),
    },
  };
}

class PageCache {
  constructor(storage, { budgetBytes = 8 * 1024 * 1024, now = Date.now } = {}) {
    this.storage = storage;
    this.budgetBytes = budgetBytes;
    this.now = now;
    this.layoutFitVersion = undefined;
    this.ocrRecoveryClaimTail = Promise.resolve();
  }

  async _all() {
    return this.storage.get(null);
  }

  async _touch(key, row) {
    const touched = storedPage(row, row.updated_at);
    try {
      touched.last_accessed_at = storedNumber(this.now(), "last_accessed_at");
      await this.storage.set({ [key]: touched });
      return runtimePage(touched, this.layoutFitVersion);
    } catch {
      return runtimePage(touched, this.layoutFitVersion);
    }
  }

  async getPage(pageKey) {
    const key = pageStorageKey(pageKey);
    const row = (await this.storage.get(key))[key];
    if (!row || row.schema_version !== PAGE_SCHEMA) return null;
    return this._touch(key, row);
  }

  async findPage(predicate, { touch = true } = {}) {
    const rows = await this._all();
    for (const [key, row] of Object.entries(rows)) {
      if (key.startsWith(PAGE_PREFIX) && row.schema_version === PAGE_SCHEMA && predicate(row)) {
        if (!touch) return runtimePage(storedPage(row, row.updated_at), this.layoutFitVersion);
        return this._touch(key, row);
      }
    }
    return null;
  }

  async purgeIncompatible(versions, patchVersions, layoutFitVersion) {
    if (layoutFitVersion !== undefined) {
      if (typeof layoutFitVersion !== "string") throw new TypeError("layoutFitVersion must be a string");
      this.layoutFitVersion = layoutFitVersion;
    }
    const remove = [];
    for (const [key, row] of Object.entries(await this._all())) {
      if (!key.startsWith(PAGE_PREFIX)) continue;
      if (row.schema_version !== PAGE_SCHEMA || !pageVersionsEqual(row.versions, versions, row.src_lang)) {
        remove.push(key);
      } else if (row.render !== undefined && patchVersions !== undefined &&
        (!metadataEqual(row.patch_versions, patchVersions) || !metadataEqual(row.render.patch_versions, patchVersions))) {
        const preserved = storedPage(row, row.updated_at);
        delete preserved.render;
        await this.storage.set({ [key]: preserved });
      }
    }
    if (remove.length) await this.storage.remove(remove);
    await this._gcOcrRecoveryLedgers();
    return remove.length;
  }

  async _gcOcrRecoveryLedgers() {
    const rows = await this._all();
    const referenced = new Set(Object.entries(rows)
      .filter(([key, row]) => key.startsWith(PAGE_PREFIX) && row.schema_version === PAGE_SCHEMA && typeof row.ocr_key === "string")
      .map(([, row]) => row.ocr_key));
    const remove = [];
    for (const [key, row] of Object.entries(rows)) {
      if (!key.startsWith(OCR_RECOVERY_PREFIX)) continue;
      const ocrKey = key.slice(OCR_RECOVERY_PREFIX.length);
      try {
        storedOcrRecovery(row);
      } catch {
        remove.push(key);
        continue;
      }
      if (!referenced.has(ocrKey)) remove.push(key);
    }
    if (remove.length) await this.storage.remove(remove);
  }

  async _evictFor(key, value, protectedPageKey) {
    const rows = await this._all();
    const protectedKey = protectedPageKey === undefined ? null : pageStorageKey(protectedPageKey);
    const stale = [];
    const complete = [];
    const otherTerminal = [];
    for (const [name, row] of Object.entries(rows)) {
      if (!name.startsWith(PAGE_PREFIX) || name === key || name === protectedKey) continue;
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
      await this._gcOcrRecoveryLedgers();
      const current = await this._all();
      bytes = await this.storage.getBytesInUse(null);
      bytes = bytes - (current[key] ? recordBytes(key, current[key]) : 0) + recordBytes(key, value);
    }
    if (bytes > this.budgetBytes) throw new CacheFullError("session cache full");
  }

  async _evictOneTerminal(excludeKey, protectedPageKey) {
    const protectedKey = protectedPageKey === undefined ? null : pageStorageKey(protectedPageKey);
    const candidates = Object.entries(await this._all())
      .filter(([key, row]) => key !== excludeKey && key !== protectedKey && key.startsWith(PAGE_PREFIX) && TERMINAL_STATES.has(row.state))
      .sort((a, b) => {
        const tier = (row) => row.schema_version !== PAGE_SCHEMA ? 0 : row.state === "complete" ? 1 : 2;
        return tier(a[1]) - tier(b[1]) || (a[1].last_accessed_at || 0) - (b[1].last_accessed_at || 0);
      });
    if (candidates.length) {
      await this.storage.remove(candidates[0][0]);
      await this._gcOcrRecoveryLedgers();
    }
  }

  async _put(key, value, protectedPageKey) {
    await this._evictFor(key, value, protectedPageKey);
    try {
      await this.storage.set({ [key]: value });
    } catch (firstError) {
      await this._evictOneTerminal(key, protectedPageKey);
      await this._evictFor(key, value, protectedPageKey);
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
    const stored = await this._put(pageStorageKey(record.page_artifact_key), value);
    await this._gcOcrRecoveryLedgers();
    return stored;
  }

  async putJob(record) {
    return this._put(jobStorageKey(record.job_id), storedJob(record));
  }

  async removeJob(jobId) {
    await this.storage.remove(jobStorageKey(jobId));
  }

  async removePage(pageKey) {
    await this.storage.remove(pageStorageKey(pageKey));
    await this._gcOcrRecoveryLedgers();
  }

  claimOcrRecovery(ocrKey, protectedPageKey) {
    if (typeof ocrKey !== "string" || typeof protectedPageKey !== "string") {
      return Promise.reject(new TypeError("ocrKey and protectedPageKey must be strings"));
    }
    const claim = this.ocrRecoveryClaimTail.then(async () => {
      const key = ocrRecoveryStorageKey(ocrKey);
      const existing = (await this.storage.get(key))[key];
      if (existing !== undefined) {
        try {
          storedOcrRecovery(existing);
          return false;
        } catch {
          await this.storage.remove(key);
        }
      }
      await this._put(key, storedOcrRecovery({ schema_version: OCR_RECOVERY_SCHEMA }), protectedPageKey);
      return true;
    });
    this.ocrRecoveryClaimTail = claim.catch(() => {});
    return claim;
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
        const page = storedPage(row, row.updated_at);
        if (page.state === "running") page.state = "queued";
        pages.push(runtimePage(page, this.layoutFitVersion));
        if (!metadataEqual(page, row)) await this.storage.set({ [key]: page });
      } else if (key.startsWith(JOB_PREFIX)) {
        const job = row.state === "running" ? { ...row, state: "queued" } : row;
        jobs.push(job);
        if (job !== row) await this.storage.set({ [key]: job });
      } else if (key.startsWith(OCR_RECOVERY_PREFIX)) {
        try {
          storedOcrRecovery(row);
        } catch {
          await this.storage.remove(key);
        }
      }
    }
    await this._gcOcrRecoveryLedgers();
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
globalThis.metadataEqual = metadataEqual;
if (typeof module !== "undefined") module.exports = { PageCache, CacheFullError, PAGE_SCHEMA, metadataEqual };
