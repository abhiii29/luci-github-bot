import { AsyncLocalStorage } from "node:async_hooks";

/** Model usage accumulated over one job. Jobs can run concurrently, so it lives in async context. */
export interface Usage {
  models: string[];
  inputTokens: number;
  outputTokens: number;
  calls: number;
  /** At least one call reported token counts. */
  reported: boolean;
}

export interface Pricing {
  inputPerMTok?: number;
  outputPerMTok?: number;
}

const store = new AsyncLocalStorage<Usage>();

export function withUsage<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ models: [], inputTokens: 0, outputTokens: 0, calls: 0, reported: false }, fn);
}

/** No-op outside `withUsage`. Counts the call even when the model reported no tokens. */
export function recordUsage(model: string, inputTokens?: number, outputTokens?: number): void {
  const u = store.getStore();
  if (!u) return;
  u.calls++;
  if (!u.models.includes(model)) u.models.push(model);
  if (inputTokens !== undefined || outputTokens !== undefined) {
    u.reported = true;
    u.inputTokens += inputTokens ?? 0;
    u.outputTokens += outputTokens ?? 0;
  }
}

export function currentUsage(): Usage | undefined {
  const u = store.getStore();
  return u ? { ...u, models: [...u.models] } : undefined;
}

const num = (n: number) => n.toLocaleString("en-US");

/** One status-comment line; undefined when no model was called. */
export function formatUsage(u: Usage | undefined, pricing: Pricing): string | undefined {
  if (!u || u.calls === 0) return undefined;
  const calls = `${u.calls} call${u.calls === 1 ? "" : "s"}`;
  const tokens = u.reported
    ? `Tokens: ${num(u.inputTokens)} in / ${num(u.outputTokens)} out (${calls})`
    : `Tokens: not reported (${calls})`;
  let cost: string;
  if (pricing.inputPerMTok === undefined || pricing.outputPerMTok === undefined) {
    cost = "n/a (set LLM_PRICE_INPUT_PER_MTOK / LLM_PRICE_OUTPUT_PER_MTOK)";
  } else if (!u.reported) {
    cost = "n/a";
  } else {
    const usd = (u.inputTokens * pricing.inputPerMTok + u.outputTokens * pricing.outputPerMTok) / 1_000_000;
    cost = usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
  }
  return `🧮 Model: ${u.models.join(", ")} · ${tokens} · Est. cost: ${cost}`;
}
