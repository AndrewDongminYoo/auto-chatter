import { readFile } from "node:fs/promises";

const schemaUrl = new URL("../db/schema.sql", import.meta.url);

/** Returns the tables that `db/schema.sql` creates, in declaration order. */
export function schemaTableNames(schema: string): string[] {
  return [...schema.matchAll(/^CREATE TABLE IF NOT EXISTS (\w+)/gm)].map((match) => match[1]!);
}

/**
 * Drops every table that `db/schema.sql` creates, then applies the schema again.
 *
 * The schema uses `CREATE TABLE IF NOT EXISTS`, so a table that a reset leaves in place keeps its old
 * definition. A `CASCADE` drop of a parent removes only the child's foreign key, and the schema does not
 * add that key back. Deriving the drop list from the schema keeps every table in the reset.
 */
export async function resetTestSchema(db: { query(sql: string): Promise<unknown> }): Promise<void> {
  const schema = await readFile(schemaUrl, "utf8");
  const tables = schemaTableNames(schema);
  if (tables.length === 0) throw new Error("db/schema.sql declares no tables");
  await db.query(`DROP TABLE IF EXISTS ${tables.join(", ")} CASCADE`);
  await db.query(schema);
}
