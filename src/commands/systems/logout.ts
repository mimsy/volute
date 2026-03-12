import { daemonFetch } from "../../lib/daemon-client.js";

export async function run() {
  const res = await daemonFetch("/api/system/logout", { method: "POST" });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
      error: string;
    };
    console.error(`Logout failed: ${body.error}`);
    process.exit(1);
  }

  console.log("Logged out. Credentials removed.");
}
