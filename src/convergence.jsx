import React from "react";
import * as ReactDOM from "react-dom/client";
import "./styles.css";
import { ConvergenceEngine, nextSeed } from "./convergence-audio.js";
import { isTypingTarget, usePersistentState, useRecordingClock } from "./hooks.js";

const { useCallback, useEffect, useRef, useState } = React;

const DEFAULT_SETTINGS = {
  energy: 0.66,
  density: 0.58,
  affinity: 0.6,
  motion: 0.56,
  space: 0.62,
  tension: 0.42,
};

const STEMS = [
  { id: "titan", name: "TITAN", range: "30-760 HZ", color: "#f97316" },
  { id: "kawaii", name: "KAWAII", range: "130 HZ-10.5 KHZ", color: "#ec4899" },
  { id: "prism", name: "PRISM", range: "430 HZ-18 KHZ", color: "#22d3ee" },
];

const BANDS = ["SUB", "LOW", "MID", "HIGH", "AIR"];

const Slider = ({ label, value, min = 0, max = 1, step = 0.01, accent = "#d8ff3e", suffix = "", onChange }) => {
  const progress = ((value - min) / (max - min)) * 100;
  const precision = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return (
    <label className="block min-w-0">
      <span className="mb-2 flex items-baseline justify-between gap-3 text-[10px] font-bold uppercase text-zinc-500">
        <span>{label}</span>
        <span className="font-mono text-zinc-200">{Number(value).toFixed(precision)}{suffix}</span>
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="convergence-range"
        style={{ "--progress": `${progress}%`, "--accent": accent }}
      />
    </label>
  );
};

const Meter = ({ label, value, color }) => (
  <div className="min-w-0">
    <div className="mb-1 flex justify-between text-[9px] font-bold text-zinc-600">
      <span>{label}</span>
      <span className="font-mono">-{value.toFixed(1)}</span>
    </div>
    <div className="h-1.5 overflow-hidden rounded-sm bg-zinc-900">
      <div className="h-full transition-[width] duration-75" style={{ width: `${Math.min(100, value * 8)}%`, backgroundColor: color }} />
    </div>
  </div>
);

const Convergence = () => {
  const engineRef = useRef(null);
  const settingsRef = useRef(DEFAULT_SETTINGS);
  const recorderRef = useRef(null);
  const canvasRef = useRef(null);
  const animationRef = useRef(null);
  const [settings, setSettings] = usePersistentState("web-synth.convergence.settings", DEFAULT_SETTINGS);
  const [seed, setSeed] = usePersistentState("web-synth.convergence.seed", 20260716);
  const [masterMode, setMasterMode] = usePersistentState("web-synth.convergence.masterMode.v2", "BRUTAL");
  const [masterDrive, setMasterDrive] = usePersistentState("web-synth.convergence.masterDrive.v2", 12);
  const [masterTone, setMasterTone] = usePersistentState("web-synth.convergence.masterTone", 0.55);
  const [outputLevel, setOutputLevel] = usePersistentState("web-synth.convergence.outputLevel", 1);
  const [stemLevels, setStemLevels] = usePersistentState("web-synth.convergence.stems", {
    titan: 0.92,
    kawaii: 0.86,
    prism: 0.84,
  });
  const [ready, setReady] = useState(false);
  const [drifting, setDrifting] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [scene, setScene] = useState({
    seed,
    scale: "DORIAN",
    material: "GLASS",
    root: 45,
    triggerCount: 1,
    titanGesture: "DROP",
    kawaiiGesture: "PLUCK",
    prismGesture: "SHARD",
    fx: { titan: "MOD", kawaii: "GRAIN", prism: "DISPERSE" },
  });
  const [activity, setActivity] = useState({ titan: 0, kawaii: 0, prism: 0 });
  const [meters, setMeters] = useState({ reductions: [0, 0, 0, 0, 0], limiter: 0 });
  const recordingTime = useRecordingClock(isRecording, recorderRef);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const stopLimitedRecording = useCallback(async () => {
    setIsRecording(false);
    const engine = engineRef.current;
    if (!engine?.recorder) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await engine.stopRecording(`CONVERGENCE_LIMIT_${engine.ctx.sampleRate}hz_24bit_${timestamp}.wav`);
  }, []);

  const getEngine = useCallback(async () => {
    if (!engineRef.current) {
      engineRef.current = new ConvergenceEngine({
        onScene: setScene,
        onVoice: ({ stem, intensity }) => {
          setActivity((current) => ({ ...current, [stem]: Math.max(current[stem], intensity) }));
        },
        onRecordLimit: stopLimitedRecording,
      });
    }

    const engine = await engineRef.current.init();
    recorderRef.current = engine.recorder;
    engine.setMasterMode(masterMode);
    engine.setMasterDrive(masterDrive);
    engine.setMasterTone(masterTone);
    engine.setOutputLevel(outputLevel);
    Object.entries(stemLevels).forEach(([stem, level]) => engine.setStemLevel(stem, level));
    setReady(true);
    return engine;
  }, [masterDrive, masterMode, masterTone, outputLevel, stemLevels, stopLimitedRecording]);

  useEffect(() => {
    if (!engineRef.current) return;
    engineRef.current.setMasterMode(masterMode);
  }, [masterMode]);

  useEffect(() => {
    engineRef.current?.setMasterDrive(masterDrive);
  }, [masterDrive]);

  useEffect(() => {
    engineRef.current?.setMasterTone(masterTone);
  }, [masterTone]);

  useEffect(() => {
    engineRef.current?.setOutputLevel(outputLevel);
  }, [outputLevel]);

  useEffect(() => {
    if (!engineRef.current) return;
    Object.entries(stemLevels).forEach(([stem, level]) => engineRef.current.setStemLevel(stem, level));
  }, [stemLevels]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActivity((current) => ({
        titan: current.titan * 0.78,
        kawaii: current.kawaii * 0.78,
        prism: current.prism * 0.78,
      }));
      if (engineRef.current) setMeters(engineRef.current.getMeterState());
    }, 90);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!ready || !canvasRef.current || !engineRef.current?.analyser) return undefined;
    const analyser = engineRef.current.analyser;
    const frequencyData = new Uint8Array(analyser.frequencyBinCount);
    const timeData = new Uint8Array(analyser.frequencyBinCount);
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    const bandColors = ["#f97316", "#fb7185", "#ec4899", "#a78bfa", "#22d3ee"];

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      if (document.hidden) return;
      const width = canvas.width;
      const height = canvas.height;
      analyser.getByteFrequencyData(frequencyData);
      analyser.getByteTimeDomainData(timeData);
      context.fillStyle = "#0b1018";
      context.fillRect(0, 0, width, height);

      context.strokeStyle = "#1b222d";
      context.lineWidth = 1;
      for (let x = 0; x <= width; x += width / 8) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
      for (let y = height / 4; y < height; y += height / 4) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }

      const bars = 144;
      const barWidth = width / bars;
      for (let index = 0; index < bars; index += 1) {
        const normalized = index / (bars - 1);
        const frequency = 20 * (1000 ** normalized);
        const bin = Math.min(frequencyData.length - 1, Math.floor((frequency / (analyser.context.sampleRate / 2)) * frequencyData.length));
        const level = frequencyData[bin] / 255;
        const band = frequency < 90 ? 0 : frequency < 360 ? 1 : frequency < 1800 ? 2 : frequency < 6500 ? 3 : 4;
        context.fillStyle = bandColors[band];
        context.globalAlpha = 0.24 + level * 0.76;
        context.fillRect(index * barWidth, height - level * height * 0.88, Math.max(1, barWidth - 1), level * height * 0.88);
      }
      context.globalAlpha = 1;

      context.strokeStyle = "rgba(248, 250, 252, 0.72)";
      context.lineWidth = 1.5;
      context.beginPath();
      for (let index = 0; index < timeData.length; index += 1) {
        const x = (index / (timeData.length - 1)) * width;
        const y = height * 0.52 + ((timeData[index] - 128) / 128) * height * 0.18;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke();
    };

    draw();
    return () => cancelAnimationFrame(animationRef.current);
  }, [ready]);

  useEffect(() => () => engineRef.current?.destroy(), []);

  const triggerBurst = useCallback(async () => {
    const burstSeed = seed;
    setSeed(nextSeed(seed));
    const engine = await getEngine();
    engine.stopDrift();
    setDrifting(false);
    engine.burst(settingsRef.current, burstSeed);
  }, [getEngine, seed, setSeed]);

  const evolve = useCallback(async () => {
    const evolved = nextSeed(nextSeed(seed));
    setSeed(evolved);
    const engine = await getEngine();
    engine.stopDrift();
    setDrifting(false);
    engine.burst(settingsRef.current, evolved);
  }, [getEngine, seed, setSeed]);

  const toggleDrift = useCallback(async () => {
    const engine = await getEngine();
    if (drifting) {
      engine.stopDrift();
      setDrifting(false);
    } else {
      engine.startDrift(() => settingsRef.current, seed);
      setDrifting(true);
    }
  }, [drifting, getEngine, seed]);

  const stopAll = useCallback(() => {
    engineRef.current?.stopAll();
    setDrifting(false);
  }, []);

  const toggleRecording = useCallback(async () => {
    const engine = await getEngine();
    if (isRecording) {
      setIsRecording(false);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      await engine.stopRecording(`CONVERGENCE_${masterMode}_${engine.ctx.sampleRate}hz_24bit_${timestamp}.wav`);
    } else {
      await engine.startRecording();
      setIsRecording(true);
    }
  }, [getEngine, isRecording, masterMode]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (isTypingTarget(event.target) || event.repeat) return;
      if (event.code === "Space") {
        event.preventDefault();
        triggerBurst();
      } else if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        toggleRecording();
      } else if (event.key === "Escape") {
        stopAll();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [stopAll, toggleRecording, triggerBurst]);

  const setMacro = (key, value) => setSettings((current) => ({ ...current, [key]: value }));
  const setStem = (stem, value) => setStemLevels((current) => ({ ...current, [stem]: value }));
  const displayedReductions = masterMode === "MULTIBAND" || masterMode === "BRUTAL"
    ? [...meters.reductions, 0, 0, 0, 0, 0].slice(0, 5)
    : [0, 0, meters.reductions[0] || 0, 0, 0];

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#070a0f] text-zinc-100">
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-[#070a0f]/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1600px] items-center justify-between gap-3 px-4 sm:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[#d8ff3e] shadow-[0_0_14px_rgba(216,255,62,0.65)]" />
              <h1 className="truncate text-base font-black uppercase sm:text-lg">CONVERGENCE</h1>
              <span className="hidden border-l border-zinc-700 pl-3 font-mono text-[10px] text-zinc-500 sm:inline">FUSION DSP 02</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden font-mono text-[10px] text-zinc-500 md:block">{ready ? `${engineRef.current.ctx.sampleRate / 1000} KHZ` : "ENGINE IDLE"}</span>
            <button
              onClick={toggleRecording}
              aria-label={isRecording ? "STOP recording" : "REC WAV"}
              className={`h-9 min-w-24 rounded border px-3 text-[10px] font-black uppercase transition-colors ${isRecording ? "border-red-500 bg-red-500 text-white" : "border-zinc-700 text-zinc-300 hover:border-zinc-500"}`}
            >
              {isRecording ? `STOP ${recordingTime}` : "REC WAV"}
            </button>
            <a href="index.html" className="flex h-9 items-center rounded border border-zinc-700 px-3 text-[10px] font-black uppercase text-zinc-400 hover:border-zinc-500 hover:text-white">LAB</a>
          </div>
        </div>
      </header>

      <section className="border-b border-zinc-800 bg-[#0b1018]">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
          <button onClick={triggerBurst} aria-label="Generate convergence burst" className="h-10 rounded bg-[#d8ff3e] px-5 text-xs font-black uppercase text-black hover:bg-[#e5ff7b]">BURST</button>
          <button onClick={toggleDrift} aria-pressed={drifting} className={`h-10 rounded border px-5 text-xs font-black uppercase ${drifting ? "border-cyan-400 bg-cyan-400/10 text-cyan-300" : "border-zinc-700 text-zinc-300 hover:border-zinc-500"}`}>{drifting ? "PAUSE DRIFT" : "DRIFT"}</button>
          <button onClick={evolve} className="h-10 rounded border border-zinc-700 px-4 text-xs font-black uppercase text-zinc-300 hover:border-zinc-500">EVOLVE</button>
          <button onClick={stopAll} aria-label="Stop all convergence voices" className="h-10 rounded border border-zinc-800 px-4 text-xs font-black uppercase text-zinc-500 hover:border-red-500 hover:text-red-400">STOP</button>
          <div className="ml-auto flex items-center gap-2 font-mono text-[10px] text-zinc-500">
            <span>SEED</span>
            <input aria-label="Scene seed" type="number" value={seed} onChange={(event) => setSeed(Number(event.target.value) || 1)} className="h-9 w-28 rounded border border-zinc-700 bg-[#070a0f] px-2 text-right text-zinc-200 outline-none focus:border-[#d8ff3e]" />
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-[1600px] lg:grid-cols-[minmax(0,1.7fr)_minmax(340px,0.75fr)]">
        <div className="min-w-0 lg:border-r lg:border-zinc-800">
          <section className="border-b border-zinc-800">
            <div className="flex items-center justify-between px-4 py-3 sm:px-6">
              <span className="text-[10px] font-black uppercase text-zinc-500">SPECTRAL FIELD</span>
              <div className="flex gap-4 font-mono text-[9px]">
                {STEMS.map((stem) => <span key={stem.id} style={{ color: stem.color }}>{stem.name}</span>)}
              </div>
            </div>
            <canvas ref={canvasRef} width="1200" height="390" aria-label="Convergence spectrum and waveform" className="block aspect-[16/6] min-h-60 w-full bg-[#0b1018]" />
          </section>

          <section className="border-b border-zinc-800 px-4 py-5 sm:px-6">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-[11px] font-black uppercase text-zinc-300">SCENE DNA</h2>
              <div className="min-w-0 text-right font-mono text-zinc-600">
                <div className="text-[10px]">{scene.material} / {scene.scale} / MIDI {scene.root}</div>
                <div data-scene-seed={scene.seed} className="mt-1 truncate text-[9px]">T:{scene.titanGesture} / K:{scene.kawaiiGesture} / P:{scene.prismGesture}</div>
                <div className="mt-1 truncate text-[9px]">FX T:{scene.fx.titan} / K:{scene.fx.kawaii} / P:{scene.fx.prism}</div>
              </div>
            </div>
            <div className="grid gap-x-6 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
              <Slider label="Energy" value={settings.energy} accent="#f97316" onChange={(value) => setMacro("energy", value)} />
              <Slider label="Density" value={settings.density} accent="#ec4899" onChange={(value) => setMacro("density", value)} />
              <Slider label="Affinity" value={settings.affinity} accent="#d8ff3e" onChange={(value) => setMacro("affinity", value)} />
              <Slider label="Motion" value={settings.motion} accent="#a78bfa" onChange={(value) => setMacro("motion", value)} />
              <Slider label="Space" value={settings.space} accent="#22d3ee" onChange={(value) => setMacro("space", value)} />
              <Slider label="Tension" value={settings.tension} accent="#fb7185" onChange={(value) => setMacro("tension", value)} />
            </div>
          </section>

          <section className="px-4 py-5 sm:px-6">
            <h2 className="mb-4 text-[11px] font-black uppercase text-zinc-300">STEM MIXER</h2>
            <div className="grid gap-4 md:grid-cols-3">
              {STEMS.map((stem) => (
                <div key={stem.id} className="border-t border-zinc-800 pt-3">
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-black" style={{ color: stem.color }}>{stem.name}</div>
                      <div className="mt-1 font-mono text-[9px] text-zinc-600">{stem.range} / COLOR &gt; TONAL</div>
                    </div>
                    <span className="h-2.5 w-2.5 rounded-full transition-shadow" style={{ backgroundColor: stem.color, opacity: 0.25 + activity[stem.id] * 0.75, boxShadow: activity[stem.id] > 0.2 ? `0 0 ${8 + activity[stem.id] * 16}px ${stem.color}` : "none" }} />
                  </div>
                  <Slider label="Level" value={stemLevels[stem.id]} max={1.2} accent={stem.color} onChange={(value) => setStem(stem.id, value)} />
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="min-w-0 bg-[#090d14]">
          <section className="border-b border-zinc-800 px-4 py-5 sm:px-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-[11px] font-black uppercase text-zinc-300">MASTER BUS</h2>
              <span className="font-mono text-[9px] text-zinc-600">CEILING -1.0 DB</span>
            </div>
            <div className="grid grid-cols-3 overflow-hidden rounded border border-zinc-700 p-1">
              <button onClick={() => setMasterMode("MULTIBAND")} aria-pressed={masterMode === "MULTIBAND"} className={`h-9 rounded-sm text-[10px] font-black uppercase ${masterMode === "MULTIBAND" ? "bg-[#d8ff3e] text-black" : "text-zinc-500 hover:text-zinc-200"}`}>L3-STYLE</button>
              <button onClick={() => setMasterMode("INFLATOR")} aria-pressed={masterMode === "INFLATOR"} className={`h-9 rounded-sm text-[10px] font-black uppercase ${masterMode === "INFLATOR" ? "bg-[#ff6b35] text-black" : "text-zinc-500 hover:text-zinc-200"}`}>INFLATOR</button>
              <button onClick={() => setMasterMode("BRUTAL")} aria-pressed={masterMode === "BRUTAL"} className={`h-9 rounded-sm text-[10px] font-black uppercase ${masterMode === "BRUTAL" ? "bg-red-500 text-white" : "text-zinc-500 hover:text-zinc-200"}`}>BRUTAL</button>
            </div>
          </section>

          <section className="border-b border-zinc-800 px-4 py-5 sm:px-6">
            <div className="grid gap-6">
              <Slider label="Drive" value={masterDrive} min={0} max={18} step={0.1} suffix=" dB" accent={masterMode === "BRUTAL" ? "#ef4444" : masterMode === "MULTIBAND" ? "#d8ff3e" : "#ff6b35"} onChange={setMasterDrive} />
              <Slider label="Tone" value={masterTone} accent="#22d3ee" onChange={setMasterTone} />
              <Slider label="Output" value={outputLevel} accent="#f8fafc" onChange={setOutputLevel} />
            </div>
          </section>

          <section className="border-b border-zinc-800 px-4 py-5 sm:px-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-[11px] font-black uppercase text-zinc-300">GAIN REDUCTION</h2>
              <span className="font-mono text-[9px] text-red-400">LIMIT -{meters.limiter.toFixed(1)}</span>
            </div>
            <div className="grid gap-3">
              {BANDS.map((band, index) => (
                <Meter key={band} label={band} value={displayedReductions[index]} color={["#f97316", "#fb7185", "#ec4899", "#a78bfa", "#22d3ee"][index]} />
              ))}
            </div>
          </section>

          <section className="px-4 py-5 sm:px-6">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-zinc-800 bg-zinc-800">
              <div className="bg-[#090d14] p-3">
                <div className="text-[9px] font-black text-zinc-600">MODE</div>
                <div className="mt-1 font-mono text-xs text-zinc-200">{drifting ? "DRIFT" : `BURST X${scene.triggerCount}`}</div>
              </div>
              <div className="bg-[#090d14] p-3">
                <div className="text-[9px] font-black text-zinc-600">MASTER</div>
                <div className="mt-1 font-mono text-xs text-zinc-200">{masterMode === "BRUTAL" ? "SERIAL CLIP" : masterMode === "MULTIBAND" ? "5 BAND" : "RC CURVE"}</div>
              </div>
              <div className="bg-[#090d14] p-3">
                <div className="text-[9px] font-black text-zinc-600">SCENE</div>
                <div className="mt-1 truncate font-mono text-xs text-zinc-200">{scene.seed}</div>
              </div>
              <div className="bg-[#090d14] p-3">
                <div className="text-[9px] font-black text-zinc-600">FORMAT</div>
                <div className="mt-1 font-mono text-xs text-zinc-200">96K / 24B</div>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<Convergence />);
