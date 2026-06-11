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

  // Image proxy — streams Wikimedia/Pexels images to avoid CORS/hotlink blocks.
  // Uses streaming (no full-buffer) to keep memory low on the 512MB production instance.
  // A concurrency semaphore limits simultaneous upstream fetches to avoid overwhelming
  // Wikimedia's CDN and exhausting the server's RAM/connections.
  const PROXY_CONCURRENCY = 8; // max simultaneous upstream fetches
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

  // Tiny metadata cache — only stores content-type + content-length, NOT the full buffer.
  // Full image bytes are streamed directly; this just avoids a HEAD request on repeat visits.
  const imgMetaCache = new Map<string, { ct: string; ts: number }>();
  const IMG_META_TTL = 60 * 60 * 1000; // 1 hour

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

      // Acquire concurrency slot (queues if too many in-flight)
      await proxyAcquire();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout

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

        if (!upstream.ok || !upstream.body) {
          proxyRelease();
          return res.status(502).send("Upstream error");
        }

        const ct = upstream.headers.get("content-type") ?? "image/jpeg";
        const cl = upstream.headers.get("content-length");

        // Cache content-type metadata for future requests
        imgMetaCache.set(url, { ct, ts: Date.now() });
        // Evict stale entries periodically
        if (imgMetaCache.size > 500) {
          const now = Date.now();
          Array.from(imgMetaCache.entries()).forEach(([k, v]) => {
            if (now - v.ts > IMG_META_TTL) imgMetaCache.delete(k);
          });
        }

        res.setHeader("Content-Type", ct);
        res.setHeader("Cache-Control", "public, max-age=86400");
        if (cl) res.setHeader("Content-Length", cl);
        res.setHeader("X-Cache", "MISS");

        // Stream the response body directly — no buffering, low memory footprint
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
        return;
      } catch (e) {
        clearTimeout(timeoutId);
        proxyRelease();
        console.error("[ImageProxy] fetch error:", e);
        return res.status(502).send("Proxy error");
      }
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
