// Shared with the frame's polls: never derive the POST Origin from user input.
export const BASE = 'http://127.0.0.1:7760';

// Structural subset of $.http.fetch (no Node or DOM APIs in a mod).
export type ChatFetch = (url: string, init?: {
  method?: string; headers?: Record<string, string>; body?: string;
}) => Promise<{ status: number; ok: boolean; text: string }>;

export type ReleaseConfirmation = { handle: string; session: string | null };
export type ChatFormState = {
  body: string; to: string; wake: boolean; handle: string;
  sending: boolean; releasing: boolean;
  sendStatus: string; releaseStatus: string;
  confirmation: ReleaseConfirmation | null;
};
export const INITIAL_CHAT_FORM_STATE: ChatFormState = {
  body: '', to: '', wake: false, handle: '', sending: false, releasing: false,
  sendStatus: '', releaseStatus: '', confirmation: null,
};

export function capMessage(value: string): string {
  return Array.from(value).slice(0, 600).join('');
}
export function messageCount(value: string): string {
  return Array.from(value).length + ' / 600';
}
export function releaseQuestion(value: ReleaseConfirmation): string {
  return 'Release handle "' + value.handle + '" ('
    + (value.session === null ? 'no live session' : 'live session: ' + value.session) + ')?';
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function request(fetch: ChatFetch, path: string, payload?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(BASE + path, payload === undefined
    ? { headers: { 'Cache-Control': 'no-cache' } }
    : { method: 'POST', headers: { Origin: BASE, 'X-Orch-Chat': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  let data: unknown;
  try { data = JSON.parse(response.text); } catch { /* A plain-text daemon refusal must remain visible. */ }
  if (!response.ok) {
    throw new Error(object(data) && typeof data.error === 'string' ? data.error : response.text || 'Chat HTTP ' + response.status);
  }
  if (!object(data)) throw new Error('Invalid chat response');
  return data;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ChatFormActions = ReturnType<typeof createChatForms>;

/** Create once per pane. The frame owns drawn state in $.state, reads it during
 * render, and merges each patch with update(); no render-time state writes.
 * canWrite must read the latest feed's readOnly/availability, not a render closure.
 * refresh queues a fresh poll even when an older background read is in flight.
 */
export function createChatForms(options: {
  fetch: ChatFetch;
  getState: () => ChatFormState | Promise<ChatFormState>;
  patchState: (patch: Partial<ChatFormState>) => void | Promise<void>;
  canWrite: () => boolean;
  refresh: () => void | Promise<void>;
}) {
  const { fetch, getState, patchState, canWrite, refresh } = options;
  // These per-pane locks admit only one action even before an async state read settles.
  let sending = false, releasing = false;
  return {
    async setBody(value: string) {
      if (!sending) await patchState({ body: capMessage(value) });
    },
    async setTo(value: string) {
      if (!sending) await patchState({ to: value });
    },
    async toggleWake() {
      if (!sending) await patchState({ wake: !(await getState()).wake });
    },
    async setHandle(value: string) {
      if (!releasing) await patchState({ handle: value.slice(0, 64), confirmation: null, releaseStatus: '' });
    },
    async cancelRelease() {
      if (!releasing) await patchState({ confirmation: null, releaseStatus: '' });
    },
    async send() {
      if (!canWrite() || sending) return;
      sending = true;
      try {
        const state = await getState();
        if (!canWrite() || !state.body.length) return;
        if (Array.from(state.body).length > 600) {
          await patchState({ sendStatus: 'Message must be at most 600 characters.' });
          return;
        }
        await patchState({ sending: true, sendStatus: 'Sending…' });
        await request(fetch, '/chat/post', {
          body: state.body, to: state.to.trim() ? state.to.split(',').map(handle => handle.trim()) : 'all', wake: state.wake,
        });
        await patchState({ body: '', sendStatus: 'Sent' });
        await refresh();
      } catch (error) {
        await patchState({ sendStatus: errorText(error) });
      } finally {
        sending = false;
        await patchState({ sending: false });
      }
    },
    async release() {
      if (!canWrite() || releasing) return;
      releasing = true;
      try {
        const state = await getState();
        const handle = state.handle.trim();
        if (!canWrite() || !handle) return;
        await patchState({ releasing: true });
        if (!state.confirmation || state.confirmation.handle !== handle) {
          await patchState({ releaseStatus: 'Checking live session…', confirmation: null });
          const feed = await request(fetch, '/api/chat');
          if (feed.readOnly === true || !canWrite()) throw new Error('Chat is read-only.');
          if (!Array.isArray(feed.handles) || !feed.handles.every(entry => object(entry)
            && typeof entry.handle === 'string' && typeof entry.session === 'string')) throw new Error('Invalid chat response');
          const binding = feed.handles.find(entry => entry.handle === handle) as { session: string } | undefined;
          await patchState({ confirmation: { handle, session: binding?.session ?? null }, releaseStatus: '' });
          return; // The fresh GET never releases: a second, explicit press is required.
        }
        // Clear first, so a failure cannot silently reuse an old confirmation.
        await patchState({ confirmation: null, releaseStatus: 'Releasing…' });
        const data = await request(fetch, '/chat/release', { handle });
        if (typeof data.handle !== 'string') throw new Error('Invalid chat response');
        await patchState({ handle: '', releaseStatus: 'Released ' + data.handle });
        await refresh();
      } catch (error) {
        await patchState({ confirmation: null, releaseStatus: errorText(error) });
      } finally {
        releasing = false;
        await patchState({ releasing: false });
      }
    },
  };
}
