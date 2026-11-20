import { describe, expect, it } from "vitest";
import { normalizePhone } from "../../src/revgas/phone.js";

describe("normalizePhone", () => {
  it.each(["+55 (86) 99999-8888", "5586999998888", "86999998888"])("normalizes %s to the same 11-digit number", (raw) => {
    expect(normalizePhone(raw)).toBe("86999998888");
  });

  it("keeps a 10-digit landline", () => {
    expect(normalizePhone("8633334444")).toBe("8633334444");
  });

  it("strips the country code from a 12-digit landline", () => {
    expect(normalizePhone("+55 86 3333-4444")).toBe("8633334444");
  });

  it.each(["123", "", "abc", "869999988881234"])("returns null for invalid input %j", (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });
});
