import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

/** A peer cursor already resolved to a position in this replica's text. */
export interface RenderedPeer {
  clientId: string;
  name: string;
  color: string;
  pos: number;
}

class PeerCursorWidget extends WidgetType {
  constructor(
    private name: string,
    private color: string,
  ) {
    super();
  }

  eq(other: PeerCursorWidget): boolean {
    return other.name === this.name && other.color === this.color;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cw-cursor";
    el.style.setProperty("--peer-color", this.color);
    const label = document.createElement("span");
    label.className = "cw-cursor-label";
    label.textContent = this.name;
    el.appendChild(label);
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** Dispatch this effect with the full current peer list to redraw cursors. */
export const setPeerCursors = StateEffect.define<RenderedPeer[]>();

/**
 * Holds peer-cursor decorations. Between presence updates, `map(tr.changes)`
 * keeps cursors visually in place as text shifts around them — the same
 * position-mapping CodeMirror uses for the local selection.
 */
export const peerCursorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(cursors, tr) {
    cursors = cursors.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setPeerCursors)) {
        cursors = Decoration.set(
          effect.value
            .filter((p) => p.pos >= 0 && p.pos <= tr.newDoc.length)
            .sort((a, b) => a.pos - b.pos)
            .map((p) =>
              Decoration.widget({
                widget: new PeerCursorWidget(p.name, p.color),
                side: -1,
              }).range(p.pos),
            ),
          true,
        );
      }
    }
    return cursors;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Deterministic color per client so every replica shows the same colors. */
const PALETTE = ["#e05252", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16"];

export function colorFor(clientId: string): string {
  let hash = 0;
  for (const ch of clientId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
