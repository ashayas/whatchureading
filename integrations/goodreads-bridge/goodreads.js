(() => {
  const OVERLAY_ID = "wcr-goodreads-bridge-overlay";
  let session;
  let exported = false;

  function overlay(message, done = false) {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = OVERLAY_ID;
      Object.assign(el.style, {
        position: "fixed", zIndex: "2147483647", right: "24px", bottom: "24px", width: "310px",
        padding: "18px 20px", borderRadius: "14px", background: "#203e35", color: "#f4f6e9",
        boxShadow: "0 12px 35px rgba(0,0,0,.2)", font: "14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif",
      });
      document.documentElement.appendChild(el);
    }
    el.innerHTML = `<div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.7">whatchureading</div><strong style="display:block;margin-top:5px">${message}</strong><div style="margin-top:11px;height:4px;border-radius:4px;background:rgba(255,255,255,.2);overflow:hidden"><i style="display:block;height:100%;width:${done ? 100 : 62}%;background:#d9e9ba;transition:width .5s"></i></div>`;
  }
  function status(status) {
    chrome.runtime.sendMessage({ type: "GOODREADS_PROGRESS", importId: session.importId, status });
    overlay(status);
  }
  async function waitForExport() {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      const link = document.querySelector('a[href*="/review_porter/export/"]');
      if (link?.href) return link.href;
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    throw new Error("Goodreads did not finish generating the export.");
  }
  async function run() {
    session = await chrome.runtime.sendMessage({ type: "GET_GOODREADS_SESSION" });
    if (!session?.importId) return;
    status("Waiting for Goodreads to be ready…");
    const button = document.querySelector("button.js-LibraryExport");
    if (!button) {
      status("Please sign in to Goodreads, then return here…");
      return;
    }
    if (!exported) {
      exported = true;
      status("Getting your Goodreads library…");
      button.click();
    }
    const href = await waitForExport();
    status("Your books are on their way…");
    const response = await fetch(href, { credentials: "include" });
    if (!response.ok) throw new Error(`Goodreads export failed (${response.status}).`);
    const csv = await response.text();
    if (!csv.includes("Book Id") || csv.length > 20_000_000) throw new Error("Goodreads returned an unexpected export file.");
    await chrome.runtime.sendMessage({ type: "GOODREADS_DATA", importId: session.importId, csv });
    overlay("Sent safely to your whatchureading library.", true);
  }
  run().catch((error) => {
    if (session?.importId) chrome.runtime.sendMessage({ type: "GOODREADS_PROGRESS", importId: session.importId, status: error.message });
    overlay(error.message);
  });
})();
