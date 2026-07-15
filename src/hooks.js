import { useEffect, useState } from "react";
import { formatDuration } from "./recording.js";

export const usePersistentState = (key, initialValue) => {
  const [value, setValue] = useState(() => {
    const fallback = typeof initialValue === "function" ? initialValue() : initialValue;
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback : JSON.parse(stored);
    } catch (error) {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // Storage can be disabled in private browsing; controls still work in memory.
    }
  }, [key, value]);

  return [value, setValue];
};

export const useRecordingClock = (isRecording, recorderRef) => {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!isRecording) {
      setSeconds(0);
      return undefined;
    }

    const update = () => setSeconds(recorderRef.current?.duration || 0);
    update();
    const timer = setInterval(update, 200);
    return () => clearInterval(timer);
  }, [isRecording, recorderRef]);

  return formatDuration(seconds);
};

export const isTypingTarget = (target) => {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    target.matches("input, select, textarea, button, a")
  );
};
