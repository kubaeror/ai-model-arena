import { describe, it, expect } from 'vitest';
import { cn } from '../../src/lib/cn.js';

describe('cn', () => {
  it('joins multiple class names', () => {
    expect(cn('text-sm', 'font-bold')).toBe('text-sm font-bold');
  });

  it('filters falsy values', () => {
    expect(cn('base', false && 'hidden', undefined, null, 'extra')).toBe('base extra');
  });

  it('handles conditional classes', () => {
    const active = true;
    expect(cn('base', active && 'bg-blue-500', !active && 'bg-gray-500')).toBe('base bg-blue-500');
  });

  it('handles object syntax with falsy values', () => {
    expect(cn('base', { 'text-red-500': false, 'text-green-500': true })).toBe('base text-green-500');
  });
});
