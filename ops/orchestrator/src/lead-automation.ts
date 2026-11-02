import { chatDelivered, chatJoin, chatList, isBroadcast, onChatPost } from './chat.ts';
import type { Runtime } from './http.ts';
import { LeadUsageTracker, type LeadDriver } from './lead-driver.ts';
import { LeadHandoverExtension } from './lead-handover.ts';
import { LeadWakeExtension } from './lead-wake.ts';
import type { Store } from './store.ts';

/** lead.handover's chat half (task 3459 L1): a handed-over lead keeps its handle — the handle
 *  bound to the replaced session rejoins under the new one, superseding the old binding exactly
 *  as a successor's own chat_join would. False when no live binding held the old session. */
function rebindLeadHandle(store: Store, from: string, to: string): boolean {
  const binding = chatList(store, { limit: 1 }).handles.find((row) => row.session === from);
  if (!binding) return false;
  chatJoin(store, { handle: binding.handle, session: to, desktop: binding.desktop ?? undefined });
  return true;
}

/** Supervised-lead middleware and its post-write wake observer, kept out of the HTTP route dispatcher. */
export function leadAutomation(rt: Pick<Runtime, 'store' | 'stateDir' | 'log'>, driver: () => LeadDriver) {
  const leadUsage = new LeadUsageTracker();
  const leadWake = new LeadWakeExtension({
    stateDir: rt.stateDir,
    targets: (post) => {
      const bindings = chatList(rt.store, { limit: 1 }).handles;
      const broadcast = isBroadcast(post.to);
      return driver().list().flatMap((lead) => {
        if (!lead.session) return [];
        const binding = bindings.find((row) => row.session === lead.session);
        return binding && binding.handle !== post.author && (broadcast || (Array.isArray(post.to) && post.to.includes(binding.handle)))
          ? [{ lead: lead.id, session: lead.session }] : [];
      });
    },
    send: (lead, text) => driver().send(lead, text),
    compact: (lead) => driver().compact(lead),
    emitStatus: (lead, text) => driver().emitStatus(lead, text),
    delivered: (session, posts) => chatDelivered(rt.store, { session, posts }),
  });
  const offLeadWake = onChatPost((post) => leadWake.offer(post));
  const leadHandover = new LeadHandoverExtension({
    usage: leadUsage,
    stateDir: rt.stateDir,
    log: rt.log,
    send: (lead, text) => driver().send(lead, text),
    restartFresh: (lead, seed) => driver().restartFresh(lead, seed),
    emitStatus: (lead, text) => driver().emitStatus(lead, text),
    rebind: (from, to) => rebindLeadHandle(rt.store, from, to),
  });
  return { leadUsage, leadWake, leadHandover, offLeadWake };
}
