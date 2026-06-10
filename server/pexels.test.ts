import { describe, it, expect } from "vitest";

describe("Pexels API key", () => {
  it("should be set in environment", () => {
    const key = process.env.PEXELS_API_KEY;
    expect(key).toBeTruthy();
    expect(key?.length).toBeGreaterThan(10);
  });

  it("should successfully query Pexels API", async () => {
    const key = process.env.PEXELS_API_KEY;
    if (!key) return;
    const res = await fetch("https://api.pexels.com/v1/search?query=aircraft&per_page=1", {
      headers: { Authorization: key },
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.photos).toBeDefined();
  }, 15000);
});
