import type { ChatMessage, ModelResponse, ToolDefinition, ToolExecutorMap } from '../types.js';
import type { ModelAdapter } from '../providers/adapters/base.js';
import { runAgentLoop, type AgentLoopOptions, type AgentLoopResult } from '../agent-loop/loop.js';
import { withSpan, truncate, captureContent } from './span-helpers.js';
import { TraceRecorder, writeTraceMeta, type TraceMeta } from './trace-meta.js';
import { runInSpan } from './span-context.js';

export interface TracedLoopOptions extends AgentLoopOptions {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  scenario: string;
  runId: string;
  modelConfig: string;
  outputDir?: string;
}

function captureContentEnabled(): boolean {
  return captureContent();
}

/**
 * Wrap a model adapter so every `sendMessage` call creates a `chat` child
 * span in the TraceRecorder. Content is captured only when
 * OTEL_CAPTURE_CONTENT=true.
 */
function wrapAdapter(
  adapter: ModelAdapter,
  recorder: TraceRecorder,
  o: { provider: string; model: string; temperature: number; maxTokens: number },
): ModelAdapter {
  const sendMessage = async (messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelResponse> => {
    return withSpan<ModelResponse>('chat', 'chat', recorder, {
      'gen_ai.system': o.provider,
      'gen_ai.request.model': o.model,
      'gen_ai.request.temperature': o.temperature,
      'gen_ai.request.max_tokens': o.maxTokens,
    }, async (spanId) => {
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

/** Wrap every tool executor so each call creates an `execute_tool` child span. */
function wrapExecutors(
  executors: ToolExecutorMap,
  recorder: TraceRecorder,
): ToolExecutorMap {
  const wrapped: ToolExecutorMap = {};
  for (const [name, executor] of Object.entries(executors)) {
    wrapped[name] = async (args, ctx) => {
      return withSpan('execute_tool', 'execute_tool', recorder, {
        'gen_ai.tool.name': name,
        'tool.arguments': truncate(JSON.stringify(args), 2000),
      }, async (spanId) => {
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

/**
 * Run the agent loop inside a root span tracked by the local TraceRecorder.
 * Uses AsyncLocalStorage for automatic parent-child context propagation.
 *
 * When OTEL_ENABLED=false (the env-var name is preserved for config
 * compatibility), this calls `runAgentLoop` directly with no overhead.
 */
export async function runAgentLoopTraced(
  opts: TracedLoopOptions,
): Promise<{ result: AgentLoopResult; trace: TraceMeta | null }> {
  const tracingEnabled = process.env.OTEL_ENABLED === undefined || process.env.OTEL_ENABLED === 'true';
  if (!tracingEnabled) {
    const { provider: _p, model: _m, temperature: _t, maxTokens: _mt, scenario: _s, runId: _r, modelConfig: _mc, outputDir: _o, ...loopOpts } = opts;
    void _p; void _m; void _t; void _mt; void _s; void _r; void _mc; void _o;
    const result = await runAgentLoop(loopOpts);
    return { result, trace: null };
  }

  const traceId = opts.runId;
  const rootSpanId = `${opts.runId}:root`;

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
  const wrappedAdapter = wrapAdapter(opts.adapter, recorder, {
    provider: opts.provider, model: opts.model, temperature: opts.temperature, maxTokens: opts.maxTokens,
  });
  const wrappedExecutors = wrapExecutors(opts.executors, recorder);

  let result: AgentLoopResult;
  try {
    result = await (runInSpan({ spanId: rootSpanId, parentSpanId: null }, () =>
      runAgentLoop({ ...loopOpts, adapter: wrappedAdapter, executors: wrappedExecutors }),
    ) as Promise<AgentLoopResult>);
    recorder.endSpan(rootSpanId, 'ok');
  } catch (err) {
    recorder.endSpan(rootSpanId, 'error');
    const msg = err instanceof Error ? err.message : String(err);
    recorder.addAttribute(rootSpanId, 'error.message', msg);
    const meta = recorder.toMeta(null);
    if (opts.outputDir) writeTraceMeta(opts.outputDir, meta);
    throw err;
  }

  const meta = recorder.toMeta(null);
  if (opts.outputDir) writeTraceMeta(opts.outputDir, meta);
  return { result, trace: meta };
}
