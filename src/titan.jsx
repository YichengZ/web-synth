import React from "react";
import * as ReactDOM from "react-dom/client";
import "./styles.css";
import { createWavRecorder } from "./recording.js";
import { isTypingTarget, usePersistentState, useRecordingClock } from "./hooks.js";

const { useState, useEffect, useRef, useMemo, useCallback } = React;

        const generateId = () => Math.random().toString(36).substr(2, 9);

        // --- DSP HELPERS ---

        // Brown Noise Reverb (Smoother for Subs)
        const createDarkReverbIR = (ctx, duration = 2.0, decay = 2.0) => {
            const rate = ctx.sampleRate;
            const length = rate * duration;
            const impulse = ctx.createBuffer(2, length, rate);
            const L = impulse.getChannelData(0);
            const R = impulse.getChannelData(1);
            let lastL = 0, lastR = 0;
            for (let i = 0; i < length; i++) {
                const env = Math.pow(1 - i / length, decay);
                // Brown Noise integration
                const whiteL = Math.random() * 2 - 1;
                const whiteR = Math.random() * 2 - 1;
                lastL = (lastL + (0.02 * whiteL)) / 1.02;
                lastR = (lastR + (0.02 * whiteR)) / 1.02;
                L[i] = lastL * env * 2.0;
                R[i] = lastR * env * 2.0;
            }
            return impulse;
        };

        const createNoiseLfo = (ctx, start, duration, speed) => {
            const bufferSize = ctx.sampleRate * 2;
            const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
            const noise = ctx.createBufferSource();
            noise.buffer = buffer; noise.loop = true;
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass'; filter.Q.value = 0.5;
            filter.frequency.value = 0.5 + (speed / 100) * 15;
            noise.connect(filter);
            noise.start(start);
            // Note: Stop is handled by caller via returned node
            return { output: filter, node: noise };
        };

        const getWaveforms = (ctx) => {
            const sineWave = ctx.createPeriodicWave(new Float32Array([0, 0]), new Float32Array([0, 1]));
            const cosWave = ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0]));
            return { sineWave, cosWave };
        };

        function generateInflatorCurve(curveValue, effectValue, clip) {
            const n = 65536; const curve = new Float32Array(n);
            const wet = effectValue * 0.01; const dry = 1 - wet;
            const A = curveValue * 0.01 + 1.5; const B = curveValue * -0.02;
            const C = curveValue * 0.01 - 0.5; const D = 0.0625 - (curveValue * 0.0025) + (curveValue * curveValue * 0.000025);
            for (let i = 0; i < n; ++i) {
                const x = (i * 2) / n - 1; const y = Math.abs(x);
                let shaped = y < 1 ? A * y + B * y * y + C * y * y * y - D * (y * y - 2 * y * y * y + y * y * y * y) : (y < 2 ? 2 * y - y * y : y);
                let out = shaped * wet * Math.sign(x) + x * dry;
                if (clip) out = Math.max(-1, Math.min(1, out));
                curve[i] = out;
            }
            return curve;
        }

        const createQuadSource = (ctx, destination, params) => {
            const { t, duration, pitchEnv, ampEnv, width, tone, pitchMin, pitchMax } = params;
            const { sineWave, cosWave } = getWaveforms(ctx);
            const oscL = ctx.createOscillator();
            const oscR_A = ctx.createOscillator();
            const oscR_B = ctx.createOscillator();

            oscL.setPeriodicWave(sineWave);
            oscR_A.setPeriodicWave(sineWave);
            oscR_B.setPeriodicWave(cosWave);

            const scheduleFreq = (osc) => {
                osc.frequency.setValueAtTime(0, t);
                [...pitchEnv].sort((a, b) => a.x - b.x).forEach((pt, idx) => {
                    const time = t + pt.x * duration;
                    const freq = pitchMin + pt.y * (pitchMax - pitchMin);
                    if (idx === 0) osc.frequency.setValueAtTime(freq, time);
                    else osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq), time);
                });
            };
            scheduleFreq(oscL); scheduleFreq(oscR_A); scheduleFreq(oscR_B);

            const ampL = ctx.createGain();
            const ampR = ctx.createGain();
            const scheduleAmp = (gainNode) => {
                gainNode.gain.setValueAtTime(0, t);
                [...ampEnv].sort((a, b) => a.x - b.x).forEach((pt, idx) => {
                    const time = t + pt.x * duration;
                    if (idx === 0) gainNode.gain.setValueAtTime(pt.y, time);
                    else gainNode.gain.linearRampToValueAtTime(pt.y, time);
                });
                gainNode.gain.linearRampToValueAtTime(0, t + duration + 0.1);
            };
            scheduleAmp(ampL); scheduleAmp(ampR);

            const shaperL = ctx.createWaveShaper(); const shaperR = ctx.createWaveShaper();
            const curve = generateInflatorCurve(0, tone, false);
            shaperL.curve = curve; shaperR.curve = curve;

            const gainR_A = ctx.createGain();
            const gainR_B = ctx.createGain();

            let w = width / 100;

            if (w <= 0.5) {
                const ratio = w * 2;
                gainR_A.gain.value = 1 - ratio;
                gainR_B.gain.value = ratio;
            } else {
                const ratio = (w - 0.5) * 2;
                gainR_A.gain.value = -1 * ratio;
                gainR_B.gain.value = 1 - ratio;
            }

            oscL.connect(ampL); ampL.connect(shaperL);

            oscR_A.connect(gainR_A);
            oscR_B.connect(gainR_B);
            gainR_A.connect(ampR);
            gainR_B.connect(ampR);
            ampR.connect(shaperR);

            const merger = ctx.createChannelMerger(2);
            shaperL.connect(merger, 0, 0);
            shaperR.connect(merger, 0, 1);

            merger.connect(destination);

            oscL.start(t); oscR_A.start(t); oscR_B.start(t);
            oscL.stop(t + duration + 1); oscR_A.stop(t + duration + 1); oscR_B.stop(t + duration + 1);

            // Return Active Nodes for cleanup
            return [oscL, oscR_A, oscR_B];
        };

        // --- COMPONENTS ---
        const Slider = ({ label, value, min, max, step, onChange, color = "#fff", suffix = "", warning = false, description = "" }) => {
            const safeValue = value !== undefined && !isNaN(value) ? value : min;
            const percentage = ((safeValue - min) / (max - min)) * 100;

            return (
                <div className="w-full flex flex-col gap-1 select-none mb-1">
                    <div className="flex justify-between items-end px-0.5">
                        <div className="flex items-center gap-2">
                            <span className={`text-[10px] font-bold uppercase tracking-wider transition-colors ${warning ? 'text-red-500 animate-pulse' : 'text-zinc-500 group-hover:text-zinc-300'}`}>
                                {warning ? '⚠ PHASE' : label}
                            </span>
                        </div>
                        <span className="text-[10px] font-mono tabular-nums" style={{ color: warning ? '#ef4444' : color }}>
                            {safeValue.toFixed(step < 1 ? 1 : 0)}{suffix}
                        </span>
                    </div>

                    <div className="relative h-6 w-full flex items-center">
                        <div className="absolute left-0 right-0 h-1 bg-zinc-800 rounded-full overflow-hidden pointer-events-none"></div>
                        <div className="absolute left-0 h-1 rounded-full pointer-events-none transition-all duration-75 ease-out"
                            style={{ width: `${percentage}%`, backgroundColor: color }}></div>
                        <input
                            aria-label={label}
                            type="range" min={min} max={max} step={step || 1} value={safeValue}
                            onChange={(e) => onChange(parseFloat(e.target.value))}
                            className="titan-slider absolute inset-0 w-full h-full opacity-0"
                        />
                        <div
                            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow pointer-events-none transition-all duration-75 ease-out"
                            style={{ left: `calc(${percentage}% - 6px)` }}
                        ></div>
                    </div>
                    {description && (
                        <div className={`text-[9px] leading-tight mt-1 ${warning ? 'text-red-500/80' : 'text-zinc-600'}`}>
                            {description}
                        </div>
                    )}
                </div>
            );
        };

        const GraphEditor = ({ pitchEnv, setPitchEnv, ampEnv, setAmpEnv, activeLayer, setActiveLayer, duration, minFreq }) => {
            const containerRef = useRef(null);
            const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
            const [mode, setMode] = useState('POINT');
            const [hoverPos, setHoverPos] = useState(null);

            const updateSize = useCallback(() => {
                if (!containerRef.current) return;

                const rect = containerRef.current.getBoundingClientRect();
                const width = Math.round(rect.width);
                const height = Math.round(rect.height);
                if (width < 2 || height < 2) return;

                setDimensions(prev => (
                    prev.width === width && prev.height === height ? prev : { width, height }
                ));
            }, []);

            useEffect(() => {
                let frameOne = null;
                let frameTwo = null;
                let settleTimer = null;
                let disposed = false;
                const node = containerRef.current;

                const scheduleUpdate = () => {
                    if (disposed) return;
                    if (frameOne) cancelAnimationFrame(frameOne);
                    if (frameTwo) cancelAnimationFrame(frameTwo);

                    frameOne = requestAnimationFrame(() => {
                        updateSize();
                        frameTwo = requestAnimationFrame(updateSize);
                    });
                };

                const observer = typeof ResizeObserver !== 'undefined' && node
                    ? new ResizeObserver(scheduleUpdate)
                    : null;

                if (observer) observer.observe(node);
                window.addEventListener('resize', scheduleUpdate);
                window.addEventListener('orientationchange', scheduleUpdate);
                scheduleUpdate();
                settleTimer = setTimeout(scheduleUpdate, 250);
                if (document.fonts && document.fonts.ready) {
                    document.fonts.ready.then(scheduleUpdate);
                }

                return () => {
                    disposed = true;
                    if (observer) observer.disconnect();
                    if (frameOne) cancelAnimationFrame(frameOne);
                    if (frameTwo) cancelAnimationFrame(frameTwo);
                    clearTimeout(settleTimer);
                    window.removeEventListener('resize', scheduleUpdate);
                    window.removeEventListener('orientationchange', scheduleUpdate);
                };
            }, [updateSize]);

            const points = activeLayer === 'PITCH' ? pitchEnv : ampEnv;
            const setPoints = activeLayer === 'PITCH' ? setPitchEnv : setAmpEnv;
            const color = activeLayer === 'PITCH' ? '#fb923c' : '#e4e4e7';

            const toPx = (normPt) => ({ x: normPt.x * dimensions.width, y: (1 - normPt.y) * dimensions.height });
            const toNorm = (pxX, pxY) => {
                const width = Math.max(1, dimensions.width);
                const height = Math.max(1, dimensions.height);
                return {
                    x: Math.max(0, Math.min(1, pxX / width)),
                    y: Math.max(0, Math.min(1, 1 - (pxY / height)))
                };
            };
            const getCP = (p1, p2, t) => {
                const p1Px = toPx(p1); const p2Px = toPx(p2);
                return { x: (p1Px.x + p2Px.x) / 2, y: (p1Px.y + p2Px.y) / 2 + (t * 100) };
            };

            const handlePointerDown = (e, type, idx) => {
                e.preventDefault(); e.stopPropagation();
                if ((mode === 'CURVE' && type === 'point') || (mode === 'POINT' && type === 'line')) return;
                const startY = e.clientY;
                const startTension = type === 'line' ? (points[idx].tension || 0) : 0;

                const onWindowMove = (ev) => {
                    if (!containerRef.current) return;
                    const rect = containerRef.current.getBoundingClientRect();
                    const newPts = [...points];
                    if (type === 'point') {
                        const norm = toNorm(ev.clientX - rect.left, ev.clientY - rect.top);
                        if (idx === 0) norm.x = 0; if (idx === points.length - 1) norm.x = 1;
                        newPts[idx] = { ...newPts[idx], x: norm.x, y: norm.y };
                        setPoints(newPts.sort((a, b) => a.x - b.x));
                    } else {
                        newPts[idx] = { ...newPts[idx], tension: Math.max(-1.5, Math.min(1.5, startTension + (startY - ev.clientY) * 0.005)) };
                        setPoints(newPts);
                    }
                };
                const onUp = () => {
                    window.removeEventListener('pointermove', onWindowMove);
                    window.removeEventListener('pointerup', onUp);
                    window.removeEventListener('pointercancel', onUp);
                };
                window.addEventListener('pointermove', onWindowMove);
                window.addEventListener('pointerup', onUp);
                window.addEventListener('pointercancel', onUp);
            };

            const handleBgClick = (e) => {
                if (mode !== 'POINT') return;
                const rect = containerRef.current.getBoundingClientRect();
                setPoints([...points, { ...toNorm(e.clientX - rect.left, e.clientY - rect.top), tension: 0, id: generateId() }].sort((a, b) => a.x - b.x));
            };

            const handleMouseMove = (e) => {
                if (e.pointerType === 'touch') return;
                const rect = containerRef.current.getBoundingClientRect();
                const norm = toNorm(e.clientX - rect.left, e.clientY - rect.top);
                const val = activeLayer === 'PITCH' ? `${(minFreq + norm.y * (200 - minFreq)).toFixed(0)} Hz` : `${(norm.y * 100).toFixed(0)}%`;
                setHoverPos({ x: e.clientX + 20, y: e.clientY + 20, val, time: (norm.x * duration).toFixed(2) + 's' });
            };

            const makePath = (pts) => {
                if (!pts.length) return "";
                const start = toPx(pts[0]);
                let d = `M ${start.x} ${start.y}`;
                for (let i = 0; i < pts.length - 1; i++) {
                    const p1 = pts[i], p2 = pts[i + 1];
                    const dest = toPx(p2);
                    if (Math.abs(p1.tension || 0) < 0.01) d += ` L ${dest.x} ${dest.y}`;
                    else { const cp = getCP(p1, p2, p1.tension); d += ` Q ${cp.x} ${cp.y} ${dest.x} ${dest.y}`; }
                }
                return d;
            };

            const stopProp = (e) => { e.stopPropagation(); };

            return (
                <div ref={containerRef} className="absolute inset-0 bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden grid-bg select-none group touch-none"
                    onPointerMove={handleMouseMove} onPointerLeave={() => setHoverPos(null)} onPointerDown={handleBgClick}>
                    <div className="absolute top-4 left-4 flex gap-4 z-20 pointer-events-none">
                        <div className="pointer-events-auto flex gap-1 bg-zinc-900 rounded p-1 border border-zinc-700 shadow-xl" onMouseDown={stopProp} onClick={stopProp}>
                            {['PITCH', 'AMP'].map(l => <button key={l} aria-pressed={activeLayer === l} onClick={() => setActiveLayer(l)} className={`text-[10px] px-3 py-1 font-bold rounded ${activeLayer === l ? (l === 'PITCH' ? 'bg-orange-500/20 text-orange-400' : 'bg-zinc-700 text-white') : 'text-zinc-500'}`}>{l}</button>)}
                        </div>
                        <div className="pointer-events-auto flex gap-1 bg-zinc-900 rounded p-1 border border-zinc-700 shadow-xl" onMouseDown={stopProp} onClick={stopProp}>
                            {['POINT', 'CURVE'].map(m => <button key={m} aria-pressed={mode === m} onClick={(e) => { e.stopPropagation(); setMode(m) }} className={`text-[10px] px-3 py-1 font-bold rounded ${mode === m ? (m === 'POINT' ? 'bg-blue-600 text-white' : 'bg-purple-600 text-white') : 'text-zinc-500'}`}>{m}</button>)}
                        </div>
                    </div>
                    {hoverPos && <div className="graph-tooltip" style={{ left: hoverPos.x, top: hoverPos.y }}><div>T: {hoverPos.time}</div><div>V: {hoverPos.val}</div></div>}

                    <svg width="100%" height="100%" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} preserveAspectRatio="none" className={`absolute inset-0 w-full h-full ${mode === 'CURVE' ? 'cursor-ew-resize' : 'cursor-crosshair'}`}>
                        <path d={makePath(activeLayer === 'PITCH' ? ampEnv : pitchEnv)} fill="none" stroke="#333" strokeWidth="2" strokeDasharray="4 4" />
                        <path d={makePath(points)} fill="none" stroke={color} strokeWidth="3" />
                        <path d={`${makePath(points)} L ${dimensions.width} ${dimensions.height} L 0 ${dimensions.height} Z`} fill={color} opacity="0.1" pointerEvents="none" />
                        {mode === 'CURVE' && points.map((pt, i) => i < points.length - 1 && <path key={`l${i}`} d={makePath([pt, points[i + 1]])} stroke="transparent" strokeWidth="28" fill="none" className="cursor-ns-resize" onPointerDown={(e) => handlePointerDown(e, 'line', i)} />)}
                        {mode === 'POINT' && points.map((pt, i) => {
                            const px = toPx(pt);
                            return <circle key={pt.id} cx={px.x} cy={px.y} r={8} fill="#18181b" stroke={color} strokeWidth="2" className="cursor-pointer hover:fill-white" onPointerDown={(e) => handlePointerDown(e, 'point', i)} onDoubleClick={(e) => { e.stopPropagation(); i > 0 && i < points.length - 1 && setPoints(points.filter((_, idx) => idx !== i)) }} />
                        })}
                    </svg>
                </div>
            );
        };

        const PageKnobs = ({ children, color }) => (
            <div className="w-full lg:w-64 bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 lg:p-6 grid grid-cols-1 sm:grid-cols-3 lg:flex lg:flex-col gap-4 lg:gap-6 relative shrink-0 z-20">
                <div className={`absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-[${color}] to-transparent opacity-50`}></div>
                {children}
            </div>
        );

        // --- MAIN APP ---
        const TitanApp = () => {
            const [tab, setTab] = usePersistentState('web-synth.titan.tab', 'DROP');
            const audioCtxRef = useRef(null);
            // Singleton Nodes
            const masterChainRef = useRef(null);
            const activeNodesRef = useRef([]); // Track active nodes to kill them
            const recorderRef = useRef(null);

            const analyserRef = useRef(null);
            const canvasRef = useRef(null);
            const rafRef = useRef(null);
            const initPts = (arr) => arr.map(p => ({ ...p, id: generateId() }));

            const [inflatorCurve, setInflatorCurve] = usePersistentState('web-synth.titan.inflatorCurve', 0);
            const [inflatorAmt, setInflatorAmt] = usePersistentState('web-synth.titan.inflatorAmt', 20);
            const [inflatorClip, setInflatorClip] = usePersistentState('web-synth.titan.inflatorClip', true);
            const [masterVol, setMasterVol] = usePersistentState('web-synth.titan.masterVol', 0.4);
            const [reverbMix, setReverbMix] = usePersistentState('web-synth.titan.reverbMix', 0);
            const [isMono, setIsMono] = usePersistentState('web-synth.titan.isMono', false);
            const [isRecording, setIsRecording] = useState(false);
            const recordingTime = useRecordingClock(isRecording, recorderRef);

            const [dropDuration, setDropDuration] = usePersistentState('web-synth.titan.dropDuration', 2.0);
            const [dropWidth, setDropWidth] = usePersistentState('web-synth.titan.dropWidth', 0);
            const [dropTone, setDropTone] = usePersistentState('web-synth.titan.dropTone', 0);
            const [dropPitch, setDropPitch] = usePersistentState('web-synth.titan.dropPitch', () => initPts([{ x: 0, y: 0.8 }, { x: 0.3, y: 0.2 }, { x: 1, y: 0 }]));
            const [dropAmp, setDropAmp] = usePersistentState('web-synth.titan.dropAmp', () => initPts([{ x: 0, y: 0 }, { x: 0.1, y: 1 }, { x: 0.8, y: 0.5 }, { x: 1, y: 0 }]));

            const [impactDrive, setImpDrive] = usePersistentState('web-synth.titan.impactDrive', 30);
            const [impactWidth, setImpWidth] = usePersistentState('web-synth.titan.impactWidth', 0);
            const [impactPitch, setImpPitch] = usePersistentState('web-synth.titan.impactPitch', () => initPts([{ x: 0, y: 1 }, { x: 0.05, y: 0 }, { x: 1, y: 0 }]));
            const [impactAmp, setImpAmp] = usePersistentState('web-synth.titan.impactAmp', () => initPts([{ x: 0, y: 1 }, { x: 0.8, y: 0 }]));

            const [rumbleShake, setRumShake] = usePersistentState('web-synth.titan.rumbleShake', 40);
            const [rumbleSpeed, setRumSpeed] = usePersistentState('web-synth.titan.rumbleSpeed', 15);
            const [rumbleWeight, setRumWeight] = usePersistentState('web-synth.titan.rumbleWeight', 50);
            const [rumbleWidth, setRumWidth] = usePersistentState('web-synth.titan.rumbleWidth', 0);
            const [rumbleDuration, setRumDur] = usePersistentState('web-synth.titan.rumbleDuration', 4.0);
            const [rumblePitch, setRumPitch] = usePersistentState('web-synth.titan.rumblePitch', () => initPts([{ x: 0, y: 0.2 }, { x: 0.5, y: 0.3 }, { x: 1, y: 0.1 }]));
            const [rumbleAmp, setRumAmp] = usePersistentState('web-synth.titan.rumbleAmp', () => initPts([{ x: 0, y: 0 }, { x: 0.2, y: 1 }, { x: 0.8, y: 0.8 }, { x: 1, y: 0 }]));

            const [activeLayer, setActiveLayer] = useState('PITCH');

            const applyMasterSettings = (chain, immediate = false) => {
                if (!chain) return;
                const ctx = chain.ctx;

                chain.shaper.curve = generateInflatorCurve(inflatorCurve, inflatorAmt, inflatorClip);
                if (immediate) {
                    chain.master.gain.setValueAtTime(masterVol, ctx.currentTime);
                    chain.verbBus.gain.setValueAtTime(reverbMix / 100, ctx.currentTime);
                } else {
                    chain.master.gain.setTargetAtTime(masterVol, ctx.currentTime, 0.05);
                    chain.verbBus.gain.setTargetAtTime(reverbMix / 100, ctx.currentTime, 0.05);
                }

                chain.mono.finalRoute.disconnect();
                chain.mono.finalRoute.connect(chain.master);
                try { chain.mono.monoMerge.disconnect(chain.mono.finalRoute); } catch (e) { }
                try { chain.mono.stereoMerge.disconnect(chain.mono.finalRoute); } catch (e) { }

                if (isMono) {
                    chain.mono.monoMerge.connect(chain.mono.finalRoute);
                } else {
                    chain.mono.stereoMerge.connect(chain.mono.finalRoute);
                }
            };

            // Initial Setup - ONE TIME ONLY
            const initAudio = () => {
                if (!audioCtxRef.current) {
                    const AudioContext = window.AudioContext || window.webkitAudioContext;
                    const ctx = new AudioContext({ sampleRate: 96000 });
                    audioCtxRef.current = ctx;

                    // --- SINGLETON MASTER CHAIN ---
                    const masterGain = ctx.createGain();
                    masterGain.gain.value = masterVol;
                    const limiter = ctx.createDynamicsCompressor();
                    limiter.threshold.value = -0.1; // Hard ceiling
                    limiter.ratio.value = 20;
                    limiter.attack.value = 0.001;

                    const dryBus = ctx.createGain();
                    const verbBus = ctx.createGain();

                    const verb = ctx.createConvolver();
                    verb.buffer = createDarkReverbIR(ctx, 2.5, 3.0);
                    const verbFilter = ctx.createBiquadFilter();
                    verbFilter.type = 'lowpass'; verbFilter.frequency.value = 400;

                    const verbLimit = ctx.createDynamicsCompressor();
                    verbLimit.threshold.value = -3;
                    verbLimit.ratio.value = 10;

                    verbBus.connect(verb);
                    verb.connect(verbFilter);
                    verbFilter.connect(verbLimit);
                    verbLimit.connect(limiter);
                    dryBus.connect(limiter);

                    const globalShaper = ctx.createWaveShaper();

                    globalShaper.connect(dryBus);
                    globalShaper.connect(verbBus);

                    const preMaster = ctx.createGain();
                    limiter.connect(preMaster);

                    const splitter = ctx.createChannelSplitter(2);
                    const monoMerge = ctx.createChannelMerger(1);
                    const stereoMerge = ctx.createChannelMerger(2);

                    preMaster.connect(splitter);
                    splitter.connect(monoMerge, 0, 0);
                    splitter.connect(monoMerge, 1, 0);

                    splitter.connect(stereoMerge, 0, 0);
                    splitter.connect(stereoMerge, 1, 1);

                    const finalRoute = ctx.createGain();
                    stereoMerge.connect(finalRoute);

                    const analyser = ctx.createAnalyser();
                    analyser.fftSize = 2048; analyserRef.current = analyser;

                    finalRoute.connect(masterGain);
                    masterGain.connect(analyser);
                    recorderRef.current = createWavRecorder(ctx, analyser, {
                        onLimit: async () => {
                            setIsRecording(false);
                            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                            await recorderRef.current?.stop(`TITAN_REC_LIMIT_${ctx.sampleRate}hz_24bit_${timestamp}.wav`);
                        }
                    });
                    analyser.connect(ctx.destination);

                    masterChainRef.current = {
                        input: globalShaper,
                        shaper: globalShaper,
                        master: masterGain,
                        verbBus: verbBus,
                        mono: { monoMerge, stereoMerge, finalRoute },
                        ctx: ctx
                    };
                    applyMasterSettings(masterChainRef.current, true);
                }
                if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
            };

            // Param Updates
            useEffect(() => {
                if (!masterChainRef.current) return;
                applyMasterSettings(masterChainRef.current);
            }, [inflatorCurve, inflatorAmt, inflatorClip, masterVol, reverbMix, isMono]);

            const stopActiveVoices = (ctx) => {
                const now = ctx.currentTime;
                if (activeNodesRef.current && Array.isArray(activeNodesRef.current)) {
                    activeNodesRef.current.forEach(node => {
                        if (node.gain && node.gain.cancelScheduledValues) {
                            node.gain.cancelScheduledValues(now);
                            node.gain.setTargetAtTime(0, now, 0.015);
                        }
                        if (node.stop) {
                            node.stop(now + 0.05);
                        }
                    });
                }
                activeNodesRef.current = [];
            };

            const triggerSound = () => {
                initAudio();
                const chain = masterChainRef.current;
                const ctx = chain.ctx;
                const t = ctx.currentTime;

                stopActiveVoices(ctx);

                let newNodes = [];

                if (tab === 'DROP') {
                    newNodes = createQuadSource(ctx, chain.input, {
                        t, duration: dropDuration, pitchEnv: dropPitch, ampEnv: dropAmp,
                        width: dropWidth, tone: dropTone, pitchMin: 20, pitchMax: 150
                    });
                } else if (tab === 'IMPACT') {
                    newNodes = createQuadSource(ctx, chain.input, {
                        t, duration: 0.8, pitchEnv: impactPitch, ampEnv: impactAmp,
                        width: impactWidth, tone: impactDrive, pitchMin: 30, pitchMax: 180
                    });
                } else if (tab === 'RUMBLE') {
                    const { sineWave, cosWave } = getWaveforms(ctx);
                    const oscL = ctx.createOscillator(); oscL.setPeriodicWave(sineWave);
                    const oscR_Main = ctx.createOscillator(); oscR_Main.setPeriodicWave(sineWave);
                    const oscR_Quad = ctx.createOscillator(); oscR_Quad.setPeriodicWave(cosWave);

                    const fmLfo = createNoiseLfo(ctx, t, rumbleDuration, rumbleSpeed);
                    const fmGain = ctx.createGain(); fmGain.gain.value = rumbleShake * 2;
                    fmLfo.output.connect(fmGain);
                    fmGain.connect(oscL.frequency); fmGain.connect(oscR_Main.frequency); fmGain.connect(oscR_Quad.frequency);

                    const amLfo = createNoiseLfo(ctx, t, rumbleDuration, rumbleSpeed * 1.5);
                    const amGain = ctx.createGain(); amGain.gain.value = 0.4 * (rumbleShake / 100);
                    const tremL = ctx.createGain(); tremL.gain.value = 0.6;
                    const tremR = ctx.createGain(); tremR.gain.value = 0.6;
                    amLfo.output.connect(amGain); amGain.connect(tremL.gain); amGain.connect(tremR.gain);

                    const env = ctx.createGain();
                    [...rumbleAmp].sort((a, b) => a.x - b.x).forEach((pt, i) => {
                        const time = t + pt.x * rumbleDuration;
                        if (i === 0) env.gain.setValueAtTime(pt.y, time); else env.gain.linearRampToValueAtTime(pt.y, time);
                    });

                    const scheduleF = (osc) => {
                        osc.frequency.setValueAtTime(40, t);
                        [...rumblePitch].sort((a, b) => a.x - b.x).forEach((pt, i) => {
                            const time = t + pt.x * rumbleDuration;
                            osc.frequency.linearRampToValueAtTime(30 + pt.y * 50, time);
                        });
                    }
                    scheduleF(oscL); scheduleF(oscR_Main); scheduleF(oscR_Quad);

                    const distL = ctx.createWaveShaper(); const distR = ctx.createWaveShaper();
                    const k = rumbleWeight * 0.02;
                    const c = new Float32Array(4096);
                    for (let i = 0; i < 4096; i++) { let x = (i * 2) / 4096 - 1; c[i] = (Math.PI + k) * x / (Math.PI + k * Math.abs(x)); }
                    distL.curve = c; distR.curve = c;

                    let w = rumbleWidth / 100;
                    const gainR_Main = ctx.createGain();
                    const gainR_Quad = ctx.createGain();

                    if (w <= 0.5) {
                        const ratio = w * 2;
                        gainR_Main.gain.value = 1 - ratio;
                        gainR_Quad.gain.value = ratio;
                    } else {
                        const ratio = (w - 0.5) * 2;
                        gainR_Main.gain.value = -1 * ratio;
                        gainR_Quad.gain.value = 1 - ratio;
                    }

                    oscR_Main.connect(gainR_Main);
                    oscR_Quad.connect(gainR_Quad);

                    const envL = ctx.createGain(); const envR = ctx.createGain();
                    const applyEnv = (g) => {
                        g.gain.setValueAtTime(0, t);
                        [...rumbleAmp].sort((a, b) => a.x - b.x).forEach((pt, i) => {
                            const time = t + pt.x * rumbleDuration;
                            if (i === 0) g.gain.setValueAtTime(pt.y, time); else g.gain.linearRampToValueAtTime(pt.y, time);
                        });
                    };
                    applyEnv(envL); applyEnv(envR);

                    oscL.connect(envL); envL.connect(tremL); tremL.connect(distL);

                    const rMix = ctx.createGain();
                    gainR_Main.connect(rMix); gainR_Quad.connect(rMix);
                    rMix.connect(envR); envR.connect(tremR); tremR.connect(distR);

                    const merger = ctx.createChannelMerger(2);
                    distL.connect(merger, 0, 0); distR.connect(merger, 0, 1);
                    merger.connect(chain.input);

                    oscL.start(t); oscR_Main.start(t); oscR_Quad.start(t);
                    oscL.stop(t + rumbleDuration + 1); oscR_Main.stop(t + rumbleDuration + 1); oscR_Quad.stop(t + rumbleDuration + 1);

                    newNodes = [oscL, oscR_Main, oscR_Quad, envL, envR, amLfo.node, fmLfo.node];
                }

                activeNodesRef.current = newNodes;
                const visualDuration = tab === 'DROP' ? dropDuration : tab === 'IMPACT' ? 0.8 : rumbleDuration;
                const d = new Uint8Array(analyserRef.current.frequencyBinCount);

                const draw = () => {
                    if (!canvasRef.current || !analyserRef.current || document.hidden) return;
                    const c = canvasRef.current.getContext('2d');
                    const w = canvasRef.current.width, h = canvasRef.current.height;
                    analyserRef.current.getByteTimeDomainData(d);
                    c.clearRect(0, 0, w, h);
                    c.lineWidth = 2; c.strokeStyle = tab === 'DROP' ? '#fb923c' : tab === 'IMPACT' ? '#3b82f6' : '#ef4444';
                    c.beginPath();
                    let x = 0, slice = w / d.length;
                    for (let i = 0; i < d.length; i++) { c[i === 0 ? 'moveTo' : 'lineTo'](x, (d[i] / 128.0) * h / 2); x += slice; }
                    c.stroke();
                    if (isRecording) {
                        c.strokeStyle = 'rgba(239, 68, 68, 0.8)';
                        c.lineWidth = 2;
                        c.strokeRect(1, 1, w - 2, h - 2);
                    }
                    rafRef.current = requestAnimationFrame(draw);
                };
                draw();
                setTimeout(() => cancelAnimationFrame(rafRef.current), (visualDuration + 3) * 1000);
            };

            const toggleRecording = useCallback(async () => {
                initAudio();
                if (!recorderRef.current || !audioCtxRef.current) return;

                if (isRecording) {
                    setIsRecording(false);
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    await recorderRef.current.stop(`TITAN_REC_${tab}_${audioCtxRef.current.sampleRate}hz_24bit_${timestamp}.wav`);
                } else {
                    await recorderRef.current.start();
                    setIsRecording(true);
                }
            }, [isRecording, tab]);

            useEffect(() => {
                const handleKeyDown = (event) => {
                    if (isTypingTarget(event.target) || event.repeat) return;
                    if (event.code === 'Space') {
                        event.preventDefault();
                        triggerSound();
                    } else if (event.key.toLowerCase() === 'r') {
                        event.preventDefault();
                        toggleRecording();
                    } else if (event.key === 'Escape' && audioCtxRef.current) {
                        stopActiveVoices(audioCtxRef.current);
                    }
                };
                window.addEventListener('keydown', handleKeyDown);
                return () => window.removeEventListener('keydown', handleKeyDown);
            }, [toggleRecording, triggerSound]);

            useEffect(() => () => {
                cancelAnimationFrame(rafRef.current);
                if (audioCtxRef.current) stopActiveVoices(audioCtxRef.current);
                recorderRef.current?.destroy();
                if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') audioCtxRef.current.close();
            }, []);

            return (
                <div className="w-full min-h-screen lg:h-screen flex flex-col bg-zinc-950 text-zinc-300">
                    <header className="min-h-16 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-3 p-3 lg:px-6 lg:py-2 bg-zinc-900/50 backdrop-blur select-none z-30 sticky top-0 lg:static">
                        <div className="flex flex-wrap items-center gap-3 lg:gap-6 min-w-0 w-full lg:w-auto">
                            <a href="index.html" aria-label="Back to AI Synth Lab" className="h-9 px-3 rounded border border-zinc-800 text-zinc-500 hover:text-white hover:bg-zinc-800 flex items-center text-[10px] font-black tracking-widest transition-colors">LAB</a>
                            <div className="flex items-center gap-2">
                                <div className="w-8 h-8 bg-zinc-100 rounded flex items-center justify-center text-black font-black text-lg">T</div>
                                <h1 className="font-bold text-white tracking-tighter">TITAN <span className="hidden sm:inline text-zinc-500 font-normal text-xs ml-2">V10.3</span></h1>
                            </div>
                            <div className="order-3 lg:order-none w-full lg:w-auto flex bg-zinc-900 rounded-lg p-1 border border-zinc-800">{['DROP', 'IMPACT', 'RUMBLE'].map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)} className={`flex-1 lg:flex-none px-3 sm:px-4 lg:px-6 py-2 lg:py-1.5 text-xs font-black tracking-widest rounded transition-all ${tab === t ? t === 'DROP' ? 'bg-orange-500 text-black' : t === 'IMPACT' ? 'bg-blue-500 text-black' : 'bg-red-500 text-black' : 'text-zinc-500 hover:text-white'}`}>{t}</button>)}</div>
                        </div>
                        <div className="flex items-center gap-3 lg:gap-4 shrink-0 justify-between lg:justify-end w-full lg:w-auto">
                            {/* CREDITS */}
                            <div className="hidden xl:flex flex-col text-[10px] leading-tight text-right mr-2 border-r border-zinc-800 pr-4 h-full justify-center opacity-50 hover:opacity-100 transition-opacity">
                                <span className="font-bold text-zinc-400">Ethan Zhu</span>
                                <span className="font-mono text-zinc-600">yichengzhu@outlook.com</span>
                            </div>
                            <div className="hidden md:block w-32 h-8 bg-zinc-900 rounded border border-zinc-800 relative overflow-hidden shrink-0"><canvas ref={canvasRef} width={128} height={32} className="w-full h-full opacity-60" /></div>
                            <div className="flex-1 max-w-40 lg:w-32"><Slider label="VOLUME" value={masterVol} min={0} max={1} step={0.01} onChange={setMasterVol} color="#fff" /></div>
                            <button onClick={triggerSound} className={`min-w-28 px-6 lg:px-8 py-2.5 rounded-full font-bold text-black shadow-[0_0_20px_rgba(255,255,255,0.2)] hover:scale-105 active:scale-95 transition-all ${tab === 'DROP' ? 'bg-orange-500' : tab === 'IMPACT' ? 'bg-blue-500' : 'bg-red-500'}`}>TRIGGER</button>
                        </div>
                    </header>
                    <div className="min-h-20 bg-zinc-900 border-b border-zinc-800 flex flex-wrap items-center px-3 sm:px-5 lg:px-8 py-3 gap-3 lg:gap-8 justify-start lg:justify-center select-none z-20 relative">
                        <div className="absolute left-0 top-0 bottom-0 w-2 bg-gradient-to-r from-black to-transparent"></div>
                        <button aria-pressed={isMono} onClick={() => setIsMono(!isMono)} className={`px-3 lg:px-4 py-2 rounded font-bold text-[10px] tracking-widest border transition-all ${isMono ? 'bg-yellow-500 text-black border-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.4)]' : 'bg-zinc-800 text-zinc-500 border-zinc-700 hover:text-white'}`}>{isMono ? 'MONO' : 'STEREO'}</button>
                        <button onClick={toggleRecording} className={`px-3 lg:px-4 py-2 rounded font-bold text-[10px] tracking-widest border transition-all active:scale-95 ${isRecording ? 'bg-red-900/50 border-red-500 text-red-100 record-pulse' : 'bg-zinc-800 text-zinc-500 border-zinc-700 hover:text-white'}`}>{isRecording ? `STOP ${recordingTime}` : 'REC WAV'}</button>
                        {isRecording && (
                            <div className="flex items-center gap-2 bg-red-500/10 px-3 py-1.5 rounded-full border border-red-500/50 record-pulse">
                                <div className="w-2 h-2 bg-red-500 rounded-full"></div>
                                <span className="text-[10px] font-bold text-red-300 tracking-widest">REC 96K · {recordingTime}</span>
                            </div>
                        )}
                        <div className="min-w-24 flex-1 max-w-40"><Slider label="INFLATOR %" value={inflatorAmt} min={0} max={100} step={1} onChange={setInflatorAmt} color="#a1a1aa" suffix="%" /></div>
                        <div className="min-w-24 flex-1 max-w-40"><Slider label="CURVE" value={inflatorCurve} min={-50} max={50} step={1} onChange={setInflatorCurve} color="#a1a1aa" /></div>
                        <div className="min-w-24 flex-1 max-w-40"><Slider label="DARK SPACE" value={reverbMix} min={0} max={100} step={1} onChange={setReverbMix} color="#a1a1aa" suffix="%" /></div>
                        <div className="hidden lg:block h-10 w-px bg-zinc-800 mx-2"></div>
                        <button aria-pressed={inflatorClip} className="flex items-center gap-2 cursor-pointer group p-2" onClick={() => setInflatorClip(!inflatorClip)}><span className={`w-3 h-3 rounded-full border transition-all ${inflatorClip ? 'bg-red-500 border-red-500 shadow-[0_0_8px_red]' : 'bg-zinc-800 border-zinc-600'}`} /><span className="text-[10px] font-bold text-zinc-500 group-hover:text-zinc-300">CLIP</span></button>
                    </div>
                    <main className="flex-1 flex flex-col lg:flex-row p-3 sm:p-4 lg:p-6 min-h-0 bg-black lg:overflow-hidden relative">
                        <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-left-4 duration-300">
                            {tab === 'DROP' && <PageKnobs color="#fb923c"><div className="text-orange-500 text-xs font-black tracking-widest border-b border-orange-500/20 pb-2">SOURCE QUADRATURE</div><Slider label="WIDTH" value={dropWidth} min={0} max={100} step={1} onChange={setDropWidth} color="#fb923c" suffix="%" warning={dropWidth > 50} description={dropWidth > 50 ? "⚠️ Phase cancellation in Mono" : "Safe: Quadrature Phase"} /><Slider label="TONE" value={dropTone} min={0} max={100} step={1} onChange={setDropTone} color="#fb923c" suffix="%" /><div className="my-2"></div><Slider label="LENGTH" value={dropDuration} min={0.5} max={5.0} step={0.01} onChange={setDropDuration} color="#fb923c" suffix="s" /></PageKnobs>}
                            {tab === 'IMPACT' && <PageKnobs color="#3b82f6"><div className="text-blue-500 text-xs font-black tracking-widest border-b border-blue-500/20 pb-2">TRANSIENT</div><Slider label="DRIVE" value={impactDrive} min={0} max={100} step={1} onChange={setImpDrive} color="#3b82f6" suffix="%" /><Slider label="WIDTH" value={impactWidth} min={0} max={100} step={1} onChange={setImpWidth} color="#3b82f6" suffix="%" warning={impactWidth > 50} description={impactWidth > 50 ? "⚠️ Phase cancellation in Mono" : "Safe: Quadrature Phase"} /></PageKnobs>}
                            {tab === 'RUMBLE' && <PageKnobs color="#ef4444"><div className="text-red-500 text-xs font-black tracking-widest border-b border-red-500/20 pb-2">DARK SEISMIC</div><Slider label="SHAKE" value={rumbleShake} min={0} max={100} step={1} onChange={setRumShake} color="#ef4444" suffix="%" /><Slider label="WIDTH" value={rumbleWidth} min={0} max={100} step={1} onChange={setRumWidth} color="#ef4444" suffix="%" warning={rumbleWidth > 50} description={rumbleWidth > 50 ? "⚠️ Phase cancellation in Mono" : "Safe: Quadrature Phase"} /><Slider label="SPEED" value={rumbleSpeed} min={0} max={100} step={1} onChange={setRumSpeed} color="#ef4444" suffix="%" /><Slider label="WEIGHT" value={rumbleWeight} min={0} max={100} step={1} onChange={setRumWeight} color="#ef4444" suffix="%" /><div className="my-2"></div><Slider label="LENGTH" value={rumbleDuration} min={1} max={8} step={0.01} onChange={setRumDur} color="#ef4444" suffix="s" /></PageKnobs>}
                        </div>
                        <div className="flex-1 mt-3 lg:mt-0 lg:ml-6 h-[480px] lg:h-full min-w-0 min-h-[480px] lg:min-h-0 relative group"><GraphEditor pitchEnv={tab === 'DROP' ? dropPitch : tab === 'IMPACT' ? impactPitch : rumblePitch} setPitchEnv={tab === 'DROP' ? setDropPitch : tab === 'IMPACT' ? setImpPitch : setRumPitch} ampEnv={tab === 'DROP' ? dropAmp : tab === 'IMPACT' ? impactAmp : rumbleAmp} setAmpEnv={tab === 'DROP' ? setDropAmp : tab === 'IMPACT' ? setImpAmp : setRumAmp} activeLayer={activeLayer} setActiveLayer={setActiveLayer} duration={tab === 'DROP' ? dropDuration : tab === 'IMPACT' ? 0.8 : rumbleDuration} minFreq={20} /></div>
                    </main>
                </div>
            );
        };

        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(<TitanApp />);
