import type { PrismaClient, Prisma } from "@prisma/client";

// Minimal MCP client — implements just enough of the Streamable HTTP
// transport (JSON-RPC 2.0 over POST) to discover a server's tools and
// call one. Not a full SDK: no stdio transport (doesn't make sense for a
// server-side connection like this), no resources/prompts, no
// bidirectional streaming — this stack only needs "list tools" and "call
// a tool", which covers what routes/tools.ts needs to expose MCP tools
// through the same executeTool() path as BUILTIN/HTTP tools.

type JsonRpcResponse<T> = { jsonrpc: "2.0"; id: number; result?: T; error?: { code: number; message: string } };

async function jsonRpcCall<T>(
  serverUrl: string,
  headers: Record<string, string>,
  method: string,
  params: unknown
): Promise<T> {
  const res = await fetch(serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`MCP server returned HTTP ${res.status}`);

  // Streamable HTTP transport allows either a plain JSON body or an SSE
  // stream carrying one JSON-RPC message; we only need the first message
  // either way, since these are single request/response calls.
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) throw new Error("MCP server sent an SSE response with no data line");
    const parsed = JSON.parse(dataLine.slice(5).trim()) as JsonRpcResponse<T>;
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed.result as T;
  }

  const parsed = (await res.json()) as JsonRpcResponse<T>;
  if (parsed.error) throw new Error(parsed.error.message);
  return parsed.result as T;
}

export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export async function listMcpTools(serverUrl: string, headers: Record<string, string> = {}): Promise<McpToolDescriptor[]> {
  const result = await jsonRpcCall<{ tools: McpToolDescriptor[] }>(serverUrl, headers, "tools/list", {});
  return result.tools ?? [];
}

export async function callMcpTool(
  serverUrl: string,
  headers: Record<string, string>,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await jsonRpcCall<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>(
    serverUrl,
    headers,
    "tools/call",
    { name: toolName, arguments: args }
  );
  const text = (result.content ?? [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
  if (result.isError) throw new Error(text || `MCP tool "${toolName}" returned an error`);
  return text || "(no output)";
}

// Syncs a connected server's advertised tools into Tool rows (type MCP),
// so they show up in the normal tool catalog and can be attached to
// chats like any other tool. Existing rows for tools no longer advertised
// are disabled rather than deleted, so any chat that had them attached
// doesn't lose the reference.
export async function syncMcpServer(prisma: PrismaClient, serverId: string): Promise<{ ok: boolean; error?: string; toolCount?: number }> {
  const server = await prisma.mcpServer.findUnique({ where: { id: serverId } });
  if (!server) return { ok: false, error: "Server not found" };

  try {
    const headers = (server.headers as Record<string, string>) ?? {};
    const tools = await listMcpTools(server.url, headers);

    for (const t of tools) {
      const toolName = `mcp:${server.name}:${t.name}`;
      await prisma.tool.upsert({
        where: { name: toolName },
        create: {
          name: toolName,
          description: t.description || `MCP tool "${t.name}" from server "${server.name}"`,
          type: "MCP",
          config: { serverUrl: server.url, headers, mcpToolName: t.name, inputSchema: t.inputSchema ?? {} } as unknown as Prisma.InputJsonValue,
          enabled: true,
        },
        update: {
          description: t.description || `MCP tool "${t.name}" from server "${server.name}"`,
          config: { serverUrl: server.url, headers, mcpToolName: t.name, inputSchema: t.inputSchema ?? {} } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    await prisma.mcpServer.update({ where: { id: serverId }, data: { lastSyncAt: new Date(), lastSyncError: null } });
    return { ok: true, toolCount: tools.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.mcpServer.update({ where: { id: serverId }, data: { lastSyncError: message } });
    return { ok: false, error: message };
  }
}
