/**
 * A text description of the schema as the database holds it: extensions, tables with their partition key, columns, constraints and
 * indexes (partitions themselves left out, since they depend on the head). A test compares it with explorer/db/schema.snapshot.txt, so
 * a migration that changes the schema shows up as a change to that file in the same pull request.
 */
import type { Pool } from "pg";

const TABLES = `select c.oid, c.relname, pg_get_partkeydef(c.oid) as partkey
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition order by c.relname`;

export async function describeSchema(pool: Pool): Promise<string> {
  const out: string[] = [];
  const ext = await pool.query<{ extname: string }>("select extname from pg_extension order by extname");
  out.push(`extensions: ${ext.rows.map((r) => r.extname).join(", ")}`);
  const tables = await pool.query<{ oid: number; relname: string; partkey: string | null }>(TABLES);
  for (const t of tables.rows) {
    out.push("", `table ${t.relname}${t.partkey ? ` partition by ${t.partkey}` : ""}`);
    const cols = await pool.query<{ line: string }>(
      `select a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
          || case when a.attnotnull then ' not null' else '' end
          || case a.attidentity when 'a' then ' identity always' when 'd' then ' identity by default' else '' end
          || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') as line
         from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`,
      [t.oid],
    );
    for (const c of cols.rows) out.push(`  column ${c.line}`);
    const cons = await pool.query<{ line: string }>(
      "select conname || ' ' || pg_get_constraintdef(oid) as line from pg_constraint where conrelid = $1 and contype <> 'n' order by conname",
      [t.oid],
    );
    for (const c of cons.rows) out.push(`  constraint ${c.line}`);
    const idx = await pool.query<{ line: string }>("select pg_get_indexdef(indexrelid) as line from pg_index where indrelid = $1 order by 1", [t.oid]);
    for (const i of idx.rows) out.push(`  ${i.line}`);
  }
  return `${out.join("\n")}\n`;
}
