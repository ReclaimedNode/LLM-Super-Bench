/**
 * The page's defences, kept apart from the server so each can be tested alone.
 *
 * 1. Cross-site requests. A password in the browser is sent along with every request to this
 *    address, including ones another website makes on the visitor's behalf. So a request that
 *    changes anything must come from this page itself, not from some other site.
 * 2. Password guessing. After a run of wrong passwords from one address, that address waits.
 * 3. Browser headers: no framing, no sniffing, scripts only from this server.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * True when the request may go ahead. Reading is always fine (another site cannot read the
 * answer). Anything else must say it came from this very address, or from no browser at all
 * (curl, a script), which sends neither header.
 */
export function sameOriginOk(method: string, headers: Pick<Headers, "get">): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  const site = headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  const origin = headers.get("origin");
  if (origin === null) return true;
  const host = headers.get("host");
  if (host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // "null" and anything that is not a web address
  }
}

export interface Throttle {
  /** Seconds this address must still wait, or 0. */
  waitSec(key: string): number;
  /** Call after a wrong password. */
  failed(key: string): void;
  /** Call after a right one. */
  passed(key: string): void;
}

/** After `limit` wrong passwords inside `windowMs`, the address is refused for `windowMs`. */
export function makeThrottle(limit = 10, windowMs = 5 * 60_000, now: () => number = Date.now): Throttle {
  const seen = new Map<string, { count: number; first: number }>();
  const MAX_TRACKED = 1000;
  return {
    waitSec(key) {
      const e = seen.get(key);
      if (!e) return 0;
      if (now() - e.first >= windowMs) {
        seen.delete(key);
        return 0;
      }
      return e.count >= limit ? Math.ceil((e.first + windowMs - now()) / 1000) : 0;
    },
    failed(key) {
      const t = now();
      const e = seen.get(key);
      if (!e || t - e.first >= windowMs) {
        if (seen.size >= MAX_TRACKED) seen.delete(seen.keys().next().value as string);
        seen.set(key, { count: 1, first: t });
      } else {
        e.count += 1;
      }
    },
    passed(key) {
      seen.delete(key);
    },
  };
}

/** Everything the pages load comes from this server; nothing may frame them or be sniffed. */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export function withSecurityHeaders(response: Response): Response {
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) response.headers.set(k, v);
    return response;
  } catch {
    return response; // a response whose headers are fixed is returned as it is
  }
}

/** Requests carry a short JSON body; anything bigger is not from this page. */
export const MAX_REQUEST_BYTES = 64 * 1024;
