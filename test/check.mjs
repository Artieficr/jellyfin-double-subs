// Self-check for the pure helpers in web/doublesubs.js. Run: node test/check.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../web/doublesubs.js', import.meta.url), 'utf8');
// eval of our own source file only (no build step, so the helpers aren't importable).
const grab = re => eval('(' + src.match(re)[1] + ')');
const clean = grab(/const clean = (t => [\s\S]*?\.trim\(\));/);
const estimateOffset = grab(/(function estimateOffset[\s\S]*?\n {2}\})\n/);
const overlap = grab(/const overlap = (\(a, b\) => [^;]*);/); // used by splitAcross
const splitAcross = grab(/(function splitAcross[\s\S]*?\n {2}\})\n/);

// splitAcross(): a merged secondary line is split back over the main lines it covers
const m2 = [{ start: 0, end: 2000, text: "It's just raining." }, { start: 2100, end: 4000, text: "What'd the boss say?" }];
const parts = s => splitAcross(m2, { start: 0, end: 4000, text: s }).map(x => [x.text, x.pair === m2[0] ? 0 : x.pair === m2[1] ? 1 : null]);
assert.deepStrictEqual(parts('- Это всего лишь дождик.\n- Что сказал босс?'), [['Это всего лишь дождик.', 0], ['Что сказал босс?', 1]]);
assert.deepStrictEqual(parts('перечень всех голубых предметов. Дай мне поработать спокойно.'), [['перечень всех голубых предметов.', 0], ['Дай мне поработать спокойно.', 1]]);
assert.deepStrictEqual(parts('Одна фраза без точки посередине'), [['Одна фраза без точки посередине', null]]); // can't split: left whole
assert.deepStrictEqual(parts('Раз. Два. Три.'), [['Раз. Два. Три.', null]]); // 3 sentences over 2 lines: left whole
assert.strictEqual(splitAcross(m2, { start: 0, end: 1900, text: 'Один. Два.' }).length, 1); // covers only one main line

// clean(): join the file's line breaks, keep speaker dashes, strip tags
assert.strictEqual(clean('One boring blue boy\nin a painfully\nboring painting.'), 'One boring blue boy in a painfully boring painting.');
assert.strictEqual(clean('- Hi!\n- Hello.'), '- Hi!\n- Hello.');
assert.strictEqual(clean('{\\i1}Hey{\\i0}\\Nyou'), 'Hey you');
assert.strictEqual(clean('<i>Let me guess.</i>\nYou are'), 'Let me guess. You are');

// estimateOffset(): main track of 900 lines; secondary = same lines, some split in two, 10 % unmatched noise
let seed = 1;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const main = [];
for (let t = 5000; main.length < 900; t += 1500 + rnd() * 5000) main.push({ start: t, end: t + 1000 + rnd() * 2500 });
const secondary = d => main.flatMap(e => {
  const s = e.start + d + (rnd() - 0.5) * 60; // ±30 ms timing jitter
  if (rnd() < 0.2) return [{ start: s, end: s + 600 }, { start: s + 700, end: e.end + d }]; // split differently
  if (rnd() < 0.1) return [{ start: s + 2000 + rnd() * 3000, end: s + 6000 }]; // unrelated line
  return [{ start: s, end: e.end + d }];
});
const near = (a, b) => Math.abs(a - b) <= 100;
for (const d of [0, 700, -700, 2300, -12000]) assert(near(estimateOffset(main, secondary(d)), -d), `shift ${d}`);
const unrelated = main.map((e, i) => ({ start: (i * 7919) % 6000000, end: (i * 7919) % 6000000 + 2000 })).sort((a, b) => a.start - b.start);
assert.strictEqual(estimateOffset(main, unrelated), 0, 'unrelated track must not be shifted');

console.log('check OK');
