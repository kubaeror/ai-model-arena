const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // More specific patterns first — a loose pattern (e.g. openai's `sk-…`) would
  // otherwise masquerade as a different secret (e.g. anthropic `sk-ant-…`) and
  // broad generic patterns would swallow Bearer tokens. Order is load-bearing.
  { name: 'anthropic_key', regex: /sk-ant-[A-Za-z0-9-_]{20,}/g },
  { name: 'openai_key', regex: /sk-[A-Za-z0-9-_]{20,}/g },
  { name: 'github_token', regex: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { name: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'aws_secret_key', regex: /[A-Za-z0-9/+=]{40}/g },
  { name: 'jwt_token', regex: /eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g },
  { name: 'private_key_header', regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'bearer_token', regex: /Bearer\s+[A-Za-z0-9-._~+/]+=*/gi },
  { name: 'db_connection_string', regex: /(?:postgres|mysql|mongodb|redis):\/\/[^\s"']+/gi },
  { name: 'generic_api_key', regex: /(?<=(?:key|token|secret|password|bearer)?\s*[:=]\s*)[A-Za-z0-9-_]{20,64}\b/gi },
];

/**
 * Sanitize a tool output string for potential secrets.
 * Replaces matched patterns with [REDACTED:pattern_name].
 * Returns {sanitized, findings} for logging.
 */
export function sanitizeSecrets(content: string): { sanitized: string; findings: string[] } {
  const findings: string[] = [];
  let sanitized = content;

  for (const { name, regex } of SECRET_PATTERNS) {
    // Reset regex state
    regex.lastIndex = 0;
    const matches = content.match(regex);
    if (matches && matches.length > 0) {
      findings.push(`${name} (${matches.length} match${matches.length > 1 ? 'es' : ''})`);
      // Replace inline to avoid offset issues from accumulated replacements
      sanitized = sanitized.replace(new RegExp(regex.source, regex.flags), `[REDACTED:${name}]`);
    }
  }

  return { sanitized, findings };
}
