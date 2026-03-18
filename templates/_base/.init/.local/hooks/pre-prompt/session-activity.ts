// Cross-session activity — shows what happened in other sessions since last check.
// Uses the daemon history API. Customize or remove this hook as you like.

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

try {
  const res = await fetch(
    `http://127.0.0.1:${VOLUTE_DAEMON_PORT}/api/minds/${VOLUTE_MIND}/history/cross-session?session=${encodeURIComponent(session)}`,
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
