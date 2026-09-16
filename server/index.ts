import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initDb, makeRailwayEnv } from "./db";
import { handle, paperCycle } from "../worker/index";

const app = express();
const PORT = Number(process.env.PORT) || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(process.cwd(), "dist");

app.use(express.json({ limit: "2mb" }));

async function proxyToWorker(req: express.Request, res: express.Response) {
  try {
    const workerUrl = new URL(
      "/api" + req.path,
      `http://${req.headers.host || "localhost"}`
    );
    workerUrl.search = new URL(req.originalUrl, "http://localhost").search;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers.set(key, value);
      } else if (Array.isArray(value)) {
        headers.set(key, value.join(","));
      }
    }

    let body: string | undefined;

    if (req.method !== "GET" && req.method !== "HEAD") {
      body = JSON.stringify(req.body ?? {});
      headers.set("content-type", "application/json");
    }

    const workerRequest = new Request(workerUrl, {
      method: req.method,
      headers,
      body,
    });

    const workerResponse = await handle(
      workerRequest,
      makeRailwayEnv() as any
    );

    res.status(workerResponse.status);
    workerResponse.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const responseBody = Buffer.from(await workerResponse.arrayBuffer());
    res.send(responseBody);
  } catch (error) {
    console.error("Worker bridge error:", error);
    res.status(500).json({
      ok: false,
      error: "Internal server error",
    });
  }
}

app.use("/api", proxyToWorker);

app.use(express.static(distPath));

app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    return next();
  }

  res.sendFile(path.join(distPath, "index.html"));
});

let tickRunning = false;

async function runTick() {
  if (tickRunning) {
    console.log("Paper bot tick skipped: previous tick still running");
    return;
  }

  tickRunning = true;
  const started = Date.now();

  try {
    await paperCycle(makeRailwayEnv() as any);
    console.log(
      `Paper bot tick completed in ${Date.now() - started}ms`
    );
  } catch (error) {
    console.error("Paper bot tick failed:", error);
  } finally {
    tickRunning = false;
  }
}

async function start() {
  if (process.env.DATABASE_URL) {
    await initDb();
  } else {
    console.warn("DATABASE_URL missing");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`PulseScan Railway server running on port ${PORT}`);
  });

  if (process.env.BOT_ENABLED === "true") {
    setTimeout(() => void runTick(), 5000);
    setInterval(() => void runTick(), 30000);

    console.log("Paper bot scheduler: 30 seconds");
  } else {
    console.log(
      "Paper bot scheduler disabled (BOT_ENABLED != true)"
    );
  }
}

start().catch((error) => {
  console.error("PulseScan startup failed:", error);
  process.exit(1);
});
