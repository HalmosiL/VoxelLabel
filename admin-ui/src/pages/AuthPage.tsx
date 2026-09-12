import { FormEvent, useState } from "react";

import { submitRegistrationRequest } from "../api/adminApi";
import { describeApiError } from "../api/client";
import { keycloakConfig } from "../config";

/** The tokens a successful password-grant exchange returns -- the same
 * three keycloak-js itself works with everywhere else in this app
 * (see main.tsx's saved-session restore for the clinician-app, which
 * hands keycloak.init() exactly this shape). */
export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
}

/** sessionStorage key main.tsx's startOver() writes a one-line reason
 * into right before it reloads into this page (a session Keycloak no
 * longer accepts, a failed restore) -- read and cleared once on mount,
 * so the person sees why they're back at the sign-in form. */
export const AUTH_NOTICE_KEY = "vl.authNotice";

function takeAuthNotice(): string | null {
  try {
    const notice = sessionStorage.getItem(AUTH_NOTICE_KEY);
    if (notice) sessionStorage.removeItem(AUTH_NOTICE_KEY);
    return notice;
  } catch {
    return null;
  }
}

/** Exchanges a username/password for tokens directly against Keycloak's
 * token endpoint (the realm's "ct-platform" client has Direct Access
 * Grants enabled -- this is the same grant_type=password flow already
 * used for every service account and test login in this project).
 * Deliberately not routed through keycloak-js: that library's own
 * init() may only be called once, and by the time this resolves we
 * still don't know whether the app has ever called it -- see
 * main.tsx's bootstrap for why the single init() call happens after,
 * not before, this. */
async function passwordLogin(username: string, password: string): Promise<AuthTokens> {
  const response = await fetch(`${keycloakConfig.url}/realms/${keycloakConfig.realm}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    // scope=openid is required explicitly -- without it Keycloak's
    // direct-grant response omits id_token entirely, which keycloak.
    // init() needs alongside the access/refresh token (found the hard
    // way: login "succeeded" but the session silently failed to
    // persist across a reload, since the persist-session code checks
    // for all three).
    body: new URLSearchParams({ grant_type: "password", client_id: keycloakConfig.clientId, username, password, scope: "openid" }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}) as { error_description?: string });
    throw new Error(
      response.status === 401 || response.status === 400
        ? "Incorrect username or password."
        : body.error_description || `Couldn't sign in (HTTP ${response.status}).`
    );
  }
  return response.json();
}

/** The one surface a person who isn't signed in ever sees: sign in, or
 * ask for an account, in the same card with a tab to switch. Replaces
 * two previously separate things -- Keycloak's own unstyled hosted
 * login page, and the standalone public/register.html this app used
 * to redirect strangers to (now just a redirect back here, see that
 * file) -- with one place, one look. main.tsx mounts this in place of
 * the app whenever there's no session to restore; it hands the
 * resulting tokens back up rather than owning the keycloak-js
 * instance itself. */
export default function AuthPage({
  onAuthenticated,
  initialTab = "signin",
}: {
  onAuthenticated: (tokens: AuthTokens) => void;
  initialTab?: "signin" | "register";
}) {
  const [tab, setTab] = useState<"signin" | "register">(initialTab);
  const [notice] = useState(takeAuthNotice);

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        {notice && (
          <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-center text-sm text-amber-800" data-testid="auth-notice">
            {notice}
          </p>
        )}
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-base font-bold text-white shadow-md shadow-brand-600/30">
            VL
          </div>
          <div>
            <div className="text-lg font-semibold text-gray-900">VoxelLabel</div>
            <div className="text-sm text-gray-400">CT annotation platform</div>
          </div>
        </div>

        <div className="card p-0 overflow-hidden">
          <div className="grid grid-cols-2 border-b border-gray-100">
            <TabButton active={tab === "signin"} onClick={() => setTab("signin")} testId="tab-signin">
              Sign in
            </TabButton>
            <TabButton active={tab === "register"} onClick={() => setTab("register")} testId="tab-register">
              Create account
            </TabButton>
          </div>
          <div className="p-7" data-testid={tab === "signin" ? "signin-panel" : "register-panel"}>
            {tab === "signin" ? <SignInForm onAuthenticated={onAuthenticated} /> : <RegisterForm onDone={() => setTab("signin")} />}
          </div>
        </div>

        <p className="mt-5 text-center text-xs text-gray-400">Trouble signing in? Ask your administrator to reset your password.</p>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`px-4 py-3.5 text-sm font-semibold transition-colors ${
        active ? "bg-brand-50/70 text-brand-700" : "text-gray-400 hover:bg-gray-50 hover:text-gray-600"
      }`}
    >
      {children}
    </button>
  );
}

function SignInForm({ onAuthenticated }: { onAuthenticated: (tokens: AuthTokens) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const tokens = await passwordLogin(username, password);
      onAuthenticated(tokens);
      // Left busy/mounted on purpose: the caller is about to replace
      // this whole tree with the authenticated app, so there's no
      // "logged in, form still sitting there enabled" state to clean up.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="field">
        <span className="label">Username</span>
        <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
      </label>
      <label className="field">
        <span className="label">Password</span>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={busy} data-testid="signin-submit" className="btn-primary mt-1 justify-center py-2.5">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function RegisterForm({ onDone }: { onDone: () => void }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^[A-Za-z0-9._-]+$/.test(username.trim())) {
      setError("Username can only contain letters, digits, dot, underscore or hyphen.");
      return;
    }
    setBusy(true);
    try {
      await submitRegistrationRequest({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        username: username.trim(),
        email: email.trim(),
        note: note.trim() || null,
      });
      setSent(true);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-inset ring-emerald-200">
          ✓
        </div>
        <h2 className="text-base font-semibold text-gray-900">Request sent</h2>
        <p className="text-sm leading-relaxed text-gray-500">
          Thanks -- an administrator will review it. You'll get an email at the address you gave either way.
        </p>
        <button type="button" onClick={onDone} data-testid="back-to-signin" className="btn-secondary btn-sm mt-1">
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <p className="-mt-1 text-sm text-gray-500">An administrator reviews every request -- you'll get an email either way.</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="field">
          <span className="label">First name</span>
          <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" required />
        </label>
        <label className="field">
          <span className="label">Last name</span>
          <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" required />
        </label>
      </div>
      <label className="field">
        <span className="label">Username</span>
        <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" minLength={3} required />
      </label>
      <label className="field">
        <span className="label">Email address</span>
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        <span className="hint">Approval and your sign-in details go here.</span>
      </label>
      <label className="field">
        <span className="label">
          Why do you need access? <span className="font-normal text-gray-400">(optional)</span>
        </span>
        <textarea
          className="input min-h-[64px]"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          placeholder="e.g. the study or team you're joining"
        />
      </label>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={busy} data-testid="register-submit" className="btn-primary mt-1 justify-center py-2.5">
        {busy ? "Sending…" : "Request access"}
      </button>
    </form>
  );
}
