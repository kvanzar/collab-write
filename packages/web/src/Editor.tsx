import { useEffect, useRef, useState } from "react";
import { basicSetup, EditorView } from "codemirror";
import { Annotation } from "@codemirror/state";
import { CollabSession } from "./collab.js";

/** Tags editor changes that came from the network, so we don't re-send them. */
const remoteChange = Annotation.define<boolean>();

// Same-origin through the Vite proxy, so the session cookie authenticates
// the upgrade. Adapts to wss:// automatically when the page is https.
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export function Editor({ docId, clientId }: { docId: string; clientId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const session = new CollabSession(WS_URL, docId, clientId);

    const view = new EditorView({
      parent: containerRef.current!,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          // Skip changes we ourselves dispatched from remote ops.
          if (update.transactions.some((tr) => tr.annotation(remoteChange))) return;

          // Translate editor changes into CRDT ops. Positions are in
          // pre-change coordinates, so process changes back-to-front to
          // keep earlier positions valid.
          const changes: { from: number; to: number; inserted: string }[] = [];
          update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            changes.push({ from: fromA, to: toA, inserted: inserted.toString() });
          });
          for (const change of changes.reverse()) {
            for (let i = change.to - 1; i >= change.from; i--) {
              session.sendLocal(session.doc.localDelete(change.from));
            }
            for (let i = 0; i < change.inserted.length; i++) {
              session.sendLocal(session.doc.localInsert(change.from + i, change.inserted[i]));
            }
          }
        }),
      ],
    });

    // Remote ops: re-render the editor from the replica via a minimal diff,
    // tagged so the update listener ignores it. CodeMirror maps the local
    // cursor across the change.
    session.onRemoteChange = () => {
      const oldText = view.state.doc.toString();
      const newText = session.doc.text();
      if (oldText === newText) return;

      let start = 0;
      while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) {
        start++;
      }
      let oldEnd = oldText.length;
      let newEnd = newText.length;
      while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
        oldEnd--;
        newEnd--;
      }
      view.dispatch({
        changes: { from: start, to: oldEnd, insert: newText.slice(start, newEnd) },
        annotations: [remoteChange.of(true)],
      });
    };

    session.onStatus = setConnected;
    session.connect();

    return () => {
      session.dispose();
      view.destroy();
    };
  }, [docId, clientId]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
        <strong>doc: {docId}</strong>
        <span style={{ color: connected ? "green" : "crimson" }}>
          {connected ? "● connected" : "○ offline (reconnecting…)"}
        </span>
      </div>
      <div
        ref={containerRef}
        style={{ border: "1px solid #ccc", borderRadius: 6, minHeight: 320 }}
      />
    </div>
  );
}
