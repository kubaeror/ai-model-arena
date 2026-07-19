import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ConversationEntry } from '../lib/types.js';
import { Badge } from './ui.js';

function snippet(s: string | null | undefined, max = 400): string {
  if (s == null) return '';
  const str = String(s).replace(/\r/g, '');
  return str.length > max ? str.slice(0, max) + ' …' : str;
}

function Collapsible({ title, children, defaultOpen = false, tone = 'default' }: { title: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; tone?: 'default' | 'error' }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`rounded border ${tone === 'error' ? 'border-red-500/40 bg-red-500/5' : 'border-border bg-background/50'}`}>
      <button className="w-full flex items-center gap-1 px-2 py-1 text-left text-xs" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
      </button>
      {open && <div className="px-2 pb-2 text-xs">{children}</div>}
    </div>
  );
}

function item(entry: ConversationEntry) {
  const ts = new Date(entry.timestamp).toLocaleTimeString();
  switch (entry.type) {
    case 'system':
      return (
        <div key={ts + entry.type} className="my-1 text-xs text-muted border-l-2 border-border pl-3">
          <span className="font-medium">SYSTEM</span> · {ts}
          <pre className="mt-1 whitespace-pre-wrap text-muted/90">{snippet(entry.content, 600)}</pre>
        </div>
      );
    case 'user':
      return (
        <div key={ts + entry.type} className="my-2 flex justify-end">
          <div className="max-w-[80%] rounded-lg bg-primary/20 px-3 py-2 text-sm">
            <div className="text-xs text-muted mb-1">USER · {ts}</div>
            <div className="whitespace-pre-wrap">{snippet(entry.content, 4000)}</div>
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div key={ts + entry.type} className="my-2 flex justify-start">
          <div className="max-w-[85%]">
            <div className="rounded-lg bg-card px-3 py-2 text-sm border border-border">
              <div className="text-xs text-muted mb-1 flex items-center gap-2">
                ASSISTANT · {ts}
                {entry.turn != null && <Badge>turn {entry.turn}</Badge>}
                {entry.stopReason && <Badge color="blue">{entry.stopReason}</Badge>}
                {entry.usage?.total != null && <span>tokens {entry.usage.total}</span>}
              </div>
              {entry.content && <div className="whitespace-pre-wrap">{snippet(entry.content, 4000)}</div>}
              {entry.toolCalls && entry.toolCalls.length > 0 && (
                <div className="mt-2 text-xs text-muted">→ called {entry.toolCalls.map((t) => t.name).join(', ')}</div>
              )}
            </div>
          </div>
        </div>
      );
    case 'tool_call': {
      const args = JSON.stringify(entry.meta?.args ?? {}, null, 2);
      return (
        <div key={ts + entry.type} className="my-1 ml-4">
          <Collapsible title={<><Badge color="blue">tool_call</Badge> <span className="font-mono">{entry.toolName}</span> · {ts}</>}>
            <pre className="whitespace-pre-wrap font-mono text-muted">{snippet(args, 2000)}</pre>
          </Collapsible>
        </div>
      );
    }
    case 'tool_result':
      return (
        <div key={ts + entry.type} className="my-1 ml-4">
          <Collapsible tone={entry.isError ? 'error' : 'default'} title={<><Badge color={entry.isError ? 'red' : 'green'}>tool_result</Badge> <span className="font-mono">{entry.toolName}</span> · {ts}</>}>
            <pre className="whitespace-pre-wrap font-mono text-muted max-h-80 overflow-auto nice-scroll">{snippet(entry.toolResult, 8000)}</pre>
          </Collapsible>
        </div>
      );
    case 'error':
      return <div key={ts + entry.type} className="my-1 text-xs text-red-400">ERROR · {ts}: {snippet(entry.content, 800)}</div>;
    case 'info':
      return <div key={ts + entry.type} className="my-1 text-xs text-muted italic">[{ts}] {snippet(entry.content, 800)}</div>;
    default:
      return null;
  }
}

export function ConversationView({ entries }: { entries: ConversationEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);
  return (
    <div className="px-4 py-3 nice-scroll">
      {entries.length === 0 ? (
        <div className="text-muted text-sm text-center py-8">No conversation yet. Updates stream in live.</div>
      ) : (
        entries.map((e, i) => <div key={i}>{item(e)}</div>)
      )}
      <div ref={bottomRef} />
    </div>
  );
}
