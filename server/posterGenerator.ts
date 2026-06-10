/**
 * posterGenerator.ts
 *
 * Generates FlightDrama-branded 4:5 Instagram poster images (1080×1350px).
 *
 * Design system (reverse-engineered from real FlightDrama posts):
 * - Full-bleed aircraft photo as background
 * - Dark gradient overlay: transparent → solid black from ~55% down
 * - FLIGHT DRAMA logo centered just above the headline
 * - Large bold Barlow Condensed ExtraBold headline, ALL CAPS
 * - Yellow (#FFD100) for key words (airline, numbers, twist words)
 * - White (#FFFFFF) for the rest
 */

import { createCanvas, loadImage, GlobalFonts, type Canvas } from "@napi-rs/canvas";
import path from "path";
import { fileURLToPath } from "url";
import { ENV } from "./_core/env";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants ─────────────────────────────────────────────────────────────────

const W = 1080;
const H = 1350; // 4:5 ratio

const YELLOW = "#FFD100";
const WHITE = "#FFFFFF";
const BLACK = "#000000";

// Where the gradient starts transitioning to black (as fraction of height)
const GRADIENT_START = 0.50;
const GRADIENT_SOLID = 0.68;

// Bottom text area height (fraction of total height)
const TEXT_AREA_HEIGHT = 0.34;

// Horizontal padding for text
const TEXT_PADDING = 44;

// ── Font registration ─────────────────────────────────────────────────────────

let fontsRegistered = false;

function registerFonts() {
  if (fontsRegistered) return;
  const fontsDir = path.join(__dirname, "fonts");
  try {
    GlobalFonts.registerFromPath(
      path.join(fontsDir, "barlow-condensed-extrabold.ttf"),
      "BarlowCondensed"
    );
    GlobalFonts.registerFromPath(
      path.join(fontsDir, "barlow-condensed-bold.ttf"),
      "BarlowCondensedBold"
    );
    fontsRegistered = true;
  } catch (err) {
    console.warn("[Poster] Font registration failed:", err);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PosterOptions {
  /** Headline text — will be split into coloured segments */
  headline: string;
  /** Which words/tokens in the headline should be yellow (0-indexed word positions) */
  yellowWords?: number[];
  /** Background image URL (proxied or direct) */
  imageUrl: string;
  /** Optional: second image URL for split layout */
  imageUrl2?: string;
}

export interface HeadlineSegment {
  text: string;
  yellow: boolean;
}

// ── Headline colouring ────────────────────────────────────────────────────────

/**
 * Parse a headline into coloured segments.
 * yellowWords is a list of word indices (0-based) that should be yellow.
 */
export function parseHeadlineSegments(
  headline: string,
  yellowWords: number[]
): HeadlineSegment[] {
  const words = headline.trim().toUpperCase().split(/\s+/);
  const yellowSet = new Set(yellowWords);
  return words.map((word, i) => ({
    text: word,
    yellow: yellowSet.has(i),
  }));
}

// ── Logo drawing ──────────────────────────────────────────────────────────────

function drawLogo(ctx: any, centerX: number, y: number): number {
  const flightFontSize = 30;
  const dramaFontSize = 32;
  const badgePadX = 14;
  const badgePadY = 5;
  const gap = 4;

  // Measure DRAMA text
  ctx.font = `800 ${dramaFontSize}px BarlowCondensed`;
  const dramaMetrics = ctx.measureText("DRAMA");
  const dramaW = dramaMetrics.width;
  const badgeW = dramaW + badgePadX * 2;
  const badgeH = dramaFontSize + badgePadY * 2;

  // Measure FLIGHT text
  ctx.font = `700 ${flightFontSize}px BarlowCondensedBold`;
  const flightMetrics = ctx.measureText("FLIGHT");
  const flightW = flightMetrics.width;

  const totalH = flightFontSize + gap + badgeH;
  const startY = y - totalH;

  // Draw "FLIGHT" in white, centered
  ctx.fillStyle = WHITE;
  ctx.font = `700 ${flightFontSize}px BarlowCondensedBold`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("FLIGHT", centerX, startY);

  // Draw yellow badge for "DRAMA"
  const badgeX = centerX - badgeW / 2;
  const badgeY = startY + flightFontSize + gap;
  ctx.fillStyle = YELLOW;
  ctx.fillRect(badgeX, badgeY, badgeW, badgeH);

  // Draw "DRAMA" text in white on yellow badge
  ctx.fillStyle = WHITE;
  ctx.font = `800 ${dramaFontSize}px BarlowCondensed`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("DRAMA", centerX, badgeY + badgePadY);

  return startY; // Returns the top of the logo
}

// ── Headline drawing ──────────────────────────────────────────────────────────

/**
 * Draw the headline with mixed yellow/white colouring.
 * Automatically sizes the font to fit within the available width and height.
 * Returns the Y position where the headline starts.
 */
function drawHeadline(
  ctx: any,
  segments: HeadlineSegment[],
  maxWidth: number,
  maxHeight: number,
  bottomY: number
): number {
  const words = segments.map(s => ({ ...s, text: s.text }));

  // Try font sizes from large to small until it fits
  let fontSize = 140;
  let lines: HeadlineSegment[][] = [];

  while (fontSize >= 50) {
    ctx.font = `800 ${fontSize}px BarlowCondensed`;
    lines = wrapSegments(ctx, words, maxWidth, fontSize);
    const totalHeight = lines.length * fontSize * 1.02;
    if (totalHeight <= maxHeight && lines.length <= 4) break;
    fontSize -= 4;
  }

  const lineHeight = fontSize * 1.02;
  const totalTextHeight = lines.length * lineHeight;
  const startY = bottomY - totalTextHeight - 20; // 20px padding from bottom

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineY = startY + i * lineHeight;

    // Calculate total line width for centering
    ctx.font = `800 ${fontSize}px BarlowCondensed`;
    let lineWidth = 0;
    for (const seg of line) {
      lineWidth += ctx.measureText(seg.text + " ").width;
    }
    lineWidth -= ctx.measureText(" ").width; // Remove trailing space

    let x = (W - lineWidth) / 2; // Center the line

    for (let j = 0; j < line.length; j++) {
      const seg = line[j];
      ctx.fillStyle = seg.yellow ? YELLOW : WHITE;
      ctx.font = `800 ${fontSize}px BarlowCondensed`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(seg.text, x, lineY);
      x += ctx.measureText(seg.text).width;

      // Add space between words (except last word on line)
      if (j < line.length - 1) {
        x += ctx.measureText(" ").width;
      }
    }
  }

  return startY;
}

/**
 * Wrap headline segments into lines that fit within maxWidth.
 */
function wrapSegments(
  ctx: any,
  segments: HeadlineSegment[],
  maxWidth: number,
  fontSize: number
): HeadlineSegment[][] {
  ctx.font = `800 ${fontSize}px BarlowCondensed`;
  const spaceWidth = ctx.measureText(" ").width;

  const lines: HeadlineSegment[][] = [];
  let currentLine: HeadlineSegment[] = [];
  let currentWidth = 0;

  for (const seg of segments) {
    const wordWidth = ctx.measureText(seg.text).width;
    const addWidth = currentLine.length === 0 ? wordWidth : wordWidth + spaceWidth;

    if (currentLine.length > 0 && currentWidth + addWidth > maxWidth) {
      lines.push(currentLine);
      currentLine = [seg];
      currentWidth = wordWidth;
    } else {
      currentLine.push(seg);
      currentWidth += addWidth;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

// ── Image loading ─────────────────────────────────────────────────────────────

async function loadImageFromUrl(url: string): Promise<any | null> {
  try {
    // Handle proxied URLs — convert /api/image-proxy?url=... to the real URL
    let fetchUrl = url;
    if (url.startsWith("/api/image-proxy")) {
      const match = url.match(/url=([^&]+)/);
      if (match) fetchUrl = decodeURIComponent(match[1]);
    }

    const res = await fetch(fetchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://commons.wikimedia.org/",
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return await loadImage(Buffer.from(buf));
  } catch (err) {
    console.warn("[Poster] Failed to load image:", url, err);
    return null;
  }
}

/**
 * Draw an image to fill a rectangle, cropping to cover (object-fit: cover).
 */
function drawImageCover(
  ctx: any,
  img: any,
  x: number,
  y: number,
  w: number,
  h: number
) {
  const imgAspect = img.width / img.height;
  const boxAspect = w / h;

  let sx = 0, sy = 0, sw = img.width, sh = img.height;

  if (imgAspect > boxAspect) {
    // Image is wider — crop sides
    sw = img.height * boxAspect;
    sx = (img.width - sw) / 2;
  } else {
    // Image is taller — crop top/bottom, bias toward top (aircraft usually in upper half)
    sh = img.width / boxAspect;
    sy = 0; // Keep top of image (aircraft usually at top)
  }

  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

// ── Main poster generator ─────────────────────────────────────────────────────

export async function generatePoster(options: PosterOptions): Promise<Buffer> {
  registerFonts();

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // ── Step 1: Draw background ──────────────────────────────────────────────

  const img1 = await loadImageFromUrl(options.imageUrl);
  const img2 = options.imageUrl2 ? await loadImageFromUrl(options.imageUrl2) : null;

  if (img2) {
    // Split layout: two photos stacked
    const splitY = H * 0.50;
    if (img1) drawImageCover(ctx, img1, 0, 0, W, splitY);
    else { ctx.fillStyle = "#1a1a1a"; ctx.fillRect(0, 0, W, splitY); }
    drawImageCover(ctx, img2, 0, splitY, W, H - splitY);
  } else if (img1) {
    // Single full-bleed photo
    drawImageCover(ctx, img1, 0, 0, W, H);
  } else {
    // Fallback: dark gradient background
    const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, "#1a2a3a");
    bgGrad.addColorStop(1, "#000000");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);
  }

  // ── Step 2: Dark gradient overlay ────────────────────────────────────────

  const overlayGrad = ctx.createLinearGradient(0, 0, 0, H);
  overlayGrad.addColorStop(0, "rgba(0,0,0,0)");
  overlayGrad.addColorStop(GRADIENT_START, "rgba(0,0,0,0.15)");
  overlayGrad.addColorStop(GRADIENT_SOLID, "rgba(0,0,0,0.92)");
  overlayGrad.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = overlayGrad;
  ctx.fillRect(0, 0, W, H);

  // ── Step 3: Solid black bottom panel ─────────────────────────────────────

  const textAreaTop = H * (1 - TEXT_AREA_HEIGHT);
  ctx.fillStyle = BLACK;
  ctx.fillRect(0, textAreaTop + H * 0.06, W, H - textAreaTop);

  // ── Step 4: Draw FLIGHT DRAMA logo ────────────────────────────────────────

  const logoBottomY = textAreaTop + 8; // Logo sits just above text area
  const logoTopY = drawLogo(ctx, W / 2, logoBottomY);

  // ── Step 5: Draw headline ─────────────────────────────────────────────────

  const yellowWords = options.yellowWords ?? [];
  const segments = parseHeadlineSegments(options.headline, yellowWords);

  const headlineMaxWidth = W - TEXT_PADDING * 2;
  const headlineMaxHeight = H - logoBottomY - 20;
  const headlineBottomY = H - 28; // 28px from bottom edge

  drawHeadline(ctx, segments, headlineMaxWidth, headlineMaxHeight, headlineBottomY);

  // ── Step 6: Export as PNG buffer ──────────────────────────────────────────

  return canvas.toBuffer("image/png");
}

// ── LLM-assisted headline colouring ──────────────────────────────────────────

/**
 * Use the LLM to decide which word indices in the headline should be yellow.
 * Falls back to a simple heuristic if LLM fails.
 */
export async function getYellowWordIndices(
  headline: string,
  airline: string,
  viralAngle: string
): Promise<number[]> {
  const words = headline.trim().toUpperCase().split(/\s+/);

  try {
    const { invokeLLM } = await import("./_core/llm");
    const res = await invokeLLM({
      model: ENV.defaultLlmModel || "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content:
            "You are a graphic designer for FlightDrama, an aviation Instagram account.\n" +
            "Given a headline, decide which word indices (0-based) should be coloured YELLOW.\n\n" +
            "YELLOW RULES (apply all that match):\n" +
            "- The airline name (e.g. 'SPIRIT', 'SOUTHWEST', 'RIYADH AIR')\n" +
            "- Numbers and amounts (e.g. '$87', 'MILLION', '80%', '70', '9')\n" +
            "- Quoted words or phrases (e.g. 'DEFECTIVE', 'NOT SO FAST')\n" +
            "- The key twist/punchline word at the end (e.g. 'FINALLY', 'FAKE', 'RARE')\n" +
            "- Named subjects (celebrity names, specific locations)\n\n" +
            "WHITE = everything else (verbs, prepositions, generic nouns)\n\n" +
            "Return ONLY valid JSON: {\"yellowIndices\": [0, 2, 5]}",
        },
        {
          role: "user",
          content: `Headline: "${headline.toUpperCase()}"\nWords: ${JSON.stringify(words.map((w, i) => ({ i, w })))}`,
        },
      ],
      response_format: { type: "json_object" },
    });
    const content = res.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const parsed = JSON.parse(text);
    return parsed.yellowIndices ?? [];
  } catch {
    // Fallback heuristic: yellow = numbers, airline name words, last word if impactful
    return getYellowWordsFallback(words, airline);
  }
}

function getYellowWordsFallback(words: string[], airline: string): number[] {
  const yellow: number[] = [];
  const airlineWords = airline.toUpperCase().split(/\s+/);

  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[^A-Z0-9$%]/g, "");

    // Numbers and money
    if (/\d/.test(w) || w.startsWith("$") || w.endsWith("%")) {
      yellow.push(i);
      continue;
    }

    // Airline name words
    if (airlineWords.some(aw => w.includes(aw) || aw.includes(w))) {
      yellow.push(i);
      continue;
    }

    // Common punchline words
    const punchlines = ["FINALLY", "FAKE", "RARE", "DEFECTIVE", "BANNED", "FIRED",
      "ARRESTED", "CRASHED", "GROUNDED", "CANCELLED", "DELAYED", "EMERGENCY",
      "RECORD", "FIRST", "LAST", "NEVER", "ALWAYS", "FREE", "BILLION", "MILLION",
      "THOUSAND", "YEARS", "HOURS", "MINUTES"];
    if (punchlines.includes(w)) {
      yellow.push(i);
    }
  }

  return yellow;
}
