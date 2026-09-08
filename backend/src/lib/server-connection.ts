// ssh2-sftp-client ships no types of its own and no @types package exists
// for it — see ssh2-sftp-client-shim.d.ts in this directory for the
// minimal ambient declaration that makes this import typecheck. (It can't
// be named server-connection.d.ts — a .d.ts sharing a source file's
// basename in the same folder is treated by tsc as that file's own
// declaration-output companion, not a general ambient shim, so the module
// augmentation silently never applies.)
import SftpClient from "ssh2-sftp-client";
import path from "node:path";
import type { PrismaClient, ServerConnection } from "@prisma/client";
import { encryptSecret, decryptSecret } from "./crypto.js";

// ---------------------------------------------------------------------------
// Lets the AI read/write files on a user's own server over SFTP (SSH).
// Read-only for the connection itself in the sense that we never execute
// commands — only file list/read/write, deliberately, per the requirement
// that this stay a file tool and not a remote shell.
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_READ_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_LIST_ENTRIES = 500;

export interface ServerConnectionInput {
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  baseDir?: string | null;
}

// Resolves a user-supplied relative path against the connection's baseDir
// (if set) and rejects any attempt to escape it via "..", so a compromised
// or careless tool call can't reach outside the sandbox the user configured.
function resolveRemotePath(conn: { baseDir?: string | null }, requested: string): string {
  const root = conn.baseDir && conn.baseDir.trim() ? conn.baseDir.trim() : "/";
  const cleanRequested = requested.trim() || ".";
  const resolved = path.posix.normalize(path.posix.join(root, cleanRequested));
  const normalizedRoot = path.posix.normalize(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/")) {
    throw new Error("Path is outside the allowed base directory");
  }
  return resolved;
}

async function withClient<T>(
  input: {
    host: string;
    port: number;
    username: string;
    authType: "password" | "privateKey";
    password?: string;
    privateKey?: string;
    passphrase?: string;
  },
  fn: (client: SftpClient) => Promise<T>
): Promise<T> {
  const client = new SftpClient();
  try {
    await client.connect({
      host: input.host,
      port: input.port,
      username: input.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      ...(input.authType === "password"
        ? { password: input.password }
        : { privateKey: input.privateKey, passphrase: input.passphrase || undefined }),
    });
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch {
      // already closed / never fully opened — nothing to clean up
    }
  }
}

export async function testServerConnection(input: ServerConnectionInput): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await withClient(input, async (client) => {
      // cwd() is a cheap round-trip that proves auth + the base dir (if any) exist
      const dir = input.baseDir && input.baseDir.trim() ? input.baseDir.trim() : "/";
      await client.list(dir);
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Connection failed" };
  }
}

// Loads a user's stored connection and decrypts the credential fields.
// Returns null if the user hasn't configured one.
export async function loadServerConnection(
  prisma: PrismaClient,
  userId: string
): Promise<(ServerConnectionInput & { row: ServerConnection }) | null> {
  const row = await prisma.serverConnection.findUnique({ where: { userId } });
  if (!row) return null;
  return {
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.authType as "password" | "privateKey",
    password: row.passwordEnc ? decryptSecret(row.passwordEnc) : undefined,
    privateKey: row.privateKeyEnc ? decryptSecret(row.privateKeyEnc) : undefined,
    passphrase: row.passphraseEnc ? decryptSecret(row.passphraseEnc) : undefined,
    baseDir: row.baseDir,
    row,
  };
}

export function encryptConnectionSecrets(input: ServerConnectionInput) {
  return {
    passwordEnc: input.authType === "password" && input.password ? encryptSecret(input.password) : null,
    privateKeyEnc: input.authType === "privateKey" && input.privateKey ? encryptSecret(input.privateKey) : null,
    passphraseEnc: input.authType === "privateKey" && input.passphrase ? encryptSecret(input.passphrase) : null,
  };
}

export async function listRemoteFiles(conn: ServerConnectionInput, dirPath: string): Promise<string> {
  const target = resolveRemotePath(conn, dirPath);
  return withClient(conn, async (client) => {
    const entries = await client.list(target);
    const truncated = entries.length > MAX_LIST_ENTRIES;
    const lines = entries.slice(0, MAX_LIST_ENTRIES).map((e: { type: string; size: number; name: string }) => {
      const kind = e.type === "d" ? "dir " : e.type === "l" ? "link" : "file";
      return `${kind}  ${e.size.toString().padStart(10)}  ${e.name}`;
    });
    return `${target}:\n${lines.join("\n")}${truncated ? `\n… (${entries.length - MAX_LIST_ENTRIES} more not shown)` : ""}`;
  });
}

export async function readRemoteFile(conn: ServerConnectionInput, filePath: string): Promise<string> {
  const target = resolveRemotePath(conn, filePath);
  return withClient(conn, async (client) => {
    const stat = await client.stat(target);
    if (stat.isDirectory) throw new Error("That path is a directory, not a file");
    if (stat.size > MAX_READ_BYTES) throw new Error(`File too large to read (max ${MAX_READ_BYTES / 1024 / 1024}MB)`);
    const buf = (await client.get(target)) as Buffer;
    return buf.toString("utf-8");
  });
}

export async function writeRemoteFile(conn: ServerConnectionInput, filePath: string, content: string | Buffer): Promise<string> {
  const target = resolveRemotePath(conn, filePath);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
  if (buffer.byteLength > MAX_WRITE_BYTES) throw new Error(`Content too large to write (max ${MAX_WRITE_BYTES / 1024 / 1024}MB)`);
  return withClient(conn, async (client) => {
    const dir = path.posix.dirname(target);
    try {
      await client.mkdir(dir, true);
    } catch {
      // already exists — fine
    }
    await client.put(buffer, target);
    return `Wrote ${buffer.byteLength} bytes to ${target}`;
  });
}

// Structured listing for the file-browser UI (the plain-text `listRemoteFiles`
// above is what the AI tool uses instead — a string is easier for a model to
// read, a JSON shape is easier for a React tree/list to render).
export interface RemoteFileEntry {
  name: string;
  type: "dir" | "file" | "link";
  size: number;
  modifyTime: number;
}

export async function listRemoteFilesStructured(
  conn: ServerConnectionInput,
  dirPath: string
): Promise<{ path: string; entries: RemoteFileEntry[] }> {
  const target = resolveRemotePath(conn, dirPath);
  const entries = await withClient(conn, (client) => client.list(target));
  return {
    path: target,
    entries: entries
      .map((e) => ({
        name: e.name,
        type: (e.type === "d" ? "dir" : e.type === "l" ? "link" : "file") as RemoteFileEntry["type"],
        size: e.size,
        modifyTime: e.modifyTime,
      }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1)),
  };
}
