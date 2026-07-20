import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema-pg.ts',
  out: './drizzle/pg',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://arena:arena@localhost:5432/arena' },
});
