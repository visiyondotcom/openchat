import { evaluate } from "mathjs";
import dns from "node:dns/promises";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { PrismaClient, Tool as PrismaTool, Prisma } from "@prisma/client";
import { GENERATED_FILES_DIR, ensureGeneratedFilesDir } from "./generated-files.js";
import { imageGenEnabled, generateImage } from "./images.js";
import { internetAccessEnabled } from "./internet-access.js";
import { webSearch as performWebSearch, webSearchEnabled } from "./websearch.js";
import { loadServerConnection, listRemoteFiles, readRemoteFile, writeRemoteFile } from "./server-connection.js";
import { runPythonCode } from "./functions-sandbox.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ToolParameter {
  name: string;
  type: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
}

// The shape stored in Tool.config for HTTP tools.
export interface HttpToolConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  // Optional JSON body template. "{{paramName}}" placeholders are replaced
  // with the (stringified) argument value before the request is sent.
  bodyTemplate?: string;
  parameters: ToolParameter[];
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  arguments: Record<string, unknown>;
  output: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Built-in tools — run in-process, no network access, safe by construction.
// Seeded into the Tool table at startup with type BUILTIN so they show up
// in the same catalog/attach flow as HTTP tools; their `config` is unused,
// the actual implementation lives in BUILTIN_HANDLERS below.
// ---------------------------------------------------------------------------

export const BUILTIN_TOOL_DEFS: {
  name: string;
  description: string;
  parameters: ToolParameter[];
}[] = [
  {
    name: "calculator",
    description:
      "Evaluate a math expression (arithmetic, powers, sqrt, trig, unit conversions). Use for any calculation instead of guessing the answer yourself.",
    parameters: [
      { name: "expression", type: "string", description: "The math expression to evaluate, e.g. \"(12 + 8) * 3.5\"", required: true },
    ],
  },
  {
    name: "current_datetime",
    description: "Get the current date and time (UTC). Use this instead of assuming what today's date is.",
    parameters: [],
  },
  {
    name: "create_file",
    description:
      "Create a downloadable file for the user (code, config, text, csv, etc.) and return a link they can click to download it. Use this whenever the user asks you to build, write, or fix something that results in a file they'd want to save — don't just paste long file contents into the chat. The file expires after 24 hours.",
    parameters: [
      { name: "filename", type: "string", description: "Filename with extension, e.g. \"server.py\" or \"index.html\"", required: true },
      { name: "content", type: "string", description: "The full text content of the file", required: true },
    ],
  },
  {
    name: "generate_image",
    description:
      "Generate an image from a text description and show it to the user. Use this whenever the user asks you to create, draw, generate, or make a picture/image/photo of something.",
    parameters: [
      { name: "prompt", type: "string", description: "A detailed, self-contained description of the image to generate, in English.", required: true },
    ],
  },
  {
    name: "browse_web",
    description:
      "Search the web or fetch a specific page. Pass 'query' to run a live web search and get back a list of results (title, url, snippet) — use this whenever the user asks about something you'd need current information for, or wants you to 'look something up' or 'go check' something, even without a link. Pass 'url' instead when you already have (or were given) the exact page to read in full. Gated by Admin > Settings > Web search > \"Enable full internet access\" — disabled by default. Requests to localhost, private, and internal network addresses are always blocked for safety.",
    parameters: [
      { name: "query", type: "string", description: "A search query to look up on the web. Provide this OR url, not both.", required: false },
      { name: "url", type: "string", description: "The full URL to fetch, including http:// or https://. Provide this OR query, not both.", required: false },
    ],
  },
  {
    name: "search_chats",
    description:
      "Search through the user's own past chat conversations (other chats, not this one) for messages matching a query. Use this whenever the user refers to something discussed earlier — \"in another chat\", \"we talked about this before\", \"what did I ask you last time\" — and the answer isn't already in the current conversation.",
    parameters: [
      { name: "query", type: "string", description: "Keywords or phrase to search for in the user's past messages.", required: true },
    ],
  },
  {
    name: "server_list_files",
    description:
      "List files and folders on the user's own server (only available if they've connected one in Settings → Server). Use this to explore what's on their server before reading or writing a file.",
    parameters: [
      { name: "path", type: "string", description: "Directory path to list, relative to the configured base directory. Use \".\" for the root.", required: false },
    ],
  },
  {
    name: "server_read_file",
    description:
      "Read the contents of a file on the user's own connected server (Settings → Server). Files over 2MB can't be read this way.",
    parameters: [
      { name: "path", type: "string", description: "File path to read, relative to the configured base directory.", required: true },
    ],
  },
  {
    name: "server_write_file",
    description:
      "Create or overwrite a file on the user's own connected server (Settings → Server). Use this instead of create_file when the user wants the result saved directly onto their server rather than downloaded.",
    parameters: [
      { name: "path", type: "string", description: "File path to write, relative to the configured base directory.", required: true },
      { name: "content", type: "string", description: "The full text content to write.", required: true },
    ],
  },
  {
    name: "run_python",
    description:
      "Execute a Python script in an isolated, network-less sandbox and get back its stdout/stderr. Use this to actually run and verify code — test a calculation, check a script's output, debug an error — instead of only writing code out and assuming it works. Standard library only, no network access, no file persistence between calls, ~8 second time limit.",
    parameters: [
      { name: "code", type: "string", description: "The full Python script to execute.", required: true },
      { name: "stdin", type: "string", description: "Optional text to feed to the script's stdin, if it reads input().", required: false },
    ],
  },
];

// Extra per-call context that isn't part of the tool's own arguments —
// who's asking, and which chat they're asking from (so search_chats can
// exclude the chat that's currently in progress).
export interface ToolExecutionContext {
  userId?: string;
  currentChatId?: string;
}

// Shared by the create_file tool handler below and by
// rescueFakeFileLinks() in chats.ts, which calls this directly for content
// the model wrote as a fake HTML/data-URI link instead of a real tool_call
// — same validation, same storage, same real markdown-link shape either
// way, so a "rescued" file is indistinguishable from one the model
// requested correctly.
export async function writeGeneratedFile(filename: string, content: string): Promise<string> {
  const trimmedName = filename.trim();
  if (!trimmedName) throw new Error("Missing filename");
  if (content.length > 5 * 1024 * 1024) throw new Error("File content too large (max 5MB)");

  // Strip path separators so this can never write outside GENERATED_FILES_DIR.
  const safeName = path.basename(trimmedName).replace(/[^\w.\-]/g, "_") || "file.txt";
  const token = crypto.randomUUID();

  await ensureGeneratedFilesDir();
  await fs.writeFile(path.join(GENERATED_FILES_DIR, `${token}__${safeName}`), content, "utf-8");

  return `[${safeName}](/api/files/${token})`;
}

const BUILTIN_HANDLERS: Record<
  string,
  (args: Record<string, unknown>, prisma?: PrismaClient, ctx?: ToolExecutionContext) => Promise<string>
> = {
  async calculator(args) {
    const expression = String(args.expression ?? "");
    if (!expression.trim()) throw new Error("Missing expression");
    if (expression.length > 500) throw new Error("Expression too long");
    const result = evaluate(expression);
    return typeof result === "object" ? JSON.stringify(result) : String(result);
  },
  async current_datetime() {
    return new Date().toISOString();
  },
  async create_file(args) {
    return writeGeneratedFile(String(args.filename ?? ""), String(args.content ?? ""));
  },
  async generate_image(args, prisma) {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) throw new Error("Missing prompt");
    if (!prisma || !(await imageGenEnabled(prisma))) {
      throw new Error("Image generation is not configured on this server.");
    }
    const url = await generateImage(prompt, undefined, prisma);
    return `![Generated image](${url})`;
  },
  async search_chats(args, prisma, ctx) {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("Missing query");
    if (!prisma || !ctx?.userId) {
      throw new Error("Chat search is not available in this context.");
    }

    const matches = await prisma.message.findMany({
      where: {
        content: { contains: query, mode: "insensitive" },
        role: { in: ["USER", "ASSISTANT"] },
        chat: {
          userId: ctx.userId,
          ...(ctx.currentChatId ? { id: { not: ctx.currentChatId } } : {}),
        },
      },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        content: true,
        role: true,
        createdAt: true,
        chat: { select: { id: true, title: true } },
      },
    });

    if (matches.length === 0) {
      return `No past chats found mentioning "${query}".`;
    }

    const SNIPPET_RADIUS = 160;
    const lines = matches.map((m) => {
      const idx = m.content.toLowerCase().indexOf(query.toLowerCase());
      let snippet = m.content;
      if (idx !== -1) {
        const start = Math.max(0, idx - SNIPPET_RADIUS);
        const end = Math.min(m.content.length, idx + query.length + SNIPPET_RADIUS);
        snippet = `${start > 0 ? "…" : ""}${m.content.slice(start, end)}${end < m.content.length ? "…" : ""}`;
      } else if (snippet.length > SNIPPET_RADIUS * 2) {
        snippet = snippet.slice(0, SNIPPET_RADIUS * 2) + "…";
      }
      const date = m.createdAt.toISOString().slice(0, 10);
      return `- Chat "${m.chat.title}" (${date}, ${m.role.toLowerCase()}): ${snippet.replace(/\s+/g, " ").trim()}`;
    });

    return `Found ${matches.length} matching message(s) in past chats:\n${lines.join("\n")}`;
  },
  async server_list_files(args, prisma, ctx) {
    if (!prisma || !ctx?.userId) throw new Error("Not available in this context.");
    const conn = await loadServerConnection(prisma, ctx.userId);
    if (!conn) throw new Error("No server is connected. Ask the user to connect one in Settings → Server.");
    const dirPath = String(args.path ?? ".").trim() || ".";
    return listRemoteFiles(conn, dirPath);
  },
  async server_read_file(args, prisma, ctx) {
    if (!prisma || !ctx?.userId) throw new Error("Not available in this context.");
    const filePath = String(args.path ?? "").trim();
    if (!filePath) throw new Error("Missing path");
    const conn = await loadServerConnection(prisma, ctx.userId);
    if (!conn) throw new Error("No server is connected. Ask the user to connect one in Settings → Server.");
    return readRemoteFile(conn, filePath);
  },
  async server_write_file(args, prisma, ctx) {
    if (!prisma || !ctx?.userId) throw new Error("Not available in this context.");
    const filePath = String(args.path ?? "").trim();
    const content = String(args.content ?? "");
    if (!filePath) throw new Error("Missing path");
    const conn = await loadServerConnection(prisma, ctx.userId);
    if (!conn) throw new Error("No server is connected. Ask the user to connect one in Settings → Server.");
    return writeRemoteFile(conn, filePath, content);
  },
  async browse_web(args, prisma) {
    const url = String(args.url ?? "").trim();
    const query = String(args.query ?? "").trim();
    if (!url && !query) throw new Error("Missing url or query");

    if (query) {
      if (!prisma || !(await webSearchEnabled(prisma))) {
        throw new Error(
          "Web search is disabled. Ask an admin to enable it in Admin > Settings > Web search."
        );
      }
      const results = await performWebSearch(query, 5, prisma);
      if (results.length === 0) return `No results found for "${query}".`;
      return results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`)
        .join("\n\n");
    }

    if (!prisma || !(await internetAccessEnabled(prisma))) {
      throw new Error(
        "Internet access is disabled. Ask an admin to enable it in Admin > Settings > Web search > \"Enable full internet access\"."
      );
    }
    await assertUrlIsSafe(url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            Accept: "text/html, text/plain, application/json, */*",
            "Accept-Language": "en-US,en;q=0.9,nl;q=0.8",
            // Many sites reject or reset requests carrying Node's default
            // (missing) User-Agent, which surfaces to us as a generic
            // "fetch failed" with no useful detail — a normal browser UA
            // avoids that class of block.
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
          redirect: "follow",
          signal: controller.signal,
        });
      } catch (err) {
        // Node wraps the real DNS/TLS/connection error in a generic
        // "fetch failed" TypeError with the actual reason on `.cause` —
        // surface that instead of the useless top-level message.
        const cause = err instanceof Error && (err as any).cause ? (err as any).cause : err;
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Could not reach ${parsedHost(url)}: ${detail}`);
      }
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Request failed with status ${res.status}`);
      }
      // Strip tags for a rough plain-text view — good enough for the model
      // to read an article/page without burning context on markup.
      const plain = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return plain.length > MAX_OUTPUT_CHARS ? plain.slice(0, MAX_OUTPUT_CHARS) + "…(truncated)" : plain;
    } finally {
      clearTimeout(timeout);
    }
  },
  async run_python(args) {
    const code = String(args.code ?? "");
    if (!code.trim()) throw new Error("Missing code");
    if (code.length > 50_000) throw new Error("Code too long (max 50,000 characters)");
    const stdinData = args.stdin !== undefined ? String(args.stdin) : "";

    const result = await runPythonCode(code, stdinData);
    if (!result.ok && !result.stdout && !result.stderr) {
      throw new Error(result.error || "Python execution failed");
    }
    const parts: string[] = [];
    if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
    if (!result.ok && result.error) parts.push(`error: ${result.error}`);
    return parts.length ? parts.join("\n\n") : "(no output)";
  },
};

export async function runBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  prisma?: PrismaClient,
  ctx?: ToolExecutionContext
): Promise<string> {
  const handler = BUILTIN_HANDLERS[name];
  if (!handler) throw new Error(`Unknown built-in tool "${name}"`);
  return handler(args, prisma, ctx);
}

// Idempotent — safe to call every time the server boots. Existing rows are
// left alone except for name/description/config, so an admin's `enabled`
// toggle on a built-in tool survives restarts.
export async function seedBuiltinTools(prisma: PrismaClient) {
  for (const def of BUILTIN_TOOL_DEFS) {
    await prisma.tool.upsert({
      where: { name: def.name },
      create: {
        name: def.name,
        description: def.description,
        type: "BUILTIN",
        config: { parameters: def.parameters } as unknown as Prisma.InputJsonValue,
      },
      update: {
        description: def.description,
        config: { parameters: def.parameters } as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP tool execution — sandboxed against SSRF (private/loopback/link-local
// targets are blocked), time-limited, and output is size-capped so a runaway
// response can't blow up the model's context window.
// ---------------------------------------------------------------------------

const HTTP_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_CHARS = 4_000;

function parsedHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function isBlockedIp(ip: string): boolean {
  if (net.isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 127) return true; // loopback
    if (parts[0] === 10) return true; // private
    if (parts[0] === 169 && parts[1] === 254) return true; // link-local / cloud metadata
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // private
    if (parts[0] === 192 && parts[1] === 168) return true; // private
    if (parts[0] === 0) return true;
    return false;
  }
  // IPv6: block loopback (::1), link-local (fe80::/10), and unique-local (fc00::/7)
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

async function assertUrlIsSafe(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }
  if (parsed.hostname === "localhost") throw new Error("Requests to localhost are blocked");

  const addresses = await dns.lookup(parsed.hostname, { all: true }).catch(() => []);
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new Error("Requests to private/internal network addresses are blocked");
    }
  }
}

function substituteTemplate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = args[key];
    return v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  });
}

async function runHttpTool(config: HttpToolConfig, args: Record<string, unknown>): Promise<string> {
  await assertUrlIsSafe(config.url);

  // Query-string substitution for GET/DELETE, body substitution otherwise.
  let url = config.url;
  for (const [key, value] of Object.entries(args)) {
    url = url.replace(`{{${key}}}`, encodeURIComponent(String(value)));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: config.method,
      headers: {
        Accept: "application/json, text/plain, */*",
        ...(config.bodyTemplate ? { "Content-Type": "application/json" } : {}),
        ...(config.headers ?? {}),
      },
      body:
        config.bodyTemplate && config.method !== "GET" && config.method !== "DELETE"
          ? substituteTemplate(config.bodyTemplate, args)
          : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP tool returned ${res.status}: ${text.slice(0, 300)}`);
    }
    return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) + "…(truncated)" : text;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Dispatch + prompt protocol
// ---------------------------------------------------------------------------

export async function executeTool(
  tool: PrismaTool,
  args: Record<string, unknown>,
  prisma?: PrismaClient,
  ctx?: ToolExecutionContext
): Promise<string> {
  if (tool.type === "BUILTIN") return runBuiltinTool(tool.name, args, prisma, ctx);
  if (tool.type === "MCP") {
    const { callMcpTool } = await import("./mcp.js");
    const config = tool.config as unknown as { serverUrl: string; headers?: Record<string, string>; mcpToolName: string };
    return callMcpTool(config.serverUrl, config.headers ?? {}, config.mcpToolName, args);
  }
  return runHttpTool(tool.config as unknown as HttpToolConfig, args);
}

function paramsOf(tool: PrismaTool): ToolParameter[] {
  const config = tool.config as { parameters?: ToolParameter[] } | null;
  return config?.parameters ?? [];
}

// Builds the system-message block describing available tools and the exact
// JSON marker the model must emit to call one. This is a prompt-level
// protocol (works with any local model, no native function-calling support
// required) rather than Ollama's `tools` API field.
export function buildToolsSystemBlock(tools: PrismaTool[]): string {
  if (tools.length === 0) return "";
  const list = tools
    .map((t) => {
      const params = paramsOf(t);
      const paramDesc = params.length
        ? params.map((p) => `${p.name} (${p.type}${p.required ? ", required" : ""})${p.description ? `: ${p.description}` : ""}`).join("; ")
        : "no arguments";
      return `- ${t.name}: ${t.description}\n  Arguments: ${paramDesc}`;
    })
    .join("\n");

  return [
    "You have access to the following tools. Use one only when it genuinely helps answer the user, never speculatively.",
    list,
    "To call a tool, respond with ONLY this JSON object and nothing else — no other text before or after it:",
    '{"tool_call": {"name": "<tool name>", "arguments": {"<param>": "<value>"}}}',
    'Always use exactly this JSON shape. Never use an XML-style call instead, such as "<tool_call>tool_name<arg_key>param</arg_key><arg_value>value</arg_value></tool_call>" — that format is not understood here and the tool will not run.',
    "Do not wrap it in a code block. After you receive the tool's result, use it to write a normal answer for the user — do not emit another tool_call unless you genuinely need a second tool.",
    "Never type the literal text \"[Generated image]\" or any similar placeholder yourself — that text only ever appears in past messages as a stand-in for an image you cannot see. If the user asks for an image (including a new/different/another one), you must call the generate_image tool; do not respond with prose or a placeholder pretending an image was made.",
    "Never invent, guess, or fabricate a download link yourself. This means never writing your own \"https://example.com/...\" or any other made-up URL, and it also means never writing a raw HTML <a> tag, an <iframe>, or a \"data:\" URI (e.g. \"data:text/html,...\" or \"data:application/octet-stream;base64,...\") to simulate a file or a download — those are not real files, they are just text you typed, and the user cannot download anything from them. Never claim you have no way to host a file or generate a permanent link, either. If the user wants a file to download — including when they ask you to turn code you already wrote (in this message or an earlier one) into a downloadable file — you MUST call the create_file tool with that exact content using the {\"tool_call\": ...} JSON format above; it returns a real, working download link (a normal markdown link, nothing else). Do this instead of writing a fake link, a placeholder, raw HTML/data-URI text, or telling the user to copy-paste the code themselves.",
  ].join("\n\n");
}

// ---- Deterministic image-request detection ----
// Small local models are inconsistent about recognizing an image request
// unless it's phrased almost exactly like the tool description ("generate
// an image of..."). A casual "kun je een foto maken van een hond" or "teken
// een huis" often doesn't trigger the tool_call JSON at all, even though
// the tool description explicitly covers "create, draw, generate, or make
// a picture/image/photo". Rather than rely purely on the model's own
// judgement, routes/chats.ts checks the user's own message against this
// pattern first — if it clearly asks for an image, the generate_image tool
// is called directly, skipping the "ask the model to decide" round-trip
// entirely, so it triggers regardless of phrasing or language.
// Covers Dutch and English verbs (maak/genereer/teken/laat zien/visualiseer,
// generate/create/draw/make/show/paint/design/render) combined with the
// common nouns for a generated image (foto/afbeelding/plaatje/tekening/
// illustratie/logo/avatar, photo/picture/image/illustration/drawing/logo/
// avatar/artwork/wallpaper/icon).
const IMAGE_VERB = "(?:maak|genereer|teken|laat\\s+zien|visualiseer|generate|create|draw|make|paint|design|render|show)";
const IMAGE_NOUN =
  "(?:foto|afbeelding|plaatje|tekening|illustratie|logo|avatar|icoon|achtergrond|" +
  "photo|picture|image|illustration|drawing|painting|logo|avatar|artwork|wallpaper|icon)";
const IMAGE_REQUEST_PATTERN = new RegExp(`${IMAGE_VERB}[a-zA-Zà-ÿ\\s]{0,20}${IMAGE_NOUN}`, "i");

export function looksLikeImageRequest(text: string): boolean {
  return IMAGE_REQUEST_PATTERN.test(text);
}

// Quote/escape-aware balanced-brace scan: finds the index of the "}" that
// closes the "{" at `start`, treating braces that appear inside string
// literals as inert (so a prompt value like "a room with {curtains}" can't
// throw off the depth count). Returns -1 if unbalanced.
function findBalancedEnd(candidate: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Best-effort repair for the most common way local models break their own
// JSON: emitting an unescaped `"` inside a string value, e.g.
//   {"tool_call": {"name": "generate_image", "arguments": {"prompt": "a robot with "glowing" eyes"}}}
// JSON.parse has no way to know where that string was "supposed" to end, so
// it throws immediately at the first stray quote. We re-scan the block
// ourselves: for every string literal, a `"` only counts as the *real*
// closing quote if — after skipping whitespace — the next character is a
// structural one (`,`, `}`, `]`, or `:`). Any other `"` we find along the
// way is almost certainly a literal quote the model meant to put in the
// text, so we escape it instead of treating it as the end of the string.
function repairJson(block: string): string {
  let out = "";
  let i = 0;
  const n = block.length;
  while (i < n) {
    const ch = block[i];
    if (ch !== '"') {
      out += ch;
      i++;
      continue;
    }
    // Entered a string literal — consume until its "real" end.
    let j = i + 1;
    let content = "";
    while (j < n) {
      const cj = block[j];
      if (cj === "\\" && j + 1 < n) {
        content += cj + block[j + 1];
        j += 2;
        continue;
      }
      if (cj === '"') {
        let k = j + 1;
        while (k < n && /\s/.test(block[k])) k++;
        const next = block[k];
        if (k >= n || next === "," || next === "}" || next === "]" || next === ":") {
          break; // genuine closing quote
        }
        // Stray unescaped quote inside the value — escape it and continue.
        content += '\\"';
        j++;
        continue;
      }
      content += cj;
      j++;
    }
    out += '"' + content + '"';
    i = j + 1;
  }
  return out;
}

// Tries to parse a model reply as a single tool call. Tolerates the model
// wrapping the JSON in a code fence or adding minor surrounding whitespace,
// but returns null (meaning: treat as a normal answer) for anything else.
export function parseToolCall(reply: string): ToolCall | null {
  const trimmed = reply.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;

  // Reasoning models (e.g. Qwen3 in "think" mode) often prepend a line or
  // two of prose before the tool_call JSON — "Ik moet een afbeelding
  // genereren.\n\n{"tool_call": ...}" — instead of emitting pure JSON as
  // their very first character. Rather than bailing out when the string
  // doesn't start with "{", scan for every "{" in the string and try each
  // one as a possible start of a balanced JSON block.
  const startIndices: number[] = [];
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] === "{") startIndices.push(i);
  }
  if (startIndices.length === 0) return null;

  for (const start of startIndices) {
    // From this "{", find the matching balanced "}" (tolerating stray
    // trailing characters after it, e.g. an extra closing brace the model
    // tacked on). Quote-aware so braces inside string values don't throw
    // off the depth count.
    const end = findBalancedEnd(candidate, start);
    if (end === -1) continue; // unbalanced from this start — try the next "{"

    const block = candidate.slice(start, end + 1);
    // Quick pre-check avoids paying JSON.parse cost on obviously-unrelated
    // braces (e.g. a stray "{" earlier in the model's prose).
    if (!/"tool_call"/.test(block)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      // Most likely cause: an unescaped quote inside a string value (very
      // common with natural-language image prompts, e.g. describing
      // "glowing" eyes). Try to repair it before giving up on this block.
      try {
        parsed = JSON.parse(repairJson(block));
      } catch {
        continue; // still not valid JSON from this start — try other "{" positions.
      }
    }

    if (parsed && typeof parsed === "object" && (parsed as any).tool_call) {
      const { name, arguments: args } = (parsed as any).tool_call;
      if (typeof name === "string") {
        return { name, arguments: args && typeof args === "object" ? args : {} };
      }
    }
  }
  return null;
}
