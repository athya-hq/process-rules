import { API, NO_TOKEN } from './agent.ts';
import { PRODUCT } from './onboard.ts';
import type { Output, Sys } from './types.ts';
import { packageVersion } from './version.ts';

/**
 * What a cloud session's GH_TOKEN reads when its environment sets none; the
 * proxy swaps it for the connected account's token (Claude Code's cloud
 * environments docs, "GitHub proxy").
 */
export const PROXY_TOKEN = 'proxy-injected';

/** The token a cloud session reaches GitHub with: one its environment set, else the proxy's placeholder, never the lock's. */
export function cloudToken(sys: Sys): string {
  const token = sys.env.GH_TOKEN;
  return token && token !== NO_TOKEN ? token : PROXY_TOKEN;
}

/** The account a cloud session reaches GitHub as, through its proxy, or why it cannot be told. */
export async function cloudLogin(sys: Sys): Promise<{ login: string } | { problem: string }> {
  try {
    const { status, json } = await sys.http(`${API}/user`, { token: cloudToken(sys) });
    const login = (json as { login?: unknown } | null)?.login;
    return status === 200 && typeof login === 'string' ? { login } : { problem: `GitHub answered HTTP ${status} when asked who this session is` };
  } catch (error) {
    return { problem: `GitHub could not be asked who this session is (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** The Node a Claude cloud session runs the CLI with: its image's own is older than the CLI needs. */
export const CLOUD_NODE = '24.21.0';

/**
 * The setup script for a Claude cloud environment, which runs as root
 * before its sessions start: Node and this release of the CLI, unpacked
 * under /opt/process-rules, and a `process-rules` on PATH that runs one
 * with the other, leaving the image's own Node alone.
 */
export function cloudSetupScript(version: string): string {
  const tarball = `https://github.com/${PRODUCT}/releases/download/v${version}/athya-hq-process-rules-${version}.tgz`;
  return [
    '#!/bin/bash',
    `# process-rules ${version} for Claude cloud sessions: Node ${CLOUD_NODE} and the CLI, as process-rules on PATH.`,
    'set -euo pipefail',
    'dir=/opt/process-rules',
    `node=${CLOUD_NODE}`,
    'case "$(uname -m)" in x86_64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) echo "process-rules: no Node for $(uname -m)" >&2; exit 1 ;; esac',
    'mkdir -p "$dir"',
    'curl -fsSL "https://nodejs.org/dist/v$node/node-v$node-linux-$arch.tar.xz" | tar -xJ -C "$dir"',
    `curl -fsSL ${tarball} | tar -xz -C "$dir"`,
    'printf \'#!/bin/sh\\nexec %s %s "$@"\\n\' "$dir/node-v$node-linux-$arch/bin/node" "$dir/package/dist/cli.js" > /usr/local/bin/process-rules',
    'chmod 755 /usr/local/bin/process-rules',
    'process-rules version',
    '',
  ].join('\n');
}

/** Prints the setup script for a Claude cloud environment, with what else agent sessions there need. */
export function cloudSetup(io: Output): number {
  io.err('process-rules: put this in the Claude cloud environment\'s Setup script; connect claude.ai\'s GitHub as the agent account the repo\'s settings name.');
  io.out(cloudSetupScript(packageVersion()).trimEnd());
  return 0;
}
