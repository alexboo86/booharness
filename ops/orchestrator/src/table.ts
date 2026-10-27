// Round table (operator #19423): the pure tally over a table's turn-2 votes.
// The members and their parsed votes come from seats.ts; nothing here reads the store.

/** One member's cast vote, as the report's `vote` field holds it. */
export type TableVote = { option: string; confidence: number; changedBy: string | null };

export type TallyResult = {
  /** One row per option, in the order the options were given; confidence is summed, count counts cast votes. */
  counts: { option: string; count: number; confidence: number }[];
  /** The option on a strict majority of cast votes with >=2 cast; else 'chairman'. */
  decided: string;
  /** Number of members with a turn-2 vote. */
  cast: number;
  /** Labels of members whose turn-2 vote is missing. */
  notVoting: string[];
};

/**
 * Count turn-2 votes only. `decided` is an option only when at least two members voted AND one
 * option has more than half the cast votes; a tie or fewer than two cast votes falls to `chairman`.
 */
export function tallyTable(options: readonly string[], members: readonly { label: string; turn2: TableVote | null }[]): TallyResult {
  const cells = new Map(options.map((option) => [option, { count: 0, confidence: 0 }]));
  for (const member of members) {
    const vote = member.turn2;
    if (!vote) continue;
    const cell = cells.get(vote.option);
    if (!cell) continue; // an off-list option is refused at parse time; never counted here
    cell.count += 1;
    cell.confidence += vote.confidence;
  }
  const counts = options.map((option) => ({ option, ...cells.get(option)! }));
  const cast = counts.reduce((total, row) => total + row.count, 0);
  let decided = 'chairman';
  if (cast >= 2) {
    let top = counts[0];
    for (const row of counts) if (row.count > top.count) top = row;
    if (top.count > cast / 2) decided = top.option;
  }
  return {
    counts,
    decided,
    cast,
    notVoting: members.filter((member) => member.turn2 === null).map((member) => member.label),
  };
}

/** The appendix label for the i-th member in creation order: Member A, Member B, ... */
export function memberLabel(index: number): string {
  return `Member ${String.fromCharCode(65 + (index % 26))}`;
}
