import { usableReply } from "./engine.js";
import { ModelRouter, costOf, type Attempt } from "./router.js";

const answer = <T,>(value: T | null, sure = true, model = "claude-haiku-5-5", costUsd = 0.0001): Attempt<T> => ({
  value,
  sure,
  model,
  costUsd,
});
const strongAnswer = <T,>(value: T | null) => answer(value, true, "claude-opus-5-5", 0.01);
const isTime = (v: string | null) => v !== null && /\d/.test(v);

describe("cheap model first, strong when needed", () => {
  it("keeps the cheap answer when it's sure and checks out", async () => {
    const r = new ModelRouter();
    let strongCalls = 0;
    const out = await r.run("read vendor text", async () => answer("11/12 2:00pm"), async () => (strongCalls++, strongAnswer("x")), isTime);
    expect(out).toBe("11/12 2:00pm");
    expect(strongCalls).toBe(0);
  });

  it("asks the strong model when the cheap one isn't sure", async () => {
    const r = new ModelRouter();
    const out = await r.run("k", async () => answer("11/12 2:00pm", false), async () => strongAnswer("11/13 9:00am"), isTime);
    expect(out).toBe("11/13 9:00am");
  });

  it("asks the strong model when the cheap answer doesn't check out, even if 'sure'", async () => {
    const r = new ModelRouter();
    const out = await r.run("k", async () => answer("sometime thursday"), async () => strongAnswer("11/12 2:00pm"), isTime);
    expect(out).toBe("11/12 2:00pm");
  });

  it("asks the strong model when the cheap call fails", async () => {
    const r = new ModelRouter();
    const out = await r.run("k", async () => { throw new Error("overloaded"); }, async () => strongAnswer("11/12 2:00pm"), isTime);
    expect(out).toBe("11/12 2:00pm");
  });

  it("returns null when even the strong answer doesn't check out", async () => {
    const r = new ModelRouter();
    expect(await r.run("k", async () => answer<string>(null), async () => strongAnswer("whenever"), isTime)).toBeNull();
  });

  it("adds up what it spent", async () => {
    const r = new ModelRouter();
    await r.run("k", async () => answer("no", false), async () => strongAnswer("11/12 2:00pm"), isTime);
    expect(r.totalUsd).toBeCloseTo(0.0101, 6);
  });
});

describe("learning per kind of job", () => {
  const opts = { window: 5, maxFailRate: 0.6, exploreEvery: 4 };

  it("stops trying the cheap model on a job where it keeps being overruled, but still checks back", async () => {
    const r = new ModelRouter(opts);
    let cheapCalls = 0;
    const cheapWrong = async () => (cheapCalls++, answer("nope"));
    const strong = async () => strongAnswer("11/12 2:00pm");
    for (let i = 0; i < 5; i++) await r.run("read vendor text", cheapWrong, strong, isTime);
    expect(cheapCalls).toBe(5);
    expect(r.failRate("read vendor text")).toBe(1);

    // Now it skips the cheap model, except every 4th call to see if it improved.
    cheapCalls = 0;
    for (let i = 0; i < 8; i++) await r.run("read vendor text", cheapWrong, strong, isTime);
    expect(cheapCalls).toBe(2);
  });

  it("each job learns on its own", async () => {
    const r = new ModelRouter(opts);
    for (let i = 0; i < 5; i++) await r.run("read vendor text", async () => answer("nope"), async () => strongAnswer("11/12 2:00pm"), isTime);
    expect(r.skipsCheap("read vendor text")).toBe(true);
    expect(r.skipsCheap("pick a trade")).toBe(false);
  });

  it("goes back to the cheap model once it starts getting things right", async () => {
    const r = new ModelRouter(opts);
    const strong = async () => strongAnswer("11/12 2:00pm");
    for (let i = 0; i < 5; i++) await r.run("k", async () => answer("nope"), strong, isTime);
    // Its occasional check-back tries now succeed, pulling the fail rate down.
    for (let i = 0; i < 40 && r.skipsCheap("k"); i++) await r.run("k", async () => answer("11/12 3:00pm"), strong, isTime);
    expect(r.skipsCheap("k")).toBe(false);
  });
});

describe("what counts as an answer the line can use", () => {
  const now = new Date(2026, 10, 8, 21);
  it.each([
    ["landlord", "YES", true],
    ["landlord", "FIND plumber 3", true],
    ["landlord", "sure, go ahead", true], // "sure" is a YES
    ["landlord", "go ahead with him", false],
    ["vendor", "11/12 2:00pm", true],
    ["vendor", "NO", true],
    ["vendor", "thursday afternoon", false],
    ["tenant", "1", true],
    ["tenant", "yes", false],
  ] as const)("%s: %s -> %s", (role, command, ok) => {
    expect(usableReply(role, command, now)).toBe(ok);
  });
});

it("prices responses by model", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
  expect(costOf("claude-haiku-5-5", usage)).toBeCloseTo(0.6);
  expect(costOf("claude-opus-5-5", usage)).toBeCloseTo(24);
  expect(costOf("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.2);
});
