import React from "react";
import * as ReactDOM from "react-dom/client";
import {
  Circle,
  Download,
  Dices,
  Home,
  Play,
  Square,
  Trash2,
  X,
} from "lucide-react";
import "./styles.css";
import { DEFAULT_FORGE_CONFIG, hashForgeSeed, runForgeRoll } from "./forge-audio.js";
import { ForgeAssetPlayer } from "./forge-player.js";
import { downloadBlob } from "./wav-utils.js";
import { usePersistentState } from "./hooks.js";

const { useCallback, useEffect, useMemo, useRef, useState } = React;

const FAST_TEST_CONFIG = {
  sourceCount: 1,
  whooshCount: 2,
  outputCount: 1,
  sourceDuration: [0.85, 1.05],
  whooshDuration: [1.1, 1.35],
  outputDuration: [1.4, 1.7],
};

const Slider = ({ label, value, accent, onChange }) => (
  <label className="block min-w-0">
    <span className="mb-2 flex items-center justify-between gap-3 text-[10px] font-bold uppercase text-zinc-500">
      <span>{label}</span>
      <span className="font-mono text-zinc-200">{Math.round(value * 100)}</span>
    </span>
    <input
      aria-label={label}
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className="forge-range"
      style={{ "--progress": `${value * 100}%`, "--accent": accent }}
    />
  </label>
);

const formatMetric = (value, suffix, fallback = "--") => (
  Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : fallback
);

const AssetRow = ({
  asset,
  active,
  recording,
  loop,
  onPlay,
  onLoop,
  onDownload,
}) => {
  const stopping = active && !recording;
  return (
    <div className="grid min-h-20 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-zinc-800 px-3 py-3 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_repeat(4,minmax(62px,auto))_auto]">
    <button
      type="button"
      onClick={onPlay}
      aria-label={`${recording ? "Trigger" : stopping ? "Stop" : "Play"} ${asset.id}`}
      title={recording ? "Trigger into REC SET" : stopping ? "Stop asset" : "Play asset"}
      className={`flex h-9 w-9 items-center justify-center rounded border transition-colors ${active ? "border-[#d8ff3e] bg-[#d8ff3e] text-black" : "border-zinc-700 text-zinc-300 hover:border-zinc-500"}`}
    >
      {stopping
        ? <Square size={13} fill="currentColor" />
        : <Play size={15} fill="currentColor" />}
    </button>
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-xs font-bold uppercase text-zinc-100">{asset.id}</span>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${asset.kind === "master" ? "bg-[#d8ff3e]" : "bg-cyan-400"}`} />
      </div>
      <div className="mt-1 truncate font-mono text-[9px] text-zinc-600">
        SEED {asset.seed} / {asset.duration.toFixed(1)} SEC
      </div>
    </div>
    <div className="hidden text-right sm:block">
      <div className="font-mono text-[10px] text-zinc-300">{formatMetric(asset.metrics?.lufs, " LUFS")}</div>
      <div className="text-[8px] font-bold uppercase text-zinc-600">Loudness</div>
    </div>
    <div className="hidden text-right sm:block">
      <div className="font-mono text-[10px] text-zinc-300">{formatMetric(asset.metrics?.truePeakDb, " dBTP")}</div>
      <div className="text-[8px] font-bold uppercase text-zinc-600">True peak</div>
    </div>
    <div className="hidden text-right sm:block">
      <div className="font-mono text-[10px] text-zinc-300">{Number.isFinite(asset.metrics?.spectralFlatness) ? asset.metrics.spectralFlatness.toFixed(3) : "--"}</div>
      <div className="text-[8px] font-bold uppercase text-zinc-600">Flatness</div>
    </div>
    <label className="hidden items-center gap-2 text-[9px] font-bold uppercase text-zinc-500 sm:flex">
      <input type="checkbox" checked={loop} onChange={onLoop} className="accent-[#d8ff3e]" />
      Loop
    </label>
    <button
      type="button"
      onClick={onDownload}
      aria-label={`Download ${asset.id}`}
      title="Download 96kHz 24-bit WAV"
      className="flex h-9 w-9 items-center justify-center rounded border border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-200"
    >
      <Download size={15} />
    </button>
  </div>
  );
};

const ConvergenceForge = () => {
  const testMode = useMemo(
    () => new URLSearchParams(window.location.search).has("forgeTest"),
    [],
  );
  const playerRef = useRef(null);
  const controllerRef = useRef(null);
  const recordingStartedAtRef = useRef(0);
  const canvasRef = useRef(null);
  const [seed, setSeed] = usePersistentState("web-synth.forge.seed", DEFAULT_FORGE_CONFIG.seed);
  const [macros, setMacros] = usePersistentState("web-synth.forge.macros", {
    variation: DEFAULT_FORGE_CONFIG.variation,
    tonal: DEFAULT_FORGE_CONFIG.tonal,
    motion: DEFAULT_FORGE_CONFIG.motion,
    violence: DEFAULT_FORGE_CONFIG.violence,
  });
  const [rolling, setRolling] = useState(false);
  const [progress, setProgress] = useState({ stage: "IDLE", percent: 0, detail: "READY" });
  const [whooshes, setWhooshes] = useState([]);
  const [masters, setMasters] = useState([]);
  const [tab, setTab] = useState("master");
  const [loops, setLoops] = useState({});
  const [activeIds, setActiveIds] = useState([]);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [error, setError] = useState("");
  const [family, setFamily] = useState(null);

  if (!playerRef.current) {
    playerRef.current = new ForgeAssetPlayer({
      onState: (state) => {
        setActiveIds(state.activeIds);
        setRecording(state.recording);
      },
    });
  }

  useEffect(() => () => {
    controllerRef.current?.abort();
    playerRef.current?.destroy();
  }, []);

  useEffect(() => {
    if (!recording) {
      setRecordingSeconds(0);
      return undefined;
    }
    const timer = window.setInterval(() => {
      setRecordingSeconds(Math.floor((performance.now() - recordingStartedAtRef.current) / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext("2d");
    const frequency = new Uint8Array(1024);
    const waveform = new Uint8Array(1024);
    let animation = 0;
    let lastDrawAt = 0;
    const draw = (timestamp) => {
      animation = requestAnimationFrame(draw);
      if (document.hidden || timestamp - lastDrawAt < 1000 / 24) return;
      lastDrawAt = timestamp;
      const width = canvas.width;
      const height = canvas.height;
      const analyser = playerRef.current?.getAnalyser();
      context.fillStyle = "#090d14";
      context.fillRect(0, 0, width, height);
      context.strokeStyle = "#1b222d";
      context.lineWidth = 1;
      for (let line = 1; line < 8; line += 1) {
        const x = width * line / 8;
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
      for (let line = 1; line < 4; line += 1) {
        const y = height * line / 4;
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }
      if (!analyser) return;
      analyser.getByteFrequencyData(frequency);
      analyser.getByteTimeDomainData(waveform);
      const bars = 112;
      for (let index = 0; index < bars; index += 1) {
        const normalized = index / Math.max(1, bars - 1);
        const hz = 20 * 1000 ** normalized;
        const bin = Math.min(frequency.length - 1, Math.floor(hz / (analyser.context.sampleRate / 2) * frequency.length));
        const level = frequency[bin] / 255;
        context.fillStyle = hz < 360 ? "#f97316" : hz < 3200 ? "#ec4899" : "#22d3ee";
        context.globalAlpha = 0.18 + level * 0.62;
        context.fillRect(index * width / bars, height - level * height * 0.88, Math.max(1, width / bars - 1), level * height * 0.88);
      }
      context.globalAlpha = 1;
      context.strokeStyle = "rgba(216,255,62,0.82)";
      context.lineWidth = 1.5;
      context.beginPath();
      for (let index = 0; index < waveform.length; index += 1) {
        const x = index / (waveform.length - 1) * width;
        const y = height * 0.5 + (waveform[index] - 128) / 128 * height * 0.22;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    };
    animation = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animation);
  }, [activeIds, recording]);

  const setMacro = (key, value) => setMacros((current) => ({ ...current, [key]: value }));

  const clearResults = useCallback(() => {
    playerRef.current.clear();
    setWhooshes([]);
    setMasters([]);
    setLoops({});
    setActiveIds([]);
    setFamily(null);
  }, []);

  const roll = useCallback(async () => {
    if (rolling) return;
    controllerRef.current?.abort();
    clearResults();
    setError("");
    setRolling(true);
    setTab("whoosh");
    const controller = new AbortController();
    controllerRef.current = controller;
    const config = {
      ...DEFAULT_FORGE_CONFIG,
      ...macros,
      seed,
      ...(testMode ? FAST_TEST_CONFIG : {}),
    };
    try {
      const result = await runForgeRoll(config, {
        signal: controller.signal,
        onProgress: setProgress,
        onAsset: (asset) => {
          if (asset.kind === "whoosh") setWhooshes((current) => [...current, asset]);
          else {
            setMasters((current) => [...current, asset]);
            setTab("master");
          }
        },
      });
      setFamily(result.dna);
      setProgress({ stage: "COMPLETE", percent: 100, detail: "SESSION READY" });
      setSeed(hashForgeSeed(seed + 0x9e3779b9));
    } catch (renderError) {
      if (renderError?.name === "AbortError") {
        setProgress({ stage: "CANCELLED", percent: 0, detail: "MEMORY RELEASED" });
      } else {
        console.error(renderError);
        setError(renderError?.message || String(renderError));
        setProgress({ stage: "ERROR", percent: 0, detail: "RENDER FAILED" });
      }
    } finally {
      controllerRef.current = null;
      setRolling(false);
    }
  }, [clearResults, macros, rolling, seed, setSeed, testMode]);

  const cancel = () => controllerRef.current?.abort();

  const toggleCapture = useCallback(async () => {
    if (recording) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      await playerRef.current.stopCapture(`CONVERGENCE_FORGE_REC_SET_96000hz_24bit_${timestamp}.wav`);
    } else {
      recordingStartedAtRef.current = performance.now();
      await playerRef.current.startCapture();
    }
  }, [recording]);

  const assets = tab === "master" ? masters : whooshes;
  const blobBytes = [...whooshes, ...masters].reduce((total, asset) => total + asset.wavBlob.size, 0);
  const minutes = String(Math.floor(recordingSeconds / 60)).padStart(2, "0");
  const seconds = String(recordingSeconds % 60).padStart(2, "0");

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#070a0f] text-zinc-100">
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-[#070a0f]/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1600px] items-center justify-between gap-3 px-4 sm:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[#d8ff3e] shadow-[0_0_14px_rgba(216,255,62,0.65)]" />
              <h1 className="truncate text-base font-black uppercase sm:text-lg">CONVERGENCE FORGE</h1>
              <span className="hidden border-l border-zinc-700 pl-3 font-mono text-[10px] text-zinc-500 md:inline">96K OFFLINE MOTION DSP</span>
            </div>
          </div>
          <a href="index.html" aria-label="Return to synth lab" title="Synth Lab" className="flex h-9 w-9 items-center justify-center rounded border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white">
            <Home size={16} />
          </a>
        </div>
      </header>

      <section className="border-b border-zinc-800 bg-[#0b1018]">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
          <button type="button" onClick={roll} disabled={rolling} className="flex h-10 items-center gap-2 rounded bg-[#d8ff3e] px-5 text-xs font-black uppercase text-black hover:bg-[#e5ff7b] disabled:cursor-not-allowed disabled:bg-[#788d2b]">
            <Dices size={16} />
            ROLL
          </button>
          <button type="button" onClick={cancel} disabled={!rolling} className="flex h-10 items-center gap-2 rounded border border-zinc-700 px-4 text-xs font-black uppercase text-zinc-300 hover:border-red-500 hover:text-red-400 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-700">
            <X size={15} />
            Cancel
          </button>
          <button type="button" onClick={toggleCapture} disabled={!recording && !whooshes.length && !masters.length} aria-pressed={recording} className={`flex h-10 items-center gap-2 rounded border px-4 text-xs font-black uppercase disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-700 ${recording ? "border-red-500 bg-red-500 text-white" : "border-zinc-700 text-zinc-300 hover:border-red-500"}`}>
            <Circle size={14} fill={recording ? "currentColor" : "none"} />
            {recording ? `STOP ${minutes}:${seconds}` : "REC SET"}
          </button>
          <button type="button" onClick={() => playerRef.current.stopAll()} disabled={!activeIds.length} aria-label="Stop all previews" title="Stop all previews" className="flex h-10 w-10 items-center justify-center rounded border border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-800">
            <Square size={14} fill="currentColor" />
          </button>
          <button type="button" onClick={clearResults} disabled={rolling || (!whooshes.length && !masters.length)} aria-label="Clear roll" title="Clear roll" className="flex h-10 w-10 items-center justify-center rounded border border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-800">
            <Trash2 size={15} />
          </button>
          <label className="ml-auto flex items-center gap-2 font-mono text-[10px] text-zinc-500">
            <span>SEED</span>
            <input aria-label="Forge seed" type="number" value={seed} onChange={(event) => setSeed(Number(event.target.value) || 1)} className="h-9 w-28 rounded border border-zinc-700 bg-[#070a0f] px-2 text-right text-zinc-200 outline-none focus:border-[#d8ff3e]" />
          </label>
        </div>
      </section>

      <section className="border-b border-zinc-800">
        <div className="mx-auto grid max-w-[1600px] gap-6 px-4 py-5 sm:grid-cols-2 sm:px-6 xl:grid-cols-4">
          <Slider label="Variation" value={macros.variation} accent="#a78bfa" onChange={(value) => setMacro("variation", value)} />
          <Slider label="Tonal" value={macros.tonal} accent="#22d3ee" onChange={(value) => setMacro("tonal", value)} />
          <Slider label="Motion" value={macros.motion} accent="#ec4899" onChange={(value) => setMacro("motion", value)} />
          <Slider label="Violence" value={macros.violence} accent="#f97316" onChange={(value) => setMacro("violence", value)} />
        </div>
      </section>

      <section className="border-b border-zinc-800 bg-[#090d14]">
        <div className="mx-auto max-w-[1600px] px-4 py-4 sm:px-6">
          <div className="mb-2 flex items-center justify-between gap-4 text-[9px] font-black uppercase text-zinc-500">
            <span>{progress.stage} / {progress.detail}</span>
            <span className="font-mono text-zinc-300">{progress.percent}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-sm bg-zinc-900">
            <div className="h-full bg-[#d8ff3e] transition-[width] duration-150" style={{ width: `${progress.percent}%` }} />
          </div>
          {error ? <div role="alert" className="mt-3 border-l-2 border-red-500 pl-3 font-mono text-[10px] text-red-400">{error}</div> : null}
        </div>
      </section>

      <div className="mx-auto grid max-w-[1600px] lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0 border-b border-zinc-800 lg:border-b-0 lg:border-r">
          <div className="border-b border-zinc-800">
            <div className="flex h-10 items-center justify-between px-4 font-mono text-[9px] uppercase text-zinc-600 sm:px-6">
              <span>Session monitor</span>
              <span>{recording ? "96K CAPTURE" : "48K PREVIEW"}</span>
            </div>
            <canvas ref={canvasRef} width="1200" height="240" aria-label="Forge preview spectrum and waveform" className="block aspect-[16/3.2] min-h-36 w-full bg-[#090d14]" />
          </div>
          <div className="flex h-14 items-end border-b border-zinc-800 px-4 sm:px-6">
            <button type="button" onClick={() => setTab("whoosh")} aria-pressed={tab === "whoosh"} className={`h-11 border-b-2 px-4 text-[10px] font-black uppercase ${tab === "whoosh" ? "border-cyan-400 text-cyan-300" : "border-transparent text-zinc-600 hover:text-zinc-300"}`}>WHOOSH {whooshes.length}</button>
            <button type="button" onClick={() => setTab("master")} aria-pressed={tab === "master"} className={`h-11 border-b-2 px-4 text-[10px] font-black uppercase ${tab === "master" ? "border-[#d8ff3e] text-[#d8ff3e]" : "border-transparent text-zinc-600 hover:text-zinc-300"}`}>MASTER {masters.length}</button>
          </div>
          <div className="min-h-[480px]">
            {assets.length ? assets.map((asset) => (
              <AssetRow
                key={asset.id}
                asset={asset}
                active={activeIds.includes(asset.id)}
                recording={recording}
                loop={Boolean(loops[asset.id])}
                onPlay={() => {
                  if (activeIds.includes(asset.id) && !recording) {
                    playerRef.current.stopAsset(asset.id);
                    return;
                  }
                  playerRef.current.play(asset, { loop: Boolean(loops[asset.id]) }).catch((playError) => setError(playError.message));
                }}
                onLoop={() => setLoops((current) => ({ ...current, [asset.id]: !current[asset.id] }))}
                onDownload={() => downloadBlob(asset.wavBlob, asset.filename)}
              />
            )) : (
              <div className="flex min-h-[480px] items-center justify-center px-6 text-center font-mono text-[10px] uppercase text-zinc-700">
                {rolling ? "Rendering assets into session memory" : "Roll a new 96k asset family"}
              </div>
            )}
          </div>
        </section>

        <aside className="bg-[#090d14]">
          <section className="border-b border-zinc-800 px-5 py-5">
            <h2 className="mb-4 text-[10px] font-black uppercase text-zinc-400">Session</h2>
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-zinc-800 bg-zinc-800">
              <div className="bg-[#090d14] p-3">
                <div className="text-[8px] font-bold uppercase text-zinc-600">Whoosh</div>
                <div className="mt-1 font-mono text-sm text-cyan-300">{whooshes.length} / {testMode ? FAST_TEST_CONFIG.whooshCount : 12}</div>
              </div>
              <div className="bg-[#090d14] p-3">
                <div className="text-[8px] font-bold uppercase text-zinc-600">Master</div>
                <div className="mt-1 font-mono text-sm text-[#d8ff3e]">{masters.length} / {testMode ? FAST_TEST_CONFIG.outputCount : 8}</div>
              </div>
              <div className="bg-[#090d14] p-3">
                <div className="text-[8px] font-bold uppercase text-zinc-600">Memory WAV</div>
                <div className="mt-1 font-mono text-sm text-zinc-200">{(blobBytes / 1024 / 1024).toFixed(1)} MB</div>
              </div>
              <div className="bg-[#090d14] p-3">
                <div className="text-[8px] font-bold uppercase text-zinc-600">Format</div>
                <div className="mt-1 font-mono text-sm text-zinc-200">96K / 24B</div>
              </div>
            </div>
          </section>
          <section className="border-b border-zinc-800 px-5 py-5">
            <h2 className="mb-4 text-[10px] font-black uppercase text-zinc-400">Family DNA</h2>
            <dl className="grid gap-3 font-mono text-[10px]">
              <div className="flex justify-between gap-4"><dt className="text-zinc-600">SCALE</dt><dd className="text-zinc-200">{family?.scale || "--"}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-zinc-600">ROOT MIDI</dt><dd className="text-zinc-200">{family?.rootMidi ?? "--"}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-zinc-600">PASS PEAK</dt><dd className="text-zinc-200">{family ? `${Math.round(family.peakRatio * 100)}%` : "--"}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-zinc-600">OUTPUTS</dt><dd className="text-zinc-200">{testMode ? "TEST" : "8 × 20–30S"}</dd></div>
            </dl>
          </section>
          <section className="px-5 py-5">
            <h2 className="mb-4 text-[10px] font-black uppercase text-zinc-400">Signal Path</h2>
            <div className="grid gap-2 font-mono text-[9px] text-zinc-500">
              <div className="border-l-2 border-cyan-400/50 pl-3 py-1">TONAL ×2 / L3 PRE</div>
              <div className="border-l-2 border-pink-400/50 pl-3 py-1">DOPPLER RAMPS / FLOOR</div>
              <div className="border-l-2 border-orange-400/50 pl-3 py-1">L3 / COLOR / L3</div>
              <div className="border-l-2 border-[#d8ff3e]/50 pl-3 py-1">TONAL / LOOKAHEAD / -1.2</div>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<ConvergenceForge />);
