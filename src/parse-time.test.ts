import { formatSlot, parseVisitTime } from "./parse-time.js";

const SUN_9PM = new Date(2026, 10, 8, 21, 0); // Sun Nov 8 2026
const read = (t: string) => {
  const d = parseVisitTime(t, SUN_9PM);
  return d ? formatSlot(d.toISOString()) : null;
};

it.each([
  ["tomorrow 8am", "Mon, Nov 9, 8:00 AM"],
  ["tmrw 2:30pm", "Mon, Nov 9, 2:30 PM"],
  ["Tue 9am", "Tue, Nov 10, 9:00 AM"],
  ["tuesday at 9", "Tue, Nov 10, 9:00 AM"],
  ["wed 3", "Wed, Nov 11, 3:00 PM"],
  ["11/12 10am", "Thu, Nov 12, 10:00 AM"],
  ["8am", "Mon, Nov 9, 8:00 AM"],
  ["sun noon", "Sun, Nov 15, 12:00 PM"],
])("%s -> %s", (input, expected) => {
  expect(read(input)).toBe(expected);
});

it.each(["sometime this week", "tuesday", "yes", "today 8am", "cant tmrw, thurs after 2"])("%s -> asks again", (input) => {
  expect(read(input)).toBeNull();
});
