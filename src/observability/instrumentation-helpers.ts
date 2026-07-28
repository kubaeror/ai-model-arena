import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

const tracer = trace.getTracer('ai-arena');

export function startAgentSpan(name: string, attrs?: Record<string, string | number | boolean>): Span {
  return tracer.startSpan(name, {
    attributes: attrs,
  });
}

export function startTurnSpan(turn: number, provider: string, model: string): Span {
  return tracer.startSpan(`agent-turn-${turn}`, {
    attributes: {
      'ai.model.provider': provider,
      'ai.model.id': model,
      turn,
    },
  });
}

export function startToolSpan(toolName: string): Span {
  return tracer.startSpan(`tool.${toolName}`, {
    attributes: { 'tool.name': toolName },
  });
}

export function startProviderCallSpan(provider: string, model: string): Span {
  return tracer.startSpan('provider.call', {
    attributes: {
      'ai.model.provider': provider,
      'ai.model.id': model,
    },
  });
}

export function endSpan(span: Span, error?: Error): void {
  if (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.recordException(error);
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}

export function setSpanAttributes(span: Span, attrs: Record<string, string | number | boolean>): void {
  for (const [key, value] of Object.entries(attrs)) {
    span.setAttribute(key, value);
  }
}
