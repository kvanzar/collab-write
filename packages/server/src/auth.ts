import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import passportSingleton from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import type { ServerConfig } from "./config.js";
import type { Db, User } from "./db.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // Passport augments req.user with this shape.
    interface User {
      id: string;
      name: string;
      email: string | null;
    }
  }
}

export function setupAuth(app: Express, db: Db, config: ServerConfig): void {
  // Own Passport instance per server node — the module-level singleton
  // accumulates (de)serializers across instances, which breaks multi-node
  // setups (tests boot several nodes in one process).
  const passport = new passportSingleton.Passport();

  // Sessions store only the user id; the full row is re-read per request
  // so a renamed/deleted user is reflected immediately.
  passport.serializeUser<string>((user, done) => done(null, user.id));
  passport.deserializeUser<string>(async (id, done) => {
    try {
      done(null, (await db.getUser(id)) ?? false);
    } catch (err) {
      done(err);
    }
  });

  app.use(passport.initialize());
  app.use(passport.session());

  if (config.google) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: config.google.clientId,
          clientSecret: config.google.clientSecret,
          callbackURL: config.google.callbackUrl,
          scope: ["profile", "email"],
        },
        async (_accessToken, _refreshToken, profile, done) => {
          try {
            const user = await db.findOrCreateGoogleUser(
              profile.id,
              profile.displayName,
              profile.emails?.[0]?.value ?? null,
            );
            done(null, user);
          } catch (err) {
            done(err as Error);
          }
        },
      ),
    );
    app.get("/api/auth/google", passport.authenticate("google"));
    app.get(
      "/api/auth/google/callback",
      passport.authenticate("google", { failureRedirect: "/" }),
      (_req, res) => res.redirect("/"),
    );
  }

  // Which login methods should the UI offer?
  app.get("/api/auth/methods", (_req, res) => {
    res.json({ google: Boolean(config.google), dev: config.allowDevLogin });
  });

  if (config.allowDevLogin) {
    app.post("/api/auth/dev-login", async (req, res, next) => {
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name) return res.status(400).json({ error: "name required" });
      try {
        const user = await db.findOrCreateDevUser(name);
        req.login(userForSession(user), (err) => (err ? next(err) : res.json(user)));
      } catch (err) {
        next(err);
      }
    });
  }

  app.post("/api/auth/logout", (req, res, next) => {
    req.logout((err) => (err ? next(err) : res.status(204).end()));
  });

  app.get("/api/me", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "not signed in" });
    res.json(req.user);
  });
}

export const requireAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: "not signed in" });
  next();
};

function userForSession(user: User): Express.User {
  return { id: user.id, name: user.name, email: user.email };
}
