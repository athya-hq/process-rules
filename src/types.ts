/** Where the CLI writes; tests pass their own. */
export interface Output {
  out(line: string): void;
  err(line: string): void;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HttpResult {
  status: number;
  json: unknown;
  /** Response headers, names lowercased. */
  headers?: Record<string, string>;
}

/** Everything a command touches outside its own memory; tests pass a fake. */
export interface Sys {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  cwd: string;
  /** The node running the CLI and the CLI's script, both by their real paths. */
  runtime: { node: string; cli: string };
  exec(
    command: string,
    args: readonly string[],
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      input?: string;
      timeoutMs?: number;
      /** The command talks to the person at the terminal; its output is not captured. */
      interactive?: boolean;
    },
  ): ExecResult;
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, data: string, mode?: number): void;
  append(path: string, data: string): void;
  mkdir(path: string): void;
  /** The names in a folder, or none when it does not exist. */
  list(path: string): string[];
  /** A new empty folder only this user can read, for the caller to remove. */
  tempDir(): string;
  /** Deletes a file or folder and all in it; nothing there is fine. */
  remove(path: string): void;
  http(
    url: string,
    options?: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<HttpResult>;
  /** Everything on standard input, as a git hook receives it. */
  readStdin(): string;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  open(url: string): void;
  now(): Date;
  sleep(ms: number): Promise<void>;
}
