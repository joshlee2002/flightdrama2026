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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s hard timeout
      try {
        const upstream = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "FlightDrama/1.0 (aviation-content-tool)",
            "Referer": "https://commons.wikimedia.org/",
          },
        });
        clearTimeout(timeoutId);
        if (!upstream.ok) return res.status(upstream.status).send("Upstream error");
        const ct = upstream.headers.get("content-type") ?? "image/jpeg";
        res.setHeader("Content-Type", ct);
        res.setHeader("Cache-Control", "public, max-age=86400");
        const buf = await upstream.arrayBuffer();
        return res.send(Buffer.from(buf));
      } catch (e: any) {
        clearTimeout(timeoutId);
        if (e?.name === "AbortError") return res.status(504).send("Proxy timeout");
        console.error("[ImageProxy] error:", e);
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
