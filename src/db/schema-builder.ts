// ── Per-dialect table builders ─────────────────────────────────────────────
// Builds drizzle SQLite/Postgres tables from the dialect-neutral spec in
// src/db/schema-defs.ts. The type-level `SqliteBuilderFor`/`PgBuilderFor`
// mappings reproduce the exact builder types that hand-written `sqliteTable` /
// `pgTable` definitions produce (NotNull/HasDefault/IsPrimaryKey modifiers),
// so `InferSelectModel`/`InferInsertModel` on built tables are identical to
// the hand-written definitions.

import {
  sqliteTable,
  text,
  integer,
  real,
  index as sqliteIndex,
  uniqueIndex as sqliteUniqueIndex,
  primaryKey as sqlitePrimaryKey,
  type SQLiteTableWithColumns,
  type SQLiteColumnBuilderBase,
  type SQLiteTextBuilderInitial,
  type SQLiteIntegerBuilderInitial,
  type SQLiteRealBuilderInitial,
  type SQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  real as pgReal,
  serial,
  index as pgIndex,
  uniqueIndex as pgUniqueIndex,
  primaryKey as pgPrimaryKey,
  type PgTableWithColumns,
  type PgColumnBuilderBase,
  type PgTextBuilderInitial,
  type PgIntegerBuilderInitial,
  type PgRealBuilderInitial,
  type PgSerialBuilderInitial,
  type PgColumn,
} from 'drizzle-orm/pg-core';
import {
  type BuildColumn,
  type TableConfig,
} from 'drizzle-orm';
import type { ColumnDef, TableDef } from './schema-defs.js';

// ── Column builder type mapping ────────────────────────────────────────────
// Mirrors the exact chains produced by the hand-written definitions:
//   sqlite text('id').primaryKey()                   -> IsPrimaryKey<NotNull<SQLiteTextBuilderInitial>>
//   sqlite integer('id').primaryKey({autoIncrement}) -> IsPrimaryKey<HasDefault<NotNull<SQLiteIntegerBuilderInitial>>>
//   pg     serial('id').primaryKey()                 -> IsPrimaryKey<NotNull<PgSerialBuilderInitial>>
//   any    .notNull()                                -> NotNull<...>
//   any    .default(v)                               -> HasDefault<...>
// Implemented with raw `_`-flag intersections (structurally identical to
// drizzle's NotNull/HasDefault/IsPrimaryKey) and deferred conditional
// wrappers so the generic constraints on BuildColumn/TableConfig are not
// eagerly evaluated against unresolved conditional types.

type SqliteBaseBuilder<D extends ColumnDef, TName extends string> =
  D['type'] extends 'text'
    ? SQLiteTextBuilderInitial<TName, [string, ...string[]], undefined>
    : D['type'] extends 'int'
      ? SQLiteIntegerBuilderInitial<TName>
      : SQLiteRealBuilderInitial<TName>;

type SqliteBuilderFor<D extends ColumnDef, TName extends string> =
  D extends { primaryKey: true }
    ? D extends { type: 'int' }
      ? SqliteBaseBuilder<D, TName> & { _: { isPrimaryKey: true; hasDefault: true; notNull: true } }
      : SqliteBaseBuilder<D, TName> & { _: { isPrimaryKey: true; notNull: true } }
    : D extends { notNull: true }
      ? SqliteBaseBuilder<D, TName> & { _: { notNull: true } }
      : SqliteBaseBuilder<D, TName>;

type PgBaseBuilder<D extends ColumnDef, TName extends string> =
  D['type'] extends 'text'
    ? PgTextBuilderInitial<TName, [string, ...string[]]>
    : D['type'] extends 'int'
      ? D extends { autoIncrement: true }
        ? PgSerialBuilderInitial<TName>
        : PgIntegerBuilderInitial<TName>
      : PgRealBuilderInitial<TName>;

type PgBuilderFor<D extends ColumnDef, TName extends string> =
  D extends { primaryKey: true }
    ? PgBaseBuilder<D, TName> & { _: { isPrimaryKey: true; notNull: true } }
    : D extends { notNull: true }
      ? PgBaseBuilder<D, TName> & { _: { notNull: true } }
      : PgBaseBuilder<D, TName>;

type SqliteColumnFor<TName extends string, B> =
  B extends SQLiteColumnBuilderBase ? BuildColumn<TName, B, 'sqlite'> : never;

type PgColumnFor<TName extends string, B> =
  B extends PgColumnBuilderBase ? BuildColumn<TName, B, 'pg'> : never;

type SqliteColumnsFor<TName extends string, C extends Record<string, ColumnDef>> = {
  [K in keyof C]: K extends string ? SqliteColumnFor<TName, SqliteBuilderFor<C[K], K>> : never;
};

type PgColumnsFor<TName extends string, C extends Record<string, ColumnDef>> = {
  [K in keyof C]: K extends string ? PgColumnFor<TName, PgBuilderFor<C[K], K>> : never;
};

type SqliteTableConfigFor<TName extends string, C extends Record<string, ColumnDef>> = {
  name: TName;
  schema: undefined;
  columns: SqliteColumnsFor<TName, C>;
  dialect: 'sqlite';
};

type PgTableConfigFor<TName extends string, C extends Record<string, ColumnDef>> = {
  name: TName;
  schema: undefined;
  columns: PgColumnsFor<TName, C>;
  dialect: 'pg';
};

type BuiltSqliteTable<TName extends string, C extends Record<string, ColumnDef>> = SqliteTableConfigFor<TName, C> extends infer Config extends TableConfig
  ? SQLiteTableWithColumns<Config>
  : never;

type BuiltPgTable<TName extends string, C extends Record<string, ColumnDef>> = PgTableConfigFor<TName, C> extends infer Config extends TableConfig
  ? PgTableWithColumns<Config>
  : never;

// ── Runtime builders ───────────────────────────────────────────────────────

type ColumnModifiers = {
  notNull(): ColumnModifiers;
  primaryKey(config?: { autoIncrement?: boolean }): ColumnModifiers;
  default(value: unknown): ColumnModifiers;
  unique(name?: string): ColumnModifiers;
  references(ref: () => unknown): ColumnModifiers;
};

function buildSqliteColumn(
  name: string,
  def: ColumnDef,
  resolveRef: (ref: NonNullable<ColumnDef['references']>) => unknown,
): SQLiteColumnBuilderBase {
  let col: unknown;
  if (def.type === 'text') col = text(name);
  else if (def.type === 'int') col = integer(name);
  else col = real(name);
  if (def.notNull) col = (col as ColumnModifiers).notNull();
  if (def.primaryKey) {
    if (def.type === 'int') col = (col as ColumnModifiers).primaryKey({ autoIncrement: def.autoIncrement ?? true });
    else col = (col as ColumnModifiers).primaryKey();
  }
  if (def.default !== undefined) col = (col as ColumnModifiers).default(def.default);
  if (def.unique) col = (col as ColumnModifiers).unique();
  if (def.references) {
    const ref = def.references;
    col = (col as ColumnModifiers).references(() => resolveRef(ref));
  }
  return col as SQLiteColumnBuilderBase;
}

function buildPgColumn(
  name: string,
  def: ColumnDef,
  resolveRef: (ref: NonNullable<ColumnDef['references']>) => unknown,
): PgColumnBuilderBase {
  let col: unknown;
  if (def.type === 'text') col = pgText(name);
  else if (def.type === 'int') {
    if (def.autoIncrement) col = serial(name);
    else col = pgInteger(name);
  } else col = pgReal(name);
  if (def.notNull) col = (col as ColumnModifiers).notNull();
  if (def.primaryKey) col = (col as ColumnModifiers).primaryKey();
  if (def.default !== undefined) col = (col as ColumnModifiers).default(def.default);
  if (def.unique) col = (col as ColumnModifiers).unique();
  if (def.references) {
    const ref = def.references;
    col = (col as ColumnModifiers).references(() => resolveRef(ref));
  }
  return col as PgColumnBuilderBase;
}

function sqliteIndexColumns(t: unknown, on: string[]): [SQLiteColumn, ...SQLiteColumn[]] {
  return on.map((cn) => (t as Record<string, SQLiteColumn>)[cn]) as [SQLiteColumn, ...SQLiteColumn[]];
}

function pgIndexColumns(t: unknown, on: string[]): [PgColumn, ...PgColumn[]] {
  return on.map((cn) => (t as Record<string, PgColumn>)[cn]) as [PgColumn, ...PgColumn[]];
}

function buildSqliteTable<TName extends string, C extends Record<string, ColumnDef>>(
  def: TableDef & { name: TName; columns: C },
  resolveRef: (ref: NonNullable<ColumnDef['references']>) => unknown,
): BuiltSqliteTable<TName, C> {
  const columns: Record<string, SQLiteColumnBuilderBase> = {};
  for (const [name, colDef] of Object.entries(def.columns)) {
    columns[name] = buildSqliteColumn(name, colDef, resolveRef);
  }
  const table = sqliteTable(def.name, columns, (t) => [
    ...(def.indexes ?? []).map((ix) =>
      ix.unique ? sqliteUniqueIndex(ix.name).on(...sqliteIndexColumns(t, ix.on)) : sqliteIndex(ix.name).on(...sqliteIndexColumns(t, ix.on)),
    ),
    ...(def.compositePrimaryKey
      ? [sqlitePrimaryKey({ columns: sqliteIndexColumns(t, def.compositePrimaryKey) })]
      : []),
  ]);
  return table as unknown as BuiltSqliteTable<TName, C>;
}

function buildPgTable<TName extends string, C extends Record<string, ColumnDef>>(
  def: TableDef & { name: TName; columns: C },
  resolveRef: (ref: NonNullable<ColumnDef['references']>) => unknown,
): BuiltPgTable<TName, C> {
  const columns: Record<string, PgColumnBuilderBase> = {};
  for (const [name, colDef] of Object.entries(def.columns)) {
    columns[name] = buildPgColumn(name, colDef, resolveRef);
  }
  const table = pgTable(def.name, columns, (t) => [
    ...(def.indexes ?? []).map((ix) =>
      ix.unique ? pgUniqueIndex(ix.name).on(...pgIndexColumns(t, ix.on)) : pgIndex(ix.name).on(...pgIndexColumns(t, ix.on)),
    ),
    ...(def.compositePrimaryKey
      ? [pgPrimaryKey({ columns: pgIndexColumns(t, def.compositePrimaryKey) })]
      : []),
  ]);
  return table as unknown as BuiltPgTable<TName, C>;
}

type AnyTable = Record<string, unknown>;

export function buildSqliteTables<T extends readonly TableDef[]>(
  defs: T,
): { [K in T[number]['name']]: BuiltSqliteTable<K, Extract<T[number], { name: K }>['columns']> } {
  const tables: Record<string, unknown> = {};
  const resolveRef = (ref: NonNullable<ColumnDef['references']>): unknown =>
    (tables[ref.table] as AnyTable | undefined)?.[ref.column];
  for (const def of defs) {
    tables[def.name] = buildSqliteTable(def, resolveRef);
  }
  return tables as unknown as { [K in T[number]['name']]: BuiltSqliteTable<K, Extract<T[number], { name: K }>['columns']> };
}

export function buildPgTables<T extends readonly TableDef[]>(
  defs: T,
): { [K in T[number]['name']]: BuiltPgTable<K, Extract<T[number], { name: K }>['columns']> } {
  const tables: Record<string, unknown> = {};
  const resolveRef = (ref: NonNullable<ColumnDef['references']>): unknown =>
    (tables[ref.table] as AnyTable | undefined)?.[ref.column];
  for (const def of defs) {
    tables[def.name] = buildPgTable(def, resolveRef);
  }
  return tables as unknown as { [K in T[number]['name']]: BuiltPgTable<K, Extract<T[number], { name: K }>['columns']> };
}
