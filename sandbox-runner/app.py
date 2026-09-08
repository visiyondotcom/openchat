"""
sandbox-runner
==============
Executes admin-submitted Filter code (see backend Prisma model `Filter`)
in an ephemeral, isolated Docker container. This service is the only
thing in the stack that talks to the Docker socket — the main backend
never does, so a bug or an exploit in the request-handling code can't
reach the daemon directly.

Isolation per run (docker-out-of-docker):
  - Fresh container per call, removed immediately after (no reuse, no
    state leaking between filters or between users).
  - network_mode="none" — the executed code cannot reach the internet,
    the internal `visiyon` network, Postgres, Redis, or Ollama.
  - read_only root filesystem, tmpfs for /tmp only, no bind mounts.
  - CPU/memory/pids limits and a wall-clock timeout enforced from both
    sides (container-level + this service killing/removing it).
  - runs as a non-root, no-new-privileges user; all capabilities dropped.
  - code + input are passed via stdin, never baked into an image or
    written to a host path the container can see.

This bounds the blast radius to "burn CPU/memory for a few seconds and
produce garbage output" — it does not attempt to make arbitrary Python
"safe" via AST inspection or import allowlists, which are well-known to
be bypassable. The container boundary is the actual security boundary.
"""

import asyncio
import json
import logging
import os
import uuid

import docker
from docker.errors import ContainerError, ImageNotFound
from docker.types import Ulimit
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("sandbox-runner")

app = FastAPI(title="visiyon-sandbox-runner")

EXECUTOR_IMAGE = os.environ.get("EXECUTOR_IMAGE", "visiyon-sandbox-executor:latest")
SANDBOX_NETWORK = os.environ.get("SANDBOX_NETWORK", "none")  # "none" disables networking entirely
DEFAULT_TIMEOUT_MS = 5000
MAX_TIMEOUT_MS = 15000
MEMORY_LIMIT = os.environ.get("SANDBOX_MEMORY_LIMIT", "128m")
CPU_QUOTA = int(os.environ.get("SANDBOX_CPU_QUOTA", "50000"))  # 0.5 CPU (period 100000)

_docker_client: docker.DockerClient | None = None


def get_docker() -> docker.DockerClient:
    global _docker_client
    if _docker_client is None:
        _docker_client = docker.from_env()
    return _docker_client


class RunFilterRequest(BaseModel):
    hook: str = Field(pattern="^(inlet|outlet|pipe|action)$")
    code: str
    body: dict
    user: dict
    timeout_ms: int = DEFAULT_TIMEOUT_MS


class RunFilterResponse(BaseModel):
    ok: bool
    body: dict | None = None
    error: str | None = None
    logs: str = ""


class RunCodeRequest(BaseModel):
    code: str
    stdin: str = ""
    timeout_ms: int = DEFAULT_TIMEOUT_MS


class RunCodeResponse(BaseModel):
    ok: bool
    stdout: str = ""
    stderr: str = ""
    error: str | None = None


@app.get("/health")
async def health():
    try:
        get_docker().ping()
        return {"status": "ok"}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"docker unreachable: {exc}")


@app.post("/run-filter", response_model=RunFilterResponse)
async def run_filter(req: RunFilterRequest):
    timeout_ms = min(req.timeout_ms or DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    payload = json.dumps({"hook": req.hook, "code": req.code, "body": req.body, "user": req.user})

    client = get_docker()
    name = f"visiyon-filter-{uuid.uuid4().hex[:12]}"
    container = None
    try:
        container = await asyncio.to_thread(
            client.containers.run,
            EXECUTOR_IMAGE,
            name=name,
            detach=True,
            stdin_open=True,
            network_disabled=True,
            network_mode="none",
            read_only=True,
            tmpfs={"/tmp": "size=16m,mode=1777"},
            mem_limit=MEMORY_LIMIT,
            memswap_limit=MEMORY_LIMIT,  # no swap beyond the mem limit
            pids_limit=64,
            cpu_period=100000,
            cpu_quota=CPU_QUOTA,
            user="65534:65534",  # nobody:nogroup
            security_opt=["no-new-privileges"],
            cap_drop=["ALL"],
            ulimits=[Ulimit(name="nofile", soft=64, hard=64)],
            environment={},
            remove=False,  # we remove explicitly below so we can read logs first
        )

        # Feed the payload on stdin via attach, then wait with a hard timeout.
        sock = container.attach_socket(params={"stdin": 1, "stream": 1})
        sock._sock.sendall(payload.encode("utf-8") + b"\n")
        sock.close()

        try:
            exit_code = await asyncio.wait_for(
                asyncio.to_thread(lambda: container.wait(timeout=timeout_ms / 1000 + 1)["StatusCode"]),
                timeout=(timeout_ms / 1000) + 2,
            )
        except asyncio.TimeoutError:
            return RunFilterResponse(ok=False, error=f"Filter exceeded {timeout_ms}ms timeout and was killed.")

        raw_logs = await asyncio.to_thread(container.logs, stdout=True, stderr=True)
        logs = raw_logs.decode("utf-8", errors="replace")

        if exit_code != 0:
            return RunFilterResponse(ok=False, error=f"Filter exited with code {exit_code}", logs=logs)

        # The executor writes exactly one JSON line to stdout as its last
        # line of output: {"ok": true, "body": {...}} or {"ok": false, "error": "..."}
        result_line = next((l for l in reversed(logs.strip().splitlines()) if l.strip()), "")
        try:
            result = json.loads(result_line)
        except json.JSONDecodeError:
            return RunFilterResponse(ok=False, error="Filter did not return valid JSON output.", logs=logs)

        if not result.get("ok"):
            return RunFilterResponse(ok=False, error=result.get("error", "Unknown filter error"), logs=logs)
        return RunFilterResponse(ok=True, body=result.get("body"), logs=logs)

    except ImageNotFound:
        raise HTTPException(status_code=500, detail=f"Executor image '{EXECUTOR_IMAGE}' not found — build it first.")
    except ContainerError as exc:
        return RunFilterResponse(ok=False, error=str(exc))
    except Exception as exc:  # noqa: BLE001
        log.exception("sandbox run failed")
        return RunFilterResponse(ok=False, error=f"Sandbox error: {exc}")
    finally:
        if container is not None:
            try:
                await asyncio.to_thread(container.kill)
            except Exception:
                pass
            try:
                await asyncio.to_thread(container.remove, force=True)
            except Exception:
                pass


@app.post("/run-code", response_model=RunCodeResponse)
async def run_code(req: RunCodeRequest):
    """
    Executes an arbitrary, top-level Python script — the code-block "Run"
    button in the chat UI and the run_python built-in tool both call this.
    Same container image and isolation as /run-filter above (no network,
    read-only fs, dropped caps, non-root, cpu/mem/pids/time limits); the
    only difference is which script inside the image runs, selected via an
    `entrypoint` override rather than a separate image to build/maintain.
    """
    timeout_ms = min(req.timeout_ms or DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    payload = json.dumps({"code": req.code, "stdin": req.stdin})

    client = get_docker()
    name = f"visiyon-runcode-{uuid.uuid4().hex[:12]}"
    container = None
    try:
        container = await asyncio.to_thread(
            client.containers.run,
            EXECUTOR_IMAGE,
            name=name,
            entrypoint=["python", "/sandbox/run_code.py"],
            detach=True,
            stdin_open=True,
            network_disabled=True,
            network_mode="none",
            read_only=True,
            tmpfs={"/tmp": "size=16m,mode=1777"},
            mem_limit=MEMORY_LIMIT,
            memswap_limit=MEMORY_LIMIT,
            pids_limit=64,
            cpu_period=100000,
            cpu_quota=CPU_QUOTA,
            user="65534:65534",
            security_opt=["no-new-privileges"],
            cap_drop=["ALL"],
            ulimits=[Ulimit(name="nofile", soft=64, hard=64)],
            environment={},
            remove=False,
        )

        sock = container.attach_socket(params={"stdin": 1, "stream": 1})
        sock._sock.sendall(payload.encode("utf-8") + b"\n")
        sock.close()

        try:
            exit_code = await asyncio.wait_for(
                asyncio.to_thread(lambda: container.wait(timeout=timeout_ms / 1000 + 1)["StatusCode"]),
                timeout=(timeout_ms / 1000) + 2,
            )
        except asyncio.TimeoutError:
            return RunCodeResponse(ok=False, error=f"Script exceeded {timeout_ms}ms timeout and was killed.")

        raw_logs = await asyncio.to_thread(container.logs, stdout=True, stderr=True)
        logs = raw_logs.decode("utf-8", errors="replace")

        if exit_code != 0:
            return RunCodeResponse(ok=False, error=f"Executor exited with code {exit_code}", stderr=logs)

        # run_code.py writes exactly one JSON line to stdout as its last
        # line of output: {"ok": ..., "stdout": ..., "stderr": ..., "error": ...}
        result_line = next((l for l in reversed(logs.strip().splitlines()) if l.strip()), "")
        try:
            result = json.loads(result_line)
        except json.JSONDecodeError:
            return RunCodeResponse(ok=False, error="Executor did not return valid JSON output.", stderr=logs)

        return RunCodeResponse(
            ok=bool(result.get("ok")),
            stdout=result.get("stdout") or "",
            stderr=result.get("stderr") or "",
            error=result.get("error"),
        )

    except ImageNotFound:
        raise HTTPException(status_code=500, detail=f"Executor image '{EXECUTOR_IMAGE}' not found — build it first.")
    except ContainerError as exc:
        return RunCodeResponse(ok=False, error=str(exc))
    except Exception as exc:  # noqa: BLE001
        log.exception("run-code sandbox run failed")
        return RunCodeResponse(ok=False, error=f"Sandbox error: {exc}")
    finally:
        if container is not None:
            try:
                await asyncio.to_thread(container.kill)
            except Exception:
                pass
            try:
                await asyncio.to_thread(container.remove, force=True)
            except Exception:
                pass
