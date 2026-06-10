/**
 * articleFetcher.test.ts
 *
 * Unit tests for the Soyunci pipeline article fetcher module.
 * Tests the HTML extraction logic without making real HTTP calls.
 */

import { describe, it, expect } from "vitest";
import { extractFromHtml } from "./articleFetcher";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHtml(body: string, title = "Test Article"): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <meta property="og:title" content="${title}" />
</head>
<body>
  ${body}
</body>
</html>`;
}

const SAMPLE_ARTICLE_TEXT = `
  An aviation incident involving a Boeing 737 has been reported at London Heathrow Airport.
  The aircraft, operated by British Airways, experienced a hydraulic failure shortly after
  takeoff. The crew declared an emergency and returned safely to the airport. All 189
  passengers and 6 crew members were evacuated via emergency slides. The Civil Aviation
  Authority has launched an investigation into the incident. This is the third hydraulic
  failure reported on this aircraft type in the past six months, raising concerns among
  aviation safety experts about maintenance procedures. The aircraft has been grounded
  pending a full inspection by Boeing engineers.
`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("extractFromHtml", () => {
  it("extracts article text from a standard <article> element", () => {
    const html = makeHtml(`
      <nav>Navigation links that should be stripped</nav>
      <article>
        ${SAMPLE_ARTICLE_TEXT}
      </article>
      <footer>Footer content that should be stripped</footer>
    `);

    const result = extractFromHtml("https://example.com/article", html);

    expect(result.success).toBe(true);
    expect(result.bodyText).toContain("Boeing 737");
    expect(result.bodyText).toContain("hydraulic failure");
    expect(result.bodyText).not.toContain("Navigation links");
    expect(result.bodyText).not.toContain("Footer content");
    expect(result.wordCount).toBeGreaterThan(50);
  });

  it("extracts og:title as the preferred title", () => {
    const html = makeHtml(`<article>${SAMPLE_ARTICLE_TEXT}</article>`, "OG Title Override");
    const result = extractFromHtml("https://example.com/article", html);
    expect(result.title).toBe("OG Title Override");
  });

  it("falls back to <title> tag when og:title is absent", () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>Fallback Title</title></head>
<body><article>${SAMPLE_ARTICLE_TEXT}</article></body>
</html>`;
    const result = extractFromHtml("https://example.com/article", html);
    expect(result.title).toBe("Fallback Title");
  });

  it("falls back to <body> when no article container is found", () => {
    const html = makeHtml(`
      <div class="content">
        ${SAMPLE_ARTICLE_TEXT}
      </div>
    `);
    const result = extractFromHtml("https://example.com/article", html);
    expect(result.success).toBe(true);
    expect(result.bodyText).toContain("Boeing 737");
  });

  it("strips navigation, ads, and sidebar boilerplate", () => {
    const html = makeHtml(`
      <nav class="navbar">Top navigation</nav>
      <aside class="sidebar">Related stories</aside>
      <div class="ad">Advertisement</div>
      <article>${SAMPLE_ARTICLE_TEXT}</article>
      <div class="newsletter">Subscribe to our newsletter</div>
      <footer>Site footer</footer>
    `);
    const result = extractFromHtml("https://example.com/article", html);
    expect(result.success).toBe(true);
    expect(result.bodyText).not.toContain("Top navigation");
    expect(result.bodyText).not.toContain("Related stories");
    expect(result.bodyText).not.toContain("Advertisement");
    expect(result.bodyText).not.toContain("Subscribe to our newsletter");
    expect(result.bodyText).not.toContain("Site footer");
  });

  it("returns success=false for very short extracted text (paywall / JS-rendered)", () => {
    const html = makeHtml(`
      <article>
        <p>Subscribe to read more.</p>
      </article>
    `);
    const result = extractFromHtml("https://example.com/paywalled", html);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too short/i);
  });

  it("truncates body text to MAX_CHARS (12000 chars)", () => {
    const longText = "Aviation incident details. ".repeat(1000); // ~27 000 chars
    const html = makeHtml(`<article>${longText}</article>`);
    const result = extractFromHtml("https://example.com/long", html);
    expect(result.success).toBe(true);
    expect(result.bodyText.length).toBeLessThanOrEqual(12000);
  });

  it("handles malformed HTML without throwing", () => {
    const malformed = "<html><body><article>Unclosed tag <p>Some aviation content here that is long enough to pass the word count threshold for the article extraction logic to succeed properly.</article></body>";
    expect(() => extractFromHtml("https://example.com/malformed", malformed)).not.toThrow();
  });

  it("returns the correct url in the result", () => {
    const url = "https://example.com/test-article";
    const html = makeHtml(`<article>${SAMPLE_ARTICLE_TEXT}</article>`);
    const result = extractFromHtml(url, html);
    expect(result.url).toBe(url);
  });

  it("extracts from .article-body class when no <article> tag", () => {
    const html = makeHtml(`
      <div class="article-body">
        ${SAMPLE_ARTICLE_TEXT}
      </div>
    `);
    const result = extractFromHtml("https://example.com/article", html);
    expect(result.success).toBe(true);
    expect(result.bodyText).toContain("Boeing 737");
  });
});
