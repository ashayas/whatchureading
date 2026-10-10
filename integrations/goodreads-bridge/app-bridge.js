window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== "WCR_GOODREADS_START") return;
  const importId = String(event.data.importId || "");
  if (!/^[0-9a-f-]{36}$/i.test(importId)) return;
  chrome.runtime.sendMessage({ type: "START_GOODREADS_IMPORT", importId });
});

chrome.runtime.onMessage.addListener((message) => {
  if (!["GOODREADS_PROGRESS", "GOODREADS_DATA"].includes(message.type)) return;
  window.postMessage({
    source: "wcr-goodreads-bridge",
    type: `WCR_${message.type}`,
    importId: message.importId,
    status: message.status,
    csv: message.csv,
  }, "*");
});
