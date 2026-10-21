// D1 rejects missing bindings; Node SQLite otherwise silently binds NULL.
export function assertBindings(sql: string, params: unknown[]) {
  const positional = (
    sql
      .replace(/'(?:''|[^'])*'/g, "''")
      .replace(/--[^\n]*/g, "")
      .match(/\?/g) || []
  ).length;
  if (positional !== params.length)
    throw new Error(
      `D1 binding count mismatch: expected ${positional}, received ${params.length}`,
    );
}
