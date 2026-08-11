const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const controller = fs.existsSync("extension/test/fixture-benchmark.js")
  ? fs.readFileSync("extension/test/fixture-benchmark.js", "utf8")
  : "";

function createApp(hostname, search = "?benchmark=cold") {
  const status = { hidden: true, textContent: "" };
  const sourceChanges = [];
  let source = "http://127.0.0.1:8000/ja_page.png", overlay = null, translatedText = null, observer;
  const image = { get src() { return source; }, set src(value) { source = value; sourceChanges.push(value); } };
  const document = {
    body: {},
    getElementById(id) { return id === "benchmarkStatus" ? status : image; },
    querySelector(selector) {
      if (selector === ".mt-overlay") return overlay;
      return selector === ".mt-translated-text" ? translatedText : null;
    },
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observer = this; }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  vm.runInNewContext(controller, {
    URL, URLSearchParams, MutationObserver, document,
    location: { hostname, search },
  });
  return {
    status, sourceChanges,
    get observer() { return observer; },
    render(text) { overlay = {}; translatedText = { textContent: text }; observer.callback(); },
    fire() { observer.callback(); },
    removeOverlay() { overlay = null; translatedText = null; observer.callback(); },
  };
}

const remote = createApp("example.test");
assert.strictEqual(remote.status.hidden, true);
assert.strictEqual(remote.observer, undefined);
const inactive = createApp("127.0.0.1", "");
assert.strictEqual(inactive.status.hidden, true);
assert.strictEqual(inactive.observer, undefined);

const app = createApp("127.0.0.1");
assert.strictEqual(app.status.textContent, "WARM-UP");
app.render(" ");
assert.strictEqual(app.sourceChanges.length, 0);
app.removeOverlay();

app.render("vi:warm-up");
// Mutation caught: restoring the removed legacy bubble selector stalls the observable cold-sample source advance.
assert.strictEqual(app.sourceChanges[0], "http://127.0.0.1:8000/ja_page.png?benchmark=1");
app.fire();
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
assert.strictEqual(app.sourceChanges.length, 20);
assert.strictEqual(new Set(app.sourceChanges).size, 20);
assert.strictEqual(app.observer.disconnected, true);
console.log("fixture-benchmark.test.js OK");
