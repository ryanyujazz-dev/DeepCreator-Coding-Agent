import { useEffect, useState } from "react";
import { AuthState } from "../../../shared/contracts/auth";
import { App } from "../../App";
import { desktopBridge } from "../../platform/desktop";
import { runtimeApi } from "../../runtimeApi";
import { AuthGate } from "./AuthGate";
import { LocalProfileSetup } from "./LocalProfileSetup";

const initialState: AuthState = { mode: "local", phase: "checking" };

export function DesktopAppRoot() {
  const desktop = desktopBridge();
  const [authState, setAuthState] = useState<AuthState>(desktop ? initialState : {
    mode: "local",
    phase: "signed_in",
    user: { displayName: "本地 Profile", githubLogin: "local", id: "00000000-0000-4000-8000-000000000001" }
  });
  const [runtimeReady, setRuntimeReady] = useState(!desktop);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const unsubscribe = desktop.auth.onState((state) => { if (active) setAuthState(state); });
    void desktop.auth.getState().then((state) => { if (active) setAuthState(state); });
    return () => { active = false; unsubscribe(); };
  }, [desktop]);

  useEffect(() => {
    if (!desktop || (authState.phase !== "signed_in" && authState.phase !== "offline")) {
      setRuntimeReady(!desktop);
      return;
    }
    let active = true;
    setRuntimeReady(false);
    setRuntimeError(null);
    void desktop.runtime.connection().then((connection) => {
      if (!active) return;
      runtimeApi.configure(connection);
      setRuntimeReady(true);
    }).catch((error: unknown) => {
      if (!active) return;
      setRuntimeError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [authState.phase, authState.user?.id, desktop]);

  if (!desktop) return <App authState={authState} />;
  if ((authState.phase === "signed_in" || authState.phase === "offline") && runtimeReady) {
    if (authState.mode === "local" && authState.profileSetupRequired && authState.user) {
      return (
        <LocalProfileSetup
          onComplete={async (input) => { setAuthState(await desktop.auth.updateLocalProfile(input)); }}
          user={authState.user}
        />
      );
    }
    return <App authState={authState} />;
  }
  const visibleState = runtimeError
    ? { detail: runtimeError, mode: authState.mode, phase: "error" as const, user: authState.user }
    : authState.phase === "signed_in" || authState.phase === "offline"
      ? { mode: authState.mode, phase: "checking" as const, user: authState.user }
      : authState;
  return (
    <AuthGate
      onCancel={async () => { await desktop.auth.cancelSignIn(); }}
      onRetry={async () => {
        if (runtimeError) {
          setRuntimeError(null);
          const connection = await desktop.runtime.retry();
          runtimeApi.configure(connection);
          setRuntimeReady(true);
          return;
        }
        setRuntimeError(null);
        setAuthState({ mode: authState.mode, phase: "checking" });
        const state = await desktop.auth.getState();
        setAuthState(state);
        if (state.mode === "local" && state.phase === "error") {
          await desktop.auth.signIn();
        } else if (state.mode === "github" && (state.phase === "signed_out" || state.phase === "expired" || state.phase === "error")) {
          await desktop.auth.signIn();
        }
      }}
      onSignIn={async () => { await desktop.auth.signIn(); }}
      state={visibleState}
    />
  );
}
