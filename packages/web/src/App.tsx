import { useEffect, useState } from "react";
import { Editor } from "./Editor.js";

// One replica identity per tab, for the life of the tab.
const clientId = crypto.randomUUID();

interface User {
  id: string;
  name: string;
  email: string | null;
}

interface Doc {
  id: string;
  title: string;
  created_at: string;
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [docId, setDocId] = useState(window.location.hash.slice(1));

  useEffect(() => {
    fetch("/api/me").then(async (r) => setUser(r.ok ? await r.json() : null));
    const onHash = () => setDocId(window.location.hash.slice(1));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", fontFamily: "system-ui, sans-serif" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ cursor: "pointer" }} onClick={() => (window.location.hash = "")}>
          CollabWrite
        </h1>
        {user && (
          <span>
            {user.name}{" "}
            <button
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                setUser(null);
              }}
            >
              sign out
            </button>
          </span>
        )}
      </header>
      {user === undefined ? (
        <p>Loading…</p>
      ) : user === null ? (
        <Login onLogin={setUser} />
      ) : docId ? (
        <Editor docId={docId} clientId={clientId} />
      ) : (
        <DocList />
      )}
    </main>
  );
}

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [methods, setMethods] = useState<{ google: boolean; dev: boolean }>();
  const [name, setName] = useState("");

  useEffect(() => {
    fetch("/api/auth/methods").then(async (r) => setMethods(await r.json()));
  }, []);

  async function devLogin() {
    const r = await fetch("/api/auth/dev-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (r.ok) onLogin(await r.json());
  }

  if (!methods) return <p>Loading…</p>;
  return (
    <section>
      <h2>Sign in</h2>
      {methods.google && (
        <p>
          <a href="/api/auth/google">Sign in with Google</a>
        </p>
      )}
      {methods.dev && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void devLogin();
          }}
        >
          <input
            placeholder="your name (dev login)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={!name.trim()}>
            enter
          </button>
        </form>
      )}
    </section>
  );
}

function DocList() {
  const [docs, setDocs] = useState<Doc[]>();
  const [title, setTitle] = useState("");

  const refresh = () =>
    fetch("/api/documents").then(async (r) => setDocs(await r.json()));
  useEffect(() => void refresh(), []);

  async function create() {
    const r = await fetch("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (r.ok) {
      const doc: Doc = await r.json();
      window.location.hash = doc.id;
    }
  }

  return (
    <section>
      <h2>Your documents</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        style={{ marginBottom: 16 }}
      >
        <input
          placeholder="new document title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit" disabled={!title.trim()}>
          create
        </button>
      </form>
      {!docs ? (
        <p>Loading…</p>
      ) : docs.length === 0 ? (
        <p style={{ color: "#666" }}>No documents yet — create one above.</p>
      ) : (
        <ul>
          {docs.map((d) => (
            <li key={d.id}>
              <a href={`#${d.id}`}>{d.title}</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
