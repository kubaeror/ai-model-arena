import type { ProviderDescriptor } from '../types.js';
export const snowflakeCortex: ProviderDescriptor = {
  id: 'snowflake-cortex', name: 'Snowflake Cortex', apiBase: 'https://{account}.snowflakecomputing.com/api/v2/cortex/inference/v1',
  authScheme: 'bearer', envVar: 'SNOWFLAKE_CORTEX_TOKEN', adapter: 'openai-compat', isBuiltin: true,
};
