# Search Console log

How orthodoxy.au does in Google search, one entry per export, so the next
reader can compare a new export with the last one instead of starting over.
How the pages are built for search — which are indexed, the sitemap, robots —
is in `docs/lite-pages.md`; what waits on this data is "Once there is data" in
`docs/roadmap.md`.

## How to add an entry

1. Search Console → Performance → Search results → Export (CSV or zip).
2. Add a dated section below with the same headings: totals, pages, queries,
   devices, and what it means. Keep the raw numbers; the reading can change.
3. Check Indexing → Pages and Sitemaps too, and note how many parish pages
   are indexed — that number is the one to watch first.

## Setup

- 2026-10-03 — orthodoxy.au verified in Search Console.
- 2026-10-07 — `sitemap.xml` submitted (home page + 293 parish pages). Lite
  parish pages (`/<acronym>`) went live with PR #65; before that every link
  served the app shell.

## 2026-10-05 — baseline (29 Sep – 3 Oct, before the sitemap)

**Totals:** 12 impressions, 0 clicks, average position 39.3. All Australia.

| Day | Impressions | Position |
|---|---|---|
| 29 Sep | 2 | 60 |
| 30 Sep | 4 | 37.5 |
| 1 Oct | 1 | 1 |
| 2 Oct | 0 | — |
| 3 Oct | 5 | 40.2 |

**Pages:** only `https://orthodoxy.au/` (12). No parish page had appeared.

**Queries** (impressions, position):

| Query | Impr. | Pos. |
|---|---|---|
| greek orthodox near me | 2 | 51 |
| orthodox churches | 2 | 71 |
| orthodox near me | 1 | 37 |
| greek orthodox church service today | 1 | 46 |
| greek orthodox church near me | 1 | 61 |
| greek orthodox sydney | 1 | 69 |

**Devices:** desktop 10 (pos. 46.3), mobile 2 (pos. 4.5).

**Reading:**
- Too little to conclude anything; this is the line to measure from.
- Every query is local intent ("near me", "service today"). The home page
  ranks on page 4–7 for them, where Google's map pack and each church's own
  Business Profile win. Parish pages are the ones that could rank, for
  "<parish or suburb> + liturgy / service times" — none was indexed yet.
- The one position-1 impression (1 Oct, mobile) is most likely a search for
  the site's name, which Google hides from the query list.
- Content limits this more than SEO: ~82 service rules across 293 parishes,
  so most parish pages have no times to show.

**Next look (late October):** are parish URLs appearing under Pages, for
which queries, and do the ones with timetables do better than the empty ones?
That decides whether event pages should be indexed (`docs/lite-pages.md`).
