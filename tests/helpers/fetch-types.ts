/**
 * Input type accepted by the global fetch(). DOM's `RequestInfo` is not
 * declared under the ES2022-only lib, so tests that stub globalThis.fetch
 * use this instead (resolves to undici's `string | URL | Request`).
 */
export type FetchInput = Parameters<typeof fetch>[0];
