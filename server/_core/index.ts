import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { scheduledIngestHandler } from "../scheduledIngest";
import { scheduledWeeklyDigestHandler } from "../scheduledWeeklyDigest";
import { scheduledLearnHandler } from "../scheduledLearn";
import { scheduledInstagramSyncHandler } from "../scheduledInstagramSync";
import { seedOnStartup } from "../seed";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  // In-memory image cache — avoids re-fetching the same image from Wikimedia/Pexels
  // and prevents rate-limit 429s when the browse modal renders 40 tiles at once.
  const IMG_CACHE_MAX = 300;
  const IMG_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  const imgCache = new Map<string, { buf: Buffer; ct: string; ts: number }>();
  function imgCacheGet(key: string) {
    const entry = imgCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > IMG_CACHE_TTL) { imgCache.delete(key); return null; }
    return entry;
  }
  function imgCacheSet(key: string, buf: Buffer, ct: string) {
    if (imgCache.size >= IMG_CACHE_MAX) {
      // Evict oldest entry
      const oldest = Array.from(imgCache.entries()).sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) imgCache.delete(oldest[0]);
    }
    imgCache.set(key, { buf, ct, ts: Date.now() });
  }

  // In-flight deduplication — if two requests for the same URL arrive simultaneously,
  // the second waits for the first fetch to complete rather than firing a duplicate upstream request.
  const imgInFlight = new Map<string, Promise<{ buf: Buffer; ct: string } | null>>();

  // Image proxy — serves Wikimedia/Pexels images to avoid CORS/hotlink blocks
  app.get("/api/image-proxy", async (req, res) => {
    const url = req.query.url as string;
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).send("Bad url");
    const allowed = [
      "upload.wikimedia.org", "commons.wikimedia.org",
      "images.pexels.com", "images.unsplash.com", "live.staticflickr.com",
    ];
    try {
      const parsed = new URL(url);
      if (!allowed.some(h => parsed.hostname === h || parsed.hostname.endsWith("." + h))) {
        return res.status(403).send("Host not allowed");
      }

      // Serve from cache if available
      const cached = imgCacheGet(url);
      if (cached) {
        res.setHeader("Content-Type", cached.ct);
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.setHeader("X-Cache", "HIT");
        return res.send(cached.buf);
      }

      // Deduplicate in-flight requests for the same URL
      let fetchPromise = imgInFlight.get(url);
      if (!fetchPromise) {
        fetchPromise = (async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 12000);
          try {
            const upstream = await fetch(url, {
              signal: controller.signal,
              headers: {
                "User-Agent": "Mozilla/5.0 (compatible; FlightDrama/1.0; +https://flightdrama.com)",
                "Referer": "https://commons.wikimedia.org/",
                "Accept": "image/webp,image/jpeg,image/*,*/*;q=0.8",
              },
            });
            clearTimeout(timeoutId);
            if (!upstream.ok) return null;
            const ct = upstream.headers.get("content-type") ?? "image/jpeg";
            const buf = Buffer.from(await upstream.arrayBuffer());
            imgCacheSet(url, buf, ct);
            return { buf, ct };
          } catch {
            clearTimeout(timeoutId);
            return null;
          } finally {
            imgInFlight.delete(url);
          }
        })();
        imgInFlight.set(url, fetchPromise);
      }

      const result = await fetchPromise;
      if (!result) return res.status(502).send("Proxy error");
      res.setHeader("Content-Type", result.ct);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("X-Cache", "MISS");
      return res.send(result.buf);
    } catch (e) {
      console.error("[ImageProxy] outer error:", e);
      return res.status(502).send("Proxy error");
    }
  });

  // Scheduled cron endpoints (called by Heartbeat jobs)
  app.post("/api/scheduled/ingest", scheduledIngestHandler);
  app.post("/api/scheduled/digest", scheduledWeeklyDigestHandler);
  app.post("/api/scheduled/learn", scheduledLearnHandler);
  app.post("/api/scheduled/instagram-sync", scheduledInstagramSyncHandler);

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Seed RSS sources on startup (no-op if already seeded)
    seedOnStartup().catch(err => console.warn("[Seed] Startup seed check failed:", err));
  });
}

startServer().catch(console.error);
