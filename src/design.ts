import { API, SETTINGS_PATH, anyLogin, loadSettings, settingsPathIn } from './agent.ts';
import type { Output, Sys } from './types.ts';
import { slicesNamed } from './work.ts';
import { FIGMA_FILE_KEY, PERSONAL_REPO, isOn, isPersonal, notAdoptedLine, offLine, renamedLines } from './features.ts';

const FIGMA = 'https://api.figma.com/v1';
/** A Figma link to one node: the file's key and the node's id. */
const FRAME_LINK = /https:\/\/(?:www\.)?figma\.com\/(?:design|file)\/([A-Za-z0-9]+)\/[^\s)?]*\?[^\s)]*?node-id=(\d+)[-:](\d+)/;
/** An image covering at least this share of a frame makes it a capture, not a design. */
const CAPTURED_SHARE = 0.5;
/** How long one Figma call may take, and all of a check's Figma calls together: well inside a job's limit. */
const FIGMA_CALL_MS = 30_000;
const FIGMA_BUDGET_MS = 120_000;
const FIGMA_HINT = "check Figma's status (status.figma.com), that the FIGMA_TOKEN secret is valid, and how large the linked file is";

/**
 * The client's design library, as the FIGMA_LIBRARY Actions secret names it,
 * with lines to warn with. Older releases read it from the committed
 * settings' `figma.library`, which is still read, with a warning, when the
 * secret is not set: a committed key is public in a public repository.
 */
export function designLibrary(sys: Sys, root: string): { library?: string; warnings: string[] } {
  const secret = sys.env.FIGMA_LIBRARY?.trim();
  if (secret) {
    if (!FIGMA_FILE_KEY.test(secret)) throw new Error('the FIGMA_LIBRARY secret must be the file key of the design library');
    return { library: secret, warnings: [] };
  }
  const raw = JSON.parse(sys.read(`${root}/${settingsPathIn(sys, root)}`)) as { figma?: { library?: unknown } | null };
  if (raw.figma === undefined) return { warnings: [] };
  const library = raw.figma?.library;
  if (typeof library !== 'string' || !FIGMA_FILE_KEY.test(library)) {
    throw new Error(`${SETTINGS_PATH}: "figma.library" must be the file key of the design library`);
  }
  return { library, warnings: [`${SETTINGS_PATH} names the Figma library; move it to the FIGMA_LIBRARY Actions secret and take the top-level "figma" object out of the settings (the figma feature stays)`] };
}

interface FigmaNode {
  id: string;
  type: string;
  componentId?: string;
  fills?: { type: string; visible?: boolean }[];
  absoluteBoundingBox?: { width: number; height: number } | null;
  children?: FigmaNode[];
}

function walk(node: FigmaNode, visit: (node: FigmaNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

const area = (node: FigmaNode): number => (node.absoluteBoundingBox ? node.absoluteBoundingBox.width * node.absoluteBoundingBox.height : 0);

const seconds = (ms: number): string => `${Math.ceil(ms / 1000)}s`;

/** When a check's Figma calls must be done by, in epoch milliseconds. */
const figmaDeadline = (sys: Sys): number => sys.now().getTime() + FIGMA_BUDGET_MS;

/** One Figma call, given up on after its own time limit or at the deadline, whichever comes first. */
async function figma(sys: Sys, token: string, path: string, deadline: number): Promise<unknown> {
  const left = deadline - sys.now().getTime();
  if (left <= 0) throw new Error(`Figma ${path} not asked: the ${seconds(FIGMA_BUDGET_MS)} for all of the design check's Figma calls ran out; ${FIGMA_HINT}`);
  const timeoutMs = Math.min(FIGMA_CALL_MS, left);
  let reply;
  try {
    reply = await sys.http(`${FIGMA}${path}`, { headers: { 'x-figma-token': token }, timeoutMs });
  } catch (error) {
    if ((error as Error).name !== 'TimeoutError') throw error;
    const limit = timeoutMs < FIGMA_CALL_MS ? `what was left of the ${seconds(FIGMA_BUDGET_MS)} for all of the design check's Figma calls` : 'the limit for one call';
    throw new Error(`Figma did not answer ${path} within ${seconds(timeoutMs)}, ${limit}; ${FIGMA_HINT}`);
  }
  if (reply.status !== 200) throw new Error(`Figma refused ${path} (HTTP ${reply.status})`);
  return reply.json;
}

/**
 * What is wrong with the frame a State links, or undefined when it is a frame
 * built from the design library: it exists, it is a frame, it holds at least
 * one instance of a library component, and no image covers most of it.
 */
export async function frameProblem(sys: Sys, token: string, link: string, libraryKeys: Set<string>, deadline = figmaDeadline(sys)): Promise<string | undefined> {
  const match = FRAME_LINK.exec(link);
  if (!match) return 'links no Figma frame (a figma.com/design link with node-id)';
  const [, file, a, b] = match as unknown as [string, string, string, string];
  const id = `${a}:${b}`;
  const reply = (await figma(sys, token, `/files/${file}/nodes?ids=${encodeURIComponent(id)}`, deadline)) as {
    nodes?: Record<string, { document: FigmaNode; components?: Record<string, { key?: string }> } | null>;
  };
  const found = reply.nodes?.[id];
  if (!found) return `links frame ${id}, which does not exist in Figma file ${file}`;
  const frame = found.document;
  if (frame.type !== 'FRAME') return `links a ${frame.type}, not a frame`;
  let instances = 0;
  let captured = false;
  walk(frame, (node) => {
    const key = node.componentId ? found.components?.[node.componentId]?.key : undefined;
    if (node.type === 'INSTANCE' && key && libraryKeys.has(key)) instances++;
    const image = node.fills?.some((fill) => fill.type === 'IMAGE' && fill.visible !== false);
    if (image && area(frame) > 0 && area(node) >= CAPTURED_SHARE * area(frame)) captured = true;
  });
  if (captured) return 'links a captured image, not a frame built from the library';
  if (instances === 0) return 'links a frame that uses no component from the design library';
  return undefined;
}

interface State {
  number: number;
  issueType: { name: string } | null;
  stateReason: string | null;
  body: string;
}

/** A work item's kind, from its `Kind:` line, bold or plain: `**Kind:** Process.` is Process. */
const KIND_LINE = /^\s*(?:\*\*)?Kind:(?:\*\*)?\s*([A-Za-z]+)/mi;

/** The kind a work item's body names, or undefined when it has no `Kind:` line. */
export function workItemKind(body: string | null | undefined): string | undefined {
  return KIND_LINE.exec(body ?? '')?.[1];
}

/** Figma frames are for this kind of work item only; a work item that names no kind is checked too. */
const DESIGNED_KIND = 'Experience';

/**
 * The design check on an agent pull request, run by the shared workflow when
 * the figma feature is on and the FIGMA_LIBRARY secret names a Figma design
 * library: each State of the slice it builds, other than one closed as not
 * planned, links a frame built from that library. A slice whose parent Work
 * item names a kind other than Experience passes without a Figma call. Off without
 * FIGMA_TOKEN, and says so.
 */
export async function prDesign(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: slug, GH_TOKEN: token, FIGMA_TOKEN: figmaToken } = sys.env;
  if (!eventPath || !slug || !token) {
    throw new Error('pr-design runs in GitHub Actions: GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  const notAdopted = notAdoptedLine(sys, sys.cwd, 'pr-design');
  if (notAdopted) {
    io.out(notAdopted);
    return 0;
  }
  loadSettings(sys, sys.cwd);
  for (const line of renamedLines(JSON.parse(sys.read(`${sys.cwd}/${settingsPathIn(sys, sys.cwd)}`)))) io.out(`::warning::${line}`);
  if (!isOn(sys, sys.cwd, 'figma')) {
    io.out(offLine('pr-design', 'figma'));
    return 0;
  }
  if (await isPersonal(sys, slug, token)) {
    io.out(offLine('pr-design', 'figma', PERSONAL_REPO));
    return 0;
  }
  const { library, warnings } = designLibrary(sys, sys.cwd);
  for (const line of warnings) io.out(`::warning::${line}`);
  if (!library) {
    io.out('pr-design: no FIGMA_LIBRARY secret names the Figma design library; the design check is off until the owner adds one');
    return 0;
  }
  if (!figmaToken) {
    io.out('pr-design: no FIGMA_TOKEN secret; the design check is off until the owner adds one');
    return 0;
  }
  const event = JSON.parse(sys.read(eventPath)) as { pull_request?: { number: number; body: string | null; user: { login: string } } };
  const pull = event.pull_request;
  const { agents } = loadSettings(sys, sys.cwd);
  const [slice] = slicesNamed(pull?.body ?? '');
  if (!pull || !anyLogin(agents, pull.user.login) || slice === undefined) {
    io.out('pr-design: not an agent pull request naming a slice; nothing to check');
    return 0;
  }

  // Every state of the slice, 100 a page: GitHub's most.
  const [owner, name] = slug.split('/');
  const states: State[] = [];
  for (let after: string | null = null; ; ) {
    const { status, json } = await sys.http(`${API}/graphql`, {
      method: 'POST',
      token,
      body: {
        query: 'query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { issue(number: $number) { parent { number body issueType { name } } subIssues(first: 100, after: $after) { nodes { number issueType { name } stateReason body } pageInfo { hasNextPage endCursor } } } } }',
        variables: { owner, name, number: slice, after },
      },
    });
    const issue = (json as { data?: { repository?: { issue?: { parent?: { number: number; body: string | null; issueType?: { name: string } | null } | null; subIssues: { nodes: State[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } } | null } } } | null)?.data?.repository?.issue;
    const page = issue?.subIssues;
    if (status !== 200 || !page) throw new Error(`cannot read the states of #${slice} (HTTP ${status})`);
    // The work item's kind, read with the first page: only Experience work is designed in Figma.
    const parent = issue.parent;
    if (after === null && parent?.issueType?.name === 'Work item') {
      const kind = workItemKind(parent.body);
      if (kind && kind.toLowerCase() !== DESIGNED_KIND.toLowerCase()) {
        io.out(`✓ pr-design: #${slice} builds ${kind} work item #${parent.number}; frames are for ${DESIGNED_KIND} work`);
        return 0;
      }
    }
    states.push(...page.nodes);
    if (!page.pageInfo?.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }

  const deadline = figmaDeadline(sys);
  const published = (await figma(sys, figmaToken, `/files/${library}/components`, deadline)) as { meta?: { components?: { key?: string }[] } };
  const keys = new Set((published.meta?.components ?? []).flatMap((component) => (component.key ? [component.key] : [])));

  const problems: string[] = [];
  let checked = 0;
  for (const state of states) {
    if (state.issueType?.name !== 'State' || state.stateReason === 'NOT_PLANNED') continue;
    checked++;
    const problem = await frameProblem(sys, figmaToken, state.body, keys, deadline);
    if (problem) problems.push(`state #${state.number} ${problem}`);
  }
  for (const problem of problems) io.err(`✗ ${problem}`);
  if (problems.length > 0) {
    io.err('pr-design: refused by the design check');
    return 1;
  }
  io.out(`✓ pr-design: ${checked} state${checked === 1 ? '' : 's'} of #${slice}, each a frame built from the design library`);
  return 0;
}
