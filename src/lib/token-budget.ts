import { daemonLoopback } from "./registry.js";

type QueuedMessage = {
  body: string;
  channel: string;
  sender: string | null;
  textContent: string;
  timestamp: number;
};

type BudgetState = {
  tokensUsed: number;
  periodStart: number;
  periodMinutes: number;
  tokenLimit: number;
  queue: QueuedMessage[];
  warningInjected: boolean;
};

export class TokenBudget {
  private budgets = new Map<string, BudgetState>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private daemonPort: number | null = null;
  private daemonToken: string | null = null;

  start(daemonPort?: number, daemonToken?: string): void {
    this.daemonPort = daemonPort ?? null;
    this.daemonToken = daemonToken ?? null;
    this.interval = setInterval(() => this.tick(), 60_000);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  setBudget(agent: string, tokenLimit: number, periodMinutes: number): void {
    const existing = this.budgets.get(agent);
    if (existing) {
      existing.tokenLimit = tokenLimit;
      existing.periodMinutes = periodMinutes;
    } else {
      this.budgets.set(agent, {
        tokensUsed: 0,
        periodStart: Date.now(),
        periodMinutes,
        tokenLimit,
        queue: [],
        warningInjected: false,
      });
    }
  }

  removeBudget(agent: string): void {
    this.budgets.delete(agent);
  }

  recordUsage(agent: string, inputTokens: number, outputTokens: number): void {
    const state = this.budgets.get(agent);
    if (!state) return;
    state.tokensUsed += inputTokens + outputTokens;
  }

  checkBudget(agent: string): "ok" | "warning" | "exceeded" {
    const state = this.budgets.get(agent);
    if (!state) return "ok";

    const pct = state.tokensUsed / state.tokenLimit;
    if (pct >= 1) return "exceeded";
    if (pct >= 0.8 && !state.warningInjected) {
      state.warningInjected = true;
      return "warning";
    }
    return "ok";
  }

  enqueue(agent: string, message: QueuedMessage): void {
    const state = this.budgets.get(agent);
    if (!state) return;
    state.queue.push(message);
  }

  drain(agent: string): QueuedMessage[] {
    const state = this.budgets.get(agent);
    if (!state) return [];
    const messages = state.queue;
    state.queue = [];
    return messages;
  }

  getUsage(agent: string): {
    tokensUsed: number;
    tokenLimit: number;
    periodMinutes: number;
    periodStart: number;
    queueLength: number;
    percentUsed: number;
  } | null {
    const state = this.budgets.get(agent);
    if (!state) return null;
    return {
      tokensUsed: state.tokensUsed,
      tokenLimit: state.tokenLimit,
      periodMinutes: state.periodMinutes,
      periodStart: state.periodStart,
      queueLength: state.queue.length,
      percentUsed: Math.round((state.tokensUsed / state.tokenLimit) * 100),
    };
  }

  tick(): void {
    const now = Date.now();
    for (const [agent, state] of this.budgets) {
      const elapsed = now - state.periodStart;
      if (elapsed >= state.periodMinutes * 60_000) {
        state.tokensUsed = 0;
        state.periodStart = now;
        state.warningInjected = false;

        const queued = this.drain(agent);
        if (queued.length > 0) {
          this.replay(agent, queued);
        }
      }
    }
  }

  private async replay(agentName: string, messages: QueuedMessage[]): Promise<void> {
    if (!this.daemonPort || !this.daemonToken) return;

    const summary = messages
      .map((m) => {
        const from = m.sender ? `[${m.sender}]` : "";
        const ch = m.channel ? `(${m.channel})` : "";
        return `${from}${ch} ${m.textContent}`;
      })
      .join("\n");

    const body = JSON.stringify({
      content: [
        {
          type: "text",
          text: `[Budget replay] ${messages.length} queued message(s) from the previous budget period:\n\n${summary}`,
        },
      ],
      channel: "system:budget-replay",
      sender: "system",
    });

    const daemonUrl = `http://${daemonLoopback()}:${this.daemonPort}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const res = await fetch(`${daemonUrl}/api/agents/${encodeURIComponent(agentName)}/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.daemonToken}`,
          Origin: daemonUrl,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error(`[token-budget] replay for ${agentName} got HTTP ${res.status}`);
      } else {
        console.error(
          `[token-budget] replayed ${messages.length} queued message(s) for ${agentName}`,
        );
      }
      // Drain the response stream
      try {
        const reader = res.body?.getReader();
        if (reader) {
          try {
            while (!(await reader.read()).done) {}
          } finally {
            reader.releaseLock();
          }
        }
      } catch {
        // Stream closed — safe to ignore
      }
    } catch (err) {
      console.error(`[token-budget] failed to replay for ${agentName}:`, err);
    } finally {
      clearTimeout(timeout);
    }
  }
}

let instance: TokenBudget | null = null;

export function getTokenBudget(): TokenBudget {
  if (!instance) instance = new TokenBudget();
  return instance;
}
