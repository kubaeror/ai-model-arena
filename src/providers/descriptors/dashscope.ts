import type { ProviderDescriptor } from '../types.js';
export const dashscope: ProviderDescriptor = {
  id: 'dashscope', name: 'Alibaba DashScope', apiBase: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  authScheme: 'bearer', envVar: 'DASHSCOPE_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
