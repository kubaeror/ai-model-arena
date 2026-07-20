// Shell commands the model is allowed to run. We reject metacharacters that
// enable shell injection (| ; & $ ` > < ( ) \n) unless the scenario explicitly
// opts in via shellPolicy: 'permissive'. The success-criteria evaluator has
// always enforced this (src/worker.ts:43); now the agent's own run_shell_command
// matches it.
export const SHELL_METACHAR_RE = /[`$(){}|;&<>\\]/;

export function isShellCommandAllowed(command: string, policy: 'strict' | 'permissive' = 'strict'): boolean {
  if (policy === 'permissive') return true;
  return !SHELL_METACHAR_RE.test(command);
}
