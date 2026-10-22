import { describe, expect, test } from "bun:test";
import { passwordOk } from "../src/auth.ts";

const basic = (user: string, pw: string) => `Basic ${btoa(`${user}:${pw}`)}`;

describe("the page password", () => {
  test("no password set means open", () => {
    expect(passwordOk(null, "")).toBe(true);
  });

  test("any user name, the right password", () => {
    expect(passwordOk(basic("anyone", "hunter2"), "hunter2")).toBe(true);
    expect(passwordOk(basic("", "hunter2"), "hunter2")).toBe(true);
  });

  test("a password with a colon in it still works", () => {
    expect(passwordOk(basic("me", "a:b:c"), "a:b:c")).toBe(true);
  });

  test("everything else is refused", () => {
    for (const header of [null, "", "Bearer hunter2", "Basic !!!not-base64", basic("me", "hunter"), basic("me", "hunter22"), basic("me", "")]) {
      expect(passwordOk(header, "hunter2")).toBe(false);
    }
  });
});
