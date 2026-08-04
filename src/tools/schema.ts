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
    name: 'edit_file',
    description:
      'Performs exact string replacements in files. ' +
      'By default replaces the first occurrence. Set replace_all=true to replace all. ' +
      'The old_string must match exactly including whitespace and indentation. ' +
      'If replace_all is false and old_string appears multiple times, returns an error listing all line numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file, e.g. "src/server.js".' },
        old_string: { type: 'string', description: 'The exact text to find and replace.' },
        new_string: { type: 'string', description: 'The replacement text. Must differ from old_string.' },
        replace_all: { type: 'boolean', description: 'If true, replace all occurrences (default: false).', default: false },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'glob',
    description:
      'Find files matching a glob pattern. Supports *, **, ?, [abc], and {a,b} syntax. ' +
      'Returns sorted relative paths. Excludes node_modules, .git, dist, .cache, .npm.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts", "src/**/*.test.*".' },
        path: { type: 'string', description: 'Directory to search in. Defaults to "." (workspace root).', default: '.' },
      },
      required: ['pattern'],
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
    name: 'web_fetch',
    description:
      'Fetch the contents of a URL and return them as text. ' +
      'HTML pages are stripped of tags; JSON responses are returned as-is. ' +
      'Results are truncated to a maximum size. Requires web access to be enabled.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch. Must start with http:// or https://. Private IPs are blocked.' },
        maxBytes: { type: 'number', description: 'Maximum bytes to return (default: 100000, max: 1048576).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web for information. Returns relevant results with titles, URLs, and snippets. ' +
      'Uses DuckDuckGo by default (free, no API key needed). ' +
      'Set SEARCH_API_URL and SEARCH_API_KEY to use a custom search backend. ' +
      'Requires web access to be enabled.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'todo_write',
    description:
      'Create and manage a structured task list for the current session. ' +
      'Use this to track progress and organize complex tasks. ' +
      'Each todo has an id, content, status (pending/in_progress/completed), and priority (high/medium/low). ' +
      'The full list replaces any existing todos.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The updated todo list',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique identifier for the todo item' },
              content: { type: 'string', description: 'The todo item content' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['id', 'content', 'status', 'priority'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
  },
  {
    name: 'todo_read',
    description:
      'Read the current todo list for the session. ' +
      'Returns all tasks grouped by status with counts. ' +
      'Use this to check what remains to be done.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'task',
    description:
      'Launch a subagent to handle a complex, multi-step task autonomously. ' +
      'The subagent has access to the same tools as the main agent (except task and todo tools). ' +
      'Use this for research, large searches, or delegating focused work. ' +
      'The subagent returns its findings when complete.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'A short (3-5 word) description of the task.' },
        prompt: { type: 'string', description: 'The detailed task for the subagent to perform. Include exactly what information to return.' },
        subagent_name: { type: 'string', description: 'Optional name for logging.' },
      },
      required: ['description', 'prompt'],
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
