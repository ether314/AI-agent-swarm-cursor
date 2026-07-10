import path from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { getRequestListener } from "@hono/node-server";
import { config as loadDotenv } from "dotenv";
import { WORKER_ROLES } from "@corp-swarm/schema";
import { loadConfig, REPO_ROOT } from "./config.js";
import {
  countQueuedHandoffs,
  getAgentInstance,
  isPaused,
  now,
  openDb,
  upsertAgentInstance,
  acceptAllPendingSuggestions,
} from "./db.js";
import { sniffProject } from "./project-brief.js";
import { Orchestrator } from "./orchestrator.js";
import { SwarmQueue } from "./queue.js";
import { createApp } from "./app.js";
import { bus } from "./events.js";
import { recoverStuckWork } from "./recover.js";

loadDotenv({ path: path.join(REPO_ROOT, ".env") });

async function main() {
  const config = loadConfig();
  const brief = sniffProject(config.targetRepo);
  const db = openDb();

  for (const role of WORKER_ROLES) {
    if (!getAgentInstance(db, role)) {
      upsertAgentInstance(db, {
        role,
        cursorAgentId: null,
        status: "idle",
        lastRunId: null,
        updatedAt: now(),
      });
    }
  }

  const recovered = recoverStuckWork(db);
  if (
    recovered.recoveredRuns ||
    recovered.recoveredHandoffs ||
    recovered.recoveredAgents
  ) {
    console.log(
      `Recovered stuck work: ${recovered.recoveredRuns} runs, ${recovered.recoveredHandoffs} handoffs, ${recovered.recoveredAgents} agents`,
    );
  }

  if (config.ceoAutoApprove) {
    const autoAccepted = acceptAllPendingSuggestions(db);
    if (autoAccepted > 0) {
      console.log(`CEO auto-approved ${autoAccepted} pending suggestion(s)`);
    }
  }

  const apiKey = process.env.CURSOR_API_KEY?.trim() ?? "";
  const apiKeyPresent = Boolean(apiKey) && !apiKey.includes("...");

  const orchestrator = new Orchestrator(db, config, brief, apiKey);
  const queue = new SwarmQueue(db, orchestrator, config.maxConcurrentAgents);
  queue.start(1500);

  const app = createApp({
    db,
    config,
    brief,
    orchestrator,
    queue,
    apiKeyPresent,
  });

  const port = config.serverPort;
  const server = createServer(getRequestListener(app.fetch));
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "swarm_state",
        paused: isPaused(db),
        queueDepth: countQueuedHandoffs(db),
      }),
    );
    const unsub = bus.subscribe((event) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    });
    socket.on("close", () => unsub());
  });

  server.listen(port, () => {
    console.log(`Corp Swarm API  http://localhost:${port}`);
    console.log(`WebSocket       ws://localhost:${port}/ws`);
    console.log(`Target repo:    ${config.targetRepo}`);
    console.log(
      `API key:        ${apiKeyPresent ? "present" : "MISSING — set CURSOR_API_KEY in .env"}`,
    );
  });

  const shutdown = async () => {
    console.log("Shutting down...");
    queue.stop();
    await orchestrator.disposeAll();
    wss.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
