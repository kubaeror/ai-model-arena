import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import { validateArgs } from './util.js';
import { safeResolve, assertSafeWriteTarget } from '../sandbox/sandbox.js';
import type { ToolExecutor } from '../types.js';

interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

const TodoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
  priority: z.enum(['high', 'medium', 'low']),
});

const TodoWriteArgs = z.object({
  todos: z.array(TodoItemSchema).min(1).max(50),
}).strict();

const TodoReadArgs = z.object({}).strict();

/**
 * Resolve the `.arena` directory inside `sandboxDir`, rejecting a pre-existing
 * symlink (or non-directory) that a write could follow outside the sandbox.
 * `create` is true on the write path only — reads must not create the dir.
 */
function arenaDir(sandboxDir: string, create: boolean): string {
  const dir = path.join(sandboxDir, '.arena');
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) {
      throw new Error('Refusing to use a symlinked .arena directory.');
    }
    if (!st.isDirectory()) {
      throw new Error('Refusing to use a non-directory .arena path.');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (create) fs.mkdirSync(dir, { recursive: true });
    } else {
      throw err;
    }
  }
  return dir;
}

/**
 * Write-path resolution: `.arena` must exist (created on demand), the resolved
 * todos path must stay in the sandbox, and the inode must be a regular
 * single-link file so a hardlink cannot redirect the write outside.
 */
function todosWritePath(sandboxDir: string): string {
  arenaDir(sandboxDir, true);
  const abs = safeResolve(sandboxDir, '.arena/todos.json');
  assertSafeWriteTarget(abs);
  return abs;
}

/** Read-path resolution: same symlink-dir rejection, but never opens O_WRONLY
 *  (a legitimately read-only todos.json must still be readable). */
function todosReadPath(sandboxDir: string): string {
  arenaDir(sandboxDir, false);
  return safeResolve(sandboxDir, '.arena/todos.json');
}

function readTodos(dir: string): TodoItem[] {
  let fp: string;
  try {
    fp = todosReadPath(dir);
  } catch {
    // Unsafe path (symlinked .arena, …): report no todos rather than reading
    // through the link.
    return [];
  }
  let raw: string;
  try {
    // Read-path mirror of assertSafeWriteTarget: O_NONBLOCK keeps a model-made
    // FIFO from blocking the open, and fstat rejects non-regular or hardlinked
    // inodes so a link inside .arena cannot read an outside file.
    const fd = fs.openSync(
      fp,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink > 1) return [];
      raw = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((t): t is TodoItem => {
      return t && typeof t.id === 'string' && typeof t.content === 'string'
        && ['pending', 'in_progress', 'completed'].includes(t.status)
        && ['high', 'medium', 'low'].includes(t.priority);
    });
  } catch {
    return [];
  }
}

function writeTodos(dir: string, todos: TodoItem[]): void {
  fs.writeFileSync(todosWritePath(dir), JSON.stringify(todos, null, 2), 'utf8');
}

function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '(no tasks)';

  const statuses: Record<TodoItem['status'], TodoItem[]> = { pending: [], in_progress: [], completed: [] };
  for (const t of todos) statuses[t.status].push(t);

  const lines: string[] = [];
  for (const status of ['in_progress', 'pending', 'completed'] as const) {
    const items = statuses[status];
    if (items.length === 0) continue;
    const mark = status === 'in_progress' ? '>' : status === 'pending' ? '+' : 'x';
    lines.push(`## ${mark} ${status.replace('_', ' ')} (${items.length})`);
    for (const t of items) {
      lines.push(`- [${t.priority}] ${t.id}: ${t.content}`);
    }
  }
  return lines.join('\n');
}

// ── todo_read ────────────────────────────────────────────────────────────────

export const todoRead: ToolExecutor = async (args, ctx) => {
  const v = validateArgs(TodoReadArgs, args);
  if (!v.ok) return { content: v.error, isError: true };
  const todos = readTodos(ctx.sandboxDir);
  const counts = {
    pending: todos.filter(t => t.status === 'pending').length,
    in_progress: todos.filter(t => t.status === 'in_progress').length,
    completed: todos.filter(t => t.status === 'completed').length,
  };
  const summary = `${todos.length} tasks: ${counts.pending} pending, ${counts.in_progress} in_progress, ${counts.completed} completed`;
  return { content: `${summary}\n\n${formatTodos(todos)}`, isError: false };
};

// ── todo_write ───────────────────────────────────────────────────────────────

export const todoWrite: ToolExecutor = async (args, ctx) => {
  const v = validateArgs(TodoWriteArgs, args);
  if (!v.ok) return { content: v.error, isError: true };
  const { todos } = v.data;

  try {
    writeTodos(ctx.sandboxDir, todos);
  } catch (e) {
    return { content: `Error: ${(e as Error).message}`, isError: true };
  }

  const counts = {
    pending: todos.filter(t => t.status === 'pending').length,
    in_progress: todos.filter(t => t.status === 'in_progress').length,
    completed: todos.filter(t => t.status === 'completed').length,
  };
  return {
    content: `Updated todo list: ${counts.pending} pending, ${counts.in_progress} in_progress, ${counts.completed} completed`,
    isError: false,
  };
};
