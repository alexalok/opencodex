import { useEffect, useState } from "react";
import { hasAdminTokenLogin, logoutApiSession, SESSION_CHANGED_EVENT } from "./api";
import type { ApiPlane } from "./api-targets";

const PLANES: readonly ApiPlane[] = ["machine", "shared"];

function anyAdminTokenLogin(): boolean {
  return PLANES.some(hasAdminTokenLogin);
}

/**
 * A dashboard that asks for the admin token remembers it for a year, but its session
 * sign-out control only tracked minted `ocx_session_` credentials. Track typed admin-token
 * logins too, so an operator can always forget the remembered credential from the app.
 */
export function useAdminTokenLogin(): boolean {
  const [active, setActive] = useState(anyAdminTokenLogin);
  useEffect(() => {
    const sync = () => setActive(anyAdminTokenLogin());
    window.addEventListener(SESSION_CHANGED_EVENT, sync);
    sync();
    return () => window.removeEventListener(SESSION_CHANGED_EVENT, sync);
  }, []);
  return active;
}

/** Sign out every plane holding a typed admin token, which also forgets its remembered copy. */
export async function logoutAdminTokenLogins(): Promise<boolean> {
  let loggedOut = false;
  for (const plane of PLANES) {
    if (hasAdminTokenLogin(plane) && await logoutApiSession(plane)) loggedOut = true;
  }
  return loggedOut;
}
