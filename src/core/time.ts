/** The current instant as the ISO-8601 string every timestamp column in the schema stores. */
export function nowIso(): string {
  return new Date().toISOString();
}
