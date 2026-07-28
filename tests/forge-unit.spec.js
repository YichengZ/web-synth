import { expect, test } from "@playwright/test";
import {
  createForgeDna,
  createForgeRandom,
  hashForgeSeed,
} from "../src/forge-audio.js";

test("forge family DNA is deterministic and derived seeds diverge", () => {
  const first = createForgeDna(20260728);
  const second = createForgeDna(20260728);
  expect(first).toEqual(second);

  const seeds = new Set();
  for (let index = 0; index < 16; index += 1) {
    seeds.add(hashForgeSeed(first.seed + index * 0x9e3779b9));
  }
  expect(seeds.size).toBe(16);
});

test("forge random stream is reproducible and bounded", () => {
  const left = createForgeRandom(711);
  const right = createForgeRandom(711);
  const leftValues = Array.from({ length: 64 }, () => left());
  const rightValues = Array.from({ length: 64 }, () => right());
  expect(leftValues).toEqual(rightValues);
  expect(Math.min(...leftValues)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...leftValues)).toBeLessThan(1);
  expect(new Set(leftValues).size).toBeGreaterThan(60);
});
