import { API, NO_TOKEN } from './agent.ts';
import { PRODUCT, SETUP_FIRST } from './onboard.ts';
import type { Output, Sys } from './types.ts';
import { CLOUD_SETUP_PATH, WORKFLOW_PATH } from './onboard-pull.ts';
import { GITHUB_WEB } from './host.ts';

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
/** The sha256 of CLOUD_NODE's Linux builds, from nodejs.org's SHASUMS256.txt for that release. */
export const CLOUD_NODE_SHA256 = {
  x64: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
  arm64: '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2',
};

/** What the Setup snippet says when the install fails: the commands after it in the Setup script still run. */
export const INSTALL_FAILED = 'process-rules: the install failed, so sessions start without process-rules; the rest of the Setup script still runs.';

/** Where the install puts Node and the CLI in a cloud session. */
export const CLOUD_DIR = '/opt/process-rules';
/**
 * The file the install leaves in CLOUD_DIR when the Setup snippet ran it,
 * so a session can tell a Setup script that runs the repo's file from one
 * that installs a release of its own.
 */
export const FROM_SETUP = `${CLOUD_DIR}/from-setup`;

/** The release `cloudRepoScript` installs, from its first comment; undefined when `text` is not one. */
export function cloudScriptVersion(text: string): string | undefined {
  return /^# process-rules (\d+\.\d+\.\d+) for Claude cloud sessions/m.exec(text)?.[1];
}

/** The release archive of `version`, as GitHub serves it. */
export function releaseTarball(version: string): string {
  return `${GITHUB_WEB}/${PRODUCT}/releases/download/v${version}/athya-hq-process-rules-${version}.tgz`;
}

/**
 * The sha256 GitHub records for `version`'s release archive, or why it
 * cannot be had: onboard pins it in the repo's cloud setup file, so the
 * cloud install checks the CLI it unpacks as it checks Node.
 */
export async function releaseSha256(sys: Sys, version: string, token: string): Promise<{ sha256: string } | { problem: string }> {
  const name = `athya-hq-process-rules-${version}.tgz`;
  try {
    const { status, json } = await sys.http(`${API}/repos/${PRODUCT}/releases/tags/v${version}`, { token });
    if (status !== 200) return { problem: `GitHub answered HTTP ${status} for the v${version} release` };
    const assets = (json as { assets?: { name?: unknown; digest?: unknown }[] } | null)?.assets ?? [];
    const digest = assets.find((asset) => asset.name === name)?.digest;
    const sha256 = typeof digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1] : undefined;
    return sha256 ? { sha256 } : { problem: `the v${version} release names no sha256 for ${name}` };
  } catch (error) {
    return { problem: `GitHub could not be asked for the v${version} release (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * The repo's cloud setup file, CLOUD_SETUP_PATH, which onboard writes at
 * the version the workflow pins and rewrites on every run: Node and that
 * release of the CLI, unpacked under CLOUD_DIR as root, and a
 * `process-rules` on PATH that runs one with the other, leaving the image's
 * own Node alone. Each download is checked against the sha256 pinned here
 * before it is unpacked; a Node already unpacked at this version is kept,
 * so a session that runs it again fetches the CLI alone. The Setup snippet
 * runs it before a session starts, and session-start runs it when the
 * environment's snapshot holds another release.
 */
export function cloudRepoScript(version: string, sha256: string): string {
  return [
    '#!/bin/bash',
    `# process-rules ${version} for Claude cloud sessions: Node ${CLOUD_NODE} and the CLI, as process-rules on PATH.`,
    `# process-rules onboard writes this file at the version ${WORKFLOW_PATH} pins, and writes it again on every run.`,
    "# The cloud environment's Setup script runs it, from what process-rules cloud-setup prints, and so does",
    '# session-start when the environment holds another release. Change it by running onboard, not by hand.',
    'set -euo pipefail',
    `dir=${CLOUD_DIR}`,
    `node=${CLOUD_NODE}`,
    `case "$(uname -m)" in x86_64) arch=x64 sum=${CLOUD_NODE_SHA256.x64} ;; aarch64 | arm64) arch=arm64 sum=${CLOUD_NODE_SHA256.arm64} ;; *) echo "process-rules: no Node for $(uname -m)" >&2; exit 1 ;; esac`,
    'bin="$dir/node-v$node-linux-$arch/bin/node"',
    'mkdir -p "$dir"',
    'if [ "$("$bin" --version 2>/dev/null)" != "v$node" ]; then',
    '  curl -fsSL --connect-timeout 10 --max-time 120 -o "$dir/node.tar.xz" "https://nodejs.org/dist/v$node/node-v$node-linux-$arch.tar.xz"',
    '  echo "$sum  $dir/node.tar.xz" | sha256sum -c --quiet -',
    '  tar -xJ -f "$dir/node.tar.xz" -C "$dir"',
    '  rm "$dir/node.tar.xz"',
    'fi',
    `curl -fsSL --connect-timeout 10 --max-time 120 -o "$dir/process-rules.tgz" ${releaseTarball(version)}`,
    `echo "${sha256}  $dir/process-rules.tgz" | sha256sum -c --quiet -`,
    // A folder per release: a session that installs another leaves the one it runs in place.
    `cli="$dir/cli-${version}"`,
    'rm -rf "$cli"',
    'mkdir -p "$cli"',
    'tar -xz -f "$dir/process-rules.tgz" -C "$cli"',
    'rm "$dir/process-rules.tgz"',
    'printf \'#!/bin/sh\\nexec %s %s "$@"\\n\' "$bin" "$cli/package/dist/cli.js" > /usr/local/bin/process-rules',
    'chmod 755 /usr/local/bin/process-rules',
    `if [ -n "\${PROCESS_RULES_SETUP:-}" ]; then : > ${FROM_SETUP}; fi`,
    'process-rules version </dev/null',
    '',
  ].join('\n');
}

/**
 * The Setup snippet for a Claude cloud environment, pasted once: it names
 * no version, so a new release needs no new paste. It runs the clone's
 * CLOUD_SETUP_PATH, which onboard keeps at the workflow's pin. The Setup
 * script runs as root after the clone, from the folder that holds it (the
 * VM's home, the clone one folder down), so it looks there and in each
 * home. The environment's Setup field holds one script, so it runs in a
 * shell of its own: its failures stay there, and the repo's own setup can
 * follow it in the same field.
 */
export function cloudSetupSnippet(): string {
  const file = CLOUD_SETUP_PATH;
  return [
    '#!/bin/bash',
    `# process-rules for Claude cloud sessions: runs the clone's ${file}, which process-rules onboard keeps at the version the repo pins. Paste once; put the repo's own setup after it.`,
    `bash <<'PROCESS_RULES' || echo "${INSTALL_FAILED}" >&2`,
    `for script in "$PWD/${file}" "$PWD"/*/${file} /home/*/*/${file} /root/*/${file}; do`,
    '  if [ -f "$script" ]; then PROCESS_RULES_SETUP=1 exec bash "$script" </dev/null; fi',
    'done',
    `echo "process-rules: no ${file} in the clone under $PWD; run process-rules onboard, which writes it" >&2`,
    'exit 1',
    'PROCESS_RULES',
    '',
  ].join('\n');
}

/** Prints the Setup snippet for a Claude cloud environment, with what else agent sessions there need. */
export function cloudSetup(io: Output): number {
  io.err(
    `process-rules: paste this into the Claude cloud environment's Setup script, once; it runs ${CLOUD_SETUP_PATH}, which process-rules onboard writes, so a new release needs no new paste. Connect claude.ai's GitHub as the agent account the repo's settings name. ${SETUP_FIRST}`,
  );
  io.out(cloudSetupSnippet().trimEnd());
  return 0;
}
