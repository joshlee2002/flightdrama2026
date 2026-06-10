/**
 * One-off migration: proxy-wrap any raw upload.wikimedia.org thumbUrls
 * stored in storyPackages.imageRecommendations.
 */
import mysql from "mysql2/promise";
import * as dotenv from "dotenv";
dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }

function proxyUrl(url) {
  if (!url) return url;
  if (url.startsWith("/api/image-proxy")) return url; // already proxied
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

const conn = await mysql.createConnection(DATABASE_URL);

const [rows] = await conn.execute(
  "SELECT id, imageRecommendations FROM story_packages WHERE imageRecommendations IS NOT NULL AND imageRecommendations != '[]'"
);

let updated = 0;
for (const row of rows) {
  let imgs;
  try { imgs = JSON.parse(row.imageRecommendations); } catch { continue; }
  let changed = false;
  for (const img of imgs) {
    if (img.thumbUrl && img.thumbUrl.startsWith("https://upload.wikimedia.org")) {
      img.thumbUrl = proxyUrl(img.thumbUrl);
      changed = true;
    }
  }
  if (changed) {
    await conn.execute(
      "UPDATE story_packages SET imageRecommendations = ? WHERE id = ?",
      [JSON.stringify(imgs), row.id]
    );
    updated++;
    console.log(`  Fixed package id=${row.id}`);
  }
}

console.log(`Done — updated ${updated} packages.`);
await conn.end();
