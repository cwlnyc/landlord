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
 *
 * Spot checks: a small model can be sure and wrong in a way no check
 * catches ("can't do Thursday, Friday 2pm works" read as Thursday 2pm).
 * So some answers the cheap model is sure about are also given to the
 * strong model: every one for a job's first few, then about 1 in 20. If
 * they disagree, the strong answer is used for that message and the cheap
 * one counts as wrong. That makes the learning measure real accuracy,
 * not the cheap model's opinion of itself.
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
  /** Share of sure cheap answers double-checked by the strong model. */
  spotCheckRate?: number;
  /** Per job, double-check this many of the cheap model's first sure answers. */
  spotCheckFirst?: number;
  /** For tests: a stand-in for Math.random. */
  random?: () => number;
  log?: (line: string) => void;
};

type Stats = { recent: boolean[]; calls: number; checked: number; disagreed: number; accepted: number };

export class ModelRouter {
  private stats = new Map<string, Stats>();
  totalUsd = 0;
  private opts: Required<RouterOptions>;

  constructor(opts: RouterOptions = {}) {
    this.opts = {
      window: 20,
      maxFailRate: 0.6,
      exploreEvery: 10,
      spotCheckRate: 0.05,
      spotCheckFirst: 10,
      random: Math.random,
      log: () => {},
      ...opts,
    };
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

  /** How the spot checks have gone for a job: checked, and how many disagreed. */
  spotChecks(key: string): { checked: number; disagreed: number } {
    const s = this.stats.get(key);
    return { checked: s?.checked ?? 0, disagreed: s?.disagreed ?? 0 };
  }

  async run<T>(
    key: string,
    cheap: () => Promise<Attempt<T>>,
    strong: () => Promise<Attempt<T>>,
    good: (value: T | null) => boolean,
    /** Whether two answers mean the same thing ("2pm" and "2:00pm"). */
    same: (a: T | null, b: T | null) => boolean = (a, b) => a === b,
  ): Promise<T | null> {
    const s = this.stats.get(key) ?? { recent: [], calls: 0, checked: 0, disagreed: 0, accepted: 0 };
    this.stats.set(key, s);
    const skip = this.skipsCheap(key);
    s.calls++;
    const remember = (ok: boolean) => {
      s.recent.push(ok);
      if (s.recent.length > this.opts.window) s.recent.shift();
    };

    if (!skip) {
      let a: Attempt<T> | null = null;
      try {
        a = await cheap();
      } catch (error) {
        this.opts.log(`AI ${key}: cheap model failed (${error instanceof Error ? error.message : error}), using the strong one`);
      }
      if (a) this.add(a.costUsd);
      const ok = !!a && a.sure && good(a.value);
      if (a && ok) {
        s.accepted++;
        const check = s.accepted <= this.opts.spotCheckFirst || this.opts.random() < this.opts.spotCheckRate;
        if (!check) {
          remember(true);
          this.opts.log(`AI ${key}: ${a.model} $${a.costUsd.toFixed(4)} · total $${this.totalUsd.toFixed(2)}`);
          return a.value;
        }
        // Spot check: the strong model answers too, and wins if they differ.
        let b: Attempt<T> | null = null;
        try {
          b = await strong();
        } catch {
          // Can't check this time; the cheap answer stands, unjudged.
        }
        if (!b) {
          remember(true);
          return a.value;
        }
        this.add(b.costUsd);
        s.checked++;
        const agree = same(a.value, b.value) || !good(b.value);
        if (!agree) s.disagreed++;
        remember(agree);
        this.opts.log(
          `AI ${key}: spot check ${agree ? "agreed" : `DISAGREED (${a.model} said ${JSON.stringify(a.value)}, ${b.model} said ${JSON.stringify(b.value)}; using ${b.model}'s)`} · ${s.disagreed} of ${s.checked} checks disagreed · $${(a.costUsd + b.costUsd).toFixed(4)} · total $${this.totalUsd.toFixed(2)}`,
        );
        return agree ? a.value : b.value;
      }
      remember(false);
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
