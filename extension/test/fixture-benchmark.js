(() => {
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
  if (!loopback || new URLSearchParams(location.search).get("benchmark") !== "cold") return;
  const status = document.getElementById("benchmarkStatus");
  const image = document.getElementById("readerPage");
  if (!status || !image) return;

  let armed = true, warmup = true, cold = 0;
  status.hidden = false;
  status.textContent = "WARM-UP";
  const observer = new MutationObserver(() => {
    if (!armed) {
      if (document.querySelector(".mt-overlay")) return;
      armed = true;
      status.textContent = `COLD ${cold + 1}/20`;
      return;
    }
    const bubble = document.querySelector(".mt-bubble");
    if (!bubble || !bubble.textContent.trim()) return;
    armed = false;
    if (!warmup) cold++;
    warmup = false;
    if (cold === 20) {
      status.textContent = "COMPLETE";
      observer.disconnect();
      return;
    }
    const source = new URL(image.src);
    source.searchParams.set("benchmark", String(cold + 1));
    image.src = source.href;
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
})();
