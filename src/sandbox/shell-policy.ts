// Shell commands the model is allowed to run. We reject metacharacters that
// enable shell injection (| ; & $ ` > < ( ) \n) unless the scenario explicitly
// opts in via shellPolicy: 'permissive'. The success-criteria evaluator has
// always enforced this (src/runner.ts runSuccessCriteria); now the agent's own run_shell_command
// matches it.
export const SHELL_METACHAR_RE = /[`$(){}|;&<>\\\n]/;

// `ln`/`link` create hardlinks to arbitrary existing inodes; safeResolve cannot
// see hardlinks, so a write through a link would mutate a file outside the
// sandbox. Block the binaries themselves (any path prefix) in strict mode.
const HARDLINK_BINARY_RE = /(^|[\\/])(ln|link)(\.exe)?$/i;

export function isShellCommandAllowed(command: string, policy: 'strict' | 'permissive' = 'strict'): boolean {
  if (policy === 'permissive') return true;
  if (SHELL_METACHAR_RE.test(command)) return false;
  const bin = command.trim().split(/\s+/)[0] ?? '';
  return !HARDLINK_BINARY_RE.test(bin);
}
