# Goodreads bridge prototype

This is an opt-in Chrome MV3 bridge for the authenticated Goodreads export
flow. It does not read cookies, passwords, or tokens. After the user starts an
import from whatchureading, it opens Goodreads, waits for the user to sign in
if necessary, clicks the visible **Export Library** control, downloads the
generated CSV with the browser's existing Goodreads session, and relays the CSV
back to the open whatchureading tab.

The bridge is intentionally separate from the web app: a normal web page
cannot access Goodreads' cookies or DOM across origins, and an iframe is not a
reliable or appropriate login surface. The app-side message contract is:

```js
window.postMessage({ type: "WCR_GOODREADS_START", importId }, "*");
window.addEventListener("message", (event) => {
  if (event.data?.type === "WCR_GOODREADS_PROGRESS") { /* show animation */ }
  if (event.data?.type === "WCR_GOODREADS_DATA") { /* parse + preview CSV */ }
});
```

Load this directory through Chrome's **Extensions → Developer mode → Load
unpacked** while developing. Production distribution should use a signed
extension package or an equivalent first-party browser integration.
