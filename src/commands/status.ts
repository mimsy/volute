export async function run(args: string[]) {
  let port = 4100;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
    }
  }

  const url = `http://localhost:${port}/health`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Health check failed: ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    const data = (await res.json()) as { name: string; version: string; status: string };
    console.log(`Agent: ${data.name} v${data.version}`);
    console.log(`Status: ${data.status}`);
  } catch (err) {
    console.error(`Could not connect to agent at ${url}`);
    console.error("Is the agent running? Try: molt start");
    process.exit(1);
  }
}
