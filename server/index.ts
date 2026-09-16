import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initDb } from "./db";
import { makeRailwayEnv } from "./railway-env";
import { handle, paperCycle } from "../worker/index";

const app = express();
const PORT = Number(process.env.PORT) || 8080;

app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, "../dist");

let tickRunning = false;

async function runBotTick() {
  if (tickRunning) {
    console.log("[SHIBA] Previous tick still running, skipping.");
    return;
  }

  tickRunning = true;
  const startedAt = Date.now();

  try {
    console.log("[SHIBA] Tick started");

    const env = makeRailwayEnv() as any;
    await paperCycle(env);

    console.log(
      `[SHIBA] Tick finished in ${Date.now() - startedAt}ms`
    );
  } catch (error) {
    console.error("[SHIBA] Tick failed:", error);
  } finally {
    tickRunning = false;
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "PulseScan",
    platform: "Railway",
    botIntervalSeconds: 30,
    botRunning: tickRunning,
  });
});

app.use("/api", async (req, res) => {
  try {
    const protocol =
      req.headers["x-forwarded-proto"]?.toString() || "http";

    const host =
      req.headers.host || `localhost:${PORT}`;

    const url = `${protocol}://${host}${req.originalUrl}`;

    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers.set(key, value);
      } else if (Array.isArray(value)) {
        headers.set(key, value.join(", "));
      }
    }

    const init: RequestInit = {
      method: req.method,
      headers,
    };

    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.body !== undefined
    ) {
      init.body = JSON.stringify(req.body);
      headers.set("content-type", "application/json");
    }

    const request = new Request(url, init);

    const workerResponse = await handle(
      request,
      makeRailwayEnv() as any
    );

    const body = await workerResponse.text();

    workerResponse.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    res.status(workerResponse.status).send(body);
  } catch (error) {
    console.error("[API] Request failed:", error);

    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
});

app.use(express.static(distPath));

app.use((_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

async function start() {
  await initDb();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`PulseScan server running on port ${PORT}`);
    console.log("Shiba bot interval: 30 seconds");
  });

  await runBotTick();

  setInterval(() => {
    void runBotTick();
  }, 30_000);
}

start().catch((error) => {
  console.error("PulseScan startup failed:", error);
  process.exit(1);
});
