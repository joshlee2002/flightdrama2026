import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerPasswordAuthRoutes } from "./passwordAuth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { scheduledIngestHandler } from "../scheduledIngest";
import { scheduledWeeklyDigestHandler } from "../scheduledWeeklyDigest";
import { scheduledLearnHandler } from "../scheduledLearn";
import { scheduledInstagramSyncHandler } from "../scheduledInstagramSync";
import { scheduledPipelineHandler } from "../scheduledPipeline";
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
  registerPasswordAuthRoutes(app);

  // Image proxy — streams Wikimedia/Pexels images to avoid CORS/hotlink blocks.
  // Key constraints:
  //   - Wikimedia rate-limits (HTTP 429) if too many requests hit the CDN simultaneously
  //   - Wikimedia only allows specific thumbnail sizes (330px, 640px, etc.) — others return 400
  //   - Production has 512MB RAM so we stream instead of buffering full images
  //
  // Strategy: concurrency=4 so at most 4 upstream fetches run at once; the rest queue.
  // Client-side staggered batches (6 images per 300ms) mean peak load is ~6 in-flight,
  // but the queue ensures Wikimedia never sees more than 4 simultaneous connections from us.
  const PROXY_CONCURRENCY = 4;
  let proxyActive = 0;
  const proxyQueue: Array<() => void> = [];
  function proxyAcquire(): Promise<void> {
    return new Promise(resolve => {
      if (proxyActive < PROXY_CONCURRENCY) { proxyActive++; resolve(); }
      else proxyQueue.push(resolve);
    });
  }
  function proxyRelease() {
    const next = proxyQueue.shift();
    if (next) { next(); } else { proxyActive--; }
  }

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

      // Acquire concurrency slot
      await proxyAcquire();

      // Retry loop — handles 429 rate-limit responses from Wikimedia CDN
      let attempt = 0;
      const maxAttempts = 3;
      while (attempt < maxAttempts) {
        attempt++;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);
        try {
          const upstream = await fetch(url, {
            signal: controller.signal,
            headers: {
              // Use a real browser UA — Wikimedia is more lenient with browser UAs
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              "Referer": "https://commons.wikimedia.org/",
              "Accept": "image/webp,image/jpeg,image/*,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
            },
          });
          clearTimeout(timeoutId);

          // 429 = rate limited — wait and retry
          if (upstream.status === 429) {
            const retryAfter = parseInt(upstream.headers.get("retry-after") ?? "2", 10);
            const waitMs = Math.min((retryAfter || 2) * 1000, 5000) * attempt;
            console.warn(`[ImageProxy] 429 rate-limit on attempt ${attempt}, waiting ${waitMs}ms`);
            await upstream.body?.cancel();
            if (attempt < maxAttempts) { await sleep(waitMs); continue; }
            proxyRelease();
            return res.status(429).send("Rate limited");
          }

          if (!upstream.ok || !upstream.body) {
            await upstream.body?.cancel();
            proxyRelease();
            return res.status(502).send(`Upstream ${upstream.status}`);
          }

          const ct = upstream.headers.get("content-type") ?? "image/jpeg";
          const cl = upstream.headers.get("content-length");

          res.setHeader("Content-Type", ct);
          res.setHeader("Cache-Control", "public, max-age=86400");
          if (cl) res.setHeader("Content-Length", cl);
          res.setHeader("X-Cache", "MISS");

          // Stream directly — no buffering
          const reader = upstream.body.getReader();
          const pump = async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) { res.end(); break; }
                const ok = res.write(value);
                if (!ok) await new Promise(r => res.once("drain", r));
              }
            } catch {
              res.destroy();
            } finally {
              proxyRelease();
            }
          };
          pump();
          return; // success — exit retry loop
        } catch (e) {
          clearTimeout(timeoutId);
          if (attempt >= maxAttempts) {
            proxyRelease();
            console.error("[ImageProxy] fetch error after retries:", e);
            return res.status(502).send("Proxy error");
          }
          await sleep(1000 * attempt);
        }
      }
      proxyRelease();
      return res.status(502).send("Proxy error");
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
  app.post("/api/scheduled/pipeline", scheduledPipelineHandler);

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
