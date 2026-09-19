# @pipeworx/sothebys

Realized auction prices from Sotheby's — search the past-lot archive by artist
or maker across every sale, and get the price including buyer's premium, the
winning (hammer) bid, the estimate range and the sale's name/date/location;
pull full catalogue detail (description, provenance, literature, exhibition
history, images) for one lot.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `sothebys_results_search(query, category?, sale_type?, page?, limit?, include_unpriced?)`
  — search the archive by artist/maker/keyword. `category` is a free-text
  filter matched against the lot's department names (e.g. "prints",
  "photographs"). `sale_type` is `"timed"` (default), `"live"` or `"any"` —
  see **What is and isn't public** below, it is the single most important
  argument here.
- `sothebys_lot_details(lot_id)` — full catalogue detail for one lot, keyed by
  the `lot_id` a `sothebys_results_search` result carries.

Tools are prefixed with the house name deliberately: three art-house packs
(Bonhams, Sotheby's, Phillips) expose the same two shapes, so bare
`results_search` would collide across them and make `ask_pipeworx` routing
ambiguous.

## Auth

Keyless. Both upstreams serve anonymous callers; the Algolia search key is
minted on demand by Sotheby's own public GraphQL and cached for 5 minutes.

## Data sources

Sotheby's is **not** the Bonhams shape. Its lot pages are a Next.js app fed by
a separate GraphQL backend, so there is no server-rendered search page to read.
Two public, keyless endpoints carry everything, and neither is `/bsp-api/*`:

- `https://clientapi.prod.sothelabs.com/graphql` — Sotheby's own public bidding
  API. Unauthenticated `POST` works. Introspection is disabled by its Cosmo
  Router, but the operation documents ship in the site's own JS bundles under
  `/buy/_next/static/chunks/`. Three operations are used:
  - `AlgoliaSearchKeyQuery` → a search key for the index below. Requesting no
    filters yields a key scoped to the whole index, not one auction.
  - `LotCardsQuery(id, lotIds, language)` → `auction.lotCardsFromIds`, the
    per-auction batch price lookup. `bidState.currentBidV2` is the winning
    (hammer) bid; `bidState.sold.premiums.finalPriceV2` is the realized price
    including buyer's premium. Amounts arrive as decimal **strings**.
    `auction.testRecord` flags Sotheby's QA sales, which are in the index.
  - `lotV2(lotId, language, countryOfOrigin)` → full catalogue detail. It
    returns the `Lottable` interface, so the selection needs
    `... on LotV2 { … }`; `condition` is an object, not a string.
- `https://KAR1UEUPJD-dsn.algolia.net/1/indexes/prod_lots/query` — the search
  index the site itself queries (`window.ALGOLIA_APP_ID` /
  `window.ALGOLIA_INDEX_NAME` in the page source). This is the only
  cross-auction search path. It carries `creators`, `departments`, estimates,
  `auctionType`, `auctionDate` and the site-relative lot `slug` — but **no
  prices at all**: `price` is null on every record, which is why every search
  costs a second, per-auction GraphQL round trip.

Neither host is `www.sothebys.com`, so the `Crawl-delay: 15` and the
`Disallow: /bsp-api/*` in <https://www.sothebys.com/robots.txt> (checked
2026-09-05) do not cover them; `clientapi.prod.sothelabs.com` serves no
robots.txt at all (404). **This pack makes no request to www.sothebys.com** —
it only builds www URLs for a human to click.

## What is and isn't public

The realized price comes from the GraphQL `bidState.sold` union, which is
either `ResultVisible` or `ResultHidden` depending on whether Sotheby's
publishes that sale's results through this platform. Measured 2026-09-05
across the 44 distinct sales in a 100-hit "Pablo Picasso" sample, the split is
a clean rule rather than noise:

| slice | sales visible |
|---|---|
| `auctionType: Live` (saleroom sales), any year including 2025–26 | **0 of 11** |
| `auctionType: Timed` (online sales), ~2021 onwards | **18 of 18**, every lot |
| `auctionType: Timed`, before ~2021 | **0 of 15** |

So `sale_type` defaults to `timed`: that is the slice of the archive where a
realized price exists at all. Asking for `live` returns lots with null prices
however famous they are — Sotheby's publishes live-saleroom results on its own
results pages, not through this API — and the tool says so in `note` rather
than letting it read as a parse failure.

Two consequences worth knowing when reading a response:

- `sothebys_results_search` scans a page of up to 100 search hits and returns
  the priced subset, so `count` is normally well below `scanned`, and
  `total_hits` (the whole archive match count) is far larger than both.
- Price lookups are spent **newest sale first**, not in relevance order.
  Relevance happily ranks 2019 sales top for "Pablo Picasso", and those can
  only answer "hidden"; output order is still relevance order.

## Related

- `bonhams` — same two-tool shape for Bonhams, whose realized prices are plain
  server-rendered HTML.
- Phillips is the third house in this survey; Christie's is closed (internal
  API) and out of scope.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "sothebys": {
      "url": "https://gateway.pipeworx.io/sothebys/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/sothebys/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/sothebys_results_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Pablo Picasso","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/sothebys_results_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "sothebys": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-sothebys"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-sothebys
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Sothebys data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
