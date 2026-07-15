import React from "react";
import * as ReactDOM from "react-dom/client";
import "./styles.css";
import { createWavRecorder } from "./recording.js";
import { isTypingTarget, usePersistentState, useRecordingClock } from "./hooks.js";

const { useState, useEffect, useRef, useCallback } = React;

        // --- ICONS SYSTEM (Manual Definitions for Standalone HTML) ---
        const IconBase = ({ children, ...props }) => (
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>{children}</svg>
        );

        const Icons = {
            Sparkles: (p) => <IconBase {...p}><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" /><path d="M5 3v4" /><path d="M9 3v4" /><path d="M3 5h4" /><path d="M3 9h4" /></IconBase>,
            Circle: (p) => <IconBase {...p}><circle cx="12" cy="12" r="10" /></IconBase>,
            Zap: (p) => <IconBase {...p}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></IconBase>,
            ArrowUp: (p) => <IconBase {...p}><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></IconBase>,
            Home: (p) => <IconBase {...p}><path d="m3 9 9-7 9 7" /><path d="M9 22V12h6v10" /><path d="M21 9v13H3V9" /></IconBase>,
            Mic: (p) => <IconBase {...p}><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" /><line x1="8" x2="16" y1="22" y2="22" /></IconBase>,
            Music: (p) => <IconBase {...p}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></IconBase>,
            Sliders: (p) => <IconBase {...p}><line x1="4" x2="4" y1="21" y2="14" /><line x1="4" x2="4" y1="10" y2="3" /><line x1="12" x2="12" y1="21" y2="12" /><line x1="12" x2="12" y1="8" y2="3" /><line x1="20" x2="20" y1="21" y2="16" /><line x1="20" x2="20" y1="12" y2="3" /><line x1="2" x2="6" y1="14" y2="14" /><line x1="10" x2="14" y1="8" y2="8" /><line x1="18" x2="22" y1="16" y2="16" /></IconBase>,
            Volume2: (p) => <IconBase {...p}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></IconBase>,
            Dices: (p) => <IconBase {...p}><rect width="12" height="12" x="2" y="10" rx="2" ry="2" /><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6" /><path d="M6 18h.01" /><path d="M10 14h.01" /><path d="M15 6h.01" /><path d="M18 9h.01" /></IconBase>,
            Layers: (p) => <IconBase {...p}><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></IconBase>,
            Droplets: (p) => <IconBase {...p}><path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.8-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z" /><path d="M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.35" /></IconBase>,
            Activity: (p) => <IconBase {...p}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></IconBase>,
            Lock: (p) => <IconBase {...p}><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></IconBase>,
            Unlock: (p) => <IconBase {...p}><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></IconBase>,
            Play: (p) => <IconBase {...p}><polygon points="5 3 19 12 5 21 5 3" /></IconBase>,
            Pause: (p) => <IconBase {...p}><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></IconBase>,
            Square: (p) => <IconBase {...p}><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /></IconBase>,
            Star: (p) => <IconBase {...p}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></IconBase>,
            Heart: (p) => <IconBase {...p}><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" /></IconBase>,
            MessageCircle: (p) => <IconBase {...p}><path d="m3 21 1.9-5.7a8.5 8.5 0 1 1 3.8 3.8z" /></IconBase>,
            MousePointer2: (p) => <IconBase {...p}><path d="m12 22 4-9 9-4-13-13-9 13 9 4" /></IconBase>,
        };

        // --- MAIN COMPONENT ---
        const KawaiiSynth = () => {
            const [audioCtx, setAudioCtx] = useState(null);
            const [masterBus, setMasterBus] = useState(null);
            const [analyser, setAnalyser] = useState(null);
            const audioCtxRef = useRef(null);
            const masterBusRef = useRef(null);
            const recorderRef = useRef(null);
            const canvasRef = useRef(null);
            const [volume, setVolume] = usePersistentState('web-synth.kawaii.volume', 0.6);
            const animationRef = useRef(null);
            const [isPresetMenuOpen, setIsPresetMenuOpen] = useState(false);

            // Params
            const [params, setParams] = usePersistentState('web-synth.kawaii.params', {
                // Osc
                frequency: 600,
                shape: 'sine',
                sweep: -0.5,

                // Filter
                filterFreq: 2000,
                filterQ: 5,
                filterEnv: 0,

                // Env
                attack: 0.01,
                decay: 0.2,

                // Mod
                modDepth: 0,
                modSpeed: 0,

                // FX (Default Off)
                delay: 0.0,
                wobble: 0.0,
            });

            const [lockedParams, setLockedParams] = usePersistentState('web-synth.kawaii.locks', {});
            const [activePreset, setActivePreset] = usePersistentState('web-synth.kawaii.preset', 'BUBBLE');
            const [lastTriggerTime, setLastTriggerTime] = useState(0);
            const [isRecording, setIsRecording] = useState(false);
            const recordingTime = useRecordingClock(isRecording, recorderRef);

            // --- PRESETS ---
            const PRESETS = {
                // --- PHYSICS ---
                BUBBLE: {
                    params: { frequency: 450, shape: 'sine', sweep: -0.6, filterFreq: 800, filterQ: 15, filterEnv: 600, decay: 0.15, modDepth: 0 },
                    locks: ['shape', 'filterQ', 'sweep', 'modDepth']
                },
                JUMP: {
                    params: { frequency: 220, shape: 'square', sweep: 0.8, filterFreq: 1500, filterQ: 2, filterEnv: 500, decay: 0.3, modDepth: 0 },
                    locks: ['shape', 'sweep']
                },
                BOING: {
                    params: { frequency: 150, shape: 'sine', sweep: 0.0, filterFreq: 600, filterQ: 5, filterEnv: 0, decay: 0.6, modDepth: 200, modSpeed: 15 },
                    locks: ['modSpeed', 'modDepth', 'decay']
                },

                // --- EMOTES ---
                QUESTION: {
                    params: { frequency: 400, shape: 'sine', sweep: 0.5, filterFreq: 2000, filterQ: 1, filterEnv: 0, decay: 0.25, modDepth: 0 },
                    locks: ['sweep', 'shape']
                },
                SAD: {
                    params: { frequency: 500, shape: 'triangle', sweep: -0.15, filterFreq: 800, filterQ: 1, filterEnv: -200, decay: 0.6, modDepth: 0, wobble: 0.15 },
                    locks: ['shape', 'sweep', 'wobble', 'decay']
                },
                ANXIETY: {
                    params: { frequency: 200, shape: 'sawtooth', sweep: 0, filterFreq: 3000, filterQ: 1, filterEnv: 0, decay: 0.1, modDepth: 500, modSpeed: 40 },
                    locks: ['modSpeed', 'shape']
                },
                ANGRY: {
                    params: { frequency: 100, shape: 'sawtooth', sweep: -0.1, filterFreq: 500, filterQ: 10, filterEnv: 2000, decay: 0.2, modDepth: 800, modSpeed: 80 },
                    locks: ['shape', 'filterEnv', 'modDepth']
                },
                HAPPY: {
                    params: { frequency: 880, shape: 'triangle', sweep: 0.1, filterFreq: 4000, filterQ: 1, filterEnv: 0, decay: 0.1, modDepth: 0 },
                    locks: ['shape']
                },

                // --- MAGIC ---
                SPARKLE: {
                    params: { frequency: 1200, shape: 'sine', sweep: 0, filterFreq: 5000, filterQ: 1, filterEnv: 0, decay: 0.5, modDepth: 1000, modSpeed: 80, delay: 0.3, wobble: 0.2 },
                    locks: ['modSpeed']
                },
                TRANSFORM: {
                    params: { frequency: 300, shape: 'sine', sweep: 1.0, filterFreq: 2000, filterQ: 8, filterEnv: 2000, decay: 1.5, modDepth: 200, modSpeed: 20, delay: 0.2 },
                    locks: ['sweep', 'decay']
                },

                // --- UI ---
                CLICK: {
                    params: { frequency: 1500, shape: 'sine', sweep: -0.9, filterFreq: 5000, filterQ: 1, filterEnv: 0, decay: 0.05, modDepth: 0 },
                    locks: ['decay', 'sweep']
                },
                ERROR: {
                    params: { frequency: 100, shape: 'sawtooth', sweep: 0, filterFreq: 500, filterQ: 1, filterEnv: 0, decay: 0.2, modDepth: 500, modSpeed: 30 },
                    locks: ['shape', 'modSpeed']
                },
            };

            const toggleLock = (key) => {
                setLockedParams(prev => ({ ...prev, [key]: !prev[key] }));
            };

            // --- Audio Init ---
            const initAudio = useCallback(() => {
                if (!audioCtxRef.current) {
                    const AudioContext = window.AudioContext || window.webkitAudioContext;
                    const ctx = new AudioContext({ sampleRate: 96000 });

                    // Master Chain
                    const masterGain = ctx.createGain();
                    const compressor = ctx.createDynamicsCompressor();
                    const analys = ctx.createAnalyser();

                    masterGain.gain.value = volume;
                    compressor.threshold.value = -3;
                    compressor.knee.value = 1;
                    compressor.ratio.value = 12;
                    compressor.attack.value = 0.003;
                    compressor.release.value = 0.15;
                    analys.fftSize = 2048;

                    // Effects Bus
                    const delayNode = ctx.createDelay();
                    delayNode.delayTime.value = 0.20;
                    const delayFeedback = ctx.createGain();
                    delayFeedback.gain.value = 0.3;
                    const delayFilter = ctx.createBiquadFilter();
                    delayFilter.frequency.value = 1500;
                    const delayGain = ctx.createGain();

                    const wobbleLfo = ctx.createOscillator();
                    wobbleLfo.type = 'sine';
                    wobbleLfo.frequency.value = 0.5;
                    const wobbleGain = ctx.createGain();
                    wobbleGain.gain.value = 0.002;
                    wobbleLfo.connect(wobbleGain);
                    wobbleGain.connect(delayNode.delayTime);
                    wobbleLfo.start();

                    delayNode.connect(delayFeedback);
                    delayFeedback.connect(delayFilter);
                    delayFilter.connect(delayNode);
                    delayNode.connect(delayGain);

                    delayGain.connect(compressor);
                    masterGain.connect(compressor);
                    compressor.connect(analys);
                    recorderRef.current = createWavRecorder(ctx, analys, {
                        onLimit: async () => {
                            setIsRecording(false);
                            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                            await recorderRef.current?.stop(`KAWAII_REC_LIMIT_${ctx.sampleRate}hz_24bit_${timestamp}.wav`);
                        }
                    });
                    analys.connect(ctx.destination);

                    const bus = {
                        master: masterGain,
                        delay: delayNode,
                        delayGain: delayGain,
                        wobbleGain: wobbleGain,
                        analyser: analys
                    };

                    audioCtxRef.current = ctx;
                    masterBusRef.current = bus;
                    setAudioCtx(ctx);
                    setMasterBus(bus);
                    setAnalyser(analys);
                }

                if (audioCtxRef.current.state === 'suspended') {
                    audioCtxRef.current.resume();
                }

                return { ctx: audioCtxRef.current, bus: masterBusRef.current };
            }, [volume]);

            useEffect(() => {
                if (!audioCtx || !masterBus) return;
                const t = audioCtx.currentTime;
                masterBus.master.gain.setTargetAtTime(volume, t, 0.05);
                masterBus.delayGain.gain.setTargetAtTime(params.delay, t, 0.05);
                masterBus.wobbleGain.gain.setTargetAtTime(params.wobble * 0.005, t, 0.05);
            }, [volume, params.delay, params.wobble, masterBus, audioCtx]);

            useEffect(() => () => {
                cancelAnimationFrame(animationRef.current);
                recorderRef.current?.destroy();
                if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') audioCtxRef.current.close();
            }, []);

            const triggerSound = useCallback((overrideFreq = null, overrideParams = null) => {
                const ready = initAudio();
                if (!ready || !ready.bus) return;

                const ctx = ready.ctx;
                const bus = ready.bus;
                const t = ctx.currentTime;
                const p = overrideParams || params;
                const baseFreq = overrideFreq || p.frequency;

                const osc = ctx.createOscillator();
                osc.type = p.shape;
                osc.frequency.setValueAtTime(baseFreq, t);

                if (p.sweep !== 0) {
                    const endFreq = Math.max(20, baseFreq * (1 + p.sweep));
                    osc.frequency.exponentialRampToValueAtTime(endFreq, t + p.decay);
                }

                if (p.modDepth > 0) {
                    const lfo = ctx.createOscillator();
                    const lfoGain = ctx.createGain();
                    lfo.type = 'sine';
                    lfo.frequency.setValueAtTime(p.modSpeed, t);
                    lfoGain.gain.setValueAtTime(p.modDepth, t);
                    lfoGain.gain.linearRampToValueAtTime(0, t + p.decay);
                    lfo.connect(lfoGain);
                    lfoGain.connect(osc.frequency);
                    lfo.start(t);
                    lfo.stop(t + p.decay + 0.1);
                }

                const filter = ctx.createBiquadFilter();
                filter.type = 'lowpass';
                filter.Q.value = p.filterQ;
                filter.frequency.setValueAtTime(p.filterFreq, t);

                if (p.filterEnv !== 0) {
                    filter.frequency.linearRampToValueAtTime(
                        Math.max(50, p.filterFreq + p.filterEnv),
                        t + (p.attack || 0.01)
                    );
                    filter.frequency.exponentialRampToValueAtTime(p.filterFreq, t + p.decay);
                }

                const gainNode = ctx.createGain();
                gainNode.gain.setValueAtTime(0, t);
                gainNode.gain.linearRampToValueAtTime(1, t + (p.attack || 0.005));
                gainNode.gain.exponentialRampToValueAtTime(0.001, t + p.decay);

                osc.connect(filter);
                filter.connect(gainNode);

                gainNode.connect(bus.master);
                gainNode.connect(bus.delay);

                osc.start(t);
                osc.stop(t + p.decay + 0.2);
                setLastTriggerTime(Date.now());

            }, [initAudio, params]);

            // --- Visualizer ---
            useEffect(() => {
                if (!analyser || !canvasRef.current) return undefined;
                const dataArray = new Uint8Array(analyser.frequencyBinCount);
                const draw = () => {
                    if (!canvasRef.current || document.hidden) return;
                    const ctx = canvasRef.current.getContext('2d');
                    const w = canvasRef.current.width;
                    const h = canvasRef.current.height;
                    const bufferLength = analyser.frequencyBinCount;
                    analyser.getByteTimeDomainData(dataArray);

                    ctx.fillStyle = '#0f172a';
                    ctx.fillRect(0, 0, w, h);

                    ctx.strokeStyle = '#1e293b';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    for (let x = 0; x < w; x += 50) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
                    for (let y = 0; y < h; y += 50) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
                    ctx.stroke();

                    const timeSinceTrigger = Date.now() - lastTriggerTime;
                    if (timeSinceTrigger < 200) {
                        ctx.fillStyle = `rgba(236, 72, 153, ${0.1 * (1 - timeSinceTrigger / 200)})`;
                        ctx.fillRect(0, 0, w, h);
                    }

                    ctx.lineWidth = 3;
                    ctx.strokeStyle = '#f472b6';
                    ctx.shadowBlur = 10;
                    ctx.shadowColor = '#f472b6';

                    ctx.beginPath();
                    const sliceWidth = w * 1.0 / bufferLength;
                    let x = 0;
                    for (let i = 0; i < bufferLength; i++) {
                        const v = dataArray[i] / 128.0;
                        const y = v * h / 2;
                        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                        x += sliceWidth;
                    }
                    ctx.lineTo(w, h / 2);
                    ctx.stroke();

                    ctx.shadowBlur = 0;

                    if (isRecording) {
                        ctx.strokeStyle = 'rgba(239, 68, 68, 0.75)';
                        ctx.lineWidth = 4;
                        ctx.strokeRect(2, 2, w - 4, h - 4);
                    }

                    animationRef.current = requestAnimationFrame(draw);
                };
                const handleVisibility = () => {
                    cancelAnimationFrame(animationRef.current);
                    if (!document.hidden) draw();
                };
                document.addEventListener('visibilitychange', handleVisibility);
                draw();
                return () => {
                    document.removeEventListener('visibilitychange', handleVisibility);
                    cancelAnimationFrame(animationRef.current);
                };
            }, [analyser, lastTriggerTime, isRecording]);

            const randomizeParams = () => {
                const r = (min, max) => Math.random() * (max - min) + min;
                const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

                const next = { ...params };
                const update = (key, val) => { if (!lockedParams[key]) next[key] = val; };

                update('frequency', r(100, 1500));
                update('shape', pick(['sine', 'triangle', 'square', 'sawtooth']));
                update('sweep', r(-0.8, 0.8));
                update('filterFreq', r(200, 4000));
                update('filterQ', r(1, 20));
                update('filterEnv', r(-1000, 1000));
                update('decay', r(0.05, 0.5));

                update('modDepth', Math.random() > 0.6 ? r(100, 1000) : 0);
                update('modSpeed', r(10, 100));

                update('delay', Math.random() > 0.8 ? r(0, 0.3) : 0);
                update('wobble', r(0, 0.2));

                setParams(next);
                triggerSound(null, next);
            };

            const loadPreset = (name) => {
                setActivePreset(name);
                const preset = PRESETS[name];
                const newParams = { ...params };
                const newLocks = {};

                Object.keys(preset.params).forEach(k => {
                    newParams[k] = preset.params[k];
                });

                if (preset.locks) {
                    preset.locks.forEach(key => {
                        newLocks[key] = true;
                    });
                }

                if (preset.params.delay === undefined) newParams.delay = 0;
                if (preset.params.modDepth === undefined) newParams.modDepth = 0;

                setLockedParams(newLocks);
                setParams(newParams);

                triggerSound(null, newParams);
            };

            const toggleRecording = useCallback(async () => {
                const ready = initAudio();
                if (!ready || !recorderRef.current) return;

                if (isRecording) {
                    setIsRecording(false);
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    await recorderRef.current.stop(`KAWAII_REC_${activePreset}_${ready.ctx.sampleRate}hz_24bit_${timestamp}.wav`);
                } else {
                    await recorderRef.current.start();
                    setIsRecording(true);
                }
            }, [activePreset, initAudio, isRecording]);

            useEffect(() => {
                const handleKeyDown = (event) => {
                    if (isTypingTarget(event.target) || event.repeat) return;
                    if (event.code === 'Space') {
                        event.preventDefault();
                        triggerSound();
                    } else if (event.key.toLowerCase() === 'r') {
                        event.preventDefault();
                        toggleRecording();
                    }
                };
                window.addEventListener('keydown', handleKeyDown);
                return () => window.removeEventListener('keydown', handleKeyDown);
            }, [toggleRecording, triggerSound]);

            return (
                <div className="min-h-screen bg-slate-950 text-slate-200 font-sans p-0 sm:p-4 lg:p-8 flex items-stretch lg:items-center justify-center">
                    <div className="w-full max-w-7xl min-h-screen lg:min-h-0 lg:h-[90vh] bg-slate-900 border border-slate-800 rounded-none sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col lg:flex-row">

                        {/* SIDEBAR */}
                        <div className="w-full lg:w-72 bg-slate-950 border-b lg:border-b-0 lg:border-r border-slate-800 p-4 sm:p-5 flex flex-col lg:overflow-hidden shrink-0">
                            <div className="flex items-center justify-between gap-3 mb-3 lg:mb-6 shrink-0">
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className="bg-pink-500/10 p-2 rounded-lg border border-pink-500/20">
                                        <Icons.Sparkles className="w-6 h-6 text-pink-400" />
                                    </div>
                                    <div>
                                        <h1 className="text-xl font-bold tracking-tight text-white">KAWAII <span className="text-pink-400">DSP</span></h1>
                                        <p className="text-[10px] text-slate-500 font-mono tracking-widest">ANIME SFX ENGINE</p>
                                    </div>
                                </div>
                                <a href="index.html" aria-label="Back to AI Synth Lab" className="h-9 px-3 rounded-lg border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-900 flex items-center gap-2 text-[10px] font-bold tracking-widest transition-colors shrink-0">
                                    <Icons.Home className="w-3.5 h-3.5" /> LAB
                                </a>
                            </div>

                            <button onClick={() => setIsPresetMenuOpen(open => !open)} aria-expanded={isPresetMenuOpen} className="lg:hidden h-10 px-3 mb-3 rounded-lg border border-slate-800 text-pink-300 flex items-center justify-between text-xs font-bold tracking-widest">
                                PRESETS <span aria-hidden="true">{isPresetMenuOpen ? '−' : '+'}</span>
                            </button>

                            {/* CREDITS */}
                            <div className="hidden lg:block mb-6 px-1 border-b border-slate-800 pb-4">
                                <div className="text-[10px] font-bold text-slate-500 mb-1 tracking-widest">DEVELOPER</div>
                                <a href="https://linktr.ee/yichengzhu316" target="_blank" rel="noopener noreferrer" className="block text-sm font-bold text-slate-200 hover:text-pink-400 transition-colors mb-1">
                                    Ethan Zhu
                                </a>
                                <div className="text-[10px] text-slate-600 font-mono mb-3">yichengzhu@outlook.com</div>
                            </div>

                            <div className={`${isPresetMenuOpen ? 'block' : 'hidden'} lg:block lg:flex-1 lg:overflow-y-auto space-y-6 lg:pr-2`}>

                                <div className="space-y-2">
                                    <Label text="Physics" icon={Icons.Activity} />
                                    <PresetBtn name="Bubble" active={activePreset === 'BUBBLE'} onClick={() => loadPreset('BUBBLE')} />
                                    <PresetBtn name="Jump" active={activePreset === 'JUMP'} onClick={() => loadPreset('JUMP')} />
                                    <PresetBtn name="Boing" active={activePreset === 'BOING'} onClick={() => loadPreset('BOING')} />
                                </div>

                                <div className="space-y-2">
                                    <Label text="Emotions" icon={Icons.Heart} />
                                    <PresetBtn name="Happy ^_^" active={activePreset === 'HAPPY'} onClick={() => loadPreset('HAPPY')} />
                                    <PresetBtn name="Sad T_T" active={activePreset === 'SAD'} onClick={() => loadPreset('SAD')} />
                                    <PresetBtn name="Anxiety >_<" active={activePreset === 'ANXIETY'} onClick={() => loadPreset('ANXIETY')} />
                                    <PresetBtn name="Angry è_é" active={activePreset === 'ANGRY'} onClick={() => loadPreset('ANGRY')} />
                                </div>

                                <div className="space-y-2">
                                    <Label text="Magic" icon={Icons.Star} />
                                    <PresetBtn name="Sparkle" active={activePreset === 'SPARKLE'} onClick={() => loadPreset('SPARKLE')} />
                                    <PresetBtn name="Transform" active={activePreset === 'TRANSFORM'} onClick={() => loadPreset('TRANSFORM')} />
                                </div>

                                <div className="space-y-2">
                                    <Label text="Interface" icon={Icons.MousePointer2} />
                                    <PresetBtn name="Click" active={activePreset === 'CLICK'} onClick={() => loadPreset('CLICK')} />
                                    <PresetBtn name="Question ?" active={activePreset === 'QUESTION'} onClick={() => loadPreset('QUESTION')} />
                                    <PresetBtn name="Error" active={activePreset === 'ERROR'} onClick={() => loadPreset('ERROR')} />
                                </div>

                            </div>

                            <div className={`${isPresetMenuOpen ? 'grid' : 'hidden'} lg:block grid-cols-1 gap-2 pt-4 mt-4 border-t border-slate-800 shrink-0 lg:space-y-2`}>
                                <button onClick={randomizeParams} className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-pink-300 hover:text-white rounded-xl flex items-center justify-center gap-2 text-xs font-bold transition-all active:scale-95 border border-slate-800 group">
                                    <Icons.Dices className="w-4 h-4 group-hover:rotate-180 transition-transform duration-500" /> RANDOMIZE
                                    <span className="text-[9px] opacity-50 font-normal ml-1">(Respects Locks)</span>
                                </button>
                                <button onClick={toggleRecording} className={`hidden lg:flex w-full py-3 rounded-xl items-center justify-center gap-2 text-xs font-bold transition-all active:scale-95 border ${isRecording ? 'bg-red-900/50 border-red-500 text-red-100 record-pulse' : 'border-slate-800 text-slate-300 hover:bg-slate-900 hover:text-white'}`}>
                                    {isRecording ? <><Icons.Square className="w-4 h-4 fill-current animate-pulse" /> STOP {recordingTime}</> : <><Icons.Mic className="w-4 h-4" /> REC WAV</>}
                                </button>
                            </div>
                        </div>

                        {/* MAIN PANEL */}
                        <main className="flex-1 min-h-0 flex flex-col bg-slate-900 relative lg:overflow-hidden">

                            {/* HEADER */}
                            <div className="min-h-16 bg-slate-950/50 border-b border-slate-800 flex items-center justify-between gap-4 px-4 sm:px-8 py-3 shrink-0 backdrop-blur-sm sticky top-0 z-30 lg:static">
                                {/* Left Side Empty (Was Play/Seq) */}
                                <div className="flex items-center gap-6">
                                    {isRecording && (
                                        <div className="flex items-center gap-2 bg-red-500/10 px-3 py-1.5 rounded-full border border-red-500/50 record-pulse">
                                            <div className="w-2 h-2 bg-red-500 rounded-full"></div>
                                            <span className="text-[10px] font-bold text-red-300 tracking-widest">REC 96K · {recordingTime}</span>
                                        </div>
                                    )}
                                </div>

                                <button onClick={toggleRecording} className={`lg:hidden h-10 px-3 rounded-lg border text-[10px] font-bold tracking-widest ${isRecording ? 'border-red-500 text-red-200' : 'border-slate-700 text-slate-300'}`}>
                                    {isRecording ? `STOP ${recordingTime}` : 'REC WAV'}
                                </button>

                                <div className="flex items-center gap-8">
                                    {/* VOLUME */}
                                    <div className="flex flex-col w-32 group">
                                        <div className="flex justify-between text-[10px] font-bold text-slate-500 mb-1 group-hover:text-slate-300 transition-colors">
                                            <span>MASTER VOL</span>
                                            <span className="text-white">{(volume * 100).toFixed(0)}%</span>
                                        </div>
                                        <input
                                            aria-label="Master volume"
                                            type="range"
                                            min="0"
                                            max="1"
                                            step={0.01}
                                            value={volume}
                                            onChange={e => setVolume(parseFloat(e.target.value))}
                                            style={getSliderStyle(volume, 0, 1, '#ec4899')}
                                            className="kawaii-range w-full cursor-pointer"
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* VISUALIZER */}
                            <div className="h-48 bg-slate-950 relative cursor-pointer group border-b border-slate-800" role="button" tabIndex="0" aria-label="Trigger Kawaii sound" onClick={() => triggerSound()} onKeyDown={(event) => { if (event.key === 'Enter' || event.code === 'Space') { event.preventDefault(); triggerSound(); } }}>
                                <canvas ref={canvasRef} width="1000" height="300" className="w-full h-full object-cover opacity-80" />
                                {!audioCtx && (
                                    <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80 z-10 backdrop-blur-sm">
                                        <div className="bg-pink-500 text-white px-6 py-3 rounded-full font-bold shadow-lg shadow-pink-500/30 animate-pulse flex items-center gap-2">
                                            <Icons.Zap className="w-4 h-4 fill-current" /> CLICK TO START ENGINE
                                        </div>
                                    </div>
                                )}
                                <div className="absolute bottom-3 right-5 text-[10px] text-slate-600 font-mono pointer-events-none tracking-widest">OSCILLOSCOPE</div>
                                {isRecording && <div className="absolute inset-0 border-2 border-red-500/70 pointer-events-none"></div>}
                            </div>

                            {/* CONTROLS */}
                            <div className="flex-1 overflow-y-auto p-5 sm:p-8 bg-slate-900/50">
                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-8">

                                    {/* 1. SOURCE */}
                                    <div className="space-y-5">
                                        <SectionTitle icon={Icons.Activity} title="Waveform" />

                                        <div className="flex justify-between items-center px-1">
                                            <span className="text-[10px] font-bold text-slate-500">SHAPE SELECT</span>
                                            <LockBtn label="waveform" locked={lockedParams.shape} onClick={() => toggleLock('shape')} />
                                        </div>

                                        <div className={`grid grid-cols-4 gap-1 p-1 bg-slate-950 rounded-lg border border-slate-800 transition-opacity ${lockedParams.shape ? 'opacity-60' : 'opacity-100'}`}>
                                            {['sine', 'triangle', 'square', 'sawtooth'].map(s => (
                                                <button key={s} onClick={() => { if (!lockedParams.shape) setParams({ ...params, shape: s }) }}
                                                    className={`h-8 rounded flex items-center justify-center transition-all ${params.shape === s ? 'bg-slate-800 text-pink-400 shadow-sm' : 'text-slate-600 hover:text-slate-400'} ${lockedParams.shape ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                                                    disabled={lockedParams.shape}
                                                    aria-label={`${s} waveform`}
                                                    aria-pressed={params.shape === s}
                                                    title={s}
                                                >
                                                    {s === 'sine' && <div className="w-4 h-4 rounded-full border-2 border-current" />}
                                                    {s === 'triangle' && <div className="w-0 h-0 border-l-[6px] border-r-[6px] border-b-[10px] border-l-transparent border-r-transparent border-b-current" />}
                                                    {s === 'square' && <Icons.Square className="w-3 h-3 fill-current" />}
                                                    {s === 'sawtooth' && <Icons.Activity className="w-4 h-4" />}
                                                </button>
                                            ))}
                                        </div>

                                        <Knob label="Frequency" param="frequency" value={params.frequency} min={50} max={2000} unit="Hz" color="accent-pink-500" onChange={v => setParams({ ...params, frequency: +v })} locked={lockedParams.frequency} onToggleLock={() => toggleLock('frequency')} />
                                        <Knob label="Sweep (Pitch)" param="sweep" value={params.sweep} min={-1} max={1} step={0.1} unit="" color="accent-pink-500" onChange={v => setParams({ ...params, sweep: +v })} locked={lockedParams.sweep} onToggleLock={() => toggleLock('sweep')} />
                                    </div>

                                    {/* 2. FILTER & ENV */}
                                    <div className="space-y-5">
                                        <SectionTitle icon={Icons.Layers} title="Filter & Env" />
                                        <Knob label="Cutoff" param="filterFreq" value={params.filterFreq} min={100} max={5000} unit="Hz" color="accent-cyan-400" onChange={v => setParams({ ...params, filterFreq: +v })} locked={lockedParams.filterFreq} onToggleLock={() => toggleLock('filterFreq')} />
                                        <Knob label="Pop (Resonance)" param="filterQ" value={params.filterQ} min={0} max={20} unit="Q" color="accent-cyan-400" onChange={v => setParams({ ...params, filterQ: +v })} locked={lockedParams.filterQ} onToggleLock={() => toggleLock('filterQ')} />
                                        <Knob label="Filter Env" param="filterEnv" value={params.filterEnv} min={-2000} max={2000} unit="Hz" color="accent-cyan-400" onChange={v => setParams({ ...params, filterEnv: +v })} locked={lockedParams.filterEnv} onToggleLock={() => toggleLock('filterEnv')} />
                                        <Knob label="Decay (Length)" param="decay" value={params.decay} min={0.05} max={2.0} step={0.05} unit="s" color="accent-slate-400" onChange={v => setParams({ ...params, decay: +v })} locked={lockedParams.decay} onToggleLock={() => toggleLock('decay')} />
                                    </div>

                                    {/* 3. MODULATION */}
                                    <div className="space-y-5">
                                        <SectionTitle icon={Icons.Zap} title="FM Texture" />
                                        <Knob label="FM Speed" param="modSpeed" value={params.modSpeed} min={0} max={200} unit="Hz" color="accent-purple-400" onChange={v => setParams({ ...params, modSpeed: +v })} locked={lockedParams.modSpeed} onToggleLock={() => toggleLock('modSpeed')} />
                                        <Knob label="FM Depth" param="modDepth" value={params.modDepth} min={0} max={2000} unit="" color="accent-purple-400" onChange={v => setParams({ ...params, modDepth: +v })} locked={lockedParams.modDepth} onToggleLock={() => toggleLock('modDepth')} />
                                    </div>

                                    {/* 4. FX BUS */}
                                    <div className="space-y-5">
                                        <SectionTitle icon={Icons.Sliders} title="FX Bus" />
                                        <Knob label="Tape Delay" param="delay" value={params.delay} min={0} max={1} step={0.05} unit="%" color="accent-indigo-400" onChange={v => setParams({ ...params, delay: +v })} locked={lockedParams.delay} onToggleLock={() => toggleLock('delay')} />
                                        <Knob label="Delay Wobble" param="wobble" value={params.wobble} min={0} max={0.5} step={0.01} unit="%" color="accent-indigo-400" onChange={v => setParams({ ...params, wobble: +v })} locked={lockedParams.wobble} onToggleLock={() => toggleLock('wobble')} />
                                    </div>

                                </div>
                            </div>
                        </main>
                    </div>
                </div>
            );
        };

        // --- SUB COMPONENTS ---
        const SectionTitle = ({ icon: Icon, title }) => (
            <div className="flex items-center gap-2 text-[10px] font-bold text-slate-500 uppercase tracking-widest pb-2 border-b border-slate-800">
                <Icon className="w-3 h-3 text-slate-400" /> {title}
            </div>
        );

        const PresetBtn = ({ name, active, onClick }) => (
            <button onClick={onClick} aria-pressed={active} className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-between group ${active ? 'bg-pink-500 text-white shadow-md shadow-pink-900/20' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'}`}>
                <span>{name}</span>
                {active && <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
            </button>
        );

        const Label = ({ text, icon: Icon }) => (
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest pl-2 mb-1 flex items-center gap-1.5 opacity-70 mt-4 first:mt-0">
                {Icon && <Icon className="w-3 h-3" />} {text}
            </div>
        );

        const LockBtn = ({ locked, onClick, label = 'parameter' }) => (
            <button onClick={onClick} aria-label={`${locked ? 'Unlock' : 'Lock'} ${label}`} aria-pressed={locked} className={`p-1 rounded hover:bg-slate-800 transition-colors ${locked ? 'text-cyan-400' : 'text-slate-600'}`}>
                {locked ? <Icons.Lock className="w-3 h-3" /> : <Icons.Unlock className="w-3 h-3" />}
            </button>
        );

        const sliderColors = {
            'accent-pink-500': '#ec4899',
            'accent-cyan-400': '#22d3ee',
            'accent-slate-400': '#94a3b8',
            'accent-purple-400': '#c084fc',
            'accent-indigo-400': '#818cf8',
        };

        const getSliderStyle = (value, min, max, accent) => {
            const numericValue = Number(value);
            const progress = ((numericValue - min) / (max - min)) * 100;
            return {
                '--slider-accent': accent,
                '--slider-progress': `${Math.min(100, Math.max(0, progress))}%`,
            };
        };

        const Knob = ({ label, value, min, max, step = 1, unit, color, onChange, locked, onToggleLock }) => (
            <div className="group">
                <div className="flex justify-between items-end mb-1.5">
                    <span className={`text-[11px] font-bold transition-colors ${locked ? 'text-cyan-400' : 'text-slate-400 group-hover:text-slate-300'}`}>{label}</span>
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-slate-500">{value !== undefined && !isNaN(value) ? Math.round(value) : 0}{unit}</span>
                        <LockBtn label={label} locked={locked} onClick={onToggleLock} />
                    </div>
                </div>
                <input
                    type="range" min={min} max={max} step={step}
                    value={value || 0}
                    aria-label={label}
                    onChange={e => onChange(e.target.value)}
                    disabled={locked}
                    style={getSliderStyle(value || 0, min, max, sliderColors[color] || '#ec4899')}
                    className={`kawaii-range w-full cursor-pointer transition-opacity ${locked ? 'cursor-not-allowed' : ''}`}
                />
            </div>
        );

        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(<KawaiiSynth />);
