# Cold benchmark fixture helper design

## Scope

Add a manual benchmark controller only to `extension/test/fixture.html` and a
fixture-only script. It activates only for `benchmark=cold` on loopback hosts.
Normal fixture modes and production extension files remain unchanged.

## Behavior

The page begins at `WARM-UP`. A human keeps the popup open and clicks the
visible-page action. When a nonempty `.mt-bubble` appears, the controller
disarms before changing `#readerPage` to `ja_page.png?benchmark=1`. It waits
until the old `.mt-overlay` is absent, then rearms and shows `COLD 1/20`.

Each cold overlay repeats that sequence with the next unique query URL. After
the twentieth cold overlay, the page disarms permanently and shows `COMPLETE`.
One mutation observer handles both overlay completion and removal.

## Files and testing

- `extension/test/fixture.html`: conditionally loads the controller and exposes
  a visible status element.
- `extension/test/fixture-benchmark.js`: the minimal state machine; no reusable
  production abstraction.
- `extension/test/fixture-benchmark.test.js`: dependency-free Node VM check of
  loopback activation, warm-up discard, disarm/removal/rearm ordering, unique
  URLs, exactly twenty cold samples, and completion.

The regression check runs the real fixture controller against a small fake DOM
and MutationObserver. Relevant Node tests and `git diff --check` remain green.

## Limits

The helper advances only after a rendered nonempty bubble; it does not click
the popup, record timings, or recover from translation failures. The human
owns those actions and the production benchmark log.
