import type { Elements } from 'claude-code';
import { messageCount, releaseQuestion } from '../chat-api';
import type { ChatFormActions, ChatFormState } from '../chat-api';

export type ChatFormsData = { readOnly?: boolean };

/** The chat form: a pane-wide message field, a compose row (count, To, wake,
 * Send), the release group set apart, and the status lines. */
export function ChatFormsSection(
  el: Elements['desktop'], data: ChatFormsData, state: ChatFormState, actions: ChatFormActions,
) {
  const { Box, Text, Button, Input } = el;
  if (data.readOnly === true) return <Box />;
  const submitMessage = async (value: string) => {
    await actions.setBody(value);
    await actions.send();
  };
  const submitHandle = async (value: string) => {
    if (value !== state.handle) await actions.setHandle(value);
    await actions.release();
  };
  return (
    // The Input element takes no width of its own (InputProps, claude-code.d.ts:5552),
    // so the widest it can be is the width of its containing Box.
    <Box key="chat-form" flexDirection="column" gap={1} width="100%">
      <Box key="chatMessage" flexDirection="column" width="100%">
        {state.sending
          ? <Text>Message: {state.body}</Text>
          : <Input key="chatBody" label="Message" value={state.body} submitLabel="send"
              onInput={actions.setBody} onSubmit={submitMessage} />}
      </Box>
      <Box key="chatCompose" flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
        <Text color="subtle">{messageCount(state.body)}</Text>
        {state.sending
          ? <Text>To: {state.to}</Text>
          : <Input key="chatTo" label="To" value={state.to} onInput={actions.setTo} onSubmit={actions.setTo} />}
        {state.sending
          ? <Text color="subtle">{state.wake ? 'wake on' : 'wake'}</Text>
          : <Button key="chatWake" onPress={actions.toggleWake}>{state.wake ? 'wake on' : 'wake'}</Button>}
        {state.sending || !state.body.length
          ? <Text color="subtle">Send</Text>
          : <Button key="chatSend" label="Send" variant="primary" onPress={actions.send} />}
      </Box>
      <Box key="chatReleaseGroup" flexDirection="column" gap={1} alignItems="flex-start" width="100%" marginTop={1}>
        {state.releasing
          ? <Text>Handle: {state.handle}</Text>
          : <Input key="chatReleaseHandle" label="Handle" value={state.handle}
              onInput={actions.setHandle} onSubmit={submitHandle} />}
        {state.releasing || !state.handle.trim()
          ? <Text color="subtle">Release</Text>
          : <Button key="chatRelease" label={state.confirmation ? 'Confirm release' : 'Release'}
              onPress={actions.release} />}
        {state.confirmation && !state.releasing
          ? <Button key="chatReleaseCancel" label="Cancel" onPress={actions.cancelRelease} />
          : null}
        {state.confirmation ? <Text wrap="truncate">{releaseQuestion(state.confirmation)}</Text> : null}
      </Box>
      <Box key="chatStatus" flexDirection="column" width="100%">
        {state.sendStatus ? <Text color="subtle" wrap="truncate">{state.sendStatus}</Text> : null}
        {state.releaseStatus ? <Text color="subtle" wrap="truncate">{state.releaseStatus}</Text> : null}
      </Box>
    </Box>
  );
}
