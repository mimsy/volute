// Ambient turn context — what's around, from the extensions installed on this system:
// someone published a page, a thread became a conversation. Not addressed to you — that's
// what notices.ts carries — and never a request. Material you're free to do nothing with.
//
// The daemon caps the total size and drops any extension that misbehaves, so this stays
// small; most turns it returns nothing at all. Empty this file to decline it entirely.

const { VOLUTE_DAEMON_PORT, VOLUTE_MIND_TOKEN, VOLUTE_MIND } = process.env;
if (!VOLUTE_DAEMON_PORT || !VOLUTE_MIND_TOKEN || !VOLUTE_MIND) {
  console.log("{}");
  process.exit(0);
}

try {
  const res = await fetch(
    `http://127.0.0.1:${VOLUTE_DAEMON_PORT}/api/v1/minds/${VOLUTE_MIND}/turn-context?reason=turn`,
    {
      headers: { Authorization: `Bearer ${VOLUTE_MIND_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    },
  );
  // Exit non-zero on failure so the hook loader can tell you (#938); "{}" hid it.
  if (!res.ok) {
    console.error(`turn context failed: ${res.status} ${await res.text().catch(() => "")}`);
    process.exit(1);
  }
  const { context } = (await res.json()) as { context: string | null };
  console.log(context ? JSON.stringify({ additionalContext: context }) : "{}");
} catch (err) {
  console.error(`turn context failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
