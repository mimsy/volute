import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import log from "./logger.js";
import { deliverMessage } from "./message-delivery.js";
import { stateDir } from "./registry.js";

const tlog = log.child("token-budget");

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

  start(): void {
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
      // Try to load persisted state first
      const persisted = this.loadBudgetState(mind);
      if (persisted) {
        persisted.tokenLimit = tokenLimit;
        persisted.periodMinutes = periodMinutes;
        this.budgets.set(mind, persisted);
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
  }

  removeBudget(mind: string): void {
    this.budgets.delete(mind);
  }

  recordUsage(mind: string, inputTokens: number, outputTokens: number): void {
    const state = this.budgets.get(mind);
    if (!state) return;
    state.tokensUsed += inputTokens + outputTokens;
    this.saveBudgetState(mind, state);
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
        this.saveBudgetState(mind, state);

        const queued = this.drain(mind);
        if (queued.length > 0) {
          this.replay(mind, queued).catch((err) => {
            tlog.warn(`replay error for ${mind}`, log.errorData(err));
          });
        }
      }
    }
  }

  private budgetStatePath(mind: string): string {
    return resolve(stateDir(mind), "budget.json");
  }

  private saveBudgetState(mind: string, state: BudgetState): void {
    try {
      const dir = stateDir(mind);
      mkdirSync(dir, { recursive: true });
      const data = {
        periodStart: state.periodStart,
        tokensUsed: state.tokensUsed,
        warningInjected: state.warningInjected,
        queue: state.queue,
      };
      writeFileSync(this.budgetStatePath(mind), `${JSON.stringify(data)}\n`);
    } catch (err) {
      tlog.warn(`failed to save budget state for ${mind}`, log.errorData(err));
    }
  }

  private loadBudgetState(mind: string): BudgetState | null {
    try {
      const path = this.budgetStatePath(mind);
      if (!existsSync(path)) return null;
      const data = JSON.parse(readFileSync(path, "utf-8"));
      if (typeof data.periodStart !== "number" || typeof data.tokensUsed !== "number") return null;
      return {
        periodStart: data.periodStart,
        tokensUsed: data.tokensUsed,
        warningInjected: data.warningInjected ?? false,
        queue: Array.isArray(data.queue) ? data.queue : [],
        periodMinutes: 0, // will be overwritten by caller
        tokenLimit: 0, // will be overwritten by caller
      };
    } catch (err) {
      tlog.warn(`failed to load budget state for ${mind}`, log.errorData(err));
      return null;
    }
  }

  private async replay(mindName: string, messages: QueuedMessage[]): Promise<void> {
    const summary = messages
      .map((m) => {
        const from = m.sender ? `[${m.sender}]` : "";
        const ch = m.channel ? `(${m.channel})` : "";
        return `${from}${ch} ${m.textContent}`;
      })
      .join("\n");

    try {
      await deliverMessage(mindName, {
        content: [
          {
            type: "text",
            text: `[Budget replay] ${messages.length} queued message(s) from the previous budget period:\n\n${summary}`,
          },
        ],
        channel: "system:budget-replay",
        sender: "system",
      });
      tlog.info(`replayed ${messages.length} queued message(s) for ${mindName}`);
    } catch (err) {
      tlog.warn(`failed to replay for ${mindName}`, log.errorData(err));
      // Re-enqueue so messages aren't lost
      const state = this.budgets.get(mindName);
      if (state) state.queue.push(...messages);
    }
  }
}

let instance: TokenBudget | null = null;

export function initTokenBudget(): TokenBudget {
  if (instance) throw new Error("TokenBudget already initialized");
  instance = new TokenBudget();
  return instance;
}

export function getTokenBudget(): TokenBudget {
  if (!instance) throw new Error("TokenBudget not initialized — call initTokenBudget() first");
  return instance;
}
