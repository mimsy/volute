import { daemonLoopback } from "./registry.js";

export const DEFAULT_BUDGET_PERIOD_MINUTES = 60;
const MAX_QUEUE_SIZE = 100;

type QueuedMessage = {
  channel: string;
  sender: string | null;
  textContent: string;
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

  setBudget(mind: string, tokenLimit: number, periodMinutes: number): void {
    if (tokenLimit <= 0) return;
    const existing = this.budgets.get(mind);
    if (existing) {
      existing.tokenLimit = tokenLimit;
      existing.periodMinutes = periodMinutes;
    } else {
      this.budgets.set(mind, {
        tokensUsed: 0,
        periodStart: Date.now(),
        periodMinutes,
        tokenLimit,
        queue: [],
        warningInjected: false,
      });
    }
  }

  removeBudget(mind: string): void {
    this.budgets.delete(mind);
  }

  recordUsage(mind: string, inputTokens: number, outputTokens: number): void {
    const state = this.budgets.get(mind);
    if (!state) return;
    state.tokensUsed += inputTokens + outputTokens;
  }

  /** Returns current budget status. Does not mutate state — call acknowledgeWarning() after delivering a warning. */
  checkBudget(mind: string): "ok" | "warning" | "exceeded" {
    const state = this.budgets.get(mind);
    if (!state) return "ok";

    const pct = state.tokensUsed / state.tokenLimit;
    if (pct >= 1) return "exceeded";
    if (pct >= 0.8 && !state.warningInjected) return "warning";
    return "ok";
  }

  /** Mark warning as delivered for this period. Call after successfully injecting the warning. */
  acknowledgeWarning(mind: string): void {
    const state = this.budgets.get(mind);
    if (state) state.warningInjected = true;
  }

  enqueue(mind: string, message: QueuedMessage): void {
    const state = this.budgets.get(mind);
    if (!state) return;
    if (state.queue.length >= MAX_QUEUE_SIZE) {
      state.queue.shift();
    }
    state.queue.push(message);
  }

  drain(mind: string): QueuedMessage[] {
    const state = this.budgets.get(mind);
    if (!state) return [];
    const messages = state.queue;
    state.queue = [];
    return messages;
  }

  getUsage(mind: string): {
    tokensUsed: number;
    tokenLimit: number;
    periodMinutes: number;
    periodStart: number;
    queueLength: number;
    percentUsed: number;
  } | null {
    const state = this.budgets.get(mind);
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
    for (const [mind, state] of this.budgets) {
      const elapsed = now - state.periodStart;
      if (elapsed >= state.periodMinutes * 60_000) {
        state.tokensUsed = 0;
        state.periodStart = now;
        state.warningInjected = false;

        const queued = this.drain(mind);
        if (queued.length > 0) {
          this.replay(mind, queued).catch((err) => {
            console.error(`[token-budget] replay error for ${mind}:`, err);
          });
        }
      }
    }
  }

  private async replay(mindName: string, messages: QueuedMessage[]): Promise<void> {
    if (!this.daemonPort || !this.daemonToken) {
      console.error(
        `[token-budget] cannot replay ${messages.length} message(s) for ${mindName}: daemon not configured`,
      );
      // Re-enqueue so messages aren't lost
      const state = this.budgets.get(mindName);
      if (state) state.queue.push(...messages);
      return;
    }

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
      const res = await fetch(`${daemonUrl}/api/minds/${encodeURIComponent(mindName)}/message`, {
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
        console.error(`[token-budget] replay for ${mindName} got HTTP ${res.status}`);
      } else {
        console.error(
          `[token-budget] replayed ${messages.length} queued message(s) for ${mindName}`,
        );
      }
      // Consume response body
      await res.text().catch(() => {});
    } catch (err) {
      console.error(`[token-budget] failed to replay for ${mindName}:`, err);
      // Re-enqueue so messages aren't lost
      const state = this.budgets.get(mindName);
      if (state) state.queue.push(...messages);
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
