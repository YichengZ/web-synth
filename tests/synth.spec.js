import { expect, test } from "@playwright/test";
import { readFile, stat } from "node:fs/promises";

const synths = [
  { name: "PRISM", path: "/CrystalPrism.html" },
  { name: "Kawaii", path: "/KawaiiSynth.html" },
  { name: "TITAN", path: "/TITAN_SUB.html" },
  { name: "CONVERGENCE", path: "/Convergence.html" },
];

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

test("CONVERGENCE switches between both master bus presets", async ({ page }) => {
  await page.goto("/Convergence.html");
  const multiband = page.getByRole("button", { name: "L3-STYLE" });
  const inflator = page.getByRole("button", { name: "INFLATOR" });
  await expect(multiband).toHaveAttribute("aria-pressed", "true");
  await inflator.click();
  await expect(inflator).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Loud")).toBeVisible();
  await expect(page.getByLabel("Tone")).toBeVisible();
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
      trigger: (page) => page.getByRole("button", { name: "Generate convergence burst" }).click(),
      expectStereo: true,
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
      const startTime = await page.evaluate(() => window.__testAudioContext.currentTime);
      await recordingCase.trigger(page);
      await page.waitForFunction(
        (start) => window.__testAudioContext.currentTime - start >= 0.2,
        startTime,
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
      expect(sampleRate).toBe(96_000);
      expect(duration).toBeGreaterThan(0.18);

      let peak = 0;
      for (let offset = 44; offset + 2 < wav.length; offset += 3) {
        let sample = wav[offset] | (wav[offset + 1] << 8) | (wav[offset + 2] << 16);
        if (sample & 0x800000) sample |= 0xff000000;
        peak = Math.max(peak, Math.abs(sample / 0x800000));
      }
      expect(peak).toBeGreaterThan(0.001);

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
