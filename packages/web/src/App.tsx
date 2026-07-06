import { Editor } from "./Editor.js";

// One replica identity per tab, for the life of the tab.
const clientId = crypto.randomUUID();

export function App() {
  // Doc selection UI comes with auth/doc-list (week 3); for now use the
  // URL hash so two tabs on the same hash share a document.
  const docId = window.location.hash.slice(1) || "demo";

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", fontFamily: "system-ui, sans-serif" }}>
      <h1>CollabWrite</h1>
      <p style={{ color: "#666" }}>
        Open this page in two windows to edit together. Change the doc with{" "}
        <code>#some-doc-name</code> in the URL.
      </p>
      <Editor docId={docId} clientId={clientId} />
    </main>
  );
}
