/** Marks scaffolded code paths that are not implemented yet, with the milestone that delivers them. */
export function notImplemented(what: string, milestone: string): never {
  throw new Error(`${what} is not implemented yet (planned for ${milestone}).`);
}
