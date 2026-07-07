import { useEffect, useRef, useState } from "react";
import { basicSetup, EditorView } from "codemirror";
import { Annotation } from "@codemirror/state";
import { placeholder } from "@codemirror/view";
import type { PeerPresence } from "@collab-write/crdt-core";
import { CollabSession } from "./collab.js";
import { colorFor, peerCursorField, setPeerCursors, type RenderedPeer } from "./presence.js";

/** Tags editor changes that came from the network, so we don't re-send them. */
const remoteChange = Annotation.define<boolean>();

// Same-origin (Vite proxy in dev, served by the node in prod), so the
// session cookie authenticates the upgrade. Adapts to wss:// under https.
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

/** Rate-limit presence broadcasts (PRD: cursors fire on every keystroke). */
function throttle<T extends unknown[]>(fn: (...args: T) => void, ms: number) {
  let last = 0;
  let timer: number | undefined;
  return (...args: T) => {
    const run = () => {
      last = Date.now();
      fn(...args);
    };
    const wait = ms - (Date.now() - last);
    if (wait <= 0) {
      run();
    } else {
      clearTimeout(timer);
      timer = window.setTimeout(run, wait);
    }
  };
}

interface EditorProps {
  docId: string;
  clientId: string;
  userName: string;
}

export function Editor({ docId, clientId, userName }: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);
  const [title, setTitle] = useState<string>();
  const [notFound, setNotFound] = useState(false);
  const [peers, setPeers] = useState<PeerPresence[]>([]);

  useEffect(() => {
    fetch(`/api/documents/${docId}`).then(async (r) => {
      if (r.ok) setTitle((await r.json()).title);
      else setNotFound(true);
    });
  }, [docId]);

  useEffect(() => {
    const session = new CollabSession(WS_URL, docId, clientId);
    const myColor = colorFor(clientId);

    const sendCursor = throttle((view: EditorView) => {
      const head = view.state.selection.main.head;
      session.sendPresence({
        clientId,
        name: userName,
        color: myColor,
        cursor: {
          afterId: head === 0 ? null : (session.doc.charIdAtVisibleIndex(head - 1) ?? null),
        },
      });
    }, 100);

    const view = new EditorView({
      parent: containerRef.current!,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        placeholder("Start writing — everyone in this document sees your words live."),
        peerCursorField,
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) sendCursor(update.view);
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

    // Resolve every peer's CharId anchor against our replica and redraw.
    const renderPeerCursors = () => {
      const rendered: RenderedPeer[] = [];
      for (const peer of session.peers.values()) {
        if (!peer.cursor) continue;
        let pos = 0;
        if (peer.cursor.afterId !== null) {
          const idx = session.doc.visibleIndexOfId(peer.cursor.afterId);
          if (idx === -1) continue; // anchor deleted — hide until next update
          pos = idx + 1;
        }
        rendered.push({ clientId: peer.clientId, name: peer.name, color: peer.color, pos });
      }
      view.dispatch({ effects: setPeerCursors.of(rendered) });
    };

    // Remote ops: re-render the editor from the replica via a minimal diff,
    // tagged so the update listener ignores it. CodeMirror maps the local
    // cursor across the change.
    session.onRemoteChange = () => {
      const oldText = view.state.doc.toString();
      const newText = session.doc.text();
      if (oldText !== newText) {
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
      }
      renderPeerCursors();
    };

    session.onPeersChange = () => {
      setPeers([...session.peers.values()]);
      renderPeerCursors();
    };

    session.onStatus = (up) => {
      setConnected(up);
      if (up) sendCursor(view); // announce ourselves right after (re)joining
    };

    session.connect();

    return () => {
      session.dispose();
      view.destroy();
    };
  }, [docId, clientId, userName]);

  if (notFound) {
    return (
      <div className="empty-state">
        Document not found. <a href="#">Back to your documents</a>
      </div>
    );
  }

  return (
    <div>
      <div className="editor-head">
        <button className="btn-ghost" onClick={() => (window.location.hash = "")}>
          ← Docs
        </button>
        <div className="doc-title">{title ?? "…"}</div>
        <div className="presence-stack">
          <span className="avatar" style={{ background: colorFor(clientId) }} title={`${userName} (you)`}>
            {initials(userName)}
          </span>
          {peers.map((p) => (
            <span key={p.clientId} className="avatar" style={{ background: p.color }} title={p.name}>
              {initials(p.name)}
            </span>
          ))}
        </div>
        <span className={`status-pill ${connected ? "live" : "offline"}`}>
          {connected ? "● Live" : "○ Reconnecting…"}
        </span>
      </div>
      <div className="editor-surface">
        <div ref={containerRef} />
      </div>
      <p className="editor-hint">
        Share this page's URL — anyone signed in can edit with you in real time.
      </p>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}
