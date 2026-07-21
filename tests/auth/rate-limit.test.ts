import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireRole } from '../../src/auth/rbac.js';
import type { Request, Response } from 'express';

function mockReqRes(role?: string) {
  let statusCode = 200;
  let body: unknown = null;
  const req = {
    user: role ? { sub: 'tester', role } : undefined,
  } as unknown as Request;
  const res = {
    status: (code: number) => { statusCode = code; return res; },
    json: (data: unknown) => { body = data; return res; },
  } as unknown as Response;
  let called = false;
  const next = () => { called = true; };
  return { req, res, next, getStatus: () => statusCode, getBody: () => body, wasCalled: () => called };
}

test('requireRole(admin) allows admin', () => {
  const mw = requireRole('admin');
  const { req, res, next, wasCalled } = mockReqRes('admin');
  mw(req, res, next);
  assert.ok(wasCalled(), 'next should be called');
});

test('requireRole(editor) denies viewer', () => {
  const mw = requireRole('editor');
  const { req, res, next, getStatus } = mockReqRes('viewer');
  mw(req, res, next);
  assert.equal(getStatus(), 403);
});

test('requireRole(viewer) allows editor (higher order)', () => {
  const mw = requireRole('viewer');
  const { req, res, next, wasCalled } = mockReqRes('editor');
  mw(req, res, next);
  assert.ok(wasCalled());
});

test('requireRole(admin) denies unauthenticated user', () => {
  const mw = requireRole('admin');
  const { req, res, next, getStatus } = mockReqRes(undefined);
  mw(req, res, next);
  assert.equal(getStatus(), 403);
});

test('requireRole(admin) denies unknown role', () => {
  const mw = requireRole('admin');
  const req = { user: { sub: 'tester', role: 'superuser' } } as unknown as Request;
  let statusCode = 200;
  const res = { status: (c: number) => { statusCode = c; return res; }, json: () => res } as unknown as Response;
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(statusCode, 403);
});
