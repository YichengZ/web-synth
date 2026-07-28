import { expect, test } from "@playwright/test";
import { readFile, stat } from "node:fs/promises";

test.describe.configure({ mode: "serial" });

const synths = [
  { name: "PRISM", path: "/CrystalPrism.html" },
  { name: "Kawaii", path: "/KawaiiSynth.html" },
  { name: "TITAN", path: "/TITAN_SUB.html" },
  { name: "CONVERGENCE", path: "/Convergence.html" },
  { name: "CONVERGENCE FORGE", path: "/ConvergenceForge.html" },
];

const getWavPeak = (wav) => {
  let peak = 0;
  for (let offset = 44; offset + 2 < wav.length; offset += 3) {
    let sample = wav[offset] | (wav[offset + 1] << 8) | (wav[offset + 2] << 16);
    if (sample & 0x800000) sample |= 0xff000000;
    peak = Math.max(peak, Math.abs(sample / 0x800000));
  }
  return peak;
};

const getWavMaxDelta = (wav) => {
  let maxDelta = 0;
  const previous = [0, 0];
  for (let offset = 44, channel = 0; offset + 2 < wav.length; offset += 3) {
    let sample = wav[offset] | (wav[offset + 1] << 8) | (wav[offset + 2] << 16);
    if (sample & 0x800000) sample |= 0xff000000;
    const value = sample / 0x800000;
    maxDelta = Math.max(maxDelta, Math.abs(value - previous[channel]));
    previous[channel] = value;
    channel = channel ? 0 : 1;
  }
  return maxDelta;
};

for (const synth of synths) {
  test(`${synth.name} loads without errors or horizontal overflow`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await page.goto(synth.path);
    await expect(page.locator("main")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(await page.locator('input[type="range"]:not([aria-label])').count()).toBe(0);
    expect(errors).toEqual([]);
  });
}

test("TITAN graph responds to touch pointer dragging", async ({ page }) => {
  await page.goto("/TITAN_SUB.html");
  const point = page.locator("svg circle").nth(1);
  const box = await point.boundingBox();
  const before = await point.getAttribute("cy");
  expect(box).not.toBeNull();

  await point.dispatchEvent("pointerdown", {
    pointerId: 7,
    pointerType: "touch",
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
    bubbles: true,
  });
  await page.evaluate(({ x, y }) => {
    window.dispatchEvent(new PointerEvent("pointermove", {
      pointerId: 7,
      pointerType: "touch",
      clientX: x,
      clientY: y,
      bubbles: true,
    }));
    window.dispatchEvent(new PointerEvent("pointerup", {
      pointerId: 7,
      pointerType: "touch",
      clientX: x,
      clientY: y,
      bubbles: true,
    }));
  }, { x: box.x + box.width / 2, y: box.y - 35 });

  await expect(point).not.toHaveAttribute("cy", before);
});

test("Kawaii sliders keep visible progress and track contrast", async ({ page }) => {
  await page.goto("/KawaiiSynth.html");
  const sliders = page.locator(".kawaii-range");
  await expect(sliders).toHaveCount(11);

  const appearance = await sliders.first().evaluate((slider) => {
    const styles = getComputedStyle(slider);
    return {
      backgroundImage: styles.backgroundImage,
      borderColor: styles.borderColor,
    };
  });

  expect(appearance.backgroundImage).toContain("linear-gradient");
  expect(appearance.backgroundImage).toContain("rgb(30, 41, 59)");
  expect(appearance.borderColor).toBe("rgb(51, 65, 85)");
});

test("CONVERGENCE switches between all master bus presets", async ({ page }) => {
  await page.goto("/Convergence.html");
  const multiband = page.getByRole("button", { name: "L3-STYLE" });
  const inflator = page.getByRole("button", { name: "INFLATOR" });
  const brutal = page.getByRole("button", { name: "BRUTAL" });
  await expect(brutal).toHaveAttribute("aria-pressed", "true");
  await multiband.click();
  await expect(multiband).toHaveAttribute("aria-pressed", "true");
  await inflator.click();
  await expect(inflator).toHaveAttribute("aria-pressed", "true");
  await brutal.click();
  await expect(brutal).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Drive")).toHaveValue("12");
  await expect(page.getByLabel("Tone")).toBeVisible();
  await expect(page.getByText("OTT > CLIP")).toBeVisible();
});

test("CONVERGENCE initializes the stable 48 kHz preview graph", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  await page.goto("/Convergence.html");
  await page.getByRole("button", { name: "Generate convergence burst" }).click();
  await expect(page.getByText("48 KHZ")).toHaveText("48 KHZ");
  await expect(page.getByText(/COLOR > SHARED TONAL/)).toHaveCount(3);
  expect(errors).toEqual([]);
});

test("CONVERGENCE preview clock stays real time and suspends when idle", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Realtime performance is measured once on desktop.");
  await page.addInitScript(() => {
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class TestAudioContext extends NativeAudioContext {
      constructor(...args) {
        super(...args);
        window.__testAudioContext = this;
      }
    };
  });
  await page.goto("/Convergence.html");
  await page.getByLabel("Density").fill("1");
  await page.getByRole("button", { name: "Generate convergence burst" }).click();
  await page.waitForTimeout(2500);
  const start = await page.evaluate(() => ({
    audio: window.__testAudioContext.currentTime,
    wall: performance.now(),
  }));
  await page.waitForTimeout(4000);
  const ratio = await page.evaluate(({ audio, wall }) => (
    (window.__testAudioContext.currentTime - audio) / ((performance.now() - wall) / 1000)
  ), start);
  expect(ratio).toBeGreaterThan(0.98);
  await page.getByRole("button", { name: "Stop all convergence voices" }).click();
  await expect.poll(
    () => page.evaluate(() => window.__testAudioContext.state),
    { timeout: 4000 },
  ).toBe("suspended");
});

test("CONVERGENCE FORGE completes, previews, downloads, and captures at 96 kHz", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "The offline render pipeline is covered once on desktop.");
  test.setTimeout(120_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  await page.goto("/ConvergenceForge.html?forgeTest=1");
  await page.getByRole("button", { name: /ROLL/ }).click();
  await expect(page.getByText("COMPLETE / SESSION READY")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("button", { name: /^WHOOSH 2$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^MASTER 1$/ })).toBeVisible();
  await page.getByRole("button", { name: /^MASTER 1$/ }).click();

  const directDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download master-01" }).click();
  const directWav = await readFile(await (await directDownload).path());
  expect(directWav.readUInt32LE(24)).toBe(96_000);
  expect(directWav.readUInt16LE(34)).toBe(24);
  expect(getWavPeak(directWav)).toBeLessThan(0.88);
  expect(getWavMaxDelta(directWav)).toBeLessThan(0.82);

  await page.getByRole("button", { name: "Play master-01" }).click();
  await expect(page.getByRole("button", { name: "Stop master-01" })).toBeVisible();
  await page.getByRole("button", { name: "Stop master-01" }).click();
  await expect(page.getByRole("button", { name: "Play master-01" })).toBeVisible();
  await page.getByRole("button", { name: "REC SET" }).click();
  await page.getByRole("button", { name: "Trigger master-01" }).click();
  await page.waitForTimeout(1000);
  const captureDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /^STOP \d{2}:\d{2}$/ }).click();
  const captureWav = await readFile(await (await captureDownload).path());
  expect(captureWav.readUInt32LE(24)).toBe(96_000);
  expect(captureWav.readUInt16LE(34)).toBe(24);
  expect(captureWav.length).toBeGreaterThan(20_000);
  await page.getByRole("button", { name: "Clear roll" }).click();
  await expect(page.getByRole("button", { name: /^WHOOSH 0$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^MASTER 0$/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("CONVERGENCE FORGE cancels between offline stages", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "The offline cancellation path is covered once on desktop.");
  await page.goto("/ConvergenceForge.html?forgeTest=1");
  await page.getByRole("button", { name: /ROLL/ }).click();
  await page.getByRole("button", { name: /Cancel/ }).click();
  await expect(page.getByText("CANCELLED / MEMORY RELEASED")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /^WHOOSH 0$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^MASTER 0$/ })).toBeVisible();
});

test("CONVERGENCE advances seeds and varies scene gestures", async ({ page }) => {
  await page.goto("/Convergence.html");
  const burst = page.getByRole("button", { name: "Generate convergence burst" });
  const stop = page.getByRole("button", { name: "Stop all convergence voices" });
  const seed = page.getByLabel("Scene seed");
  const gesture = page.getByText(/^T:/);
  const effects = page.getByText(/^FX T:/);
  const seenGestures = new Set();
  const seenEffects = new Set();
  const seenTriggerCounts = new Set();
  let previousSeed = await seed.inputValue();
  let previousSceneSeed = await gesture.getAttribute("data-scene-seed");

  for (let index = 0; index < 4; index += 1) {
    await burst.click();
    await expect(seed).not.toHaveValue(previousSeed);
    await expect(gesture).not.toHaveAttribute("data-scene-seed", previousSceneSeed);
    await expect(gesture).toHaveText(/^T:(DROP|RISE|PULSE|BOUNCE|GLIDE) \/ K:(PLUCK|STAB|CHORD|BEND|PULSE) \/ P:(SHARD|RIBBON|SWELL|CASCADE|PULSE)$/);
    await expect(effects).toHaveText(/^FX T:(MOD|GRAIN|DISPERSE) \/ K:(MOD|GRAIN|DISPERSE) \/ P:(MOD|GRAIN|DISPERSE)$/);
    const mode = await page.getByText(/^BURST X[1-4]$/).textContent();
    seenGestures.add(await gesture.textContent());
    seenEffects.add(await effects.textContent());
    seenTriggerCounts.add(mode);
    previousSeed = await seed.inputValue();
    previousSceneSeed = await gesture.getAttribute("data-scene-seed");
    await stop.click();
  }

  expect(seenGestures.size).toBeGreaterThan(1);
  expect(seenEffects.size).toBeGreaterThan(1);
  expect(seenTriggerCounts.size).toBeGreaterThan(1);
});

test("CONVERGENCE recovers after extreme overlapping bursts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "The overload recovery path is covered once on desktop.");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  await page.addInitScript(() => {
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class TestAudioContext extends NativeAudioContext {
      constructor(...args) {
        super(...args);
        window.__testAudioContext = this;
        window.__activeOscillators = 0;
        const nativeCreateOscillator = this.createOscillator.bind(this);
        this.createOscillator = (...values) => {
          const oscillator = nativeCreateOscillator(...values);
          window.__activeOscillators += 1;
          oscillator.addEventListener("ended", () => {
            window.__activeOscillators -= 1;
          }, { once: true });
          return oscillator;
        };
      }
    };
  });
  await page.goto("/Convergence.html");
  await page.getByLabel("Density").fill("1");
  await page.getByLabel("Drive").fill("18");
  const burst = page.getByRole("button", { name: "Generate convergence burst" });
  await page.getByRole("button", { name: "REC WAV", exact: true }).click();
  for (let index = 0; index < 10; index += 1) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await burst.click();
      if (await burst.isDisabled()) break;
      await page.waitForTimeout(100);
    }
    await expect(burst).toBeDisabled();
    await page.waitForTimeout(430);
    await expect(burst).toBeEnabled();
  }
  const stressDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /^STOP/ }).first().click();
  const stressWav = await readFile(await (await stressDownloadPromise).path());
  expect(getWavPeak(stressWav)).toBeGreaterThan(0.01);
  expect(getWavPeak(stressWav)).toBeLessThan(0.9);
  expect(await page.evaluate(() => window.__activeOscillators)).toBeLessThanOrEqual(200);
  await page.getByRole("button", { name: "Stop all convergence voices" }).click();
  await expect.poll(() => page.evaluate(() => window.__activeOscillators)).toBe(0);

  await page.getByRole("button", { name: "REC WAV", exact: true }).click();
  const startTime = await page.evaluate(() => window.__testAudioContext.currentTime);
  await burst.click();
  await page.waitForFunction(
    (start) => window.__testAudioContext.currentTime - start >= 0.35,
    startTime,
    { timeout: 20_000 },
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /^STOP/ }).first().click();
  const download = await downloadPromise;
  const wav = await readFile(await download.path());
  const peak = getWavPeak(wav);
  expect(peak).toBeGreaterThan(0.01);
  expect(peak).toBeLessThan(0.9);
  expect(errors).toEqual([]);
});

test.describe("recording", () => {
  const recordingCases = [
    {
      path: "/CrystalPrism.html",
      recordName: "REC WAV",
      trigger: (page) => page.getByRole("button", { name: "Hold to trigger PRISM sound" }).click(),
    },
    {
      path: "/KawaiiSynth.html",
      recordName: "REC WAV",
      trigger: (page) => page.getByRole("button", { name: "Trigger Kawaii sound" }).click(),
    },
    {
      path: "/TITAN_SUB.html",
      recordName: "REC WAV",
      trigger: (page) => page.getByRole("button", { name: "TRIGGER", exact: true }).click(),
    },
    {
      name: "CONVERGENCE MULTIBAND",
      path: "/Convergence.html",
      recordName: "REC WAV",
      trigger: async (page) => {
        await page.getByRole("button", { name: "L3-STYLE" }).click();
        await page.getByRole("button", { name: "Generate convergence burst" }).click();
      },
      expectStereo: true,
      expectCeiling: true,
      captureSeconds: 0.45,
    },
    {
      name: "CONVERGENCE INFLATOR",
      path: "/Convergence.html",
      recordName: "REC WAV",
      trigger: async (page) => {
        await page.getByRole("button", { name: "INFLATOR" }).click();
        await page.getByRole("button", { name: "Generate convergence burst" }).click();
      },
      expectStereo: true,
      expectCeiling: true,
      captureSeconds: 0.45,
    },
    {
      name: "CONVERGENCE BRUTAL",
      path: "/Convergence.html",
      recordName: "REC WAV",
      trigger: (page) => page.getByRole("button", { name: "Generate convergence burst" }).click(),
      expectStereo: true,
      expectCeiling: true,
      captureSeconds: 0.45,
    },
  ];

  for (const recordingCase of recordingCases) {
    test(`${recordingCase.name || recordingCase.path} exports a WAV`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name === "mobile", "Recording export is covered once on desktop.");
      await page.addInitScript(() => {
        const NativeAudioContext = window.AudioContext;
        window.AudioContext = class TestAudioContext extends NativeAudioContext {
          constructor(...args) {
            super(...args);
            window.__testAudioContext = this;
          }
        };
      });
      await page.goto(recordingCase.path);
      await page.getByRole("button", { name: recordingCase.recordName, exact: true }).first().click();
      await expect(page.getByRole("button", { name: /^STOP/ }).first()).toBeVisible();
      const startTime = await page.evaluate(() => window.__testAudioContext.currentTime);
      await recordingCase.trigger(page);
      await page.waitForFunction(
        ({ start, duration }) => window.__testAudioContext.currentTime - start >= duration,
        { start: startTime, duration: recordingCase.captureSeconds || 0.2 },
        { timeout: 20_000 },
      );

      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: /^STOP/ }).first().click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/\.wav$/i);
      const downloadPath = await download.path();
      expect((await stat(downloadPath)).size).toBeGreaterThan(10_000);
      const wav = await readFile(downloadPath);
      const channels = wav.readUInt16LE(22);
      const sampleRate = wav.readUInt32LE(24);
      const bitDepth = wav.readUInt16LE(34);
      const duration = (wav.length - 44) / (channels * (bitDepth / 8) * sampleRate);
      expect(channels).toBe(2);
      expect(bitDepth).toBe(24);
      expect(sampleRate).toBe(48_000);
      expect(duration).toBeGreaterThan(0.18);

      const peak = getWavPeak(wav);
      expect(peak).toBeGreaterThan(0.001);
      if (recordingCase.expectCeiling) expect(peak).toBeLessThan(0.9);

      if (recordingCase.expectStereo) {
        let stereoDifference = 0;
        for (let offset = 44; offset + 5 < wav.length; offset += 6) {
          let left = wav[offset] | (wav[offset + 1] << 8) | (wav[offset + 2] << 16);
          let right = wav[offset + 3] | (wav[offset + 4] << 8) | (wav[offset + 5] << 16);
          if (left & 0x800000) left |= 0xff000000;
          if (right & 0x800000) right |= 0xff000000;
          stereoDifference += Math.abs(left - right);
        }
        expect(stereoDifference).toBeGreaterThan(1000);
      }
    });
  }
});
