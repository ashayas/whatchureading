import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AuthRoot, BookLoading } from "./AuthBook";
import "./styles.css";

let appModule: ReturnType<typeof importApp> | undefined;
function importApp() {
  return import("./App");
}
const prepareApp = () => (appModule ??= importApp());
const App = lazy(prepareApp);
createRoot(document.getElementById("root")!).render(
  <AuthRoot prepareApp={prepareApp}>
    {(data) => (
      <Suspense fallback={<BookLoading />}>
        <App key={data.reader_id} initialData={data} />
      </Suspense>
    )}
  </AuthRoot>,
);
