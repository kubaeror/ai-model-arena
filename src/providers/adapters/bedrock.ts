import type { ChatMessage, ModelResponse, ToolDefinition } from '../../types.js';
import type { ModelAdapter, SendOpts } from './base.js';
import { BaseAdapter, HttpError } from './base.js';
import type { ProviderDescriptor } from '../types.js';
import type { CreateAdapterOpts } from '../registry.js';

let BedrockRuntimeClient: typeof import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient;
let ConverseCommand: typeof import('@aws-sdk/client-bedrock-runtime').ConverseCommand;
type ConverseCommandOutput = import('@aws-sdk/client-bedrock-runtime').ConverseCommandOutput;

async function loadAwsSdk(): Promise<void> {
  if (BedrockRuntimeClient) return;
  const bedrock = await import('@aws-sdk/client-bedrock-runtime');
  BedrockRuntimeClient = bedrock.BedrockRuntimeClient;
  ConverseCommand = bedrock.ConverseCommand;
}

/**
 * Native Bedrock adapter using the AWS SDK with SigV4 signing and automatic
 * credential resolution (IRSA, EKS Pod Identity, instance profile, env vars).
 * Falls back to the OpenAI-compatible gateway path if AWS_BEDROCK_GATEWAY_URL
 * is set, for backward compatibility.
 */
export class BedrockAdapter extends BaseAdapter implements ModelAdapter {
  private modelId: string;
  private region: string;
  private client: InstanceType<typeof BedrockRuntimeClient> | null = null;
  private clientCreatedAt = 0;
  private gatewayUrl?: string;
  private gatewayKey?: string;
  private useGateway: boolean;

  // Recreate client every 55 minutes to ensure fresh STS credentials
  // (AWS SDK credential chain handles refresh internally, but edge cases
  // like clock skew or revoked credentials require a fresh client).
  private static CLIENT_MAX_AGE_MS = 55 * 60 * 1000;

  constructor(_descriptor: ProviderDescriptor, modelId: string, opts: CreateAdapterOpts) {
    super(opts.logger);
    this.modelId = modelId;
    this.gatewayUrl = opts.baseUrl ?? process.env.AWS_BEDROCK_GATEWAY_URL;
    this.gatewayKey = opts.apiKey ?? process.env.AWS_BEDROCK_GATEWAY_KEY;
    this.useGateway = !!this.gatewayUrl;

    // Resolve region: env var > AWS_REGION > AWS_DEFAULT_REGION
    // No hardcoded fallback — require explicit configuration
    this.region = process.env.AWS_BEDROCK_REGION ||
      process.env.AWS_REGION ||
      process.env.AWS_DEFAULT_REGION ||
      '';
    if (!this.region && !this.useGateway) {
      throw new Error('BedrockAdapter requires AWS_BEDROCK_REGION, AWS_REGION, or AWS_DEFAULT_REGION to be set');
    }

    if (!this.useGateway) {
      // Will be initialized lazily on first call (allows IRSA token to be fresh)
      this.logger?.info('BedrockAdapter using native SigV4', { region: this.region, model: modelId });
    } else {
      if (!this.gatewayKey) {
        throw new Error('BedrockAdapter gateway mode requires AWS_BEDROCK_GATEWAY_KEY');
      }
      this.logger?.info('BedrockAdapter using gateway', { url: this.gatewayUrl });
    }
  }

  supportsReasoning(): boolean { return false; }
  supportsPromptCaching(): boolean { return false; }

  private async getClient(): Promise<InstanceType<typeof BedrockRuntimeClient>> {
    const now = Date.now();
    if (this.client && (now - this.clientCreatedAt) < BedrockAdapter.CLIENT_MAX_AGE_MS) {
      return this.client;
    }
    if (this.client) {
      this.logger?.info('BedrockAdapter: recreating client (max age exceeded)', {
        ageMs: now - this.clientCreatedAt,
      });
    }
    await loadAwsSdk();
    this.client = new BedrockRuntimeClient({
      region: this.region,
      maxAttempts: 3,
    });
    this.clientCreatedAt = now;
    return this.client;
  }

  async sendMessage(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse> {
    if (this.useGateway) {
      return this.sendViaGateway(messages, tools, opts);
    }
    return this.sendViaSdk(messages, tools, opts);
  }

  /** Native SigV4 via AWS SDK Converse API */
  private async sendViaSdk(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse> {
    return this.withRetry(async () => {
      const client = await this.getClient();

      const converseMessages: Array<{
        role: 'user' | 'assistant';
        content: Array<{ text?: string; toolResult?: Record<string, unknown>; toolUse?: { toolUseId: string; name: string; input: unknown } }>;
      }> = messages
        .filter(m => m.role !== 'system')
        .map(m => {
          const role = m.role as 'user' | 'assistant';
          if (m.role === 'tool') {
            // Tool results — but Converse API routes tool results through user messages
            const content = [{ toolResult: { toolUseId: m.toolCallId ?? '', content: [{ text: m.content ?? '' }] } }];
            return { role: 'user' as const, content };
          }
          if (m.toolCalls?.length) {
            return {
              role,
              content: m.toolCalls.map(tc => ({
                toolUse: {
                  toolUseId: tc.id,
                  name: tc.name,
                  input: tc.arguments,
                },
              })),
            };
          }
          return { role, content: [{ text: m.content ?? '' }] };
        });

      const systemMessage = messages.find(m => m.role === 'system');

      const toolConfig = tools.length > 0 ? {
        tools: tools.map(t => ({
          toolSpec: {
            name: t.name,
            description: t.description,
            inputSchema: { json: t.parameters ?? {} },
          },
        })),
      } : undefined;

      const inferenceConfig: Record<string, unknown> = {};
      if (opts?.temperature !== undefined) inferenceConfig.temperature = opts.temperature;
      if (opts?.maxTokens !== undefined) inferenceConfig.maxTokens = opts.maxTokens;

      const input: Record<string, unknown> = {
        modelId: this.modelId,
        messages: converseMessages,
        inferenceConfig,
      };
      if (systemMessage?.content) {
        input.system = [{ text: systemMessage.content }];
      }
      if (toolConfig) {
        input.toolConfig = toolConfig;
      }

      const command = new ConverseCommand(input as unknown as import('@aws-sdk/client-bedrock-runtime').ConverseCommandInput);
      const response: ConverseCommandOutput = await client.send(command);

      const output = response.output?.message;
      const usage = response.usage;

      // Extract text and tool calls from content blocks
      let text: string | null = null;
      const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

      if (output?.content) {
        for (const block of output.content) {
          if (block.text) {
            text = (text ?? '') + block.text;
          }
          if (block.toolUse) {
            toolCalls.push({
              id: block.toolUse.toolUseId ?? '',
              name: block.toolUse.name ?? '',
              arguments: (block.toolUse.input ?? {}) as Record<string, unknown>,
            });
          }
        }
      }

      return {
        text,
        toolCalls,
        usage: {
          prompt: usage?.inputTokens,
          completion: usage?.outputTokens,
          total: usage?.totalTokens,
        },
        stopReason: response.stopReason,
        raw: response,
      };
    }, { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 30000 });
  }

  /** Gateway proxy fallback (backward compatible) */
  private async sendViaGateway(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse> {
    return this.withRetry(async () => {
      const body: Record<string, unknown> = {
        model: this.modelId,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
          ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
        })),
      };
      if (tools.length > 0) body.tools = tools;
      if (opts?.temperature !== undefined) body.temperature = opts.temperature;
      if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

      const headers: Record<string, string> = {};
      if (this.gatewayKey) headers.authorization = `Bearer ${this.gatewayKey}`;

      const res = await this.post(`${this.gatewayUrl}/chat/completions`, body, headers);
      if (!res.ok) {
        const text = await res.text();
        throw new HttpError(res.status, text, `Bedrock ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
          finish_reason: string;
        }>;
        usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const choice = json.choices[0];
      if (!choice) {
        return { text: null, toolCalls: [], usage: {}, stopReason: undefined, raw: json };
      }
      return {
        text: choice.message.content ?? null,
        toolCalls: (choice.message.tool_calls ?? []).map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || '{}'),
        })),
        usage: {
          prompt: json.usage.prompt_tokens,
          completion: json.usage.completion_tokens,
          total: json.usage.total_tokens,
        },
        stopReason: choice.finish_reason,
        raw: json,
      };
    }, { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 30000 });
  }
}
