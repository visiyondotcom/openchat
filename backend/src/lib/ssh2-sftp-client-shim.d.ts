// Minimal ambient types for ssh2-sftp-client — the package ships no types
// of its own and there's no @types/ssh2-sftp-client to install. Only the
// shape actually used in server-connection.ts is declared; everything else
// on the real client is untyped (any) if ever needed.
//
// Deliberately NOT named server-connection.d.ts: a .d.ts sharing a source
// file's basename in the same folder is treated by tsc as that file's own
// declaration-output companion rather than a general ambient shim, so the
// `declare module` below would silently never apply.
declare module "ssh2-sftp-client" {
  interface ConnectOptions {
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string | Buffer;
    passphrase?: string;
    readyTimeout?: number;
  }

  interface FileInfo {
    type: "d" | "l" | "-";
    name: string;
    size: number;
    modifyTime: number;
    accessTime: number;
    rights: { user: string; group: string; other: string };
    owner: number;
    group: number;
  }

  interface Stats {
    mode: number;
    size: number;
    accessTime: number;
    modifyTime: number;
    isDirectory: boolean;
    isFile: boolean;
    isSymbolicLink: boolean;
  }

  class SftpClient {
    connect(options: ConnectOptions): Promise<void>;
    end(): Promise<void>;
    list(remotePath: string): Promise<FileInfo[]>;
    stat(remotePath: string): Promise<Stats>;
    get(remotePath: string): Promise<Buffer>;
    put(data: Buffer, remotePath: string): Promise<string>;
    mkdir(remotePath: string, recursive?: boolean): Promise<string>;
  }

  export = SftpClient;
}
