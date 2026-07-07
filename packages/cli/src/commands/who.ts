import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";

type RosterMind = {
  name: string;
  displayName: string | null;
  description: string | null;
  avatar: string | null;
  status: "running" | "starting" | "sleeping" | "stopped";
};

type RosterBrain = { username: string; displayName: string | null };

type Roster = { minds: RosterMind[]; brains: RosterBrain[] };

// Warm, human-readable presence words for each run state.
const PRESENCE: Record<RosterMind["status"], string> = {
  running: "here",
  starting: "waking up",
  sleeping: "sleeping",
  stopped: "away",
};

const cmd = command({
  name: "volute who",
  description: "See who's on the system — the other minds and the people around",
  flags: {},
  async run() {
    const res = await daemonFetch("/api/minds/roster");
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
        error: string;
      };
      console.error(`Couldn't read the roster: ${body.error}`);
      process.exit(1);
    }

    const { minds, brains } = (await res.json()) as Roster;
    const self = process.env.VOLUTE_MIND;

    if (minds.length === 0) {
      console.log("No minds on the system yet — you may be the first.");
    } else {
      console.log("Minds on the system:\n");
      const labels = minds.map((m) => {
        const name = m.displayName?.trim() || m.name;
        return name + (m.name === self ? " (you)" : "");
      });
      const width = Math.max(...labels.map((l) => l.length));
      minds.forEach((m, i) => {
        const presence = PRESENCE[m.status];
        const desc = m.description?.trim() ? `  — ${m.description.trim()}` : "";
        console.log(`  ${labels[i].padEnd(width)}  ${presence.padEnd(10)}${desc}`);
      });
    }

    console.log("");
    if (brains.length === 0) {
      console.log("No people are online right now.");
    } else {
      console.log("People here now:");
      for (const b of brains) {
        const name = b.displayName?.trim() || b.username;
        const handle = name === b.username ? name : `${name} (${b.username})`;
        console.log(`  ${handle}`);
      }
    }
  },
});

export const run = cmd.execute;
