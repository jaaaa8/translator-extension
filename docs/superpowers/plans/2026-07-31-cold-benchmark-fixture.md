# Cold Benchmark Fixture Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a loopback-only fixture controller that discards one prewarm-assisted visible action, then advances through 20 unique cold visible sources.

**Architecture:** `fixture.html` exposes a fixed status element and loads one fixture-only controller. The controller is an IIFE with one MutationObserver and a small state machine; a dependency-free Node VM test executes that real file against a fake DOM.

**Tech Stack:** Browser DOM APIs, vanilla JavaScript, Node `assert`/`fs`/`vm`.

## Global Constraints

- Activate only for `benchmark=cold` on `127.0.0.1`, `localhost`, or `[::1]`.
- Do not modify production extension files or add dependencies.
- Preserve normal and acceptance fixture behavior.
- Preserve `.tmp-task10-browser/`.

---

### Task 1: Fixture-only cold benchmark controller

**Files:**
- Create: `extension/test/fixture-benchmark.test.js`
- Create: `extension/test/fixture-benchmark.js`
- Modify: `extension/test/fixture.html`

**Interfaces:**
- Consumes: `location`, `document`, `MutationObserver`, `URL`, `URLSearchParams`, `#readerPage`, `#benchmarkStatus`, `.mt-overlay`, `.mt-bubble`.
- Produces: visible states `WARM-UP`, `COLD n/20`, `COMPLETE`; unique reader URLs `?benchmark=1` through `?benchmark=20`.

- [ ] **Step 1: Write the failing behavioral test**

Create a Node VM harness that evaluates `fixture-benchmark.js` when present,
supplies a fake status element, reader image, DOM queries, and MutationObserver,
then asserts:

```javascript
const remote = createApp("example.test");
assert.strictEqual(remote.status.hidden, true);
assert.strictEqual(remote.observer, undefined);

const app = createApp("127.0.0.1");
assert.strictEqual(app.status.textContent, "WARM-UP");
app.render("vi:warm-up");
assert.strictEqual(app.sourceChanges[0], "http://127.0.0.1:8000/ja_page.png?benchmark=1");
app.fire();
assert.strictEqual(app.sourceChanges.length, 1);
app.removeOverlay();
assert.strictEqual(app.status.textContent, "COLD 1/20");

for (let sample = 1; sample <= 20; sample++) {
  app.render(`vi:cold-${sample}`);
  if (sample < 20) {
    app.removeOverlay();
    assert.strictEqual(app.status.textContent, `COLD ${sample + 1}/20`);
  }
}
assert.strictEqual(app.status.textContent, "COMPLETE");
assert.strictEqual(new Set(app.sourceChanges).size, 20);
assert.strictEqual(app.observer.disconnected, true);
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `node --test extension/test/fixture-benchmark.test.js`

Expected: assertion failure because the absent controller leaves the loopback
status hidden/empty and creates no observer.

- [ ] **Step 3: Implement the minimum controller and fixture wiring**

In `fixture-benchmark.js`, exit unless the query and loopback host match. Show
`WARM-UP`, disarm on a nonempty bubble, advance `#readerPage` with the next
query value, and only rearm after `.mt-overlay` is absent. After cold sample 20,
show `COMPLETE` and disconnect. Add `#benchmarkStatus` plus the sibling script
tag to `fixture.html`.

- [ ] **Step 4: Verify GREEN and relevant regressions**

Run:

```powershell
node --test extension/test/fixture-benchmark.test.js
node --test extension/test/content.test.js extension/test/content-progressive.test.js extension/test/srcset.test.js
git diff --check
```

Expected: focused 1/1, relevant extension 3/3, diff check clean.

- [ ] **Step 5: Review and commit**

Confirm only the fixture, controller, focused test, spec, and plan belong to
this work; production extension sources remain unchanged. Commit implementation:

```powershell
git add extension/test/fixture.html extension/test/fixture-benchmark.js extension/test/fixture-benchmark.test.js docs/superpowers/plans/2026-07-31-cold-benchmark-fixture.md
git commit -m "test: add cold benchmark fixture helper"
```
