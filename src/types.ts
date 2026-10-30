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
  exec(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; env?: Record<string, string | undefined>; input?: string },
  ): ExecResult;
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, data: string, mode?: number): void;
  mkdir(path: string): void;
  http(
    url: string,
    options?: { method?: string; token?: string; body?: unknown },
  ): Promise<HttpResult>;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  open(url: string): void;
  now(): Date;
}
