import { useState, useMemo, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface Column<T> {
  key: string;
  header: string;
  sortable?: boolean;
  render?: (row: T) => ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (row: T) => void;
  getRowId?: (row: T) => string;
  className?: string;
}

export function DataTable<T>({ columns, data, onRowClick, getRowId, className }: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const sortedData = useMemo(() => {
    if (!sortKey) return data;
    const col = columns.find(c => c.key === sortKey);
    if (!col?.sortable) return data;
    const sorted = [...data].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return sorted;
  }, [data, sortKey, sortDir, columns]);

  function handleSort(key: string) {
    const col = columns.find(c => c.key === key);
    if (!col?.sortable) return;
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full border-collapse">
        <thead className="sticky top-0 z-10 bg-bg-1">
          <tr className="border-b border-border">
            {columns.map(col => (
              <th
                key={col.key}
                onClick={() => handleSort(col.key)}
                className={cn(
                  'px-12 py-8 text-left font-mono text-12 uppercase text-fg-1',
                  col.sortable && 'cursor-pointer hover:text-fg-0',
                  col.className,
                )}
              >
                {col.header}
                {sortKey === col.key && (sortDir === 'asc' ? ' ↑' : ' ↓')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((row, i) => (
            <tr
              key={getRowId ? getRowId(row) : i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                'border-b border-border/50 hover:bg-bg-2',
                onRowClick && 'cursor-pointer',
              )}
            >
              {columns.map(col => (
                <td
                  key={col.key}
                  data-testid={col.key === 'age' ? 'row-age' : undefined}
                  className={cn('px-12 py-8 font-mono text-14 text-fg-0', col.className)}
                >
                  {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
