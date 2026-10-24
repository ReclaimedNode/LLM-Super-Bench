import { describe, expect, test } from "bun:test";
import { makeThrottle, sameOriginOk, withSecurityHeaders } from "../src/guard.ts";

const h = (o: Record<string, string>) => new Headers(o);

describe("cross-site requests", () => {
  test("reading is allowed from anywhere, since another site cannot read the answer", () => {
    expect(sameOriginOk("GET", h({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).toBe(true);
  });
  test("a POST from this page is allowed, from another site is refused", () => {
    expect(sameOriginOk("POST", h({ origin: "http://mini.local:9500", host: "mini.local:9500", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOriginOk("POST", h({ origin: "https://evil.example", host: "mini.local:9500" }))).toBe(false);
    expect(sameOriginOk("POST", h({ host: "mini.local:9500", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOriginOk("POST", h({ origin: "null", host: "mini.local:9500" }))).toBe(false);
  });
  test("curl and scripts, which send no origin, still work", () => {
    expect(sameOriginOk("POST", h({ host: "mini.local:9500" }))).toBe(true);
  });
  test("a look-alike host is not the same host", () => {
    expect(sameOriginOk("DELETE", h({ origin: "http://mini.local:9500.evil.example", host: "mini.local:9500" }))).toBe(false);
  });
});

describe("password guessing", () => {
  test("ten wrong passwords lock that address for the window, a right one clears the count", () => {
    let t = 0;
    const th = makeThrottle(3, 1000, () => t);
    th.failed("a"); th.failed("a");
    expect(th.waitSec("a")).toBe(0);
    th.failed("a");
    expect(th.waitSec("a")).toBeGreaterThan(0);
    expect(th.waitSec("b")).toBe(0);
    t = 1500;
    expect(th.waitSec("a")).toBe(0);
    th.failed("c"); th.passed("c");
    expect(th.waitSec("c")).toBe(0);
  });
});

describe("headers", () => {
  test("every response is unframeable and unsniffable, with scripts only from this server", () => {
    const r = withSecurityHeaders(new Response("x"));
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
