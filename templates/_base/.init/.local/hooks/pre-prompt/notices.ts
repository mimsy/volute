// Failure notices — surfaces failures (auth, rate-limit, overloaded, network, crash,
// budget) that happened in this session while you couldn't respond, on your next turn.
// The daemon records them; this hook whispers them in. Customize or remove as you like.

const input = await new Promise<string>((resolve) => {
  let data = "";
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolve(data));
});

const { VOLUTE_DAEMON_PORT, VOLUTE_DAEMON_TOKEN, VOLUTE_MIND } = process.env;
if (!VOLUTE_DAEMON_PORT || !VOLUTE_DAEMON_TOKEN || !VOLUTE_MIND) {
  console.log("{}");
  process.exit(0);
}

let session = "";
try {
  session = JSON.parse(input).session ?? "";
} catch {}

if (!session) {
  console.log("{}");
  process.exit(0);
}

try {
  const res = await fetch(
    `http://127.0.0.1:${VOLUTE_DAEMON_PORT}/api/minds/${VOLUTE_MIND}/history/notices?session=${encodeURIComponent(session)}`,
    { headers: { Authorization: `Bearer ${VOLUTE_DAEMON_TOKEN}` } },
  );
  if (!res.ok) {
    console.log("{}");
    process.exit(0);
  }
  const { context } = (await res.json()) as { context: string | null };
  if (context) {
    console.log(JSON.stringify({ additionalContext: context }));
  } else {
    console.log("{}");
  }
} catch {
  console.log("{}");
}
