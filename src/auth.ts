/**
 * The optional password on the page. HTTP Basic: the browser asks once and sends
 * it with every request, so the page, the event streams and the API are all
 * behind the one lock. Any user name is accepted; only the password counts.
 *
 * This keeps a shared network out of a page that can start races. It is not
 * encryption: over plain HTTP the password crosses the wire in the clear, so
 * keep the port on a LAN or a Tailscale network, never open to the internet.
 */

import { timingSafeEqual } from "node:crypto";

/** True when no password is set, or the Authorization header carries it. */
export function passwordOk(authorization: string | null, password: string): boolean {
  if (password === "") return true;
  const header = authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  let given: string;
  try {
    given = atob(header.slice(6)).split(":").slice(1).join(":");
  } catch {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(password);
  // timingSafeEqual needs equal lengths; a length mismatch is already a no.
  return a.length === b.length && timingSafeEqual(a, b);
}
