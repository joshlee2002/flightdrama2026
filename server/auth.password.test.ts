import { describe, it, expect } from "vitest";
import { createPasswordSessionToken, verifyPasswordSession } from "./_core/passwordAuth";

describe("Password auth", () => {
  it("APP_PASSWORD env is set", () => {
    const pw = process.env.APP_PASSWORD;
    expect(pw).toBeTruthy();
    expect(pw!.length).toBeGreaterThan(0);
  });

  it("creates a session token", async () => {
    const token = await createPasswordSessionToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
  });

  it("verifies a valid session token", async () => {
    const token = await createPasswordSessionToken();
    const result = await verifyPasswordSession(token);
    expect(result).not.toBeNull();
    expect(result?.openId).toBeTruthy();
  });

  it("rejects a bad token", async () => {
    const result = await verifyPasswordSession("not-a-real-token");
    expect(result).toBeNull();
  });
});
