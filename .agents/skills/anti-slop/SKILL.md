---
name: anti-slop
description: >
  The copywriter default beside the kit-excluded product copy skill. Find and remove machine-text
  tells in English and Russian copy: UI strings, landing pages, terminal docs,
  academy. The kit-excluded product copy skill owns where text lives and the gates it passes; this
  skill owns how the words read. Run on every copy change before delivery.
---

# Anti-slop — machine-text tells in EN and RU copy

## Read this first: the cluster rule

A tell counts in a cluster — three or more in one paragraph — not alone. One
dash, one «важно отметить», one triplet is not a verdict: when in doubt whether
a phrase is the author or the machine, leave it. Two families stand outside the
cluster rule and count alone: technical artifacts (mechanical leftovers a
person never types) and self-commentary (text describing its own argument
instead of making it).

Over-sterile text is a failure too. The goal is copy a person at work would
have written — not copy scrubbed of every flagged word. Fix the cluster, keep
the voice.

## Passes, in order

1. Facts. Nothing added to the source: no causal link between facts that
   merely sit together («поэтому», "which means"), no upgraded confidence, no
   invented taxonomy ("three reasons" over items that never were a row), no
   assigned reader reaction («это знакомо каждому», "you will discover").
2. Self-commentary. Cut text about the text: «главный аргумент здесь»,
   "here's where it gets interesting", «но об этом ниже». If cutting it
   changes nothing, it was scaffolding.
3. Technical artifacts (search, don't judge): U+202F narrow no-break space;
   citation leftovers oaicite, turn0search0, 【】; utm_source=chatgpt.com in
   links; a leaked chat frame («Конечно, вот…», "Of course!", "I hope this
   helps"); markdown bold in a surface that renders none.
4. Vocabulary and structure — the lists below, judged by the cluster rule.
5. Fresh read, then the final check pass at the end of this skill.

## Shared tells, both languages

- Structure: forced triads; negative parallelism with no real contrast
  (Not X. Not Y. Z. / «не просто X — это Y»); false ranges ("from startups to
  enterprises", «от частных лиц до корпораций») whose ends share no scale;
  synonym cycling (the feature / the capability / the solution); a perfectly
  balanced two-for-two argument with a concession after every claim; staccato
  fragments for drama («Скорость. Вот и всё.»).
- Words: EN — delve, crucial, pivotal, tapestry, testament, underscore,
  leverage, seamless, robust, vibrant, landscape (abstract). RU — «важно
  отметить», «играет ключевую роль», «в современном мире», «комплексный
  подход», «раскрыть потенциал», «динамично развивается», «инновационный».
- Copula substitutes: "serves as", "stands as" / «служит инструментом»,
  «выступает примером» — write is / это with a real verb.
- Vague authority: "experts believe", «эксперты считают», "studies show" —
  name the source or cut the claim.
- Promo adjectives without a fact: "powerful and flexible", «надёжный и
  удобный» — cut, or replace with the number or the mechanism.
- Feelings instead of function: "blazing-fast charts", «удобные графики» —
  write what it does or measures: "renders 100 000 candles". Swap test: move
  the sentence into a rival product's docs; if it still fits, it carries no
  fact about ours.
- Filler: "in order to" becomes "to"; «осуществление проверки» becomes
  «проверили»; an intensifier on a vague verb ("greatly speeds up") gives way
  to the number: "opens in 0.4 s instead of 2 s".

## Russian specifics

- The em dash (тире) is normal Russian punctuation. It is not a marker, alone
  or in ordinary density; never remove one for being one.
- Парцелляция alone is not a marker either: people write it too, and the gap
  to machines is small. Fix it when several land in one paragraph.
- A capital letter after a colon is not a marker.
- Канцелярит is the main Russian tell: verbs folded into abstract nouns.
  Unfold them with an actor: «осуществление внедрения» becomes «мы внедрили».
- Do not swap a spoken word for its bookish synonym («вроде» → «в
  некоторой степени», «я допёр» → «я определил»): flattening a live voice is a
  defect, not a fix.
- Grammar calques: a деепричастие whose subject cannot act («Используя этот
  метод, результаты улучшаются») — name the actor; mechanical SVO in every
  sentence — let Russian word order move as it does; case disagreement left
  by a rewrite.
- Register: legal wording goes to the kit-excluded Russian-legal product skill and its rules outrank
  style here; formal docs keep formal register — the bans above are for
  landing, docs and academy prose.

## English specifics

- Em dashes are fine in moderation; the tell is one in every second sentence,
  not the dash itself.
- Title-case headings and bold-label bullets ("**Performance:** performance
  improved") are formatting tells; use sentence case and prose.
- Chatbot residue: "Great question!", "Let me know if…", "I hope this helps";
  hedging stacks ("could potentially perhaps be"); "Not just X, but Y"; a
  generic close ("The future looks bright") — write the plan or the number.
- Register: technical docs may keep the passive when the actor does not
  matter; replace business buzzwords, not domain terms.

## UI strings

A label or tooltip cannot carry paragraph rules; apply only what fits: name
the mechanism, not a feeling; cut filler; keep the claim identical across
locales (the kit-excluded product copy skill owns key parity and the gates). Error text stays
actionable — what failed and what to try — and that outranks brevity.

## Final check pass

1. Meaning survived: no invented facts, no upgraded confidence, no liveliness
   added that the source never had — local edits only, never a voice
   transplant.
2. Alive: the copy keeps a concrete number or name, a live verb where a
   noun-pile was, and the author's position where one existed; no stacked
   paired epithets remain. A paragraph with zero markers and zero specifics
   has been sterilized — put the fact back.
3. Report: quote each fixed cluster — the fragment, the tells counted, the
   fix.

Sources are restated, not copied; see PROVENANCE.md beside this file.
