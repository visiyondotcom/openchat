import type { PrismaClient } from "@prisma/client";
import { logEvent } from "./logger.js";

const SANDBOX_RUNNER_URL = process.env.SANDBOX_RUNNER_URL || "http://sandbox-runner:8000";

export type FilterUser = { id: string; email: string; role: string };
export type FilterBody = { content: string; [key: string]: unknown };

type SandboxResponse = {
  ok: boolean;
  body?: FilterBody;
  error?: string;
  logs?: string;
};

// One HTTP call to the sandbox-runner control service, which itself
// spawns the actual isolated container per filter run. Never throws for
// "the filter code was bad" — those come back as {ok:false, error}. Only
// throws for "the sandbox-runner service itself is unreachable", which
// callers treat as fail-open-but-log (see runFilters below) so one down
// service doesn't take the whole chat pipeline with it.
async function callSandbox(args: {
  hook: "inlet" | "outlet" | "pipe" | "action";
  code: string;
  body: FilterBody;
  user: FilterUser;
  timeoutMs: number;
}): Promise<SandboxResponse> {
  const controller = new AbortController();
  // A little slack over the per-filter timeout so the sandbox-runner's own
  // container-level timeout fires first and gives us a clean error instead
  // of us aborting the HTTP call mid-flight.
  const abortAfter = args.timeoutMs + 3000;
  const timer = setTimeout(() => controller.abort(), abortAfter);
  try {
    const res = await fetch(`${SANDBOX_RUNNER_URL}/run-filter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook: args.hook,
        code: args.code,
        body: args.body,
        user: args.user,
        timeout_ms: args.timeoutMs,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `sandbox-runner returned HTTP ${res.status}` };
    }
    return (await res.json()) as SandboxResponse;
  } finally {
    clearTimeout(timer);
  }
}

export type RunCodeResult = {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
};

// One HTTP call to sandbox-runner's /run-code endpoint — same isolated,
// network-less container as filters (see sandbox-runner/app.py), but for
// an arbitrary top-level Python script instead of the Filter/Pipe/Action
// class contract. Used by both the run_python built-in tool and the
// code-block "Run" button in the chat UI (routes/tools.ts).
export async function runPythonCode(code: string, stdinData = "", timeoutMs = 8000): Promise<RunCodeResult> {
  const controller = new AbortController();
  const abortAfter = timeoutMs + 3000;
  const timer = setTimeout(() => controller.abort(), abortAfter);
  try {
    const res = await fetch(`${SANDBOX_RUNNER_URL}/run-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, stdin: stdinData, timeout_ms: timeoutMs }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `sandbox-runner returned HTTP ${res.status}` };
    }
    return (await res.json()) as RunCodeResult;
  } catch (err) {
    return { ok: false, error: `sandbox-runner unreachable: ${err instanceof Error ? err.message : err}` };
  } finally {
    clearTimeout(timer);
  }
}

// Single-shot sandbox call for the admin "test this filter" button —
// same isolation as a live run, but doesn't touch lastError/lastRunAt or
// chain with other filters.
export async function runFilterOnce(args: {
  hook: "inlet" | "outlet" | "pipe" | "action";
  code: string;
  body: FilterBody;
  user: FilterUser;
  timeoutMs: number;
}): Promise<SandboxResponse> {
  try {
    return await callSandbox(args);
  } catch (err) {
    return { ok: false, error: `sandbox-runner unreachable: ${err instanceof Error ? err.message : err}` };
  }
}

// Runs a Pipe's `pipe(body, user)` — used as a custom model provider.
// Unlike Filter, a Pipe fully REPLACES the model call: whatever it
// returns in body.content becomes the assistant's reply, so callers
// treat sandbox unreachable / non-ok results as a hard failure rather
// than a pass-through.
export async function runPipe(
  prisma: PrismaClient,
  pipeId: string,
  body: FilterBody,
  user: FilterUser
): Promise<{ ok: true; body: FilterBody } | { ok: false; error: string }> {
  const pipe = await prisma.pipe.findUnique({ where: { id: pipeId } });
  if (!pipe || !pipe.enabled) return { ok: false, error: "Pipe not found or disabled" };

  const result = await runFilterOnce({ hook: "pipe", code: pipe.code, body, user, timeoutMs: pipe.timeoutMs });
  if (!result.ok) {
    await prisma.pipe.update({ where: { id: pipeId }, data: { lastError: result.error, lastRunAt: new Date() } });
    logEvent(prisma, "ERROR", "pipe", `Pipe "${pipe.name}" failed: ${result.error}`, { pipeId });
    return { ok: false, error: result.error ?? "Unknown pipe error" };
  }
  await prisma.pipe.update({ where: { id: pipeId }, data: { lastError: null, lastRunAt: new Date() } });
  return { ok: true, body: result.body ?? body };
}

// Runs an Action's `action(body, user)` — a one-shot chat-toolbar button
// handler. Returns whatever dict the action produces so the frontend can
// render it (toast, side panel, etc.); doesn't chain or mutate history.
export async function runAction(
  prisma: PrismaClient,
  actionId: string,
  body: FilterBody,
  user: FilterUser
): Promise<{ ok: true; body: FilterBody } | { ok: false; error: string }> {
  const action = await prisma.action.findUnique({ where: { id: actionId } });
  if (!action || !action.enabled) return { ok: false, error: "Action not found or disabled" };

  const result = await runFilterOnce({ hook: "action", code: action.code, body, user, timeoutMs: action.timeoutMs });
  if (!result.ok) {
    await prisma.action.update({ where: { id: actionId }, data: { lastError: result.error, lastRunAt: new Date() } });
    logEvent(prisma, "ERROR", "action", `Action "${action.name}" failed: ${result.error}`, { actionId });
    return { ok: false, error: result.error ?? "Unknown action error" };
  }
  await prisma.action.update({ where: { id: actionId }, data: { lastError: null, lastRunAt: new Date() } });
  return { ok: true, body: result.body ?? body };
}

// Runs every enabled Filter that applies to `modelName` (empty
// modelNames = applies to all), in priority order, for the given hook.
// Each filter's output body feeds into the next filter's input, so a
// chain of filters composes the same way OpenWebUI's does. A filter that
// throws (inlet only) blocks the message; an outlet error is logged and
// skipped so a broken post-processing filter never eats a reply the user
// already saw generated. Sandbox-runner being unreachable is treated the
// same as an individual filter erroring — logged, filter skipped, chat
// keeps working with the non-sandboxed pipeline rules still enforced.
export async function runFilters(
  prisma: PrismaClient,
  hook: "inlet" | "outlet",
  modelName: string,
  body: FilterBody,
  user: FilterUser
): Promise<{ body: FilterBody; blocked?: string }> {
  const filters = await prisma.filter.findMany({
    where: { enabled: true },
    orderBy: { priority: "asc" },
  });
  const applicable = filters.filter((f) => f.modelNames.length === 0 || f.modelNames.includes(modelName));

  let current = body;
  for (const filter of applicable) {
    let result: SandboxResponse;
    try {
      result = await callSandbox({ hook, code: filter.code, body: current, user, timeoutMs: filter.timeoutMs });
    } catch (err) {
      result = { ok: false, error: `sandbox-runner unreachable: ${err instanceof Error ? err.message : err}` };
    }

    if (!result.ok) {
      await prisma.filter.update({
        where: { id: filter.id },
        data: { lastError: result.error ?? "Unknown error", lastRunAt: new Date() },
      });
      logEvent(prisma, "ERROR", "filter", `Filter "${filter.name}" (${hook}) failed: ${result.error}`, {
        filterId: filter.id,
      });
      if (hook === "inlet") {
        // An inlet filter that errors blocks the message rather than
        // silently sending unfiltered content — the admin opted this
        // filter into gating traffic, so a broken filter should fail
        // closed, not fail open.
        return { body: current, blocked: `Message blocked: filter "${filter.name}" failed to run.` };
      }
      // Outlet failure: skip this filter's transform, keep the previous
      // body, move on to the next filter.
      continue;
    }

    await prisma.filter.update({ where: { id: filter.id }, data: { lastError: null, lastRunAt: new Date() } });
    current = result.body ?? current;
  }

  return { body: current };
}
