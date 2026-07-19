import type { ToolDefinition } from '../types.js';

/**
 * Tool catalog. Each tool's `parameters` is a plain JSON Schema object so it is
 * directly compatible with OpenAI function calling (`parameters`), Anthropic
 * tool use (`input_schema`), and MCP (`inputSchema`).
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Read the full text contents of a file inside the sandbox workspace. ' +
      'Provide a path relative to the workspace root. Paths cannot escape the sandbox.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file, e.g. "src/server.js".' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a file inside the sandbox workspace with the given text content. ' +
      'Parent directories are created automatically. Paths cannot escape the sandbox.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file, e.g. "src/server.js".' },
        content: { type: 'string', description: 'Full text content to write to the file.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description:
      'List files in the sandbox workspace, returning relative paths. ' +
      'Excludes node_modules, .git, dist. Set recursive=false for a top-level listing.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory to list. Defaults to "." (workspace root).', default: '.' },
        recursive: { type: 'boolean', description: 'Whether to recurse into subdirectories.', default: true },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'run_shell_command',
    description:
      'Run a shell command inside the sandbox workspace (cwd = workspace root). ' +
      'stdout and stderr are captured and returned (truncated to a max size). ' +
      'Use this to run builds, tests, and inspect output. There is a timeout.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_code',
    description:
      'Search for a text/regex pattern across files in the sandbox workspace (grep-like). ' +
      'Returns matching lines as "relative/path:lineNo: line". Excludes node_modules and .git.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring or regular expression to search for.' },
        regex: { type: 'boolean', description: 'If true, treat query as a regular expression.', default: false },
        caseSensitive: { type: 'boolean', description: 'If true, perform a case-sensitive search.', default: false },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_complete',
    description:
      'Signal that the assigned task is complete. Call this ONLY after you have verified ' +
      'the work (e.g. tests pass).',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'A short summary of what was accomplished.' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
];

/** Name of the tool the agent calls to stop the loop. */
export const TASK_COMPLETE_TOOL = 'task_complete';

/**
 * MCP-style representation: { name, description, inputSchema }.
 * If you later expose these tools via a real MCP server, this is the shape
 * MCP expects for `tools/list`.
 */
export const MCP_TOOLS = TOOL_DEFINITIONS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.parameters,
}));
