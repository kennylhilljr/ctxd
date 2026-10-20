import { runSearch, type SearchInput } from "../search/fts.js";
import type { RequestContext } from "../server/context.js";

/** context_search (SPEC v6 sections 4.2, 11.2): a thin wrapper over search/fts.ts's runSearch. */
export async function contextSearch(ctx: RequestContext, input: SearchInput): Promise<unknown> {
  return runSearch(ctx, input);
}
