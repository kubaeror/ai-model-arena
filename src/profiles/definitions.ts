export const EXECUTION_PROFILES = [
  'read-only-analysis',
  'code-generation',
  'test-runner',
  'networked-research',
  'artifact-validation',
  'restricted-production-support',
] as const;

export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

export interface ProfileDefinition {
  name: ExecutionProfile;
  label: string;
  description: string;
  allowedTools: string[];
  /** If true, shell commands are allowed but only in strict mode (no metacharacters). */
  shellAllowed: boolean;
  /** If true, web_fetch and web_search are allowed. */
  webAccess: boolean;
  /** Max turns the agent can run. */
  maxTurns: number;
  /** Max cost in USD for this run. 0 = unlimited. */
  maxCostUsd: number;
  /** Max execution time in seconds. */
  maxExecutionSec: number;
  /** Whether this profile requires operator approval before execution. */
  requiresApproval: boolean;
}

const ALL_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'list_files', 'glob',
  'run_shell_command', 'search_code', 'web_fetch', 'web_search',
  'todo_read', 'todo_write', 'task', 'task_complete',
];

const READ_ONLY_TOOLS = ['read_file', 'list_files', 'glob', 'search_code', 'todo_read', 'task_complete'];
const CODE_GEN_TOOLS = [...READ_ONLY_TOOLS, 'write_file', 'edit_file'];
const FULL_SAFE_TOOLS = [...CODE_GEN_TOOLS, 'run_shell_command', 'task', 'todo_write'];

export const PROFILES: Record<ExecutionProfile, ProfileDefinition> = {
  'read-only-analysis': {
    name: 'read-only-analysis',
    label: 'Read-Only Analysis',
    description: 'Analyze code, read files, search codebase. No modifications, no shell, no network.',
    allowedTools: READ_ONLY_TOOLS,
    shellAllowed: false,
    webAccess: false,
    maxTurns: 10,
    maxCostUsd: 5,
    maxExecutionSec: 600,
    requiresApproval: false,
  },
  'code-generation': {
    name: 'code-generation',
    label: 'Code Generation',
    description: 'Read, write, and edit files. Shell allowed in strict mode (builds, lint, typecheck). No network.',
    allowedTools: FULL_SAFE_TOOLS,
    shellAllowed: true,
    webAccess: false,
    maxTurns: 30,
    maxCostUsd: 25,
    maxExecutionSec: 1800,
    requiresApproval: false,
  },
  'test-runner': {
    name: 'test-runner',
    label: 'Test Runner',
    description: 'Run tests, analyze failures, suggest fixes. Shell allowed in strict mode. No network.',
    allowedTools: FULL_SAFE_TOOLS,
    shellAllowed: true,
    webAccess: false,
    maxTurns: 20,
    maxCostUsd: 15,
    maxExecutionSec: 1200,
    requiresApproval: false,
  },
  'networked-research': {
    name: 'networked-research',
    label: 'Networked Research',
    description: 'Web fetch and search enabled for research tasks. Code tools allowed. Shell in strict mode.',
    allowedTools: ALL_TOOLS,
    shellAllowed: true,
    webAccess: true,
    maxTurns: 25,
    maxCostUsd: 30,
    maxExecutionSec: 2400,
    requiresApproval: true,
  },
  'artifact-validation': {
    name: 'artifact-validation',
    label: 'Artifact Validation',
    description: 'Validate generated artifacts against checksums and success criteria. Read-only.',
    allowedTools: READ_ONLY_TOOLS,
    shellAllowed: false,
    webAccess: false,
    maxTurns: 5,
    maxCostUsd: 3,
    maxExecutionSec: 300,
    requiresApproval: false,
  },
  'restricted-production-support': {
    name: 'restricted-production-support',
    label: 'Restricted Production Support',
    description: 'Emergency production debugging. Read-only. No shell beyond status checks. No network.',
    allowedTools: READ_ONLY_TOOLS,
    shellAllowed: false,
    webAccess: false,
    maxTurns: 15,
    maxCostUsd: 20,
    maxExecutionSec: 900,
    requiresApproval: true,
  },
};

export function getProfile(name: string): ProfileDefinition {
  return PROFILES[name as ExecutionProfile] ?? PROFILES['read-only-analysis'];
}

export function getAllowedTools(profile: ProfileDefinition): string[] {
  return profile.allowedTools;
}
