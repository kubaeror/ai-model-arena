/** Keys whose values must never be logged or serialized verbatim. */
export const SENSITIVE_KEYS: RegExp = /(api[_-]?key|secret|password|token|authorization|credential|private[_-]?key)/i;
