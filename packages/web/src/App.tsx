import { useEffect, useState } from "react";
import { Editor } from "./Editor.js";
import { colorFor } from "./presence.js";

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
    <>
      <header className="topbar">
        <div className="logo" onClick={() => (window.location.hash = "")}>
          Collab<span>Write</span>
        </div>
        {user && (
          <div className="userchip">
            <span className="avatar" style={{ background: colorFor(user.id) }}>
              {user.name[0]?.toUpperCase()}
            </span>
            {user.name}
            <button
              className="btn-ghost"
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                window.location.hash = "";
                setUser(null);
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </header>
      <div className="container">
        {user === undefined ? null : user === null ? (
          <Login onLogin={setUser} />
        ) : docId ? (
          <Editor docId={docId} clientId={clientId} userName={user.name} />
        ) : (
          <DocList />
        )}
      </div>
    </>
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

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>
          Collab<span style={{ color: "var(--accent)" }}>Write</span>
        </h1>
        <p className="tagline">Write together, in real time. Conflict-free.</p>
        {!methods ? (
          <p>Loading…</p>
        ) : (
          <>
            {methods.google && (
              <a className="google-btn" href="/api/auth/google">
                <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.7 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.4 17.7 9.5 24 9.5z" />
                  <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
                  <path fill="#FBBC05" d="M10.4 28.7a14.4 14.4 0 0 1 0-9.4l-7.8-6.1a24 24 0 0 0 0 21.6l7.8-6.1z" />
                  <path fill="#34A853" d="M24 48c6.2 0 11.5-2 15.3-5.6l-7.5-5.8c-2.1 1.4-4.7 2.2-7.8 2.2-6.3 0-11.7-3.9-13.6-9.4l-7.8 6.1C6.5 42.6 14.6 48 24 48z" />
                </svg>
                Sign in with Google
              </a>
            )}
            {methods.google && methods.dev && <div className="divider">or</div>}
            {methods.dev && (
              <form
                className="login-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void devLogin();
                }}
              >
                <input
                  className="textinput"
                  placeholder="Your name (dev login)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
                  Enter
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DocList() {
  const [docs, setDocs] = useState<Doc[]>();
  const [title, setTitle] = useState("");

  useEffect(() => {
    fetch("/api/documents").then(async (r) => setDocs(await r.json()));
  }, []);

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
      <h2 className="page-title">Your documents</h2>
      <form
        className="create-row"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          className="textinput"
          placeholder="Start a new document…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={!title.trim()}>
          Create
        </button>
      </form>
      {!docs ? (
        <p>Loading…</p>
      ) : docs.length === 0 ? (
        <div className="empty-state">No documents yet — create your first one above.</div>
      ) : (
        <div className="doc-grid">
          {docs.map((d) => (
            <a key={d.id} className="doc-card" href={`#${d.id}`}>
              <div className="title">{d.title}</div>
              <div className="date">
                {new Date(d.created_at).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </div>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
