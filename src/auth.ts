import { AuthClient } from "@supabase/auth-js";
export type AuthOnlyClient = { auth: InstanceType<typeof AuthClient> };

let client: Promise<AuthOnlyClient> | undefined;
export function authClient() {
  return (client ??= (async () => {
    const response = await fetch("/api/v1/auth/config", { cache: "no-store" });
    if (!response.ok)
      throw new Error("Could not open the sign-in service. Please try again.");
    const { url, publishableKey } = (await response.json()) as {
      url: string;
      publishableKey: string;
    };
    return {
      auth: new AuthClient({
        url: `${url}/auth/v1`,
        headers: { apikey: publishableKey },
        storageKey: `sb-${new URL(url).hostname.split(".")[0]}-auth-token`,
        flowType: "pkce",
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      }),
    };
  })().catch((error) => {
    client = undefined;
    throw error;
  }));
}
export function callbackUrl(recovery = false) {
  return `${location.origin}/auth/callback${recovery ? "?recovery=1" : ""}`;
}
export async function signOut() {
  const client = await authClient();
  const { error } = await client.auth.signOut({ scope: "local" });
  if (error) throw error;
  history.replaceState(null, "", "/");
}
