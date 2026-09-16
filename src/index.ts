interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Sotheby's MCP — realized auction prices from sothebys.com.
 *
 * Sotheby's is NOT the Bonhams shape. Its past-lot pages are a Next.js app
 * whose data arrives from a separate GraphQL backend, so there is no
 * server-rendered search page to scrape. Two public, keyless endpoints carry
 * everything this pack needs, and NEITHER is `/bsp-api/*`:
 *
 *   1. `clientapi.prod.sothelabs.com/graphql` — Sotheby's own public bidding
 *      API. Unauthenticated `POST` works (introspection is off, but the
 *      operation documents are in the site's own JS bundles). It serves
 *      `algoliaSearchKey`, `auction.lotCardsFromIds` and `lotV2`.
 *   2. `KAR1UEUPJD-dsn.algolia.net` index `prod_lots` — the search index the
 *      site itself queries, reached with a short-lived search key handed out
 *      by (1) to any anonymous caller. This is the ONLY cross-auction search
 *      path; it spans every house sale, not one auction.
 *
 * Neither host is `www.sothebys.com`, so the `Crawl-delay: 15` and the
 * `Disallow: /bsp-api/*` in https://www.sothebys.com/robots.txt (checked
 * 2026-09-05) do not cover them — `clientapi.prod.sothelabs.com` serves no
 * robots.txt at all (404). This pack makes no request to www.sothebys.com;
 * it only builds www URLs for humans to click.
 *
 * WHAT IS AND ISN'T PUBLIC — this is the whole shape of the pack. The Algolia
 * index carries no prices at all (`price` is null on every record), so the
 * realized price comes from the GraphQL `bidState.sold` union, which is
 * `ResultVisible` or `ResultHidden` depending on whether Sotheby's publishes
 * that sale's results here. Measured 2026-09-05 across 44 distinct sales in a
 * 100-hit "Pablo Picasso" sample, the split is not noisy — it is a clean rule:
 *
 *   - `auctionType: Live` (the saleroom sales): ALWAYS hidden, 0/11 sales
 *     visible, including 2025 and 2026 ones. Sotheby's publishes live results
 *     on its own results pages, not through this bidding platform.
 *   - `auctionType: Timed` (online sales) from ~2021 on: ALWAYS visible,
 *     18/18 sales, every lot in them.
 *   - `Timed` before ~2021: hidden (15/15 sales) — the platform predates the
 *     retention.
 *
 * So `sale_type` defaults to `timed`, because that is the slice of the archive
 * where a realized price exists at all; asking for `live` returns lots with
 * null prices however famous they are, and the tool says so rather than
 * pretending the parse failed. A hidden result is Sotheby's withholding it.
 *
 * Third of the art-house survey (Bonhams, Sotheby's, Phillips); Christie's is
 * closed (internal API) and out of scope.
 */


const UA = 'pipeworx-mcp-sothebys/1.0 (+https://pipeworx.io)';
const GQL = 'https://clientapi.prod.sothelabs.com/graphql';
const ALGOLIA_APP = 'KAR1UEUPJD';
const ALGOLIA_INDEX = 'prod_lots';
const SITE = 'https://www.sothebys.com';

/** Algolia hits pulled per search page before the price filter runs. */
const SCAN_PER_PAGE = 100;
/** Cap on parallel GraphQL price lookups (one per distinct auction). */
const MAX_AUCTION_LOOKUPS = 20;

const tools: McpToolExport['tools'] = [
  {
    name: 'sothebys_results_search',
    description:
      "Search Sotheby's past-lot archive by artist/maker (or any keyword) and return realized prices: price including buyer's premium, winning (hammer) bid, estimate range, sale name/date/location and department. Covers every Sotheby's sale in the index, not one auction. Defaults to `sale_type: \"timed\"` (online sales) because those are the ones Sotheby's publishes results for — live-saleroom sales are searchable but their prices are withheld, so a famous evening-sale lot will come back with a null price whatever you do.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Artist, maker, or keyword, e.g. "Pablo Picasso", "Patek Philippe".' },
        category: {
          type: 'string',
          description: 'Optional free-text filter matched against the lot\'s department names, e.g. "prints", "photographs", "jewelry".',
        },
        page: { type: 'number', description: `Search page, 1-based (each page scans up to ${SCAN_PER_PAGE} matching lots). Default 1.` },
        limit: { type: 'number', description: 'Max lots to return (1-50, default 20).' },
        sale_type: {
          type: 'string',
          enum: ['timed', 'live', 'any'],
          description:
            'Which sales to search. "timed" (default) = online sales, the only ones whose realized prices Sotheby\'s publishes. "live" = saleroom sales, searchable but with prices withheld. "any" = both.',
        },
        include_unpriced: {
          type: 'boolean',
          description: "Also return lots whose result Sotheby's withholds, with null prices. Default false.",
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'sothebys_lot_details',
    description:
      "Full detail for one Sotheby's lot: catalogue description, provenance, literature, exhibition history, catalogue note, images, estimate range, and the realized price (including buyer's premium) where Sotheby's publishes it. Needs the `lot_id` from sothebys_results_search.",
    inputSchema: {
      type: 'object',
      properties: {
        lot_id: {
          type: 'string',
          description: 'Lot UUID from sothebys_results_search\'s `lot_id` field, e.g. "bca81c91-e36d-482c-a705-064e06671fb0".',
        },
      },
      required: ['lot_id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'sothebys_results_search':
      return resultsSearch(args);
    case 'sothebys_lot_details':
      return lotDetails(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── transport ───────────────────────────────────────────────────────

async function gql(query: string, variables: Record<string, unknown>, label: string): Promise<any> {
  const res = await fetchWithTimeout(
    GQL,
    {
      method: 'POST',
      headers: { 'User-Agent': UA, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    },
    "Sotheby's",
  );
  if (!res.ok) throw new Error(`Sotheby's ${label}: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: unknown; errors?: Array<{ message?: string }> };
  if (body.errors?.length) throw new Error(`Sotheby's ${label}: ${body.errors[0]?.message ?? 'GraphQL error'}`);
  return body.data;
}

/**
 * The Algolia search key is minted per request by Sotheby's GraphQL and is a
 * secured (time-limited) key, so it is cached only briefly — long enough to
 * spare the extra round trip inside one tool call and across a burst, short
 * enough that expiry is never our problem.
 */
let cachedKey: { key: string; until: number } | null = null;
const KEY_TTL_MS = 5 * 60 * 1000;

async function algoliaKey(): Promise<string> {
  if (cachedKey && cachedKey.until > Date.now()) return cachedKey.key;
  const data = await gql(
    'query AlgoliaSearchKeyQuery($filters: [KeyValuePair!]) { algoliaSearchKey(requestedFilters: $filters) { key } }',
    {},
    'search key',
  );
  const key = data?.algoliaSearchKey?.key;
  if (typeof key !== 'string' || !key) throw new Error("Sotheby's search key: no key returned.");
  cachedKey = { key, until: Date.now() + KEY_TTL_MS };
  return key;
}

async function algoliaSearch(body: Record<string, unknown>): Promise<any> {
  const key = await algoliaKey();
  const res = await fetchWithTimeout(
    `https://${ALGOLIA_APP}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}/query`,
    {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'content-type': 'application/json',
        'X-Algolia-Application-Id': ALGOLIA_APP,
        'X-Algolia-API-Key': key,
      },
      body: JSON.stringify(body),
    },
    "Sotheby's",
  );
  if (!res.ok) {
    // A stale cached key is the one failure worth retrying, and only once.
    if (res.status === 403 && cachedKey) {
      cachedKey = null;
      return algoliaSearch(body);
    }
    throw new Error(`Sotheby's lot search: HTTP ${res.status}`);
  }
  return res.json();
}

// ── sothebys_results_search ─────────────────────────────────────────

const LOT_PRICE_QUERY = `query LotCardsQuery($id: String!, $lotIds: [String!]!, $language: TranslationLanguage!) {
  auction(id: $id, language: $language) {
    __typename
    testRecord
    lotCards: lotCardsFromIds(ids: $lotIds) {
      __typename
      lotId
      bidState {
        __typename
        numberOfBids
        currentBidV2 { __typename currency amount }
        sold {
          __typename
          ... on ResultVisible {
            isSold
            premiums { __typename finalPriceV2 { __typename currency amount } }
          }
        }
      }
    }
  }
}`;

interface LotResult {
  lot_id: string;
  title: string;
  creators: string[];
  lot_number: string | null;
  departments: string[];
  sale_name: string;
  sale_date: string | null;
  sale_location: string | null;
  currency: string;
  estimate_low: number | null;
  estimate_high: number | null;
  hammer_price: number | null;
  realized_price_inc_premium: number | null;
  sold: boolean | null;
  result_published: boolean;
  url: string;
}

async function resultsSearch(args: Record<string, unknown>): Promise<unknown> {
  const query = strArg(args.query);
  if (!query) throw new Error('query is required.');
  const category = strArg(args.category).toLowerCase();
  const page = clamp(numArg(args.page, 1), 1, 100);
  const limit = clamp(numArg(args.limit, 20), 1, 50);
  const includeUnpriced = args.include_unpriced === true;
  const saleType = saleTypeArg(args.sale_type);

  const filters = ['auctionState:CLOSED', 'isTestLot:false', 'withdrawn:false'];
  if (saleType !== 'any') filters.push(saleType === 'live' ? 'auctionType:Live' : 'auctionType:Timed');

  const search = await algoliaSearch({
    query,
    page: page - 1,
    hitsPerPage: SCAN_PER_PAGE,
    filters: filters.join(' AND '),
    attributesToHighlight: [],
    attributesToRetrieve: [
      'objectID',
      'auctionId',
      'title',
      'creators',
      'creatorsDisplayTitle',
      'departments',
      'lotDisplayNumber',
      'currency',
      'lowEstimate',
      'highEstimate',
      'auctionName',
      'auctionDate',
      'auctionLocation',
      'auctionType',
      'slug',
    ],
  });

  const allHits: any[] = Array.isArray(search?.hits) ? search.hits : [];
  const hits = allHits.filter((h) => h && (!category || departmentsOf(h).some((d) => d.toLowerCase().includes(category))));

  // Prices come one auction at a time, so bucket the hits by sale and spend
  // the capped budget of GraphQL calls NEWEST FIRST: published results start
  // around 2021 (see the header note), so relevance order — which happily
  // ranks 2019 sales first — spends the whole budget on sales that can only
  // answer "hidden". Output order stays relevance order regardless.
  const buckets = new Map<string, any[]>();
  for (const h of hits) {
    const aid = typeof h.auctionId === 'string' ? h.auctionId : '';
    if (!aid) continue;
    const bucket = buckets.get(aid);
    if (bucket) bucket.push(h);
    else buckets.set(aid, [h]);
  }
  const lookedUp = [...buckets.entries()]
    .sort((a, b) => String(b[1][0].auctionDate ?? '').localeCompare(String(a[1][0].auctionDate ?? '')))
    .slice(0, MAX_AUCTION_LOOKUPS);

  const priced = new Map<string, any>();
  const settled = await Promise.allSettled(
    lookedUp.map(([auctionId, bucket]) =>
      gql(LOT_PRICE_QUERY, { id: auctionId, lotIds: bucket.map((h) => String(h.objectID)), language: 'ENGLISH' }, 'lot prices'),
    ),
  );
  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue;
    const auction = outcome.value?.auction;
    if (!auction || auction.testRecord === true) continue;
    for (const card of auction.lotCards ?? []) {
      if (card?.lotId) priced.set(String(card.lotId), card.bidState ?? null);
    }
  }

  const results: LotResult[] = [];
  for (const h of hits) {
    const bidState = priced.get(String(h.objectID)) ?? null;
    const sold = bidState?.sold?.__typename === 'ResultVisible' ? bidState.sold : null;
    const finalPrice = sold?.premiums?.finalPriceV2 ?? null;
    const realized = amountOf(finalPrice);
    if (realized === null && !includeUnpriced) continue;
    results.push({
      lot_id: String(h.objectID),
      title: typeof h.title === 'string' ? h.title : '',
      creators: creatorsOf(h),
      lot_number: h.lotDisplayNumber != null ? String(h.lotDisplayNumber) : null,
      departments: departmentsOf(h),
      sale_name: typeof h.auctionName === 'string' ? h.auctionName : '',
      sale_date: typeof h.auctionDate === 'string' ? h.auctionDate : null,
      sale_location: typeof h.auctionLocation === 'string' ? h.auctionLocation : null,
      currency: finalPrice?.currency ?? (typeof h.currency === 'string' ? h.currency : ''),
      estimate_low: numOrNull(h.lowEstimate),
      estimate_high: numOrNull(h.highEstimate),
      hammer_price: amountOf(bidState?.currentBidV2),
      realized_price_inc_premium: realized,
      sold: sold ? sold.isSold === true : null,
      result_published: realized !== null,
      url: lotUrlFromSlug(h.slug),
    });
    if (results.length >= limit) break;
  }

  return {
    source: `${ALGOLIA_INDEX} @ ${ALGOLIA_APP}-dsn.algolia.net + ${GQL}`,
    query,
    category_filter: category || null,
    sale_type: saleType,
    page,
    total_hits: numOrNull(search?.nbHits),
    scanned: hits.length,
    priced_lookups: lookedUp.length,
    count: results.length,
    results,
    note: emptyNote(results.length, hits.length, saleType),
  };
}

function saleTypeArg(v: unknown): 'timed' | 'live' | 'any' {
  const s = strArg(v).toLowerCase();
  return s === 'live' || s === 'any' ? s : 'timed';
}

function emptyNote(count: number, scanned: number, saleType: string): string | undefined {
  if (count > 0) return undefined;
  if (scanned === 0) return "No Sotheby's lots matched. Try the artist's full name, or sale_type:\"any\" to widen the search beyond online sales.";
  if (saleType === 'live')
    return "Sotheby's does not publish realized prices for live-saleroom sales through this API — every live lot comes back with a null price. Use the default sale_type:\"timed\" for priced results.";
  return "Sotheby's matched lots but publishes no realized price for any on this page; published results start around 2021, so an older-only match returns none. Try a later page, a narrower query, or include_unpriced:true to see the matches without prices.";
}

// ── sothebys_lot_details ────────────────────────────────────────────

const LOT_DETAIL_QUERY = `query LotV2Query($lotId: String!, $language: TranslationLanguage!, $countryOfOrigin: String) {
  lotV2(lotId: $lotId, language: $language, countryOfOrigin: $countryOfOrigin) {
    __typename
    ... on LotV2 {
      lotId
      title
      subtitle
      slug
      creatorsDisplayTitle
      designationLine
      sapAuctionSaleNumber
      lotNumber { __typename ... on VisibleLotNumber { lotDisplayNumber } }
      auction {
        __typename
        auctionId
        title
        sapSaleNumber
        currencyV2
        state
        type
        departmentNames
        testRecord
        slug { __typename name year }
        locationV2 { __typename name }
      }
      estimateV2 {
        __typename
        ... on LowHighEstimateV2 {
          lowEstimate { __typename amount }
          highEstimate { __typename amount }
        }
      }
      bidState {
        __typename
        numberOfBids
        currentBidV2 { __typename currency amount }
        sold {
          __typename
          ... on ResultVisible {
            isSold
            premiums { __typename finalPriceV2 { __typename currency amount } }
          }
        }
      }
      description
      provenance
      catalogueNote
      literature
      exhibition
      saleroomNotice
      media(imageSizes: [Large]) {
        __typename
        images { __typename renditions { __typename url width height } }
      }
    }
  }
}`;

async function lotDetails(args: Record<string, unknown>): Promise<unknown> {
  const lotId = strArg(args.lot_id);
  if (!lotId) throw new Error('lot_id is required.');

  const data = await gql(LOT_DETAIL_QUERY, { lotId, language: 'ENGLISH', countryOfOrigin: 'US' }, `lot ${lotId}`);
  const lot = data?.lotV2;
  if (!lot || lot.__typename !== 'LotV2') {
    throw new Error(`Sotheby's lot ${lotId}: not found. lot_id must be the UUID from sothebys_results_search's lot_id field.`);
  }

  const auction = lot.auction ?? {};
  const sold = lot.bidState?.sold?.__typename === 'ResultVisible' ? lot.bidState.sold : null;
  const finalPrice = sold?.premiums?.finalPriceV2 ?? null;
  const realized = amountOf(finalPrice);

  return {
    source: GQL,
    lot_id: String(lot.lotId ?? lotId),
    title: lot.title ?? '',
    subtitle: lot.subtitle ?? null,
    creator: lot.creatorsDisplayTitle ?? null,
    designation: lot.designationLine ?? null,
    lot_number: lot.lotNumber?.lotDisplayNumber ?? null,
    sale_name: auction.title ?? '',
    sale_number: auction.sapSaleNumber ?? lot.sapAuctionSaleNumber ?? null,
    sale_location: auction.locationV2?.name ?? null,
    sale_state: auction.state ?? null,
    departments: Array.isArray(auction.departmentNames) ? auction.departmentNames.map(String) : [],
    currency: finalPrice?.currency ?? auction.currencyV2 ?? '',
    estimate_low: amountOf(lot.estimateV2?.lowEstimate),
    estimate_high: amountOf(lot.estimateV2?.highEstimate),
    hammer_price: amountOf(lot.bidState?.currentBidV2),
    realized_price_inc_premium: realized,
    sold: sold ? sold.isSold === true : null,
    result_published: realized !== null,
    number_of_bids: numOrNull(lot.bidState?.numberOfBids),
    description: stripTags(lot.description ?? ''),
    provenance: stripTags(lot.provenance ?? '') || null,
    catalogue_note: stripTags(lot.catalogueNote ?? '') || null,
    literature: stripTags(lot.literature ?? '') || null,
    exhibition: stripTags(lot.exhibition ?? '') || null,
    saleroom_notice: stripTags(lot.saleroomNotice ?? '') || null,
    image_url: firstImageUrl(lot.media),
    url: lotUrl(auction.slug?.year, auction.slug?.name, lot.slug),
  };
}

// ── helpers ─────────────────────────────────────────────────────────

/** Algolia stores the site-relative lot path; anything else is not linkable. */
function lotUrlFromSlug(slug: unknown): string {
  return typeof slug === 'string' && slug.startsWith('/') ? `${SITE}${slug}` : SITE;
}

function lotUrl(year: unknown, saleSlug: unknown, lotSlug: unknown): string {
  if (typeof year === 'string' && typeof saleSlug === 'string' && typeof lotSlug === 'string') {
    return `${SITE}/en/buy/auction/${year}/${saleSlug}/${lotSlug}`;
  }
  return SITE;
}

/** Amounts arrive as decimal STRINGS on the Amount type, not numbers. */
function amountOf(amount: unknown): number | null {
  if (!amount || typeof amount !== 'object') return null;
  return numOrNull((amount as Record<string, unknown>).amount);
}

function creatorsOf(hit: any): string[] {
  if (Array.isArray(hit?.creators) && hit.creators.length) return hit.creators.map(String);
  return typeof hit?.creatorsDisplayTitle === 'string' && hit.creatorsDisplayTitle ? [hit.creatorsDisplayTitle] : [];
}

function departmentsOf(hit: any): string[] {
  return Array.isArray(hit?.departments) ? hit.departments.map(String) : [];
}

function firstImageUrl(media: unknown): string | null {
  const images = (media as any)?.images;
  if (!Array.isArray(images)) return null;
  for (const image of images) {
    for (const rendition of image?.renditions ?? []) {
      if (typeof rendition?.url === 'string' && rendition.url) return rendition.url;
    }
  }
  return null;
}

function stripTags(s: string): string {
  return decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
function strArg(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function numArg(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
