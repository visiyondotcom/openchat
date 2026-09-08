// Tiny, dependency-free HTTP server that does the actual work for the
// admin panel's "Updates" page. It's a separate container (see
// updater/Dockerfile + the `updater` service in docker-compose.yml) for
// one reason: it's the only thing that needs the docker socket and a
// checkout of the repo mounted in — the main backend never gets that
// access, so a bug or compromise there can't reach the host's Docker.
//
// Endpoints (internal network only — not published, see docker-compose.yml):
//   GET  /status  -> { state, log, startedAt, finishedAt }
//   POST /run     -> kicks off the update in the background, returns
//                    immediately; poll /status for progress
//
// What "update" means for this project: this is a git-clone + docker
// compose deployment (see README's "Local install" section), not a
// packaged binary — so updating means pulling the latest commit on the
// configured branch and rebuilding/restarting the compose stack. That's
// exactly what an operator would type by hand over SSH; this just runs
// those same commands from a button.

import { createServer } from "node:http";
import { spawn } from "node:child_process";

const PORT = process.env.UPDATER_PORT || 9000;
const REPO_DIR = process.env.REPO_DIR || "/repo";
const BRANCH = process.env.UPDATE_BRANCH || "main";
// If the deployment has GPU passthrough enabled (docker-compose.gpu.yml —
// see backend/src/lib/system.ts), that override MUST be re-applied on
// every `docker compose up`, this one included. Without this, an update
// silently drops back to the base compose file (no GPU flags, no error),
// which reads as "GPU stats just disappeared" after any auto-update even
// though nothing about the GPU setup itself changed. Set this to match
// however the stack was originally brought up, e.g.:
//   COMPOSE_GPU_OVERRIDE=docker-compose.gpu.yml
const COMPOSE_GPU_OVERRIDE = process.env.COMPOSE_GPU_OVERRIDE || "";

let state = "idle"; // idle | running | success | failed
let log = "";
let startedAt = null;
let finishedAt = null;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: REPO_DIR });
    proc.stdout.on("data", (d) => (log += d.toString()));
    proc.stderr.on("data", (d) => (log += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

async function performUpdate() {
  state = "running";
  log = "";
  startedAt = new Date().toISOString();
  finishedAt = null;
  try {
    log += `$ git fetch origin ${BRANCH}\n`;
    await run("git", ["fetch", "origin", BRANCH]);
    log += `$ git reset --hard origin/${BRANCH}\n`;
    await run("git", ["reset", "--hard", `origin/${BRANCH}`]);
    const composeArgs = ["compose"];
    if (COMPOSE_GPU_OVERRIDE) {
      composeArgs.push("-f", "docker-compose.yml", "-f", COMPOSE_GPU_OVERRIDE);
    }
    composeArgs.push("up", "-d", "--build");
    log += `$ docker ${composeArgs.join(" ")}\n`;
    await run("docker", composeArgs);
    state = "success";
  } catch (err) {
    log += `\n[error] ${err.message}\n`;
    state = "failed";
  } finally {
    finishedAt = new Date().toISOString();
  }
}

const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET" && req.url === "/status") {
    res.end(JSON.stringify({ state, log: log.slice(-8000), startedAt, finishedAt }));
    return;
  }

  if (req.method === "POST" && req.url === "/run") {
    if (state === "running") {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, message: "Already running" }));
      return;
    }
    // Fire and forget — the caller polls /status for progress. The
    // backend's own updates:lock in Redis is what actually prevents two
    // overlapping triggers; this check is just a second line of defense.
    performUpdate();
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`[updater] listening on :${PORT}, repo dir ${REPO_DIR}, branch ${BRANCH}`);
});
