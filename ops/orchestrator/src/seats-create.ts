import type { SeatManager } from './seats.ts';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { defaultHarness, FAMILIES, hasAdapter } from './providers/index.ts';
import type { Family, Harness } from './providers/types.ts';
import { effectiveInstruments } from './shared.entry.ts';
import { isStandArm } from './stand.ts';
import { remotePiMcpPath } from './remote-pi-mcp.ts';
import type { Seat } from './store.ts';
import { accountingRole, appliesToModel, MAX_REVIEWERS, pickFamily, rankFamilies, roleMatrix, windowMs } from './profiles.ts';
import { readPaused } from './paused-families.ts';
import { readHost, readHosts } from './config.ts';
import { hostInstrumentCauses, lighterHost, missingHostInstruments, needsBrightdataWeb, placeSeat, PLATFORM_NEEDS, touchesMacDesktop, type Candidate, type LoadProbe, type PlatformNeed, type Target } from './placement.ts';
import { assertMirrorPath } from './remote-worktree.ts';
import { checkoutTop, largestUntrackedSnapshotDirs, repoOf, resolveCommit, snapshotBytes, snapshotCommit } from './worktrees.ts';
import { chainHolds } from './seats-drain.ts';
import { ROLE_POLICY, landable, reviewRights, normalizeFile, SAFE } from './seats-defs.ts';
import type { SeatRole, CreateSeat, Choose } from './seats-defs.ts';
import { seatModel } from './seats-scope.ts';
import { imageInput } from './model-input.ts';


export const SNAPSHOT_REMOTE_MAX_BYTES = 256 * 1024 * 1024;

const SKILL_MAP = new URL('.agents/domains/_skill-map.json', new URL('../../../', import.meta.url));

type SkillMap = {
  roleDefaults?: Record<string, unknown>;
  skills?: Record<string, { requires?: unknown }>;
};

/** Absent, unreadable, or not a JSON object: no role default needs images. Not cached: each create reads again, as the context builder does. */
function readSkillMap(mapPath: string | URL): SkillMap | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(mapPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as SkillMap;
  } catch {
    return null;
  }
}

/** A role default skill holds the requires token input:image. Sync: the pick adds no await. */
function roleNeedsImages(role: string, map: SkillMap | null): boolean {
  if (!map) return false;
  const names = map.roleDefaults?.[role];
  if (!Array.isArray(names)) return false;
  return names.some((name) => {
    if (typeof name !== 'string') return false;
    const requires = map.skills?.[name]?.requires;
    return Array.isArray(requires) && requires.includes('input:image');
  });
}

/** Lead flag, or a role default that requires image input. A non-boolean flag is refused. `images: true` does not read the map. */
function effectiveImages(input: { role: string; images?: unknown }, mapPath: string | URL = SKILL_MAP): boolean {
  if (input.images !== undefined && typeof input.images !== 'boolean') throw new Error('images must be true or false');
  if (input.images === true) return true;
  return roleNeedsImages(input.role, readSkillMap(mapPath));
}

/** The round-table option list a create carries, or undefined (operator #19423). Refused when malformed. */
function tableOptions(input: { role: string; options?: unknown }): string[] | undefined {
  if (input.options === undefined) return undefined;
  if (input.role !== 'debater') throw new Error('options is for a debater round table only');
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 4
    || input.options.some((option) => typeof option !== 'string' || !option.trim() || Array.from(option).length > 60)) {
    throw new Error('options must be 2-4 non-empty strings of at most 60 characters each');
  }
  const trimmed = input.options.map((option) => option.trim());
  if (new Set(trimmed).size !== trimmed.length) throw new Error('options must be distinct after trimming');
  return trimmed;
}
export async function createIdempotent(self: SeatManager, input: CreateSeat, choose: Choose & { replaces?: string }, skillMap?: string): Promise<Seat> {
    if (typeof input.request_id !== 'string' || !/^[A-Za-z0-9][\w.-]{0,127}$/.test(input.request_id)) throw new Error('request_id must be 1..128 characters of letters, digits, _, - or .');
    // A retry of a create whose answer the client lost (task 1757): the stored row,
    // or the create still running, is the answer — never a second seat. Role, title,
    // repo and the effective images value must match; a different create reusing the id is refused.
    // Compare after the D5 alias. A row stored before it (role scout, data.critic true) is a critic;
    // a plain-scout reuse of that request_id still refuses.
    const criticOf = (row: { role: string; critic?: boolean; data?: Record<string, unknown> | null }): boolean => row.role === 'critic' || row.critic === true || row.data?.critic === true;
    const roleOf = (row: { role: string; critic?: boolean; data?: Record<string, unknown> | null }): string =>
      row.role === 'critic' || (row.role === 'scout' && (row.critic === true || row.data?.critic === true)) ? 'critic' : row.role;
    const requestId = input.request_id;
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const refuse = (seatId: string): never => {
      throw new Error(`request_id ${requestId} already belongs to ${seatId}`);
    };
    const images = effectiveImages(input, skillMap);
    const options = tableOptions(input);
    const mismatched = (seat: { role: string; title: string; critic?: boolean; data?: Record<string, unknown> | null }): boolean =>
      roleOf(input) !== roleOf(seat) || title !== seat.title || criticOf(input) !== criticOf(seat) || images !== (seat.data?.images === true)
      || JSON.stringify(options) !== JSON.stringify(Array.isArray(seat.data?.options) ? seat.data.options : undefined);
    // A known mismatch refuses before any chain wait. Repo comparison stays with resolution.
    const stored = self.store.seatByRequestId(requestId);
    if (stored && mismatched(stored)) refuse(stored.id);
    const finish = async (onCoderChain: boolean): Promise<Seat> => {
      const existing = self.store.seatByRequestId(requestId);
      if (existing && mismatched(existing)) refuse(existing.id);
      let top: string;
      try {
        // Same named failure as createSeat: a request_id create queued behind removal must not
        // report the generic missing-directory text from repoOf.
        if (onCoderChain && !existsSync(input.repo)) throw new Error(`checkout removed: ${input.repo}`);
        top = (await repoOf(input.repo)).top;
      } catch (error) {
        if (existing) refuse(existing.id);
        throw error;
      }
      if (existing) {
        if (top !== existing.data.repo) refuse(existing.id);
        return existing;
      }
      const inFlight = self.creating.get(requestId);
      if (inFlight) {
        if (input.role !== inFlight.role || title !== inFlight.title || top !== inFlight.repo || (input.role === 'critic') !== inFlight.critic || images !== inFlight.images || JSON.stringify(options) !== JSON.stringify(inFlight.options)) {
          const row = self.store.seatByRequestId(requestId);
          refuse(row?.id ?? 'a create still in flight');
        }
        return inFlight.work;
      }
      // Already on the coder chain: createSeat must not queue again, or this wait deadlocks.
      const work = onCoderChain
        ? createSeat(self, input, choose, skillMap, images, true)
        : self.createSeat(input, choose, skillMap, images);
      self.creating.set(requestId, { role: input.role, title, repo: top, critic: input.role === 'critic', images, options, work });
      try { return await work; } finally { self.creating.delete(requestId); }
    };
    const owner = await coderOwningCheckout(self, input.repo);
    if (!owner) return finish(false);
    // Already inside this coder's chain (its turn): waiting for the chain waits for ourselves.
    if (chainHolds(owner)) return finish(true);
    let result: Seat | undefined;
    let failure: unknown;
    self.chain(owner, async () => {
      try { result = await finish(true); }
      catch (error) { failure = error; }
    });
    await self.chains.get(owner);
    if (failure) throw failure;
    return result!;
  }

/** The placement reason of a lead's needs mac, with the reason the lead stated (task 3288). */
function macPinNote(stated: string | undefined): string {
  return `needs mac${stated ? ` (${stated})` : ''}: this Mac, not probed (decision #12522)`;
}

function sameCheckout(left: string, right: string): boolean {
  if (existsSync(left) && existsSync(right)) {
    try { return realpathSync(left) === realpathSync(right); }
    catch { /* one path vanished; compare the strings */ }
  }
  return path.resolve(left) === path.resolve(right);
}

/** A coder seat whose checkout is `repo` or the checkout that contains it: the local worktree or stateDir/mirrors/<id>.
 * A coder's worktree is always stateDir/worktrees/<id> or stateDir/mirrors/<id>, so the checkout top's
 * basename names the only seat that can own it: one row read, not a scan of the stored history (task 2637). */
export async function coderOwningCheckout(self: SeatManager, repo: string): Promise<string | null> {
  let top: string;
  try { top = await checkoutTop(repo); }
  catch { return null; }
  const seat = self.store.getSeat(path.basename(top));
  if (!seat || !landable(seat.role) || typeof seat.worktree !== 'string') return null;
  const local = path.join(self.options.stateDir, 'worktrees', seat.id);
  const mirror = path.join(self.options.stateDir, 'mirrors', seat.id);
  if (seat.worktree !== local && seat.worktree !== mirror) return null;
  return sameCheckout(seat.worktree, top) ? seat.id : null;
}

export async function createSeat(self: SeatManager, input: CreateSeat, choose: Choose & { replaces?: string }, skillMap?: string, images?: boolean, onCoderChain = false): Promise<Seat> {
    const createStart = Date.now();
    if (!Object.hasOwn(ROLE_POLICY, input.role)) throw new Error(`role must be one of ${Object.keys(ROLE_POLICY).join(', ')}`);
    const role = input.role as SeatRole;
    if (input.family !== undefined && !(FAMILIES as readonly string[]).includes(input.family)) throw new Error(`family must be one of ${FAMILIES.join(', ')}`);
    if (input.harness !== undefined && input.harness !== 'pi' && input.harness !== 'native') throw new Error("harness must be 'pi' or 'native'");
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) throw new Error('title must be 1..200 characters');
    for (const [name, value] of [['model', input.model], ['effort', input.effort]] as const) {
      if (value !== undefined && (typeof value !== 'string' || !SAFE.test(value))) throw new Error(`${name} '${value}' is not a plain identifier`);
    }
    // A plan critic is role 'critic' (#13286, #13875; the old scout flag is aliased away in
    // create, plan 14746 D5): its family pool, model and effort come from roleMatrix().critic — the
    // reviewer matrix — so an explicit model/effort and an explicit native harness are refused
    // here; omitted harness keeps Claude's matrix model.
    const critic = role === 'critic';
    const options = tableOptions(input);
    const needsImages = images ?? effectiveImages(input, skillMap);
    if (input.coauthors !== undefined && (!Array.isArray(input.coauthors) || input.coauthors.length > 20
      || [...input.coauthors].some((id) => typeof id !== 'string') || new Set(input.coauthors).size !== input.coauthors.length)) {
      throw new Error('coauthors must be an array of unique seat id strings, at most 20');
    }
    // An empty list names no coauthor: it is absent, not a request that needs an author.
    const coauthors = input.coauthors === undefined || input.coauthors.length === 0 ? undefined : [...input.coauthors];
    if (critic && input.model !== undefined) throw new Error("a critic's model comes from the reviewer matrix; do not pass model");
    if (critic && input.effort !== undefined) throw new Error("a critic's effort comes from the reviewer matrix (high); do not pass effort");
    if (critic && input.harness === 'native') throw new Error('a critic needs its reviewer-matrix model, which the native harness would drop; use the pi harness');
    // Refused at creation, not silently all-on: a mistyped arm would measure the wrong thing.
    const instruments = effectiveInstruments(input.instruments);
    if (input.standArm !== undefined && !isStandArm(input.standArm)) throw new Error(`unknown stand arm '${String(input.standArm)}'`);
    if (input.standArm === 'no-codegraph') {
      if ((input.instruments as Record<string, unknown> | undefined)?.codegraph === true) throw new Error('no-codegraph arm cannot enable codegraph');
      instruments.codegraph = false;
    }
    const policy = ROLE_POLICY[role];
    if (input.needs !== undefined && !(PLATFORM_NEEDS as readonly unknown[]).includes(input.needs)) throw new Error(`needs must be one of ${PLATFORM_NEEDS.join(', ')}`);
    const needs = (input.needs ?? 'any') as PlatformNeed;
    if (input.host !== undefined && input.harness === 'native') throw new Error('remote seats require the pi harness; native is not supported');
    // A stand arm runs Pi with a Mac-local HOME and profile, which remote Pi refuses at its first turn.
    if (input.host !== undefined && input.standArm !== undefined) throw new Error('an A/B stand arm runs on this Mac only; host is not supported with standArm');
    // Omitted needs uses load placement (decision #12591), except seats confined to this Mac.
    // An explicit non-Mac need still refuses native and stand arms rather than silently narrowing it.
    const placing = input.host === undefined && needs !== 'mac';
    if (placing && input.needs !== undefined && input.harness === 'native') throw new Error(`needs ${needs} may place the seat on a host, which requires the pi harness; native is not supported`);
    if (placing && input.needs !== undefined && input.standArm !== undefined) throw new Error(`an A/B stand arm runs on this Mac only; needs ${needs} is not supported with standArm`);
    const probing = placing && input.harness !== 'native' && input.standArm === undefined && (input.family !== 'claude' || input.needs !== undefined);
    const parent = input.parent === undefined ? null : self.store.getSeat(input.parent);
    if (input.parent !== undefined && ((role !== 'scout' && role !== 'critic') || !parent)) throw new Error('parent names the seat a scout answers, and only a scout or a critic has one');
    const parentHost = typeof parent?.data.host === 'string' ? parent.data.host : null;
    if (parentHost && input.host !== undefined && input.host !== parentHost) throw new Error('a scout must run on its parent host');
    let hostName = parentHost ?? input.host;
    let remoteHost = hostName === undefined ? null : readHost(hostName, self.options.stateDir);
    // An explicit host picks the machine, but never over a need it contradicts: mac is this Mac, win a win32 host (decision #12522).
    const desktopFile = input.files?.find(touchesMacDesktop);
    if (remoteHost && desktopFile) throw new Error(`host ${hostName} contradicts ${desktopFile}: this Mac's desktop runtime requires this Mac`);
    if (remoteHost && input.needs === 'mac') throw new Error(`host ${hostName} contradicts needs mac: mac means this Mac (decision #12522); omit host or pass needs any`);
    if (remoteHost && input.needs === 'win' && remoteHost.platform !== 'win32') throw new Error(`host ${hostName} is ${remoteHost.platform}, which contradicts needs win: win needs a win32 host`);
    const owner = onCoderChain ? null : await coderOwningCheckout(self, input.repo);
    // The owner's own scout (scout_request) arrives while the owner's turn holds its chain, outside
    // that async stack; queueing would wait for the turn that waits for this scout (task 2602).
    // The running turn keeps the checkout in use, so the sweep cannot remove it meanwhile.
    if (owner && (chainHolds(owner) || input.parent === owner)) return createSeat(self, input, choose, skillMap, images, true);
    if (owner) {
      let result: Seat | undefined;
      let failure: unknown;
      self.chain(owner, async () => {
        try { result = await createSeat(self, input, choose, skillMap, images, true); }
        catch (error) { failure = error; }
      });
      await self.chains.get(owner);
      if (failure) throw failure;
      return result!;
    }
    if (onCoderChain && !existsSync(input.repo)) throw new Error(`checkout removed: ${input.repo}`);
    const { top, main } = await repoOf(input.repo);
    const title = input.title.trim();
    if (input.snapshot && policy.worktree === 'none') throw new Error(`a ${role} reads the lead's checkout in place; snapshot is for coder and reviewer seats`);
    if (input.snapshot && input.base !== undefined) throw new Error('snapshot and base are exclusive: a snapshot sits on HEAD');
    if (reviewRights(role) && input.base === undefined && !input.snapshot) throw new Error(`a ${role} reviews the accumulated diff: give \`base\` (the commit that holds the whole change; name its diff range in the brief) or \`snapshot\` (your uncommitted work)`);
    const hosts = probing && !remoteHost ? readHosts(self.options.stateDir) : {};
    // Without hosts, the omitted need has no other machine to rank: preserve the local, unprobed path.
    const shouldProbe = !remoteHost && probing && (input.needs !== undefined || Object.keys(hosts).length > 0);
    const commit = policy.worktree === 'none' && !remoteHost && !shouldProbe ? null : input.snapshot ? await snapshotCommit(top) : await resolveCommit(top, input.base ?? 'HEAD');
    const snapshotSize = input.snapshot && commit ? await snapshotBytes(top, commit) : null;
    const snapshotLimit = self.options.snapshotRemoteMaxBytes ?? SNAPSHOT_REMOTE_MAX_BYTES;
    const oversizedSnapshot = snapshotSize !== null && snapshotSize > snapshotLimit;
    const snapshotReason = oversizedSnapshot ? `snapshot ${snapshotSize} bytes exceeds remote limit ${snapshotLimit} bytes; stays on this Mac` : null;
    if (oversizedSnapshot && (hostName !== undefined || needs === 'win')) {
      const directories = await largestUntrackedSnapshotDirs(top, commit!);
      throw new Error(`snapshot ${snapshotSize} bytes exceeds remote limit ${snapshotLimit} bytes; cannot use ${hostName !== undefined ? `host ${hostName}` : 'needs win'}. Largest untracked top-level directories: ${directories}; ignore or move them before creating a remote snapshot seat`);
    }
    // Checkout and load awaits precede the cap check; from refreshAvoid to insertSeat there is no await (#10756).
    const probed = shouldProbe && !oversizedSnapshot ? await self.probeTargets(Object.keys(hosts)) : null;
    const retryTimedOutInstruments = async (target: Target, probe: LoadProbe): Promise<LoadProbe> => {
      if (target === 'local' || !probe.ok) return probe;
      const checks = missingHostInstruments(probe, instruments).map(tool => probe.instrumentChecks?.[tool as keyof NonNullable<typeof probe.instrumentChecks>]);
      // An absent or unknown required tool is already a refusal, not a transient.
      if (!checks.length || checks.some(check => check?.status !== 'timed out')) return probe;
      return self.options.probeLoad(target);
    };
    if (probed) await Promise.all([...probed].map(async ([target, probe]) => {
      probed.set(target, await retryTimedOutInstruments(target, probe));
    }));
    // Forced hosts (including parent-bound scouts) use the same combined probe,
    // before a row can promise tools. They cannot fall back to a different machine.
    if (remoteHost) {
      const probe = await retryTimedOutInstruments(hostName!, await self.options.probeLoad(hostName!));
      if (probe.ok === false) throw new Error(`${hostName} probe failed: ${probe.error}`);
      if (needsBrightdataWeb(role) && probe.capabilities?.['brightdata-web'] !== true)
        throw new Error(`${hostName} missing capability: brightdata-web (BRIGHTDATA_API_KEY required for ${role})`);
      const missing = missingHostInstruments(probe, instruments);
      if (missing.length) throw new Error(`${hostName} missing instrument: ${hostInstrumentCauses(probe, missing)}`);
    }
    const probeMs = Date.now() - createStart;
    // Who steps aside: the author of the change under review, and the reviewers already on this task.
    const avoid = new Set<Family>();
    const paused = new Set(readPaused(self.options.stateDir));
    const MODEL_RULE = 'a reviewer or critic never runs the model of the author, a coauthor or an earlier reviewer (model rule)';
    const modelHolders: { seat: Seat; why: string }[] = [];
    const familyAside = new Set<Family>();
    const blockedModels = new Map<string, string>();
    const refreshAvoid = () => {
      avoid.clear();
      modelHolders.length = 0;
      familyAside.clear();
      blockedModels.clear();
      let claudeMayReview = critic;
      const claudeWriters: string[] = [];
      if (coauthors !== undefined) {
        if (input.author === undefined) throw new Error('coauthors requires author naming the primary coder seat');
        if (!reviewRights(role) && !critic) throw new Error("coauthors is for a reviewer or a plan critic (role: 'critic') only");
      }
      if (input.author !== undefined) {
        if (!reviewRights(role) && !critic) throw new Error("author names the coder seat a reviewer reviews; a critic seat (role: 'critic') also takes one");
        const author = self.store.getSeat(input.author);
        if (!author) throw new Error(`author: no seat ${input.author}`);
        if (reviewRights(role) && input.snapshot !== true && landable(author.role) && author.data.snapshot !== true
          && typeof author.data.base === 'string' && commit === author.data.base) {
          throw new Error(`review commit ${commit} is the commit author ${author.id} started from; use repo: ${author.worktree ?? author.cwd}, snapshot: true, author: ${author.id}, or a base commit that holds the change`);
        }
        avoid.add(author.family as Family);
        modelHolders.push({ seat: author, why: `author ${author.id}` });
        claudeMayReview = (reviewRights(role) || critic) && author.family !== 'claude';
        if (author.family === 'claude') claudeWriters.push(`author ${author.id}`);
      }
      for (const id of coauthors ?? []) {
        if (id === input.author) throw new Error(`coauthor: ${id} is the author; name it once, in author`);
        const coauthor = self.store.getSeat(id);
        if (!coauthor || !landable(coauthor.role)) throw new Error(`coauthor: ${id} must name an existing coder seat`);
        avoid.add(coauthor.family as Family);
        modelHolders.push({ seat: coauthor, why: `coauthor ${coauthor.id}` });
        if (coauthor.family === 'claude') {
          claudeMayReview = false;
          claudeWriters.push(`coauthor ${coauthor.id}`);
        }
      }
      // Claude reviewers need a named non-Claude author and only non-Claude coauthors (#13728).
      // Critics may omit author, but no named author/coauthor may be Claude (#13875).
      // Both may share a Claude lead's family when these writer conditions hold.
      if ((reviewRights(role) || critic) && !claudeMayReview) {
        avoid.add('claude');
        if (input.family === 'claude') throw new Error(critic
          ? `a claude plan critic requires a plan no claude seat wrote, even when family is named explicitly; claude wrote it as ${claudeWriters.join(', ')}`
          : claudeWriters.length
            ? `a claude reviewer requires a change no claude seat wrote, even when family is named explicitly; claude wrote it as ${claudeWriters.join(', ')}`
            : 'a claude reviewer requires author naming a seat whose family is not claude, even when family is named explicitly');
      }
      // Coders may share the lead's family (#11829). Eligible Claude reviewers and critics
      // may too (#13728, #13875); other lead families retain their step-asides.
      if (reviewRights(role) || (input.family === undefined && role !== 'coder')) {
        for (const lead of choose.leadFamilies ?? []) {
          if (lead !== 'claude' || !claudeMayReview) avoid.add(lead);
        }
      }
      if (reviewRights(role)) {
        const siblings = self.reviewSiblings(title, main);
        // A replaced reviewer steps aside from the cap, never from family exclusions.
        if (choose.replaces !== undefined) {
          if (!siblings.some((other) => other.id === choose.replaces)) throw new Error(`replaces: ${choose.replaces} is not a reviewer on "${title}"`);
          for (const other of siblings) avoid.add(other.family as Family);
        }
        const { counted, replaced } = self.countReviewers(siblings, choose.replaces);
        for (const other of replaced) avoid.add(other);
        // The cap counts per role (task 2802 correction): a legal or security seat never consumes
        // a reviewer slot and vice versa; the family exclusion below spans the whole review class.
        const sameRole = counted.filter(({ seat }) => seat.role === role);
        if (sameRole.length >= MAX_REVIEWERS) throw new Error(`at most ${MAX_REVIEWERS} ${role}s per task: ${sameRole.map(({ seat, why }) => `${seat.id} (${why})`).join(', ')} count for "${title}"; send a recheck to one of them`);
        for (const { seat: other } of counted) avoid.add(other.family as Family);
        const earlier = choose.replaces !== undefined
          ? siblings
          : [
              ...counted.map(({ seat }) => seat),
              ...siblings.filter((other) => replaced.has(other.family as Family) && !counted.some(({ seat }) => seat.id === other.id)),
            ];
        for (const other of earlier) modelHolders.push({ seat: other, why: `earlier reviewer ${other.id}` });
      }
      // Independence is by model as well as by family (plan 16330, decision 16311). The family
      // rules above stay. Compared is the model this seat would run — an explicit model, else
      // the role matrix model — against the resolved model of the author, each coauthor and each
      // earlier reviewer those rules already step aside from. A debater's model is not in this set.
      for (const family of avoid) familyAside.add(family);
      for (const { seat, why } of modelHolders) {
        const held = seatModel(seat);
        if (held === undefined) continue;
        const prior = blockedModels.get(held);
        blockedModels.set(held, prior ? `${prior}, ${why}` : why);
      }
      if ((reviewRights(role) || critic) && blockedModels.size) {
        const wanted = (family?: Family) => seatModel({ role, family, data: { model: input.model ?? null } });
        if (input.family !== undefined || input.model !== undefined) {
          // A family the family rule already steps aside from keeps that rule's message.
          if (!(input.family !== undefined && avoid.has(input.family as Family))) {
            const model = wanted(input.family as Family);
            const who = model === undefined ? undefined : blockedModels.get(model);
            if (who) throw new Error(`${who} already runs model ${model}: ${MODEL_RULE}; leave family and model out, or name a family with another model`);
          }
        } else {
          for (const candidate of Object.keys(roleMatrix()[role]) as Family[]) {
            const model = wanted(candidate);
            if (model !== undefined && blockedModels.has(model)) avoid.add(candidate);
          }
        }
      }
      // The two debaters of one fork never run the same model (operator #16088). What is compared is
      // the model this seat WOULD run — an explicit model, else the family's matrix model — against
      // each sibling's: an explicit family or model that repeats one is refused, naming the sibling
      // and the rule; an automatic pick steps aside from every family that would run it.
      if (role === 'debater') {
        // Every open sibling of the title must carry the identical option list (operator #19423): a
        // table member and a bare fork debater can never mix on one title, and two tables with
        // different options are refused too.
        for (const other of self.debaterSiblings(title, main)) {
          const otherOptions = Array.isArray(other.data.options) ? other.data.options as string[] : undefined;
          const same = options !== undefined && otherOptions !== undefined && options.length === otherOptions.length
            && options.every((option, i) => option === otherOptions[i]);
          if (options === undefined && otherOptions === undefined) continue;
          if (!same) throw new Error(`every open debater of "${title}" must carry the identical options list (operator #19423); ${other.id} carries ${otherOptions === undefined ? 'none' : JSON.stringify(otherOptions)}`);
        }
        const wanted = (family?: Family) => seatModel({ role, family, data: { model: input.model ?? null } });
        for (const other of self.debaterSiblings(title, main)) {
          const otherModel = seatModel(other);
          if (otherModel === undefined) continue;
          if (input.family !== undefined || input.model !== undefined) {
            if (wanted(input.family as Family) === otherModel) throw new Error(`${other.id} already debates "${title}" on model ${otherModel}: the two debaters of one fork never run the same model (operator #16088); leave family and model out, or name a family with another model`);
          } else {
            for (const candidate of Object.keys(roleMatrix()[role]) as Family[]) if (wanted(candidate) === otherModel) avoid.add(candidate);
          }
        }
      }
    };
    refreshAvoid();
    // A win need never stays on the Mac, so its family must run remotely too.
    const remoteBound = remoteHost !== null || (placing && needs === 'win');
    const runnable = (candidate: Family) => (!remoteBound || candidate !== 'claude') && hasAdapter(candidate, (remoteBound ? 'pi' : input.harness ?? defaultHarness(candidate)) as Harness);
    // Image input is a prohibition in the same synchronous step as the model filter (task 2385):
    // rankFamilies drops avoided families before the emergency choice and the coder cap.
    const imageAside = new Map<Family, string>();
    if (needsImages) {
      if (input.model !== undefined && imageInput(input.model) === false) {
        throw new Error(`images: model ${input.model} has no image input`);
      }
      for (const candidate of Object.keys(roleMatrix()[role]) as Family[]) {
        const resolved = seatModel({ role, family: candidate, data: { model: input.model ?? null } });
        if (resolved !== undefined && imageInput(resolved) === false) imageAside.set(candidate, resolved);
      }
      for (const candidate of imageAside.keys()) avoid.add(candidate);
      if (input.family !== undefined && imageAside.has(input.family as Family)) {
        throw new Error(`images: ${input.family} runs ${imageAside.get(input.family as Family)}, which has no image input`);
      }
      if (input.family === undefined) {
        const allowed = (Object.keys(roleMatrix()[role]) as Family[]).filter(runnable);
        const asideWithoutImages = new Set([...avoid].filter((candidate) => !imageAside.has(candidate)));
        const open = allowed.filter((candidate) => !avoid.has(candidate) && !paused.has(candidate));
        const openBefore = allowed.filter((candidate) => !asideWithoutImages.has(candidate) && !paused.has(candidate));
        if (!open.length && openBefore.length) {
          const listed = [...imageAside.entries()].map(([candidate, resolved]) => `${candidate} (${resolved})`).join(', ');
          throw new Error(`images: no family is left: the image filter removed ${listed}`);
        }
      }
    }
    const spentModelWindow = (family: Family, model: string) => choose.loads?.find((load) => load.family === family)?.readings?.find((reading) =>
      reading.window.includes('·') && !reading.window.endsWith('·mcp') && windowMs(reading.window) !== null
      && appliesToModel(reading, model) && reading.used >= 100);
    let family: Family;
    let picked: string | null = null;
      if (input.family !== undefined) {
        family = input.family as Family;
        if (paused.has(family)) throw new Error(`${family} is paused; unpause it before creating a ${role} seat`);
        if (!roleMatrix()[role][family]) throw new Error(critic
          ? `${family} does not take a critic seat; a critic picks from the reviewer matrix: ${Object.keys(roleMatrix().reviewer).join(', ')}`
          : `${family} does not take a ${role} seat; ${role}: ${Object.keys(roleMatrix()[role]).join(', ')}`);
        if (critic && (choose.leadFamilies ?? []).includes(family) && (family !== 'claude' || avoid.has('claude'))) throw new Error(`${family} is the lead's own family: only claude may take a plan critic seat under its own lead, when no named author or coauthor is claude, even when family is named explicitly`);
        const { loads, reservations } = self.pickInputs(choose, role, input.model, accountingRole({ role, data: { critic } }));
        const row = rankFamilies(role, loads, avoid, runnable, Date.now(), input.model, reservations).find((row) => row.family === family);
        if (row?.reserveHit) throw new Error(`${family} reserve ${row.reserve}% kept for hermes-agent; cannot create a ${role} seat`);
        if (input.model !== undefined) {
          const spent = spentModelWindow(family, input.model);
          if (spent) throw new Error(`${family} model ${input.model} has no budget left: ${spent.window} used ${spent.used}%`);
        }
        if (avoid.has(family)) throw new Error(`${family} is the author's family or already reviews "${title}": a reviewer comes from another family`);
      } else {
        if ((reviewRights(role) || critic) && blockedModels.size) {
          const allowed = (Object.keys(roleMatrix()[role]) as Family[]).filter(runnable);
          const open = allowed.filter((family) => !avoid.has(family) && !paused.has(family));
          const openWithoutModel = allowed.filter((family) => !familyAside.has(family) && !paused.has(family));
          if (!open.length && openWithoutModel.length) {
            const hitting = new Map<string, string>();
            for (const family of openWithoutModel) {
              const model = seatModel({ role, family, data: { model: null } });
              const who = model === undefined ? undefined : blockedModels.get(model);
              if (model && who) hitting.set(model, who);
            }
            const models = [...hitting.entries()].map(([model, who]) => `${model} (${who})`).join(', ');
            throw new Error(`no candidate is left for a ${role}: the model rule excludes every remaining family (${MODEL_RULE}); models: ${models}`);
          }
        }
        const { loads, reservations, workingCoders, workingSeats, tiers } = self.pickInputs(choose, role, input.model, accountingRole({ role, data: { critic } }));
        const pace = pickFamily(role, loads, avoid, runnable, Date.now(), paused, input.model, reservations, workingCoders, workingSeats, tiers);
        ({ family, why: picked } = pace);
        // Operator #12590: an auto-picked Mac-only coder family steps aside when the probe already taken for placement
        // ranks a host lighter than this Mac, the same way a capped family steps aside. A named family, needs mac,
        // Mac-only files, no hosts and failed probes all keep claude; no second probe runs.
        if (landable(role) && family === 'claude' && hostName === undefined && needs === 'any' && probed && Object.keys(hosts).length > 0) {
          const active = self.activeByTarget();
          const candidate = (target: Target, platform: NodeJS.Platform): Candidate => ({ platform, probe: probed.get(target)!, activeSeats: active.get(target) ?? 0 });
          const lighter = lighterHost({ taskFiles: input.files ?? [], instruments, local: candidate('local', process.platform),
            hosts: Object.fromEntries(Object.entries(hosts).map(([name, host]) => [name, candidate(name, host.platform)])) });
          if (lighter) try {
            const repick = pickFamily(role, loads, new Set([...avoid, 'claude' as Family]), runnable, Date.now(), paused, input.model, reservations, workingCoders, workingSeats, tiers);
            family = repick.family;
            picked = `claude runs native on this Mac only and ${lighter} ranks lighter, so claude steps aside (operator #12590); ${repick.why}`;
          } catch { /* no Pi family left: claude stays */ }
        }
      }
      // The placement journal (decision #12522): the lead's need, where the seat runs and why.
      // needs is null only beside an explicit host with no need given: the host, not a default, chose the machine.
      let placement: { needs: PlatformNeed | null; target: Target; reason: string };
      if (snapshotReason) placement = { needs, target: 'local', reason: snapshotReason };
      else if (hostName !== undefined) placement = { needs: (input.needs as PlatformNeed | undefined) ?? null, target: hostName, reason: 'explicit host from the lead' };
      else if (!probed) placement = { needs, target: 'local', reason: input.needs === undefined
            ? `needs omitted (default any; decision #12591): ${probing ? 'no registered hosts; this Mac' : `${input.family === 'claude' ? 'claude' : input.standArm !== undefined ? 'standArm' : 'native harness'} stays on this Mac`}, not probed`
            : macPinNote(input.needsReason) };
      else {
        const active = self.activeByTarget();
        const candidate = (target: Target, platform: NodeJS.Platform): Candidate => ({ platform, probe: probed.get(target)!, activeSeats: active.get(target) ?? 0 });
        // Only the omitted need may fall back when every load probe failed. An explicit any/win still refuses.
        const allFailed = input.needs === undefined && probed.get('local')?.ok === false &&
          Object.keys(hosts).every((name) => probed.get(name)?.ok === false);
        if (allFailed) {
          const failures = [...probed].map(([target, probe]) => `${target} probe failed: ${probe.ok === false ? probe.error : ''}`).join('; ');
          placement = { needs, target: 'local', reason: `needs omitted (default any; decision #12591): no probe succeeded; this Mac is the fallback; ${failures}` };
        } else {
          const placed = placeSeat({ role, family, taskFiles: input.files ?? [], need: needs, instruments, local: candidate('local', process.platform),
            hosts: Object.fromEntries(Object.entries(hosts).map(([name, host]) => [name, candidate(name, host.platform)])) });
          placement = { needs, ...placed, reason: `${input.needs === undefined ? 'needs omitted (default any; decision #12591): ' : ''}${placed.reason}` };
          if (placed.target !== 'local') { hostName = placed.target; remoteHost = hosts[placed.target]; }
        }
      }
      if (remoteHost && family === 'claude') throw new Error('claude is not supported on a remote host');
      // A host runtime move needs the commit this daemon started from (task 1784); without it a
      // remote create is refused here, before a row exists. The move itself runs in the seat chain.
      if (remoteHost && !self.options.daemonRuntime && !self.options.syncHostRuntime)
        throw new Error('remote create needs the daemon commit resolved at serve start');
      const harness = (remoteHost ? 'pi' : input.harness ?? defaultHarness(family)) as Harness;
      if (!hasAdapter(family, harness)) throw new Error(`${family} cannot run under harness '${harness}'`);
      if (input.standArm !== undefined && harness !== 'pi') throw new Error('standArm requires a Pi seat');
      // The matrix names Pi's model ids (claude's native opt-in keeps its matrix
      // model too); another native CLI keeps its own default model.
      const profile = roleMatrix()[role][family]!;
      const model = input.model ?? (harness === 'pi' || family === 'claude' ? profile.model : undefined);
      const effort = input.effort ?? profile.effort ?? undefined;
      if (needsImages && typeof model === 'string' && imageInput(model) === null) {
        const note = `image input of ${model} is unknown`;
        picked = picked ? `${picked}; ${note}` : note;
      }
      // Decision #17805 D2: when no creating session resolved, the step-aside still covers every
      // active lead family; `picked` says so, so the lead knows to pass `session` and narrow it.
      if ((reviewRights(role) || (input.family === undefined && role !== 'coder')) && typeof choose.leadAsideNote === 'string') {
        picked = picked ? `${picked}; ${choose.leadAsideNote}` : choose.leadAsideNote;
      }
      const id = `${role}-${family}-${randomBytes(3).toString('hex')}`;
      const mirror = remoteHost && landable(role) ? path.join(self.options.stateDir, 'mirrors', id) : null;
      const worktree = mirror ?? (policy.worktree === 'none' || remoteHost ? null : path.join(self.options.stateDir, 'worktrees', id));
      const remotePath = remoteHost?.platform === 'win32' ? path.win32 : path.posix;
      // A remote scout borrows the parent's live host checkout; it never owns or provisions that path.
      const borrowedRemote = Boolean(parentHost);
      const remoteDir = borrowedRemote ? parent!.data.remoteDir as string : remoteHost ? remotePath.join(remotePath.dirname(remoteHost.repo), 'worktrees', id) : null;
      if (borrowedRemote && (!remoteDir || parent!.cwd !== remoteDir)) throw new Error('remote parent has no live host checkout');
      const branch = policy.worktree === 'branch' && !remoteHost ? `orch/${id}` : null;
      // The host checkout and mirror are the seat chain's first step (task 1757):
      // create answers as soon as the row exists and a prompt waits behind the chain.
      if (mirror && remoteDir) {
        assertMirrorPath(self.options.stateDir, mirror);
        if (existsSync(mirror) || self.store.getSeat(id)) throw new Error(`remote coder mirror or seat already exists: ${id}`);
      }
      // The create-time files also select the first brief's knowledge page and lessons when its prompt names none.
      const taskFiles = [...new Set((input.files ?? []).map(normalizeFile).filter(Boolean))];
      // One table, one id (operator #19423): a debater with options joins the open table its
      // title+repo already carry; a later table after the first closed mints a fresh cohort, so
      // tableMembers, the appendix and the tally never see the earlier members.
      let tableId: string | undefined;
      if (options !== undefined) {
        const openTableSibling = self.debaterSiblings(title, main).find((other) => Array.isArray(other.data.options));
        const inherited = openTableSibling?.data?.tableId;
        tableId = typeof inherited === 'string' && inherited ? inherited : randomBytes(6).toString('hex');
      }
      const provisionHeld = self.draining && role !== 'scout' && role !== 'critic' && !borrowedRemote && Boolean(worktree || remoteDir);
      const seat = self.store.insertSeat({
        id, role, family, title,
        status: borrowedRemote ? 'ready' : worktree || remoteDir ? 'provisioning' : 'ready',
        cwd: remoteDir ?? worktree ?? top,
        worktree,
        data: { ...(provisionHeld ? { provisionHeld: true } : {}), harness, access: policy.access, model: model ?? null, matrixModel: profile.model, effort: effort ?? null, picked, placement, repo: top, main, base: remoteHost || policy.worktree !== 'none' ? commit : null, snapshot: input.snapshot === true, branch, author: input.author ?? null, ...(coauthors !== undefined ? { coauthors } : {}),
          ...(taskFiles.length ? { taskFiles } : {}), ...(choose.leadFamily ? { leadFamily: choose.leadFamily } : {}), sessionId: null, providerModel: null, instruments, ...(remoteDir ? { host: hostName, remoteDir, ...(borrowedRemote ? { borrowedRemote: true, remoteMcpConfig: remotePiMcpPath(remoteHost!, remoteDir) } : { remoteCheckoutOwned: false }) } : {}), ...(mirror ? { mirror } : {}), ...(input.request_id !== undefined ? { requestId: input.request_id } : {}), ...(input.standArm !== undefined ? { standArm: input.standArm } : {}), ...(input.parent !== undefined ? { parent: input.parent } : {}), ...(needsImages ? { images: true } : {}), ...(options !== undefined ? { options } : {}), ...(tableId !== undefined ? { tableId } : {}), ...(input.leadHandle !== undefined ? { leadHandle: input.leadHandle } : {}) },
      });
      if (seat.status === 'provisioning' && !provisionHeld) self.queueProvision(seat);
      self.options.log('info', 'seat.created', { seat: id, target: placement.target, probeMs, createMs: Date.now() - createStart });
      return seat;
  }
