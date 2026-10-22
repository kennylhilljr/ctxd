/**
 * W6: generates the search benchmark's corpus and labeled queries (test/fixtures/search-bench/).
 * Run by hand when the fixture set needs to change: `npx tsx scripts/gen-search-bench-fixtures.ts`.
 * Deterministic and offline; only scripts/gen-search-bench-embeddings.ts needs the network, to
 * precompute vectors for this script's output.
 *
 * 25 invented topics x 8 (scope, kind) combinations = 200 entries. Each topic carries a keyword
 * query (exact vocabulary from its entries), a paraphrase query (the same meaning, deliberately
 * no shared salient words, to actually exercise embeddings rather than bm25), and a mixed query
 * (partial overlap). All 8 entries under a topic are that topic's relevant set for all three of
 * its queries: 25 x 3 = 75 labeled queries.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SCOPES = ["sample-app", "notes", "project-b", "shared-tools", "pool-dev", "pool-notes", "pool-ops", "pool-private"] as const;
const KINDS = ["note", "fact", "lesson", "decision", "convention", "journal", "handoff", "task"] as const;

interface Topic {
  id: string;
  title: string;
  body: string;
  keyword: string;
  paraphrase: string;
  mixed: string;
}

const TOPICS: Topic[] = [
  { id: "blue-green", title: "Blue-green deployment rollback", body: "The blue-green deployment keeps the previous release warm so a rollback just flips the router back, with no rebuild and no downtime.", keyword: "blue-green deployment rollback", paraphrase: "how to switch traffic back to the old version safely", mixed: "rollback to the old version after a deployment" },
  { id: "conn-pool", title: "Database connection pooling", body: "Connection pool exhaustion happens when every pooled connection is checked out and a new request has nowhere to go; raise the pool size or fix a leak that never returns connections.", keyword: "connection pool exhaustion", paraphrase: "running out of available database links under load", mixed: "database running out of pooled connections" },
  { id: "rate-limit", title: "Rate limiting API requests", body: "Rate limit responses return 429 with a Retry-After header once a client exceeds its quota in the current window.", keyword: "rate limit 429 responses", paraphrase: "throttling how often clients can call an endpoint", mixed: "limiting how many requests a client can send" },
  { id: "secret-rotate", title: "Rotating credentials on a schedule", body: "Rotate API keys quarterly, revoking the previous key only after every service has picked up the new one.", keyword: "rotate API keys quarterly", paraphrase: "replacing credentials on a regular schedule", mixed: "rotating API keys regularly" },
  { id: "flag-rollout", title: "Gradual feature flag rollout", body: "A gradual feature flag rollout ramps a new capability from 1% to 100% of traffic, watching error rates at each step before widening it.", keyword: "gradual feature flag rollout", paraphrase: "slowly turning on a new capability for more users over time", mixed: "gradually turning on a feature flag for more traffic" },
  { id: "cache-invalidate", title: "Cache invalidation on write", body: "Cache invalidation on write clears or updates the cached copy the moment the underlying row changes, so stale data is never served after an edit.", keyword: "cache invalidation stale data", paraphrase: "making sure old cached results don't get served after a change", mixed: "invalidating the cache after a change to avoid stale data" },
  { id: "structured-log", title: "Structured JSON logging", body: "Structured JSON logging writes one JSON object per log line with fixed field names, so a log pipeline can filter and aggregate without regex parsing.", keyword: "structured JSON logging", paraphrase: "writing log lines in a machine-parseable format", mixed: "logging in a structured JSON format" },
  { id: "flaky-test", title: "Flaky tests in CI", body: "A flaky test fails intermittently in CI for reasons unrelated to the code under test, usually timing, shared state, or network calls; quarantine it rather than retrying blindly.", keyword: "flaky test retries CI", paraphrase: "tests that sometimes fail for no clear reason", mixed: "flaky tests that sometimes fail in CI" },
  { id: "pr-checklist", title: "Pull request review checklist", body: "A pull request review checklist covers tests, naming, error handling and whether the diff matches its stated intent before approval.", keyword: "pull request review checklist", paraphrase: "what to look for before approving someone's changes", mixed: "checklist for reviewing a pull request before approving" },
  { id: "postmortem", title: "Blameless incident postmortem", body: "A blameless incident postmortem documents the timeline, root cause and action items from an outage without naming who made the mistake.", keyword: "incident postmortem blameless", paraphrase: "writing up what went wrong after an outage without assigning blame", mixed: "writing a blameless postmortem after an incident" },
  { id: "zero-downtime-migration", title: "Zero downtime schema migration", body: "A zero downtime schema migration adds the new column as nullable, backfills it in batches, then only later makes it required, so no deploy ever waits on a lock.", keyword: "zero downtime schema migration", paraphrase: "changing the database structure without taking the service offline", mixed: "migrating the schema without any downtime" },
  { id: "dep-upgrade", title: "Upgrading a major dependency", body: "Upgrading a major dependency version means reading its changelog for breaking changes first, then fixing call sites before touching the lockfile.", keyword: "upgrade major dependency version", paraphrase: "moving to a newer release of a library that breaks compatibility", mixed: "upgrading to a new major version of a dependency" },
  { id: "alert-fatigue", title: "Alert fatigue from noisy pages", body: "Alert fatigue sets in when too many low-signal pages fire, so engineers start ignoring real incidents along with the noise; tune thresholds before adding more alerts.", keyword: "alert fatigue noisy pages", paraphrase: "getting paged too often for things that don't matter", mixed: "too many noisy pages causing alert fatigue" },
  { id: "load-test", title: "Load testing throughput and latency", body: "A load test ramps simulated traffic to find the throughput and latency ceiling before real users do, and the point where error rate starts climbing.", keyword: "load test throughput latency", paraphrase: "measuring how the system behaves under heavy simulated traffic", mixed: "testing throughput under heavy load" },
  { id: "backup-restore", title: "Encrypted backup and restore", body: "An encrypted backup is useless without a tested restore path; practice decrypting and restoring it on a schedule, not only when a real outage forces the question.", keyword: "encrypted backup restore", paraphrase: "making sure you can recover data after it's encrypted and stored safely", mixed: "restoring from an encrypted backup" },
  { id: "short-lived-token", title: "Short-lived access tokens", body: "Short-lived access tokens expire in minutes, not days, so a stolen token is only useful to an attacker for a narrow window.", keyword: "short lived access tokens", paraphrase: "credentials that expire quickly to limit exposure if stolen", mixed: "access tokens that expire quickly" },
  { id: "onboarding", title: "New engineer onboarding checklist", body: "A new hire onboarding checklist covers accounts, local setup, a first small pull request, and who to ask when something is unclear.", keyword: "new hire onboarding checklist", paraphrase: "getting an engineer set up and productive in their first week", mixed: "onboarding checklist for a new engineer's first week" },
  { id: "api-versioning", title: "API versioning for breaking changes", body: "A breaking API version change ships alongside the old one under a new version prefix, so existing callers keep working until they migrate on their own schedule.", keyword: "breaking change API version", paraphrase: "introducing incompatible changes to an interface without disrupting existing callers", mixed: "introducing a breaking change to the API version" },
  { id: "backoff-retry", title: "Exponential backoff on retry", body: "Exponential backoff doubles the wait between retries after a failure, with jitter added so many clients don't retry in lockstep and overwhelm the service again.", keyword: "exponential backoff retry", paraphrase: "waiting progressively longer between repeated attempts after a failure", mixed: "retrying with exponential backoff after a failure" },
  { id: "search-ranking", title: "Tuning search relevance ranking", body: "Tuning search relevance ranking means adjusting how keyword match, recency and importance are weighted so the most useful result lands near the top, not just any match.", keyword: "search relevance ranking tuning", paraphrase: "making the most useful results show up first", mixed: "tuning the ranking so the best results show up first" },
  { id: "missing-index", title: "Slow queries from a missing index", body: "A slow query with no index behind it scans every row; add the index on the filtered column and the same query returns in milliseconds.", keyword: "slow query missing index", paraphrase: "a lookup taking too long because the database has nothing to speed it up", mixed: "a slow query that needs an index" },
  { id: "crash-loop", title: "Container crash loop on restart", body: "A container crash loop restarts over and over because the process exits immediately on startup; check the startup logs before assuming it is a resource limit.", keyword: "container restart crash loop", paraphrase: "a process that keeps failing and starting over endlessly", mixed: "a container that keeps crashing and restarting" },
  { id: "secret-leak", title: "Secrets leaked into logs", body: "A secret leaked into logs usually comes from an exception handler that prints the whole request object; redact known secret fields before any log line is written.", keyword: "secret leaked in logs", paraphrase: "sensitive credentials accidentally ending up somewhere they shouldn't", mixed: "a secret that leaked into the logs" },
  { id: "stale-docs", title: "Stale documentation", body: "Stale documentation describes a flow that no longer matches the code; the fix is linking docs to the code they describe so a change forces a review of both.", keyword: "stale outdated documentation", paraphrase: "docs that no longer match how the system actually behaves", mixed: "documentation that is now outdated" },
  { id: "cpu-profile", title: "CPU profiling a hot path", body: "CPU profiling a hot path samples where time is actually spent, usually revealing one unexpected function rather than confirming whatever was guessed beforehand.", keyword: "CPU profiling hot path", paraphrase: "finding which part of the code is using the most processing time", mixed: "profiling the CPU to find the hot path" },
];

interface CorpusEntry {
  id: string;
  topic: string;
  scope: string;
  kind: string;
  title: string;
  body: string;
}

interface LabeledQuery {
  id: string;
  topic: string;
  type: "keyword" | "paraphrase" | "mixed";
  query: string;
  relevant: string[];
}

const KIND_PREFIX: Record<string, string> = {
  note: "Note",
  fact: "Fact",
  lesson: "Lesson learned",
  decision: "Decision",
  convention: "Convention",
  journal: "Journal",
  handoff: "Handoff",
  task: "Task",
};

function buildCorpus(): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  for (const topic of TOPICS) {
    for (let i = 0; i < 8; i++) {
      const scope = SCOPES[i]!;
      const kind = KINDS[i]!;
      entries.push({
        id: `${topic.id}-${scope}`,
        topic: topic.id,
        scope,
        kind,
        title: topic.title,
        body: `${KIND_PREFIX[kind]}: ${topic.body}`,
      });
    }
  }
  return entries;
}

function buildQueries(corpus: CorpusEntry[]): LabeledQuery[] {
  const queries: LabeledQuery[] = [];
  for (const topic of TOPICS) {
    const relevant = corpus.filter((e) => e.topic === topic.id).map((e) => e.id);
    queries.push({ id: `${topic.id}-keyword`, topic: topic.id, type: "keyword", query: topic.keyword, relevant });
    queries.push({ id: `${topic.id}-paraphrase`, topic: topic.id, type: "paraphrase", query: topic.paraphrase, relevant });
    queries.push({ id: `${topic.id}-mixed`, topic: topic.id, type: "mixed", query: topic.mixed, relevant });
  }
  return queries;
}

const corpus = buildCorpus();
const queries = buildQueries(corpus);

const outDir = join(import.meta.dirname, "..", "test", "fixtures", "search-bench");
writeFileSync(join(outDir, "corpus.json"), JSON.stringify(corpus, null, 2));
writeFileSync(join(outDir, "queries.json"), JSON.stringify(queries, null, 2));
console.log(`wrote ${corpus.length} corpus entries and ${queries.length} labeled queries to ${outDir}`);
