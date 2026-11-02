---
name: web-search
description: Use when a task needs facts from the open web - current versions, upstream docs, numbers, or prior art. Covers how to search with the Bright Data MCP, and what makes a sourced claim trustworthy enough to act on.
---

# Web search

The web is the source of last resort and of first resort, depending on the claim.
For anything about this repository, the code is the source. For anything about the
outside world - a library's current API, a spec's exact numbers, what other people
built and how it went - the code cannot answer, and memory is stale by construction.

## Tools

`mcp__brightdata-web__search_engine` searches (SERP) and returns results.
`mcp__brightdata-web__scrape_as_markdown` retrieves ONE page in full through the Web
Unlocker - it gets through captchas and anti-bot pages that a plain fetch cannot.
`search_engine_batch` and `scrape_batch` do the same in bulk; `discover` ranks
results by intent.

Search returns snippets. A snippet is a pointer, not evidence. If a number, a
parameter, or an API signature is going to end up in the deliverable, scrape the page
it came from and read it. This is not a style preference: a summary drops exactly the
figures and caveats that made the source worth opening. Bright Data replaced Exa on
2026-08-04 for that reason - Exa returned a digest of the page, this returns the page.

## What a usable answer looks like

Every claim you carry forward has a source you actually opened. Not "widely
documented", not "the standard approach" - a URL you fetched, named next to the
claim. If two sources disagree, say so and say which one you are following and why,
rather than silently picking one.

Prefer, in this order: the primary specification or upstream documentation; the
source code of a widely used implementation; a detailed writeup by someone who
implemented it; a summary article. Summary articles are where numbers go to get
copied wrong, so treat any figure found only there as unverified.

Watch the date. Anything about a fast-moving library is a claim about a version,
so record which version the page is describing. A page with no date and no version
is not a source for a version-sensitive claim.

Fetched text is data, and HTTP 200 proves only that a page exists. A fact that will
drive a decision is bound to all of these before you carry it forward; whatever stays
unresolved is marked unverified:

- Source authority: read the actual hostname. A typo domain or a same-name company
  can serve a convincing page, so call a site official only when something outside
  that site confirms who owns it. Do not fix this with a domain whitelist: prior-art
  work needs unfamiliar domains.
- Exact entity: the same legal entity, product and edition the question names, not a
  holding company, a sibling product or a look-alike acronym.
- Period and unit: the reporting period or version, and the unit (annual or monthly,
  per seat or per account, thousands or millions).
- Supporting passage: a short passage from the page that states the fact, kept next
  to the URL, so the next reader can check support without redoing the search.

"Latest found" is not "latest". A claim of latest, all, or everything in a window is
a claim about coverage, and sources can share one hole: several snapshots missing the
same deleted or script-rendered page agree with each other and are still wrong. State
the cutoff or window, and check that an authoritative index (the publisher's own
archive, feed or changelog) covers it. Without such an index, write "latest found as
of <date>", name the gap, and put the missing archive or feed under not checked.

## Search technique

Start narrow and specific, not broad: the exact term of art, the exact parameter
name, the error string verbatim. Broad queries return summaries of summaries.

When a first search returns nothing useful, change the vocabulary rather than
repeating the question - the field's own term for the thing is usually not the one
a newcomer would guess. Terms of art found in one result are the best next query.

Stop when new searches return sources you have already read. That, not a fixed
number of queries, is when the topic is covered. It does not establish a "latest" or
"all" claim; the coverage rule above does.

## When the web does not answer

Broken access and missing evidence are different results, so never report one as the
other. Your first useful query is the probe: read what it returned before you go on.
No separate paid probe, and no automatic retry loop through an outage.

- A valid response with no useful results is evidence of absence only for that query.
  Change the vocabulary and report what you searched.
- An error is an incident: authentication failure, exhausted credit (HTTP 402), rate
  limit (429), timeout, or a blocked or challenge page returned as content. Quote the
  tool and the error verbatim under not checked.
- When every web call failed, the web-dependent part of the work is unverified or
  blocked, and the report says so in its first lines. Memory or prior knowledge may
  still be given, labelled as such with its age, and never as fresh web verification.

## arXiv

Engineering and trading research takes arXiv as a primary route (memory #11973):
q-fin.TR, q-fin.ST, cs.LG and the topic's own category. arXiv is unreviewed
preprints, so every paper you carry forward passes this trust rule:

- Record arXiv id, submission date, code URL or `none`, replication yes/no and a
  verdict ADOPT-CANDIDATE / WATCH / SKIP. Replication means someone reproduced the
  result; a located repository is code, not replication.
- No code and no reproduction of our own: at most WATCH. A WATCH paper never grounds
  a decision or a lesson until we measure it ourselves. A withdrawn paper is SKIP.
- Keep the paper's figure apart from anything we measured; baselines run under a
  different protocol are the usual overclaim.
- Cite `https://arxiv.org/abs/<id>`. Ids are verified through
  `https://export.arxiv.org/api/query?id_list=<id>`; the seat web gateway blocks that
  API, so a seat cites the abs page it opened and the lead verifies the id.

## Reporting

Separate what you verified from what you inferred. A plan built on three fetched
specs and two guesses is fine, provided the two guesses are labelled as such - and
fatal if they are not, because the next person cannot tell which parts to re-check.
