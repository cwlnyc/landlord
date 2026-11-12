import { sameReply, usableReply } from "./engine.js";
import { ModelRouter, costOf, type Attempt } from "./router.js";

const answer = <T,>(value: T | null, sure = true, model = "claude-haiku-5-5", costUsd = 0.0001): Attempt<T> => ({
  value,
  sure,
  model,
  costUsd,
});
const strongAnswer = <T,>(value: T | null) => answer(value, true, "claude-opus-5-5", 0.01);
const isTime = (v: string | null) => v !== null && /\d/.test(v);
// These tests are about routing and learning; spot checks have their own.
const noChecks = { spotCheckFirst: 0, random: () => 1 };

describe("cheap model first, strong when needed", () => {
  it("keeps the cheap answer when it's sure and checks out", async () => {
    const r = new ModelRouter(noChecks);
    let strongCalls = 0;
    const out = await r.run("read vendor text", async () => answer("11/12 2:00pm"), async () => (strongCalls++, strongAnswer("x")), isTime);
    expect(out).toBe("11/12 2:00pm");
    expect(strongCalls).toBe(0);
  });

  it("asks the strong model when the cheap one isn't sure", async () => {
    const r = new ModelRouter(noChecks);
    const out = await r.run("k", async () => answer("11/12 2:00pm", false), async () => strongAnswer("11/13 9:00am"), isTime);
    expect(out).toBe("11/13 9:00am");
  });

  it("asks the strong model when the cheap answer doesn't check out, even if 'sure'", async () => {
    const r = new ModelRouter(noChecks);
    const out = await r.run("k", async () => answer("sometime thursday"), async () => strongAnswer("11/12 2:00pm"), isTime);
    expect(out).toBe("11/12 2:00pm");
  });

  it("asks the strong model when the cheap call fails", async () => {
    const r = new ModelRouter(noChecks);
    const out = await r.run("k", async () => { throw new Error("overloaded"); }, async () => strongAnswer("11/12 2:00pm"), isTime);
    expect(out).toBe("11/12 2:00pm");
  });

  it("returns null when even the strong answer doesn't check out", async () => {
    const r = new ModelRouter(noChecks);
    expect(await r.run("k", async () => answer<string>(null), async () => strongAnswer("whenever"), isTime)).toBeNull();
  });

  it("adds up what it spent", async () => {
    const r = new ModelRouter(noChecks);
    await r.run("k", async () => answer("no", false), async () => strongAnswer("11/12 2:00pm"), isTime);
    expect(r.totalUsd).toBeCloseTo(0.0101, 6);
  });
});

describe("learning per kind of job", () => {
  const opts = { window: 5, maxFailRate: 0.6, exploreEvery: 4, ...noChecks };

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

describe("spot checks: catching a cheap model that's sure and wrong", () => {
  // Dad's worry: "can't do Thursday, Friday 2pm works" read as Thursday 2pm.
  // A real time, so no check catches it; only a second opinion does.
  const sureButWrong = async () => answer("11/12 2:00pm"); // Thursday
  const right = async () => strongAnswer("11/13 2:00pm"); // Friday

  it("double-checks a job's first sure answers, and uses the strong answer when they differ", async () => {
    const r = new ModelRouter({ spotCheckFirst: 3, random: () => 1 });
    const out = await r.run("read vendor text", sureButWrong, right, isTime);
    expect(out).toBe("11/13 2:00pm");
    expect(r.spotChecks("read vendor text")).toEqual({ checked: 1, disagreed: 1 });
  });

  it("after the first few, checks about 1 in 20", async () => {
    let strongCalls = 0;
    const strong = async () => (strongCalls++, strongAnswer("11/12 2:00pm"));
    const rolls = [0.5, 0.01, 0.9, 0.3];
    const r = new ModelRouter({ spotCheckFirst: 0, spotCheckRate: 0.05, random: () => rolls.shift() ?? 1 });
    for (let i = 0; i < 4; i++) await r.run("k", async () => answer("11/12 2:00pm"), strong, isTime);
    expect(strongCalls).toBe(1); // only the 0.01 roll
  });

  it("answers that mean the same thing agree ('2pm' vs '2:00pm')", async () => {
    const r = new ModelRouter({ spotCheckFirst: 1, random: () => 1 });
    const same = (a: string | null, b: string | null) => a?.replace(":00", "") === b?.replace(":00", "");
    const out = await r.run("k", async () => answer("11/12 2pm"), async () => strongAnswer("11/12 2:00pm"), isTime, same);
    expect(out).toBe("11/12 2pm");
    expect(r.spotChecks("k")).toEqual({ checked: 1, disagreed: 0 });
  });

  it("a cheap model that's confidently wrong gets benched, even though it never said 'not sure'", async () => {
    const r = new ModelRouter({ window: 5, maxFailRate: 0.6, exploreEvery: 4, spotCheckFirst: 5, random: () => 1 });
    for (let i = 0; i < 5; i++) await r.run("read vendor text", sureButWrong, right, isTime);
    expect(r.failRate("read vendor text")).toBe(1);
    expect(r.skipsCheap("read vendor text")).toBe(true);
  });

  it("if the strong model can't be reached, the cheap answer stands", async () => {
    const r = new ModelRouter({ spotCheckFirst: 1, random: () => 1 });
    const out = await r.run("k", sureButWrong, async () => { throw new Error("overloaded"); }, isTime);
    expect(out).toBe("11/12 2:00pm");
  });
});

describe("what counts as an answer the line can use", () => {
  const now = new Date(2026, 10, 8, 21);
  it.each([
    ["landlord", "YES", true],
    ["landlord", "FIND plumber 3", true],
    ["landlord", "sure, go ahead", true], // "sure" is a YES
    ["landlord", "go ahead with him", true], // "go ahead" is a yes
    ["landlord", "how about the other guy", false],
    ["vendor", "11/12 2:00pm", true],
    ["vendor", "NO", true],
    ["vendor", "thursday afternoon", false],
    ["tenant", "1", true],
    ["tenant", "yes", false],
  ] as const)("%s: %s -> %s", (role, command, ok) => {
    expect(usableReply(role, command, now)).toBe(ok);
  });
});

describe("the same reply, said two ways", () => {
  const now = new Date(2026, 10, 8, 21);
  it.each([
    ["vendor", "11/12 2pm", "11/12 2:00pm", true],
    ["vendor", "thu 2pm", "11/12 2:00pm", true],
    ["vendor", "11/12 2:00pm", "11/13 2:00pm", false],
    ["vendor", "no", "NO", true],
    ["landlord", "find plumber #3", "FIND PLUMBER 3", true],
    ["landlord", "YES", "NO", false],
  ] as const)("%s: %s ~ %s -> %s", (role, a, b, same) => {
    expect(sameReply(role, a, b, now)).toBe(same);
  });
});

it("prices responses by model", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
  expect(costOf("claude-haiku-5-5", usage)).toBeCloseTo(0.6);
  expect(costOf("claude-opus-5-5", usage)).toBeCloseTo(24);
  expect(costOf("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.2);
});
