import { expect, test } from "bun:test";
import { parseSystemVersion, requiredSystemVersion, systemVersion } from "./system-version.ts";

test("missing version labels are 0 and present ones must be whole numbers", () => {
  expect(parseSystemVersion(undefined)).toBe(0);
  expect(parseSystemVersion("2")).toBe(2);
  for (const value of ["", " 1", "1.5", "-1", "two"]) expect(() => parseSystemVersion(value), value).toThrow("Invalid System version");
});

test("this app runs on the System built from the same commit", () => {
  expect(requiredSystemVersion).toBeLessThanOrEqual(systemVersion);
});
