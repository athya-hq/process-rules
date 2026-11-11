/**
 * What niyam 0.6.9 wrote, before P-55 moved its files to ~/.config/niyam, copied from that release, not built by
 * the code that reads it: a session file, hooks and settings that still name the old folder, variable and token.
 * HOME is the fake's, /home/u, and the agent ExampleBot, id 42.
 */

/** The hooks onboard 0.6.9 wrote. */
export const HOOK_COMMAND_069 = "cli=\"$HOME/.config/process-rules/bin/process-rules\"; [ -x \"$cli\" ] || cli=niyam; if said=$(\"$cli\" session-start 2>&1); then printf '%s\\n' \"$said\"; else printf '%s\\n' \"niyam: STOP. niyam session-start did not run here ($said), so this session cannot be given the agent identity and GitHub is locked out of it. Do not push, fetch, or run gh in this session; tell the owner.\"; fi";
export const GUARD_COMMAND_069 = "input=$(cat); cmd=$(printf '%s' \"$input\" | sed -nE 's/.*\"command\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p'); printf '%s' \"$cmd\" | grep -Eq '(^|[^[:alnum:]_-])(gh|git)([^[:alnum:]_-]|$)' || exit 0; cli=\"$HOME/.config/process-rules/bin/process-rules\"; [ -x \"$cli\" ] || cli=niyam; printf '%s' \"$input\" | \"$cli\" guard && exit 0; [ $? -eq 2 ] && exit 2; echo \"niyam: refused, because the niyam CLI did not run here to check this command. Do not work around it; tell the owner.\" >&2; exit 2";
export const PRE_PUSH_HOOK_069 = "#!/bin/sh\n# Written by niyam onboard: before an agent session pushes, that it pushes as the agent, then the work rules.\n# Anyone else's push goes ahead. Without the CLI nothing can check an agent session's push, so it is refused.\n[ -z \"$PROCESS_RULES_AGENT\" ] && [ \"$CLAUDECODE\" != 1 ] && exit 0\ncli=\"$HOME/.config/process-rules/bin/process-rules\"\n[ -x \"$cli\" ] || cli=niyam\nif ! command -v \"$cli\" >/dev/null 2>&1; then\n  echo \"niyam: the CLI is not installed, so this agent push cannot be checked\" >&2\n  exit 1\nfi\nexec \"$cli\" pre-push \"$@\"\n";

/** The session file machine 0.6.9 wrote, in ~/.config/process-rules/examplebot/session.sh. */
export const SESSION_069 = "# Written by process-rules machine. Makes this shell act as ExampleBot on GitHub.\nexport GH_TOKEN=\"$(/usr/bin/security find-generic-password -s niyam -a ExampleBot -w 2>/dev/null || /usr/bin/security find-generic-password -s process-rules -a ExampleBot -w 2>/dev/null)\"\n[ -n \"$GH_TOKEN\" ] || export GH_TOKEN=process-rules-no-agent-token\nunset GITHUB_TOKEN GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_ASKPASS SSH_ASKPASS\nexport PROCESS_RULES_AGENT='ExampleBot'\nexport GH_CONFIG_DIR='/home/u/.config/process-rules/examplebot/gh'\nexport GIT_AUTHOR_NAME='ExampleBot'\nexport GIT_COMMITTER_NAME='ExampleBot'\nexport GIT_AUTHOR_EMAIL='42+ExampleBot@users.noreply.github.com'\nexport GIT_COMMITTER_EMAIL='42+ExampleBot@users.noreply.github.com'\nexport GIT_TERMINAL_PROMPT='0'\nexport GIT_SSH_COMMAND='echo '\\''process-rules: SSH is off in agent sessions; GitHub goes over HTTPS'\\'' >&2; false'\nexport GIT_CONFIG_COUNT='11'\nexport GIT_CONFIG_KEY_0='gpg.format'\nexport GIT_CONFIG_VALUE_0='ssh'\nexport GIT_CONFIG_KEY_1='user.signingkey'\nexport GIT_CONFIG_VALUE_1='/home/u/.ssh/examplebot_signing.pub'\nexport GIT_CONFIG_KEY_2='commit.gpgsign'\nexport GIT_CONFIG_VALUE_2='true'\nexport GIT_CONFIG_KEY_3='tag.gpgsign'\nexport GIT_CONFIG_VALUE_3='true'\nexport GIT_CONFIG_KEY_4='credential.helper'\nexport GIT_CONFIG_VALUE_4=''\nexport GIT_CONFIG_KEY_5='credential.https://github.com.helper'\nexport GIT_CONFIG_VALUE_5='!f() { test \"$1\" = get && printf '\\''username=%s\\npassword=%s\\n'\\'' ExampleBot \"$GH_TOKEN\"; }; f'\nexport GIT_CONFIG_KEY_6='core.askpass'\nexport GIT_CONFIG_VALUE_6=''\nexport GIT_CONFIG_KEY_7='url.https://github.com/.insteadOf'\nexport GIT_CONFIG_VALUE_7='git@github.com:'\nexport GIT_CONFIG_KEY_8='url.https://github.com/.insteadOf'\nexport GIT_CONFIG_VALUE_8='ssh://git@github.com/'\nexport GIT_CONFIG_KEY_9='url.https://github.com/.insteadOf'\nexport GIT_CONFIG_VALUE_9='ssh://git@github.com:22/'\nexport GIT_CONFIG_KEY_10='url.https://github.com/.insteadOf'\nexport GIT_CONFIG_VALUE_10='ssh://git@ssh.github.com:443/'\n";
/** The same, from a release before P-50, which read the keychain service process-rules alone. */
export const SESSION_BEFORE_P50 = "# Written by process-rules machine. Makes this shell act as ExampleBot on GitHub.\nexport GH_TOKEN=\"$(/usr/bin/security find-generic-password -s process-rules -a ExampleBot -w 2>/dev/null)\"\n[ -n \"$GH_TOKEN\" ] || export GH_TOKEN=process-rules-no-agent-token\nunset GITHUB_TOKEN GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_ASKPASS SSH_ASKPASS\nexport PROCESS_RULES_AGENT='ExampleBot'\nexport GH_CONFIG_DIR='/home/u/.config/process-rules/examplebot/gh'\nexport GIT_AUTHOR_NAME='ExampleBot'\nexport GIT_COMMITTER_NAME='ExampleBot'\nexport GIT_AUTHOR_EMAIL='42+ExampleBot@users.noreply.github.com'\nexport GIT_COMMITTER_EMAIL='42+ExampleBot@users.noreply.github.com'\nexport GIT_TERMINAL_PROMPT='0'\nexport GIT_SSH_COMMAND='echo '\\''process-rules: SSH is off in agent sessions; GitHub goes over HTTPS'\\'' >&2; false'\nexport GIT_CONFIG_COUNT='11'\nexport GIT_CONFIG_KEY_0='gpg.format'\nexport GIT_CONFIG_VALUE_0='ssh'\nexport GIT_CONFIG_KEY_1='user.signingkey'\nexport GIT_CONFIG_VALUE_1='/home/u/.ssh/examplebot_signing.pub'\nexport GIT_CONFIG_KEY_2='commit.gpgsign'\nexport GIT_CONFIG_VALUE_2='true'\nexport GIT_CONFIG_KEY_3='tag.gpgsign'\nexport GIT_CONFIG_VALUE_3='true'\nexport GIT_CONFIG_KEY_4='credential.helper'\nexport GIT_CONFIG_VALUE_4=''\nexport GIT_CONFIG_KEY_5='credential.https://github.com.helper'\nexport GIT_CONFIG_VALUE_5='!f() { test \"$1\" = get && printf '\\''username=%s\\npassword=%s\\n'\\'' ExampleBot \"$GH_TOKEN\"; }; f'\nexport GIT_CONFIG_KEY_6='core.askpass'\nexport GIT_CONFIG_VALUE_6=''\nexport GIT_CONFIG_KEY_7='url.https://github.com/.insteadOf'\nexport GIT_CONFIG_VALUE_7='git@github.com:'\nexport GIT_CONFIG_KEY_8='url.https://github.com/.insteadOf'\nexport GIT_CONFIG_VALUE_8='ssh://git@github.com/'\nexport GIT_CONFIG_KEY_9='url.https://github.com/.insteadOf'\nexport GIT_CONFIG_VALUE_9='ssh://git@github.com:22/'\nexport GIT_CONFIG_KEY_10='url.https://github.com/.insteadOf'\nexport GIT_CONFIG_VALUE_10='ssh://git@ssh.github.com:443/'\n";

/** The lock session-start 0.6.9 appended to CLAUDE_ENV_FILE. */
export const LOCK_069 = "# Written by process-rules session-start. GitHub is locked out unless an agent identity below replaces this.\nexport GH_TOKEN=process-rules-no-agent-token\nunset GITHUB_TOKEN GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_ASKPASS SSH_ASKPASS\nexport GH_CONFIG_DIR='/home/u/.config/process-rules/locked/gh'\nexport GIT_TERMINAL_PROMPT='0'\nexport GIT_SSH_COMMAND='echo '\\''process-rules: SSH is off in agent sessions; GitHub goes over HTTPS'\\'' >&2; false'\nexport GIT_CONFIG_COUNT='6'\nexport GIT_CONFIG_KEY_0='credential.helper'\nexport GIT_CONFIG_VALUE_0=''\nexport GIT_CONFIG_KEY_1='core.askpass'\nexport GIT_CONFIG_VALUE_1=''\nexport GIT_CONFIG_KEY_2='url.https://github.com/.insteadOf'\nexport GIT_CONFIG_VALUE_2='git@github.com:'\nexport GIT_CONFIG_KEY_3='url.https://github.com/.insteadOf'\nexport GIT_CONFIG_VALUE_3='ssh://git@github.com/'\nexport GIT_CONFIG_KEY_4='url.https://github.com/.insteadOf'\nexport GIT_CONFIG_VALUE_4='ssh://git@github.com:22/'\nexport GIT_CONFIG_KEY_5='url.https://github.com/.insteadOf'\nexport GIT_CONFIG_VALUE_5='ssh://git@ssh.github.com:443/'\n";

/** The lock onboard 0.6.9 put in a client's .claude/settings.json env. */
export const BASE_ENV_069: Record<string, string> = {
  GH_TOKEN: "process-rules-no-agent-token",
  GITHUB_TOKEN: "process-rules-no-agent-token",
  GIT_CONFIG_PARAMETERS: "",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "echo 'process-rules: SSH is off in agent sessions; GitHub goes over HTTPS' >&2; false",
  GIT_CONFIG_COUNT: "6",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: "core.askpass",
  GIT_CONFIG_VALUE_1: "",
  GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_2: "git@github.com:",
  GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
  GIT_CONFIG_KEY_4: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_4: "ssh://git@github.com:22/",
  GIT_CONFIG_KEY_5: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_5: "ssh://git@ssh.github.com:443/"
};
