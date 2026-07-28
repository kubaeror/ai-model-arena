import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ConversationEntry } from '../lib/types.js';
import { Badge } from './ui/Badge';

function snippet(s: string | null | undefined, max = 400): string {
  if (s == null) return '';
  const str = String(s).replace(/\r/g, '');
  return str.length > max ? str.slice(0, max) + ' …' : str;
}

function Collapsible({ title, children, defaultOpen = false, tone = 'default' }: { title: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; tone?: 'default' | 'error' }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`rounded-inner border ${tone === 'error' ? 'border-danger/40 bg-danger/5' : 'border-border bg-bg-0/50'}`}>
      <button className="w-full flex items-center gap-1 px-2 py-1 text-left font-mono text-12" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
      </button>
      {open && <div className="px-2 pb-2 font-mono text-12">{children}</div>}
    </div>
  );
}

function item(entry: ConversationEntry) {
  const ts = new Date(entry.timestamp).toLocaleTimeString();
  switch (entry.type) {
    case 'system':
      return (
        <div key={ts + entry.type} className="my-1 font-mono text-12 text-fg-1 border-l-2 border-border pl-3">
          <span className="font-500 text-fg-0">SYSTEM</span> · {ts}
          <pre className="mt-1 whitespace-pre-wrap text-fg-1/90">{snippet(entry.content, 600)}</pre>
        </div>
      );
    case 'user':
      return (
        <div key={ts + entry.type} className="my-2 flex justify-end">
          <div className="max-w-[80%] rounded-inner bg-accent/20 px-3 py-2 text-14">
            <div className="font-mono text-12 text-fg-1 mb-1">USER · {ts}</div>
            <div className="whitespace-pre-wrap">{snippet(entry.content, 4000)}</div>
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div key={ts + entry.type} className="my-2 flex justify-start">
          <div className="max-w-[85%]">
            <div className="rounded-inner bg-bg-1 px-3 py-2 text-14 border border-border">
              <div className="font-mono text-12 text-fg-1 mb-1 flex items-center gap-2">
                ASSISTANT · {ts}
                {entry.turn != null && <Badge variant="tier" value={`turn ${entry.turn}`} />}
                {entry.stopReason && <Badge variant="provider" value={entry.stopReason} />}
                {entry.usage?.total != null && <span>tokens {entry.usage.total}</span>}
              </div>
              {entry.content && <div className="whitespace-pre-wrap">{snippet(entry.content, 4000)}</div>}
              {entry.toolCalls && entry.toolCalls.length > 0 && (
                <div className="mt-2 font-mono text-12 text-fg-1">→ called {entry.toolCalls.map((t) => t.name).join(', ')}</div>
              )}
            </div>
          </div>
        </div>
      );
    case 'tool_call': {
      const args = JSON.stringify(entry.meta?.args ?? {}, null, 2);
      return (
        <div key={ts + entry.type} className="my-1 ml-1">
          <Collapsible title={<><Badge variant="provider" value="tool_call" /> <span className="font-mono">{entry.toolName}</span> · {ts}</>}>
            <pre className="whitespace-pre-wrap font-mono text-fg-1">{snippet(args, 2000)}</pre>
          </Collapsible>
        </div>
      );
    }
    case 'tool_result':
      return (
        <div key={ts + entry.type} className="my-1 ml-1">
          <Collapsible tone={entry.isError ? 'error' : 'default'} title={<><Badge variant={entry.isError ? 'status' : 'tier'} value={entry.isError ? 'error' : 'result'} /> <span className="font-mono">{entry.toolName}</span> · {ts}</>}>
            <pre className="whitespace-pre-wrap font-mono text-fg-1 max-h-80 overflow-auto nice-scroll">{snippet(entry.toolResult, 8000)}</pre>
          </Collapsible>
        </div>
      );
    case 'error':
      return <div key={ts + entry.type} className="my-1 font-mono text-12 text-danger">ERROR · {ts}: {snippet(entry.content, 800)}</div>;
    case 'info':
      return <div key={ts + entry.type} className="my-1 font-mono text-12 text-fg-1 italic">[{ts}] {snippet(entry.content, 800)}</div>;
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
    <div className="px-1 py-3 nice-scroll">
      {entries.length === 0 ? (
        <div className="text-fg-1 text-sm text-center py-2">No conversation yet. Updates stream in live.</div>
      ) : (
        entries.map((e, i) => <div key={i}>{item(e)}</div>)
      )}
      <div ref={bottomRef} />
    </div>
  );
}
