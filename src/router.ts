/**
 * Picks the cheapest Claude model that gets each job right, and learns.
 *
 * Every job (reading a repair person's reply, picking a trade, ...) is tried
 * on the cheap model first. Its answer is kept only if it says it's sure
 * and the answer checks out (a time the line can read, a real command).
 * Otherwise the strong model answers.
 *
 * Per kind of job, it remembers how often the cheap model had to be
 * overruled. When that's most of the time, it stops trying the cheap model
 * for that job (saving the wasted call and the wait), but still tries it
 * now and then in case it does better.
 */

export type Attempt<T> = {
  value: T | null;
  /** The model said it was confident. Only the cheap model's answer needs it. */
  sure: boolean;
  costUsd: number;
  model: string;
};

export type RouterOptions = {
  /** How many recent cheap tries to judge by. */
  window?: number;
  /** Above this share of overruled cheap answers, go straight to strong. */
  maxFailRate?: number;
  /** While skipping cheap, still try it every this many calls. */
  exploreEvery?: number;
  log?: (line: string) => void;
};

type Stats = { recent: boolean[]; calls: number };

export class ModelRouter {
  private stats = new Map<string, Stats>();
  totalUsd = 0;
  private opts: Required<RouterOptions>;

  constructor(opts: RouterOptions = {}) {
    this.opts = { window: 20, maxFailRate: 0.6, exploreEvery: 10, log: () => {}, ...opts };
  }

  /** Share of the recent cheap tries for this job that were overruled. */
  failRate(key: string): number {
    const s = this.stats.get(key);
    if (!s || s.recent.length === 0) return 0;
    return s.recent.filter((ok) => !ok).length / s.recent.length;
  }

  /** Whether the next call for this job will skip the cheap model. */
  skipsCheap(key: string): boolean {
    const s = this.stats.get(key);
    if (!s || s.recent.length < this.opts.window) return false;
    if (this.failRate(key) <= this.opts.maxFailRate) return false;
    return (s.calls + 1) % this.opts.exploreEvery !== 0;
  }

  async run<T>(
    key: string,
    cheap: () => Promise<Attempt<T>>,
    strong: () => Promise<Attempt<T>>,
    good: (value: T | null) => boolean,
  ): Promise<T | null> {
    const s = this.stats.get(key) ?? { recent: [], calls: 0 };
    this.stats.set(key, s);
    const skip = this.skipsCheap(key);
    s.calls++;

    if (!skip) {
      let a: Attempt<T> | null = null;
      try {
        a = await cheap();
      } catch (error) {
        this.opts.log(`AI ${key}: cheap model failed (${error instanceof Error ? error.message : error}), using the strong one`);
      }
      if (a) this.add(a.costUsd);
      const ok = !!a && a.sure && good(a.value);
      s.recent.push(ok);
      if (s.recent.length > this.opts.window) s.recent.shift();
      if (a && ok) {
        this.opts.log(`AI ${key}: ${a.model} $${a.costUsd.toFixed(4)} · total $${this.totalUsd.toFixed(2)}`);
        return a.value;
      }
    }

    const b = await strong();
    this.add(b.costUsd);
    this.opts.log(
      `AI ${key}: ${b.model}${skip ? " (cheap model skipped: it's been wrong here lately)" : " (cheap model wasn't sure)"} $${b.costUsd.toFixed(4)} · total $${this.totalUsd.toFixed(2)}`,
    );
    return good(b.value) ? b.value : null;
  }

  add(costUsd: number) {
    this.totalUsd += costUsd;
  }
}

/** $ per million tokens, from Anthropic's price list. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** What one response cost, from its token counts. Unknown models count as Opus. */
export function costOf(model: string, usage: Usage): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  return (usage.input_tokens * p.input + read * p.input * 0.1 + write * p.input * 1.25 + usage.output_tokens * p.output) / 1e6;
}
