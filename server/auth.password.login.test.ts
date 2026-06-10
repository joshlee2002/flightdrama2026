import { describe, expect, it } from "vitest";
import { createPasswordSessionToken, verifyPasswordSession } from "./_core/passwordAuth";

describe("password auth session", () => {
  it("creates a valid session token that verifies correctly", async () => {
    // Set up JWT_SECRET for the test
    process.env.JWT_SECRET = "test-secret-for-vitest-12345";
    
    const token = await createPasswordSessionToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);

    const session = await verifyPasswordSession(token);
    expect(session).not.toBeNull();
    expect(session?.openId).toBe("password-auth-user");
    expect(session?.name).toBe("Admin");
  });

  it("returns null for an invalid token", async () => {
    process.env.JWT_SECRET = "test-secret-for-vitest-12345";
    const result = await verifyPasswordSession("not-a-valid-token");
    expect(result).toBeNull();
  });

  it("returns null for undefined token", async () => {
    const result = await verifyPasswordSession(undefined);
    expect(result).toBeNull();
  });
});
