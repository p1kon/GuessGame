export async function pollOnce({ client, adapter, signal }) {
  await adapter.drain();
  const updates = await client.call('getUpdates', { offset: adapter.getOffset(), timeout: 20,
    allowed_updates: ['message', 'callback_query'], limit: 50 }, { signal });
  if (!Array.isArray(updates)) throw new Error('INVALID_TELEGRAM_RESPONSE');
  for (const update of updates) {
    if (signal?.aborted) break;
    await adapter.handle(update);
    // Acknowledge to Telegram only after both state and outgoing actions are durable.
    adapter.confirmOffset(update.update_id);
  }
}
