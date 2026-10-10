const SESSION_KEY = "wcrGoodreadsSession";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_GOODREADS_IMPORT") {
    const session = { importId: message.importId, appTabId: sender.tab?.id ?? null, startedAt: Date.now() };
    chrome.storage.session.set({ [SESSION_KEY]: session });
    chrome.tabs.create({ url: "https://www.goodreads.com/review/import", active: true });
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "GET_GOODREADS_SESSION") {
    chrome.storage.session.get(SESSION_KEY).then((value) => sendResponse(value[SESSION_KEY] || null));
    return true;
  }
  if (message.type === "GOODREADS_PROGRESS" || message.type === "GOODREADS_DATA") {
    chrome.storage.session.get(SESSION_KEY).then(async (value) => {
      const session = value[SESSION_KEY];
      if (!session || session.importId !== message.importId || !session.appTabId) return;
      await chrome.tabs.sendMessage(session.appTabId, { ...message, type: message.type });
      if (message.type === "GOODREADS_DATA") await chrome.storage.session.remove(SESSION_KEY);
    });
    sendResponse({ ok: true });
    return true;
  }
});
