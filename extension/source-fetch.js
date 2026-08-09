(() => {
  "use strict";

  function abortError() {
    const error = new Error("source fetch aborted");
    error.name = "AbortError";
    return error;
  }

  function create({ fetchImpl, cryptoImpl, maxConcurrent }) {
    const limit = Math.max(1, Math.floor(maxConcurrent));
    const entries = new Map();
    const queue = [];
    let active = 0;

    function pump() {
      while (active < limit && queue.length) {
        const entry = queue.shift();
        if (entry.refs === 0) continue;
        entry.started = true;
        active++;
        void (async () => {
          try {
            const response = await fetchImpl(entry.url, { signal: entry.controller.signal });
            if (!response.ok) throw new Error(`source fetch HTTP ${response.status}`);
            const blob = await response.blob();
            const bytes = await blob.arrayBuffer();
            if (entry.controller.signal.aborted) throw abortError();
            const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
            const sourceContentHash = [...new Uint8Array(digest)]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
            if (entry.controller.signal.aborted) throw abortError();
            entry.resolve({ sourceContentHash, blob });
          } catch (error) {
            if (entries.get(entry.url) === entry) entries.delete(entry.url);
            entry.reject(error);
          } finally {
            entry.settled = true;
            active--;
            if (entry.refs === 0 && entries.get(entry.url) === entry) entries.delete(entry.url);
            pump();
          }
        })();
      }
    }

    function acquire(url) {
      let entry = entries.get(url);
      if (!entry) {
        entry = {
          url,
          controller: new AbortController(),
          refs: 1,
          started: false,
          settled: false,
        };
        entry.promise = new Promise((resolve, reject) => {
          entry.resolve = resolve;
          entry.reject = reject;
        });
        entry.promise.catch(() => {});
        entries.set(url, entry);
        queue.push(entry);
        pump();
      } else {
        entry.refs++;
      }
      let released = false;
      return {
        promise: entry.promise,
        release() {
          if (released) return;
          released = true;
          entry.refs--;
          if (entry.refs !== 0) return;
          entry.controller.abort();
          if (!entry.started) {
            if (entries.get(entry.url) === entry) entries.delete(entry.url);
            entry.reject(abortError());
          } else if (entry.settled && entries.get(entry.url) === entry) {
            entries.delete(entry.url);
          }
        },
      };
    }

    return { acquire };
  }

  globalThis.MangaSourceFetch = { create };
})();
