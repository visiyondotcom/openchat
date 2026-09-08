// Live system resource stats for the Admin overview dashboard (CPU, RAM,
// disk, GPU). Polled by the frontend every few seconds via
// GET /admin/health, so every function here needs to be cheap and never
// throw — a stat that can't be read on this deployment just comes back
// null/undefined rather than failing the whole health check.
//
// Important caveat, since this runs inside the backend's own Docker
// container: CPU/RAM numbers reflect what Node's `os` module sees from
// inside that container (the host's numbers on an unconstrained container,
// or the container's own cgroup limits if the deployment sets
// mem_limit/cpus in docker-compose.yml). Disk reflects the filesystem the
// backend container itself sees, which is meaningful for the app's own
// volumes but won't include unrelated host disks. GPU stats need
// `nvidia-smi` to be reachable from *this* container specifically — in the
// default docker-compose.yml the GPU is attached to the Ollama/sd-webui
// containers, not this one, so GPU numbers will show "unavailable" out of
// the box. To enable them, bring the stack up with the bundled GPU
// override, which passes the host's GPU(s) through to the backend
// container specifically (nvidia-container-toolkit injects `nvidia-smi`
// automatically once the device is attached — nothing to install):
//   docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
// IMPORTANT: this only works if the backend image is glibc-based (the
// Dockerfile uses node:20-bookworm-slim for this reason). NVIDIA Container
// Toolkit's device/driver injection is built against glibc and does not
// reliably work on musl-based images like node:*-alpine — on Alpine,
// `nvidia-smi` either won't be injected at all or won't execute even with
// `runtime: nvidia` set, producing confusing "executable file not found"
// errors that look like a passthrough problem but are actually a
// base-image problem.
// If the backend runs on a different machine than the GPU, point
// NVIDIA_SMI_PATH at a script that fetches the same CSV format remotely
// from wherever the GPU actually lives instead.

import { promises as fs } from "fs";
import os from "os";
import { execFile } from "child_process";

export type CpuStats = {
  cores: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  // Load average isn't a true instantaneous "% busy" reading (that would
  // need sampling /proc/stat over an interval), but load-avg-over-core-count
  // is the standard cheap approximation and is what most dashboards show.
  usedPercent: number;
};

export type MemoryStats = {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
};

export type DiskStats = {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
};

export type GpuStats = {
  index: number;
  name: string;
  utilizationPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  temperatureC: number | null;
};

export type SystemStats = {
  cpu: CpuStats;
  memory: MemoryStats;
  disk: DiskStats | null;
  gpus: GpuStats[] | null;
};

function getCpuStats(): CpuStats {
  const cores = os.cpus().length || 1;
  const [loadAvg1, loadAvg5, loadAvg15] = os.loadavg();
  const usedPercent = Math.min(100, Math.round((loadAvg1 / cores) * 100));
  return { cores, loadAvg1, loadAvg5, loadAvg15, usedPercent };
}

function getMemoryStats(): MemoryStats {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
  };
}

// Path to report disk usage for — defaults to the whole container
// filesystem. Point this at a specific mounted volume (e.g. where
// uploads/generated files live) via DISK_STATS_PATH if that's more useful
// than the root filesystem for a given deployment.
const DISK_STATS_PATH = process.env.DISK_STATS_PATH || "/";

async function getDiskStats(): Promise<DiskStats | null> {
  try {
    // fs.statfs needs Node 18.15+ / 19.6+ — both satisfied by the node:20
    // base image this project already uses.
    const stats = await fs.statfs(DISK_STATS_PATH);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    return {
      path: DISK_STATS_PATH,
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
    };
  } catch {
    // statfs unsupported on this platform/path — don't fail the whole
    // health check over an optional stat.
    return null;
  }
}

const NVIDIA_SMI_PATH = process.env.NVIDIA_SMI_PATH || "nvidia-smi";
const NVIDIA_SMI_TIMEOUT_MS = 2000;

// Shells out to `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`,
// which prints one CSV line per GPU with exactly the fields queried, no
// units, no header — cheap to parse and works the same across driver
// versions. Returns null (not an error) whenever nvidia-smi isn't
// installed/reachable, which is the common case for the backend container
// specifically (see the module-level comment above) — the frontend just
// hides the GPU section in that case rather than showing an error state.
function getGpuStats(): Promise<GpuStats[] | null> {
  return new Promise((resolve) => {
    execFile(
      NVIDIA_SMI_PATH,
      ["--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"],
      { timeout: NVIDIA_SMI_TIMEOUT_MS },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        try {
          const gpus = stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [index, name, util, memUsed, memTotal, temp] = line.split(",").map((v) => v.trim());
              return {
                index: Number(index),
                name,
                utilizationPercent: Number(util) || 0,
                // nvidia-smi reports memory.used/memory.total in MiB.
                memoryUsedBytes: (Number(memUsed) || 0) * 1024 * 1024,
                memoryTotalBytes: (Number(memTotal) || 0) * 1024 * 1024,
                temperatureC: temp === "" || Number.isNaN(Number(temp)) ? null : Number(temp),
              };
            });
          resolve(gpus.length ? gpus : null);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

export async function getSystemStats(): Promise<SystemStats> {
  const [disk, gpus] = await Promise.all([getDiskStats(), getGpuStats()]);
  return {
    cpu: getCpuStats(),
    memory: getMemoryStats(),
    disk,
    gpus,
  };
}
