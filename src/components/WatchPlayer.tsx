import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Play, Pause, Maximize, Minimize, MessageCircle, RotateCcw, RotateCw, X } from "lucide-react";

type Props = {
  src: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  onPlay: () => void;
  onPause: () => void;
  onSeeked: () => void;
  onError: () => void;
  onReady?: () => void;
  chat: ReactNode;
  unread: number;
  onChatOpenChange: (open: boolean) => void;
  lastMessage: { name: string; text: string; id: string } | null;
};

function fmt(s: number) {
  if (!isFinite(s)) return "0:00";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
}

export function WatchPlayer({ src, videoRef, onPlay, onPause, onSeeked, onError, onReady, chat, unread, onChatOpenChange, lastMessage }: Props) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [showUi, setShowUi] = useState(true);
  const [fs, setFs] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [ripple, setRipple] = useState<{ side: "l" | "r"; n: number } | null>(null);
  const [peek, setPeek] = useState<{ name: string; text: string } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTap = useRef<{ t: number; side: "l" | "r" | "c" } | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rippleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { onChatOpenChange(chatOpen); }, [chatOpen, onChatOpenChange]);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (tapTimer.current) clearTimeout(tapTimer.current);
    if (rippleTimer.current) clearTimeout(rippleTimer.current);
  }, []);

  useEffect(() => {
    const f = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []);

  // Show incoming message briefly when chat is hidden
  useEffect(() => {
    if (!lastMessage || chatOpen) return;
    setPeek(lastMessage);
    const t = setTimeout(() => setPeek(null), 4000);
    return () => clearTimeout(t);
  }, [lastMessage, chatOpen]);

  function bump() {
    setShowUi(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { if (!videoRef.current?.paused) setShowUi(false); }, 3000);
  }

  function toggle() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
    bump();
  }

  function skip(d: number, side: "l" | "r") {
    const v = videoRef.current;
    if (!v) return;
    const max = isFinite(v.duration) ? v.duration : Infinity;
    v.currentTime = Math.max(0, Math.min(max, v.currentTime + d));
    setRipple((r) => ({ side, n: r && r.side === side ? r.n + 10 : 10 }));
    if (rippleTimer.current) clearTimeout(rippleTimer.current);
    rippleTimer.current = setTimeout(() => setRipple(null), 700);
  }

  function onTap(e: React.PointerEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const side = x < 0.35 ? "l" : x > 0.65 ? "r" : "c";
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && now - prev.t < 300 && side !== "c" && prev.side === side) {
      if (tapTimer.current) clearTimeout(tapTimer.current);
      skip(side === "l" ? -10 : 10, side);
      lastTap.current = { t: now, side };
      return;
    }
    lastTap.current = { t: now, side };
    if (tapTimer.current) clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => {
      if (side === "c" && showUi) toggle();
      else if (showUi) setShowUi(false);
      else bump();
    }, 280);
  }

  async function toggleFs() {
    const el = wrap.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
        const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
        await o.lock?.("landscape").catch(() => {});
      }
    } catch {
      // iOS Safari: fall back to native video fullscreen (chat overlay unavailable there)
      const v = videoRef.current as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
      v?.webkitEnterFullscreen?.();
    }
    bump();
  }

  return (
    <div
      ref={wrap}
      className={`relative w-full overflow-hidden bg-black select-none ${fs ? "h-full" : "aspect-video max-h-[70vh] rounded-2xl lg:max-h-full"}`}
      onPointerMove={(e) => e.pointerType === "mouse" && bump()}
    >
      <video
        ref={videoRef}
        src={src}
        playsInline
        preload="metadata"
        className="absolute inset-0 h-full w-full object-contain"
        onPlay={() => { setPlaying(true); onPlay(); bump(); }}
        onPause={() => { setPlaying(false); setShowUi(true); onPause(); }}
        onSeeked={onSeeked}
        onError={onError}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => { setDur(e.currentTarget.duration); onReady?.(); }}
        onDurationChange={(e) => setDur(e.currentTarget.duration)}
      />

      {/* Gesture layer */}
      <div className="absolute inset-0 touch-manipulation" onPointerUp={onTap} />

      {ripple && (
        <div className={`pointer-events-none absolute inset-y-0 flex w-1/3 items-center justify-center ${ripple.side === "l" ? "left-0 rounded-r-full" : "right-0 rounded-l-full"} bg-foreground/15 animate-fade-in`}>
          <div className="flex flex-col items-center gap-1 text-foreground">
            {ripple.side === "l" ? <RotateCcw className="h-7 w-7" /> : <RotateCw className="h-7 w-7" />}
            <span className="text-sm font-medium">{ripple.n} seconds</span>
          </div>
        </div>
      )}

      {peek && !chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="absolute left-3 top-3 max-w-[70%] animate-fade-in rounded-2xl bg-background/80 px-3 py-2 text-left text-sm text-foreground backdrop-blur"
        >
          <span className="font-medium text-primary">{peek.name}: </span>{peek.text}
        </button>
      )}

      {/* Controls */}
      <div className={`pointer-events-none absolute inset-0 transition-opacity duration-200 ${showUi ? "opacity-100" : "opacity-0"}`}>
        <button
          onClick={toggle}
          className={`absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-background/60 text-foreground backdrop-blur ${showUi ? "pointer-events-auto" : ""}`}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause className="h-7 w-7" /> : <Play className="ml-1 h-7 w-7" />}
        </button>
        <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-background/90 to-transparent px-3 pb-2 pt-8 ${showUi ? "pointer-events-auto" : ""}`}>
          <input
            type="range"
            min={0}
            max={isFinite(dur) ? dur : 0}
            step={0.1}
            value={time}
            onChange={(e) => { const v = videoRef.current; if (v) v.currentTime = Number(e.target.value); bump(); }}
            className="h-1.5 w-full cursor-pointer accent-primary"
            aria-label="Seek"
          />
          <div className="mt-1 flex items-center gap-2 text-foreground">
            <button onClick={toggle} className="p-2" aria-label={playing ? "Pause" : "Play"}>
              {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </button>
            <span className="font-mono text-xs">{fmt(time)} / {fmt(dur)}</span>
            <div className="ml-auto flex items-center">
              {fs && (
                <button onClick={() => setChatOpen((o) => !o)} className="relative p-2" aria-label="Toggle chat">
                  <MessageCircle className="h-5 w-5" />
                  {unread > 0 && !chatOpen && (
                    <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">{unread}</span>
                  )}
                </button>
              )}
              <button onClick={toggleFs} className="p-2" aria-label="Fullscreen">
                {fs ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {fs && chatOpen && (
        <div className="absolute inset-y-0 right-0 flex w-[min(360px,45%)] flex-col bg-background/75 backdrop-blur-md animate-slide-in-right">
          <div className="flex items-center justify-between border-b px-3 py-2 text-sm font-medium">
            Chat
            <button onClick={() => setChatOpen(false)} className="p-1" aria-label="Close chat"><X className="h-4 w-4" /></button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">{chat}</div>
        </div>
      )}
    </div>
  );
}