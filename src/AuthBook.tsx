import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/auth-js";
import type { AuthOnlyClient } from "./auth";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Eye,
  EyeOff,
  Wind,
} from "lucide-react";
import { authClient, callbackUrl } from "./auth";
import { api, type Bootstrap } from "./types";
import { AboutPage } from "./AboutPage";
import "./auth-book.css";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Stage =
  "email" | "username" | "password" | "confirm" | "reset-sent" | "recovery";
export function BookLoading({ leaving = false }: { leaving?: boolean }) {
  return (
    <BookFrame loading leaving={leaving}>
      <div className="auth-loading" role="status">
        <Wind size={27} />
        <span className="auth-eyebrow">YOUR NEXT CHAPTER</span>
        <h1>
          Finding your
          <br />
          <em>place.</em>
        </h1>
        <p>
          A moment to settle in.
          <br />
          Your shelves are on their way.
        </p>
        <span className="auth-loading-dots">
          <i />
          <i />
          <i />
        </span>
      </div>
    </BookFrame>
  );
}
function BookFrame({
  children,
  loading = false,
  leaving = false,
  turning = false,
}: {
  children: ReactNode;
  loading?: boolean;
  leaving?: boolean;
  turning?: boolean;
}) {
  return (
    <main className={`auth-scene ${leaving ? "auth-leaving" : ""}`}>
      <a href="/" className="auth-brand">
        <img src="/logo.png" alt="" />
        whatchureading<span className="brand-dot">.</span>
      </a>
      <a
        href="#about"
        className="auth-promise"
        aria-label="About whatchureading and open data"
        onClick={(e) => {
          e.preventDefault();
          location.hash = "about";
        }}
      >
        <strong>Free. Open-source. Own your own chapter.</strong>
        <span>No Amazon. No ads. Learn more →</span>
      </a>
      <div className={`auth-book ${loading ? "is-fluttering" : ""}`}>
        <div className="auth-back-cover" />
        <section className="auth-left-page" aria-label="Welcome">
          <span className="auth-eyebrow">
            A LITTLE LESS SCROLLING. A LITTLE MORE READING.
          </span>
          <div className="auth-cover-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-spark">✦</div>
            <div className="art-book">
              <BookOpen strokeWidth={0.8} />
            </div>
            <span className="art-caption">
              GOOD THINGS ARE
              <br />
              BETWEEN THE PAGES.
            </span>
          </div>
          <h2>
            Every reader
            <br />
            has a <em>story.</em>
          </h2>
          <p>
            Keep your place. Share a thought.
            <br />
            Find the book that finds you.
          </p>
          <span className="auth-page-number">01 — THE BEGINNING</span>
        </section>
        <section className="auth-right-page">{children}</section>
        <div className="auth-spine" aria-hidden="true" />
        {loading &&
          [0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="auth-flying-page"
              style={{ animationDelay: `${i * 0.24}s` }}
              aria-hidden="true"
            >
              <span />
              <span />
              <span />
              <BookOpen />
            </div>
          ))}
        {turning && (
          <div className="auth-turn-page" aria-hidden="true">
            <span />
            <span />
            <span />
            <BookOpen />
          </div>
        )}
        <div className="auth-ribbon" aria-hidden="true" />
      </div>
      <footer className="auth-footer">
        <span>A home for your reading life.</span>
        <span>
          <a
            href="#about"
            onClick={(e) => {
              e.preventDefault();
              location.hash = "about";
            }}
          >
            About
          </a>{" "}
          ·{" "}
          <a
            href="#privacy"
            onClick={(e) => {
              e.preventDefault();
              location.hash = "privacy";
            }}
          >
            Privacy
          </a>{" "}
          ·{" "}
          <a
            href="#terms"
            onClick={(e) => {
              e.preventDefault();
              location.hash = "terms";
            }}
          >
            Terms &amp; EULA
          </a>{" "}
          ·{" "}
          <a
            href="#support"
            onClick={(e) => {
              e.preventDefault();
              location.hash = "support";
            }}
          >
            Support
          </a>{" "}
          · made by{" "}
          <a href="https://x.com/ashaya" target="_blank" rel="noreferrer">
            @ashaya
          </a>
        </span>
      </footer>
    </main>
  );
}
export function AuthRoot({
  children,
  prepareApp,
}: {
  children: (data: Bootstrap) => ReactNode;
  prepareApp: () => Promise<unknown>;
}) {
  const [client, setClient] = useState<AuthOnlyClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState(
    new URLSearchParams(location.search).get("recovery") === "1",
  );
  const [leaving, setLeaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const isLegalOrAbout = () => {
    if (typeof location === "undefined") return false;
    const paths = ["/about", "/privacy", "/terms", "/eula", "/support"];
    const hashes = ["#about", "#privacy", "#terms", "#eula", "#support"];
    return paths.includes(location.pathname) || hashes.includes(location.hash);
  };
  const [showAbout, setShowAbout] = useState(isLegalOrAbout);
  useEffect(() => {
    const syncAbout = () => {
      setShowAbout(isLegalOrAbout());
    };
    window.addEventListener("hashchange", syncAbout);
    window.addEventListener("popstate", syncAbout);
    return () => {
      window.removeEventListener("hashchange", syncAbout);
      window.removeEventListener("popstate", syncAbout);
    };
  }, []);
  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    authClient()
      .then(async (supabase) => {
        if (!active) return;
        setClient(supabase);
        const subscription = supabase.auth.onAuthStateChange((event, next) => {
          if (!active) return;
          if (event === "PASSWORD_RECOVERY") setRecovery(true);
          setSession(next);
          if (!next) {
            setData(null);
            setLeaving(false);
          }
        });
        unsubscribe = () => subscription.data.subscription.unsubscribe();
        // Token-hash links work across devices. PKCE code links are also handled
        // automatically by the auth client, without putting tokens in our API.
        const callbackParams = new URLSearchParams(location.search);
        const tokenHash = callbackParams.get("token_hash");
        const type = callbackParams.get("type");
        if (
          location.pathname === "/auth/callback" &&
          tokenHash &&
          (type === "email" || type === "signup" || type === "recovery")
        ) {
          if (type === "recovery") setRecovery(true);
          history.replaceState(null, "", "/auth/callback");
          const verified = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type,
          });
          if (!active) return;
          if (verified.error) {
            setError(
              "This link has expired or was already used. Request a new link or sign in.",
            );
            setRecovery(false);
          }
        }
        const initialized = await supabase.auth.initialize();
        if (initialized.error) setError(initialized.error.message);
        const { data, error } = await supabase.auth.getSession();
        if (!active) return;
        if (error) setError(error.message);
        setSession(data.session);
        const params = new URLSearchParams(location.search);
        const hash = new URLSearchParams(location.hash.slice(1));
        const callbackError =
          params.get("error_description") || hash.get("error_description");
        if (callbackError) setError(callbackError);
        if (params.has("code") && !data.session) {
          setRecovery(false);
          setError(
            "This sign-in link could not be opened. Use the browser where you requested it, or request a new link.",
          );
        }
        if (params.get("recovery") === "1" && !data.session) {
          setRecovery(false);
          setError(
            callbackError ||
              "This reset link has expired. Sign in or request a new link.",
          );
        }
        if (location.pathname === "/auth/callback")
          history.replaceState(null, "", "/" + (data.session ? "#feed" : ""));
        setInitializing(false);
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setInitializing(false);
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [retry]);
  const userId = session?.user.id;
  useEffect(() => {
    if (!userId || recovery || initializing) return;
    let active = true;
    setData(null);
    setError("");
    setLeaving(false);
    Promise.all([
      (async () => {
        const pendingUsername = localStorage.getItem("wcr.pending-username");
        if (pendingUsername) {
          await api("username", "PUT", { username: pendingUsername });
          localStorage.removeItem("wcr.pending-username");
        }
        return api<Bootstrap>("bootstrap");
      })(),
      pause(800),
      prepareApp(),
    ])
      .then(async ([next]) => {
        if (!active) return;
        setLeaving(true);
        await pause(450);
        if (active) {
          setLoadedFor(userId);
          setData(next);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [userId, recovery, initializing, retry, prepareApp]);
  if (data && session && loadedFor === session.user.id && !recovery)
    return children(data);
  if (showAbout && (!data || !session))
    return (
      <AboutPage
        onBack={() => {
          setShowAbout(false);
          if (location.hash === "#about") {
            history.pushState(null, "", "/");
          } else if (location.pathname === "/about") {
            history.pushState(null, "", "/");
          }
        }}
        isAuthenticated={false}
      />
    );
  if ((initializing || (session && !recovery)) && !error)
    return <BookLoading leaving={leaving} />;
  if (!client || (session && !recovery))
    return (
      <BookFrame>
        <div className="auth-form-content">
          <span className="auth-eyebrow">A SMALL PLOT TWIST</span>
          <h1>
            Let’s try
            <br />
            <em>again.</em>
          </h1>
          <p role="alert">{error || "Your connection needs a moment."}</p>
          {session && error.toLowerCase().includes("username") && (
            <UsernameClaimRecovery
              initial={localStorage.getItem("wcr.pending-username") || ""}
              onClaimed={() => {
                setError("");
                setRetry((n) => n + 1);
              }}
            />
          )}
          <button
            className="auth-primary"
            onClick={() => {
              setError("");
              setInitializing(true);
              setRetry((n) => n + 1);
            }}
          >
            Try again <ArrowRight size={18} />
          </button>
          {client && (
            <button
              className="auth-text-button"
              onClick={() => void client.auth.signOut({ scope: "local" })}
            >
              Back to sign in
            </button>
          )}
        </div>
      </BookFrame>
    );
  return (
    <AuthForm
      client={client}
      recovery={recovery}
      initialError={error}
      onRecovered={() => setRecovery(false)}
    />
  );
}
function UsernameClaimRecovery({
  initial,
  onClaimed,
}: {
  initial: string;
  onClaimed: () => void;
}) {
  const [username, setUsername] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("username", "PUT", { username });
      localStorage.removeItem("wcr.pending-username");
      onClaimed();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save that username.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} aria-label="Choose a username">
      <label htmlFor="username-recovery">Choose an available username</label>
      <input
        id="username-recovery"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        minLength={3}
        maxLength={20}
        pattern="[A-Za-z0-9_]{3,20}"
        autoComplete="nickname"
        required
      />
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <button className="auth-primary" disabled={busy} type="submit">
        {busy ? "Saving…" : "Save username"} <ArrowRight size={18} />
      </button>
    </form>
  );
}
function AuthForm({
  client,
  recovery,
  initialError,
  onRecovered,
}: {
  client: AuthOnlyClient;
  recovery: boolean;
  initialError: string;
  onRecovered: () => void;
}) {
  const [stage, setStage] = useState<Stage>(recovery ? "recovery" : "email");
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(
    null,
  );
  const [checkingUsername, setCheckingUsername] = useState(false);
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [turning, setTurning] = useState(false);
  const [error, setError] = useState(initialError);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (recovery) setStage("recovery");
  }, [recovery]);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, [stage, busy, turning]);
  useEffect(() => {
    if (mode !== "signup" || stage !== "username") return;
    const value = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(value)) {
      setUsernameAvailable(null);
      setCheckingUsername(false);
      return;
    }
    let active = true;
    setCheckingUsername(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/v1/username-available?username=${encodeURIComponent(value)}`,
        );
        const result = (await response.json()) as { available?: boolean };
        if (active)
          setUsernameAvailable(response.ok && result.available === true);
      } catch {
        if (active) setUsernameAvailable(null);
      } finally {
        if (active) setCheckingUsername(false);
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [username, mode, stage]);
  async function turn(next: Stage) {
    if (turning) return;
    setError("");
    setTurning(true);
    await pause(
      matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 340,
    );
    setStage(next);
    await pause(380);
    setTurning(false);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (stage === "email") {
      await turn(mode === "signup" ? "username" : "password");
      return;
    }
    if (stage === "username") {
      if (usernameAvailable !== true || checkingUsername) {
        setError("Choose an available username before continuing.");
        return;
      }
      await turn("password");
      return;
    }
    setBusy(true);
    try {
      if (stage === "recovery") {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        setPassword("");
        onRecovered();
        return;
      }
      const result =
        mode === "signup"
          ? (localStorage.setItem(
              "wcr.pending-username",
              username.trim().toLowerCase(),
            ),
            await client.auth.signUp({
              email: email.trim(),
              password,
              options: { emailRedirectTo: callbackUrl() },
            }))
          : await client.auth.signInWithPassword({
              email: email.trim(),
              password,
            });
      if (result.error) throw result.error;
      setPassword("");
      if (!result.data.session) await turn("confirm");
    } catch (e) {
      if (mode === "signup") localStorage.removeItem("wcr.pending-username");
      setError(
        e instanceof Error ? e.message : "Could not sign in. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function resetPassword() {
    setBusy(true);
    setError("");
    try {
      const { error } = await client.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: callbackUrl(true),
      });
      if (error) throw error;
      await turn("reset-sent");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not send the reset link.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (busy) return <BookLoading />;
  const passwordStep = stage === "password" || stage === "recovery";
  const messageStep = stage === "confirm" || stage === "reset-sent";
  return (
    <BookFrame turning={turning}>
      <div className="auth-form-content">
        <div className="auth-chapter">
          <span className="auth-eyebrow">
            {messageStep
              ? "CHECK YOUR INBOX"
              : stage === "recovery"
                ? "A FRESH START"
                : mode === "signup"
                  ? "START YOUR STORY"
                  : "WELCOME BACK"}
          </span>
          <span className="auth-step-count">
            {stage === "email"
              ? "01"
              : messageStep
                ? "03"
                : stage === "username"
                  ? "02"
                  : "03"}{" "}
            / 03
          </span>
        </div>
        <div className="auth-progress" aria-hidden="true">
          <i className="done" />
          <i className={stage !== "email" ? "done" : ""} />
          <i className={messageStep ? "done" : ""} />
        </div>
        <h1>
          {messageStep ? (
            <>
              A note
              <br />
              <em>for you.</em>
            </>
          ) : stage === "recovery" ? (
            <>
              A new
              <br />
              <em>beginning.</em>
            </>
          ) : stage === "email" ? (
            <>
              Your next
              <br />
              <em>chapter.</em>
            </>
          ) : (
            <>
              Make it
              <br />
              <em>yours.</em>
            </>
          )}
        </h1>
        <p className="auth-intro">
          {messageStep ? (
            <>
              We sent a{" "}
              {stage === "confirm" ? "confirmation" : "password reset"} link to{" "}
              <strong>{email}</strong>. Open it in this browser to turn the
              page.
            </>
          ) : stage === "recovery" ? (
            "Choose a new password to return to your reading life."
          ) : stage === "email" ? (
            mode === "signup" ? (
              "A place for the books you love. And the ones you haven’t met yet."
            ) : (
              "Your books, your thoughts, your place. Right where you left them."
            )
          ) : stage === "username" ? (
            "Choose the name your friends will use to find you."
          ) : mode === "signup" ? (
            "One last thing. Give your reading life a little privacy."
          ) : (
            "Your story is waiting. Let’s pick up where you left off."
          )}
        </p>
        {messageStep ? (
          <>
            <div className="auth-mail-stamp">
              <Check />{" "}
              {stage === "confirm"
                ? "Confirm your email to continue"
                : "Follow the link to set a new password"}
            </div>
            <button
              className="auth-primary"
              onClick={() => {
                setMode("signin");
                void turn("email");
              }}
            >
              Back to sign in <ArrowRight size={18} />
            </button>
          </>
        ) : (
          <form
            onSubmit={submit}
            aria-label={
              stage === "recovery"
                ? "Set new password"
                : mode === "signup"
                  ? "Create account"
                  : "Sign in"
            }
          >
            {stage === "password" && mode === "signup" && (
              <button
                type="button"
                className="auth-email-receipt"
                onClick={() => void turn("username")}
              >
                <ArrowLeft size={14} />
                <span>@{username}</span>
                <small>Edit</small>
              </button>
            )}
            {passwordStep && stage !== "recovery" && mode === "signin" && (
              <button
                type="button"
                className="auth-email-receipt"
                onClick={() => void turn("email")}
              >
                <ArrowLeft size={14} />
                <span>{email}</span>
                <small>Edit</small>
              </button>
            )}
            <label htmlFor="auth-input">
              {stage === "username"
                ? "Your username"
                : passwordStep
                  ? stage === "recovery"
                    ? "New password"
                    : "Your password"
                  : "Your email"}
            </label>
            <div className="auth-input-wrap">
              <input
                ref={input}
                id="auth-input"
                name={
                  stage === "username"
                    ? "username"
                    : passwordStep
                      ? "password"
                      : "email"
                }
                type={
                  stage === "username"
                    ? "text"
                    : passwordStep
                      ? visible
                        ? "text"
                        : "password"
                      : "email"
                }
                value={
                  stage === "username"
                    ? username
                    : passwordStep
                      ? password
                      : email
                }
                onChange={(e) =>
                  stage === "username"
                    ? setUsername(e.target.value)
                    : passwordStep
                      ? setPassword(e.target.value)
                      : setEmail(e.target.value)
                }
                autoComplete={
                  passwordStep
                    ? mode === "signup" || stage === "recovery"
                      ? "new-password"
                      : "current-password"
                    : stage === "username"
                      ? "nickname"
                      : "email"
                }
                placeholder={
                  stage === "username"
                    ? "yourname"
                    : passwordStep
                      ? "••••••••••"
                      : "you@somewhere.com"
                }
                minLength={
                  stage === "username"
                    ? 3
                    : passwordStep &&
                        (mode === "signup" || stage === "recovery")
                      ? 8
                      : undefined
                }
                maxLength={stage === "username" ? 20 : passwordStep ? 128 : 254}
                pattern={
                  stage === "username" ? "[A-Za-z0-9_]{3,20}" : undefined
                }
                required
                disabled={turning}
                aria-describedby={
                  error ? "auth-error" : passwordStep ? "auth-hint" : undefined
                }
              />
              {passwordStep && (
                <button
                  className="auth-eye"
                  type="button"
                  aria-label={visible ? "Hide password" : "Show password"}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              )}
            </div>
            {stage === "username" && (
              <small className="auth-hint" aria-live="polite">
                {checkingUsername
                  ? "Checking availability…"
                  : username.length < 3
                    ? "3–20 characters: letters, numbers, and underscores."
                    : usernameAvailable === true
                      ? "That username is available."
                      : usernameAvailable === false
                        ? "That username is taken."
                        : "Enter 3–20 letters, numbers, or underscores."}
              </small>
            )}
            {passwordStep && (
              <small id="auth-hint" className="auth-hint">
                {mode === "signup" || stage === "recovery"
                  ? "At least 8 characters. Make it a good one."
                  : "The password you chose for your account."}
              </small>
            )}
            {error && (
              <p id="auth-error" className="auth-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="auth-primary"
              disabled={
                turning ||
                (stage === "username" &&
                  (checkingUsername || usernameAvailable !== true))
              }
              type="submit"
            >
              {stage === "email"
                ? "Turn the page"
                : stage === "username"
                  ? "Use this username"
                  : stage === "recovery"
                    ? "Save new password"
                    : mode === "signup"
                      ? "Begin my story"
                      : "Open my book"}
              <ArrowRight size={18} />
            </button>
            {stage === "password" && mode === "signin" && (
              <button
                type="button"
                className="auth-text-button"
                onClick={() => void resetPassword()}
              >
                Forgot your password?
              </button>
            )}
          </form>
        )}
        {error && messageStep && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        {!recovery && !messageStep && (
          <p className="auth-switch">
            {mode === "signup"
              ? "Already have a story here?"
              : "New around here?"}{" "}
            <button
              onClick={() => {
                setMode(mode === "signup" ? "signin" : "signup");
                setPassword("");
                setError("");
              }}
            >
              {" "}
              {mode === "signup" ? "Sign in" : "Start your story"}
            </button>
          </p>
        )}
        <div className="auth-page-bottom">
          <BookOpen size={15} />
          <span>
            {messageStep
              ? "A new chapter awaits."
              : "Your reading life, all in one place."}
          </span>
          <span>{stage === "email" ? "02" : "03"}</span>
        </div>
      </div>
    </BookFrame>
  );
}
