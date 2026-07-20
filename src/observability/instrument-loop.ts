import type { ChatMessage, ModelResponse, ToolDefinition, ToolExecutorMap } from '../types.js';
import type { ModelAdapter } from '../providers/adapters/base.js';
import { runAgentLoop, type AgentLoopOptions, type AgentLoopResult } from '../agent-loop/loop.js';
import { getTracer, externalTraceUrl, isTracingEnabled } from './tracing.js';
import { withSpan, truncate } from './span-helpers.js';
import { TraceRecorder, writeTraceMeta, type TraceMeta } from './trace-meta.js';

export interface TracedLoopOptions extends AgentLoopOptions {
  /** gen_ai.system attribute (provider name). */
  provider: string;
  /** gen_ai.request.model attribute. */
  model: string;
  /** gen_ai.request.temperature attribute. */
  temperature: number;
  /** gen_ai.request.max_tokens attribute. */
  maxTokens: number;
  /** ai_arena.scenario attribute + recorder metadata. */
  scenario: string;
  /** ai_arena.run_id attribute + recorder metadata. */
  runId: string;
  /** ai_arena.model_config attribute (free-form label). */
  modelConfig: string;
  /** Trace metadata is flushed here on completion. */
  outputDir?: string;
}

/**
 * Wrap a model adapter so every `sendMessage` call opens a `chat` child span
 * with GenAI semantic-convention attributes (model, temperature, max_tokens,
 * usage, finish reasons, duration). Content is captured only when
 * OTEL_CAPTURE_CONTENT=true.
 */
function wrapAdapter(
  adapter: ModelAdapter,
  tracer: ReturnType<typeof getTracer>,
  recorder: TraceRecorder,
  o: { provider: string; model: string; temperature: number; maxTokens: number },
): ModelAdapter {
  const sendMessage = async (messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelResponse> => {
    return withSpan(tracer, 'chat', 'chat', recorder, {
      'gen_ai.system': o.provider,
      'gen_ai.request.model': o.model,
      'gen_ai.request.temperature': o.temperature,
      'gen_ai.request.max_tokens': o.maxTokens,
    }, async (_span, spanId) => {
      if (captureContentEnabled()) {
        recorder.addAttribute(spanId, 'gen_ai.prompt', truncate(JSON.stringify(messages.slice(-4)), 8000));
      }
      const start = Date.now();
      const response = await adapter.sendMessage(messages, tools);
      recorder.addAttribute(spanId, 'gen_ai.usage.input_tokens', response.usage?.prompt ?? 0);
      recorder.addAttribute(spanId, 'gen_ai.usage.output_tokens', response.usage?.completion ?? 0);
      recorder.addAttribute(spanId, 'duration_ms', Date.now() - start);
      if (response.stopReason) recorder.addAttribute(spanId, 'gen_ai.response.finish_reasons', response.stopReason);
      if (captureContentEnabled()) recorder.addAttribute(spanId, 'gen_ai.completion', truncate(response.text ?? '', 8000));
      return response;
    });
  };
  return {
    sendMessage,
    supportsStreaming: () => adapter.supportsStreaming(),
    supportsReasoning: () => adapter.supportsReasoning(),
    supportsPromptCaching: () => adapter.supportsPromptCaching(),
    ...(adapter.buildCacheBreakpoints ? { buildCacheBreakpoints: (m: ChatMessage[]) => adapter.buildCacheBreakpoints!(m) } : {}),
    ...(adapter.sendMessageStream ? { sendMessageStream: (m: ChatMessage[], t: ToolDefinition[]) => adapter.sendMessageStream!(m, t) } : {}),
  };
}

/** Wrap every tool executor so each call opens an `execute_tool` child span. */
function wrapExecutors(
  executors: ToolExecutorMap,
  tracer: ReturnType<typeof getTracer>,
  recorder: TraceRecorder,
): ToolExecutorMap {
  const wrapped: ToolExecutorMap = {};
  for (const [name, executor] of Object.entries(executors)) {
    wrapped[name] = async (args, ctx) => {
      return withSpan(tracer, 'execute_tool', 'execute_tool', recorder, {
        'gen_ai.tool.name': name,
        'tool.arguments': truncate(JSON.stringify(args), 2000),
      }, async (_span, spanId) => {
        const start = Date.now();
        try {
          const res = await executor(args, ctx);
          recorder.addAttribute(spanId, 'tool.success', !res.isError);
          recorder.addAttribute(spanId, 'duration_ms', Date.now() - start);
          if (res.isError) recorder.addAttribute(spanId, 'tool.error', truncate(res.content, 1000));
          return res;
        } catch (err) {
          recorder.addAttribute(spanId, 'tool.success', false);
          recorder.addAttribute(spanId, 'duration_ms', Date.now() - start);
          recorder.addAttribute(spanId, 'tool.error', err instanceof Error ? err.message : String(err));
          throw err;
        }
      });
    };
  }
  return wrapped;
}

function captureContentEnabled(): boolean {
  return process.env.OTEL_CAPTURE_CONTENT === 'true';
}

/**
 * Run the agent loop inside a root `invoke_agent` span. Creates the
 * `TraceRecorder`, wraps the adapter + executors with span-producing shims,
 * runs the existing `runAgentLoop`, then flushes trace metadata to
 * `outputDir/trace-meta.json` (+ `index.json` summary) and returns the trace.
 *
 * When tracing is disabled, this calls `runAgentLoop` directly with no overhead.
 */
export async function runAgentLoopTraced(
  opts: TracedLoopOptions,
): Promise<{ result: AgentLoopResult; trace: TraceMeta | null }> {
  if (!isTracingEnabled()) {
    const { provider: _p, model: _m, temperature: _t, maxTokens: _mt, scenario: _s, runId: _r, modelConfig: _mc, outputDir: _o, ...loopOpts } = opts;
    void _p; void _m; void _t; void _mt; void _s; void _r; void _mc; void _o;
    const result = await runAgentLoop(loopOpts);
    return { result, trace: null };
  }

  const tracer = getTracer('ai-model-arena:agent');
  const rootSpan = tracer.startSpan('invoke_agent', {
    attributes: {
      'gen_ai.system': opts.provider,
      'gen_ai.request.model': opts.model,
      'ai_arena.run_id': opts.runId,
      'ai_arena.scenario': opts.scenario,
      'ai_arena.model_config': opts.modelConfig,
    },
  });
  const traceId = rootSpan.spanContext().traceId;
  const rootSpanId = rootSpan.spanContext().spanId;

  const recorder = new TraceRecorder({
    traceId,
    runId: opts.runId,
    model: opts.model,
    scenario: opts.scenario,
    modelConfig: opts.modelConfig,
  });
  recorder.recordNew(rootSpanId, traceId, 'invoke_agent', 'root', null, {
    'gen_ai.system': opts.provider,
    'gen_ai.request.model': opts.model,
    'ai_arena.run_id': opts.runId,
    'ai_arena.scenario': opts.scenario,
    'ai_arena.model_config': opts.modelConfig,
  });

  const { provider: _p, model: _m, temperature: _t, maxTokens: _mt, scenario: _s, runId: _r, modelConfig: _mc, outputDir: _o, ...loopOpts } = opts;
  void _p; void _m; void _t; void _mt; void _s; void _r; void _mc; void _o;
  const wrappedAdapter = wrapAdapter(opts.adapter, tracer, recorder, {
    provider: opts.provider, model: opts.model, temperature: opts.temperature, maxTokens: opts.maxTokens,
  });
  const wrappedExecutors = wrapExecutors(opts.executors, tracer, recorder);

  const { context, trace: apiTrace, SpanStatusCode } = await import('@opentelemetry/api');
  let result: AgentLoopResult;
  try {
    result = await context.with(apiTrace.setSpan(context.active(), rootSpan), () =>
      runAgentLoop({ ...loopOpts, adapter: wrappedAdapter, executors: wrappedExecutors }),
    );
    recorder.endSpan(rootSpanId, 'ok');
    rootSpan.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    recorder.endSpan(rootSpanId, 'error');
    const msg = err instanceof Error ? err.message : String(err);
    recorder.addAttribute(rootSpanId, 'error.message', msg);
    rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: msg });
    rootSpan.recordException(err as Error);
    rootSpan.end();
    const meta = recorder.toMeta(externalTraceUrl(traceId));
    if (opts.outputDir) writeTraceMeta(opts.outputDir, meta);
    throw err;
  } finally {
    rootSpan.end();
  }

  const meta = recorder.toMeta(externalTraceUrl(traceId));
  if (opts.outputDir) writeTraceMeta(opts.outputDir, meta);
  return { result, trace: meta };
}

