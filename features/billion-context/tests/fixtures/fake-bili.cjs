#!/usr/bin/env node
// Test-only HTTP process. It never reads Bili config, sessions or user data.
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const args = process.argv.slice(2);
if (args[0] !== "start" || args[1] !== "--host" || args[2] !== "127.0.0.1" || args[3] !== "--port" || args[5] !== "--no-auto-update") process.exit(2);
if (process.env.BILI_STRICT_PORT !== "1" || process.env.ACP_AUTO_UPDATE !== "0" || process.env.ACP_AUTO_RESTART_ON_UPDATE !== "0" || process.env.BILI_PARENT_PID || process.env.BILI_LAUNCH_TOKEN) process.exit(3);
const identity = { ok: true, pid: process.pid, instanceId: randomUUID(), startedAt: Date.now(), version: "test-fixture" };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("content-type", "application/json");
  if (url.pathname === "/__bili/plugin/manifest") response.end(JSON.stringify({ ok: true, proxy: "billion-context", version: "test-fixture" }));
  else if (url.pathname === "/__bili/health") response.end(JSON.stringify(identity));
  else if (url.pathname === "/__bili/plugin/status" && url.searchParams.get("conversationId")) response.end(JSON.stringify({ ok: true, sessionId: "fixture/" + url.searchParams.get("conversationId") }));
  else { response.statusCode = 404; response.end("{}"); }
});
server.listen(Number(args[4]), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
