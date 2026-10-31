import { API, SETTINGS_PATH, loadSettings, sameLogin } from './agent.ts';
import type { Output, Sys } from './types.ts';
import { slicesNamed } from './work.ts';
import { FIGMA_FILE_KEY, PERSONAL_REPO, isOn, isPersonal, notAdoptedLine, offLine, renamedLines } from './features.ts';

const FIGMA = 'https://api.figma.com/v1';
/** A Figma link to one node: the file's key and the node's id. */
const FRAME_LINK = /https:\/\/(?:www\.)?figma\.com\/(?:design|file)\/([A-Za-z0-9]+)\/[^\s)?]*\?[^\s)]*?node-id=(\d+)[-:](\d+)/;
/** An image covering at least this share of a frame makes it a capture, not a design. */
const CAPTURED_SHARE = 0.5;

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
  const raw = JSON.parse(sys.read(`${root}/${SETTINGS_PATH}`)) as { figma?: { library?: unknown } | null };
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

async function figma(sys: Sys, token: string, path: string): Promise<unknown> {
  const { status, json } = await sys.http(`${FIGMA}${path}`, { headers: { 'x-figma-token': token } });
  if (status !== 200) throw new Error(`Figma refused ${path} (HTTP ${status})`);
  return json;
}

/**
 * What is wrong with the frame a State links, or undefined when it is a frame
 * built from the design library: it exists, it is a frame, it holds at least
 * one instance of a library component, and no image covers most of it.
 */
export async function frameProblem(sys: Sys, token: string, link: string, libraryKeys: Set<string>): Promise<string | undefined> {
  const match = FRAME_LINK.exec(link);
  if (!match) return 'links no Figma frame (a figma.com/design link with node-id)';
  const [, file, a, b] = match as unknown as [string, string, string, string];
  const id = `${a}:${b}`;
  const reply = (await figma(sys, token, `/files/${file}/nodes?ids=${encodeURIComponent(id)}`)) as {
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

/**
 * The design check on an agent pull request, run by the shared workflow when
 * the figma feature is on and the FIGMA_LIBRARY secret names a Figma design
 * library: each State of the slice it builds, other than one closed as not
 * planned, links a frame built from that library. Off without FIGMA_TOKEN,
 * and says so.
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
  for (const line of renamedLines(JSON.parse(sys.read(`${sys.cwd}/${SETTINGS_PATH}`)))) io.out(`::warning::${line}`);
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
  const { agent } = loadSettings(sys, sys.cwd);
  const [slice] = slicesNamed(pull?.body ?? '');
  if (!pull || !sameLogin(pull.user.login, agent) || slice === undefined) {
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
        query: 'query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { issue(number: $number) { subIssues(first: 100, after: $after) { nodes { number issueType { name } stateReason body } pageInfo { hasNextPage endCursor } } } } }',
        variables: { owner, name, number: slice, after },
      },
    });
    const page = (json as { data?: { repository?: { issue?: { subIssues: { nodes: State[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } } | null } } } | null)?.data?.repository?.issue?.subIssues;
    if (status !== 200 || !page) throw new Error(`cannot read the states of #${slice} (HTTP ${status})`);
    states.push(...page.nodes);
    if (!page.pageInfo?.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }

  const published = (await figma(sys, figmaToken, `/files/${library}/components`)) as { meta?: { components?: { key?: string }[] } };
  const keys = new Set((published.meta?.components ?? []).flatMap((component) => (component.key ? [component.key] : [])));

  const problems: string[] = [];
  let checked = 0;
  for (const state of states) {
    if (state.issueType?.name !== 'State' || state.stateReason === 'NOT_PLANNED') continue;
    checked++;
    const problem = await frameProblem(sys, figmaToken, state.body, keys);
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
