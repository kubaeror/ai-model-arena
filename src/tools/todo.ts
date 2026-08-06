import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import { validateArgs } from './util.js';
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

function todosPath(sandboxDir: string): string {
  const arenaDir = path.join(sandboxDir, '.arena');
  fs.mkdirSync(arenaDir, { recursive: true });
  return path.join(arenaDir, 'todos.json');
}

function readTodos(dir: string): TodoItem[] {
  const fp = todosPath(dir);
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = fs.readFileSync(fp, 'utf8');
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
  fs.writeFileSync(todosPath(dir), JSON.stringify(todos, null, 2), 'utf8');
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

  writeTodos(ctx.sandboxDir, todos);

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
