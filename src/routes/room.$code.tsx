import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Copy, Upload, X, Send, Users, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { closeRoom, getRoom, getUploadTarget, setRoomVideo } from "@/lib/rooms.functions";
import { WatchPlayer } from "@/components/WatchPlayer";

export const Route = createFileRoute("/room/$code")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Watch room — Duet" },
      { name: "description", content: "Join this Duet room to watch a video together in sync and chat live." },
      { property: "og:title", content: "You're invited to a Duet watch room" },
      { property: "og:description", content: "Open the link to watch together and chat in real time." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RoomPage,
});

type Msg = { id: string; from: string; name: string; text: string; at: number };
type Peer = { id: string; name: string; typing: boolean };
type SyncPayload = { action: "play" | "pause" | "seek" | "tick"; time: number; paused: boolean };

function RoomPage() {
  const { code } = Route.useParams();
  const [name, setName] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setName(localStorage.getItem("duet-name"));
  }, []);

  if (!name) {
    return (
      <main className="min-h-screen flex items-center justify-center px-5">
        <form
          className="w-full max-w-sm rounded-3xl border bg-card p-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const n = draft.trim().slice(0, 24);
            if (!n) return;
            localStorage.setItem("duet-name", n);
            setName(n);
          }}
        >
          <h1 className="font-display text-2xl">What should we call you?</h1>
          <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Your name" className="h-12" />
          <Button type="submit" className="w-full h-11">Enter room {code}</Button>
        </form>
      </main>
    );
  }
  return <Room code={code} name={name} />;
}

function isIOS() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Mac") && "ontouchend" in document);
}

function Room({ code, name }: { code: string; name: string }) {
  const navigate = useNavigate();
  const fetchRoom = useServerFn(getRoom);
  const getTarget = useServerFn(getUploadTarget);
  const saveVideo = useServerFn(setRoomVideo);
  const close = useServerFn(closeRoom);

  const [me] = useState(() => crypto.randomUUID());
  const [hostSecret, setHostSecret] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "gone">("loading");
  const [video, setVideo] = useState<{ path: string; url: string; name: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [text, setText] = useState("");

  const channelRef = useRef<RealtimeChannel | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Echo guards: when we apply a remote action, the matching local media event must not be re-broadcast.
  const applying = useRef({ play: 0, pause: 0, seek: 0 });
  const controller = useRef(false); // true if this device last drove playback (sends heartbeats)
  const pendingSync = useRef<SyncPayload | null>(null);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingRef = useRef(false);
  const [fsChatOpen, setFsChatOpen] = useState(false);
  const [seenCount, setSeenCount] = useState(0);
  const onFsChat = useCallback((o: boolean) => setFsChatOpen(o), []);
  const incomingCount = messages.filter((m) => m.from !== me).length;
  useEffect(() => {
    const inFs = typeof document !== "undefined" && !!document.fullscreenElement;
    if (!inFs || fsChatOpen) setSeenCount(incomingCount);
  }, [incomingCount, fsChatOpen]);

  const load = useCallback(async () => {
    try {
      const r = await fetchRoom({ data: { code } });
      if (!r.exists) return setStatus("gone");
      setStatus("ok");
      // Keep the same object (and URL) while the file is unchanged, so the player never remounts needlessly.
      setVideo((prev) => {
        if (!r.videoUrl || !r.videoPath) return null;
        if (prev && prev.path === r.videoPath) return prev;
        return { path: r.videoPath, url: r.videoUrl, name: r.videoName ?? "Video" };
      });
    } catch (e) {
      toast.error((e as Error).message || "Couldn't load the room");
      setStatus((s) => (s === "loading" ? "gone" : s));
    }
  }, [code, fetchRoom]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    setHostSecret(localStorage.getItem(`duet-host-${code}`));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  function applySync(p: SyncPayload) {
    const v = videoRef.current;
    if (!v || v.readyState < 1) {
      pendingSync.current = p; // video not ready yet; apply on loadedmetadata
      return;
    }
    controller.current = false;
    const guard = (k: "play" | "pause" | "seek") => { applying.current[k] = Date.now() + 2500; };
    const threshold = p.action === "tick" ? 1.5 : 0.5;
    if (Math.abs(v.currentTime - p.time) > threshold) {
      guard("seek");
      v.currentTime = p.time;
    }
    if (p.paused && !v.paused) {
      guard("pause");
      v.pause();
    } else if (!p.paused && v.paused) {
      guard("play");
      v.play().catch(() => {
        applying.current.play = 0;
        toast("Tap play to join your partner");
      });
    }
  }
  const applySyncRef = useRef(applySync);
  applySyncRef.current = applySync;

  // Realtime: chat, presence (online + typing), playback sync
  useEffect(() => {
    if (status !== "ok") return;
    const ch = supabase.channel(`duet-${code}`, { config: { presence: { key: me }, broadcast: { self: false } } });
    channelRef.current = ch;
    let wasDown = false;

    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState<{ name: string; typing: boolean }>();
      setPeers(
        Object.entries(state).map(([id, metas]) => ({ id, name: metas[0]?.name ?? "?", typing: !!metas[0]?.typing })),
      );
    })
      .on("presence", { event: "join" }, ({ key, newPresences }) => {
        if (key !== me) toast(`${(newPresences[0] as unknown as { name: string })?.name ?? "Someone"} joined`);
      })
      .on("broadcast", { event: "chat" }, ({ payload }) => {
        const m = payload as Msg;
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m].slice(-300)));
      })
      .on("broadcast", { event: "video" }, () => loadRef.current())
      .on("broadcast", { event: "closed" }, () => setStatus("gone"))
      .on("broadcast", { event: "sync" }, ({ payload }) => applySyncRef.current(payload as SyncPayload))
      .on("broadcast", { event: "sync-request" }, () => {
        const v = videoRef.current;
        if (!v || v.readyState < 1) return;
        ch.send({ type: "broadcast", event: "sync", payload: { action: "tick", time: v.currentTime, paused: v.paused } satisfies SyncPayload });
      })
      .subscribe(async (s) => {
        if (s === "SUBSCRIBED") {
          try { await ch.track({ name, typing: false }); } catch { /* ignore */ }
          ch.send({ type: "broadcast", event: "sync-request", payload: {} });
          if (wasDown) { wasDown = false; loadRef.current(); }
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
          wasDown = true;
        }
      });

    // Re-sync after the tab/app returns from background (mobile browsers drop sockets)
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      ch.track({ name, typing: false }).catch(() => {});
      ch.send({ type: "broadcast", event: "sync-request", payload: {} });
    };
    document.addEventListener("visibilitychange", onVisible);

    // Heartbeat: whoever last drove playback keeps the other side from drifting
    const beat = setInterval(() => {
      const v = videoRef.current;
      if (!controller.current || !v || v.paused || v.readyState < 2) return;
      ch.send({ type: "broadcast", event: "sync", payload: { action: "tick", time: v.currentTime, paused: false } satisfies SyncPayload });
    }, 3000);

    return () => {
      clearInterval(beat);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [status, code, me, name]);

  useEffect(() => {
    document.querySelectorAll("[data-chat-end]").forEach((el) => el.scrollIntoView({ block: "nearest" }));
  }, [messages, peers]);

  useEffect(() => () => {
    if (seekTimer.current) clearTimeout(seekTimer.current);
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }, []);

  function sendSync(action: "play" | "pause" | "seek") {
    const v = videoRef.current;
    if (!v) return;
    channelRef.current?.send({ type: "broadcast", event: "sync", payload: { action, time: v.currentTime, paused: v.paused } satisfies SyncPayload });
  }

  function onLocalEvent(kind: "play" | "pause" | "seek") {
    // Ignore events that were caused by applying a remote action (consume once)
    if (Date.now() < applying.current[kind]) {
      applying.current[kind] = 0;
      return;
    }
    controller.current = true;
    if (kind === "seek") {
      // Dragging the seek bar fires many events; send only the final one
      if (seekTimer.current) clearTimeout(seekTimer.current);
      seekTimer.current = setTimeout(() => sendSync("seek"), 250);
    } else {
      sendSync(kind);
    }
  }

  function onPlayerReady() {
    const p = pendingSync.current;
    pendingSync.current = null;
    if (p) applySync(p);
    else channelRef.current?.send({ type: "broadcast", event: "sync-request", payload: {} });
  }

  function setTyping(t: boolean) {
    if (typingRef.current === t) return;
    typingRef.current = t;
    channelRef.current?.track({ name, typing: t });
  }

  function onType(v: string) {
    setText(v);
    setTyping(v.length > 0);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), 2500);
  }

  function sendMsg(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    const msg: Msg = { id: crypto.randomUUID(), from: me, name, text: t.slice(0, 1000), at: Date.now() };
    setMessages((m) => [...m, msg]);
    channelRef.current?.send({ type: "broadcast", event: "chat", payload: msg });
    setText("");
    setTyping(false);
  }

  async function onFile(file: File) {
    if (!file.type.startsWith("video/") && !/\.(mkv|mp4|webm|mov|m4v)$/i.test(file.name)) {
      toast.error("Please choose a video file");
      return;
    }
    try {
      setProgress(0);
      const { path, token } = await getTarget({ data: { code, fileName: file.name } });
      const url = `${import.meta.env['VITE_SUPABASE_URL']}/storage/v1/object/upload/sign/room-videos/${path}?token=${token}`;
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("apikey", import.meta.env['VITE_SUPABASE_PUBLISHABLE_KEY']);
        xhr.setRequestHeader("content-type", file.type || "video/x-matroska");
        xhr.upload.onprogress = (ev) => ev.lengthComputable && setProgress(Math.round((ev.loaded / ev.total) * 100));
        xhr.onload = () => {
          if (xhr.status < 300) return resolve();
          let detail = "";
          try { detail = JSON.parse(xhr.responseText)?.message ?? ""; } catch { detail = xhr.responseText?.slice(0, 120) ?? ""; }
          if (xhr.status === 413 || /exceeded the maximum allowed size/i.test(detail)) {
            reject(new Error("File is too big for your Supabase storage limit (free plan max is 50 MB)"));
          } else if (/mime type/i.test(detail)) {
            reject(new Error("Bucket blocks this file type — clear 'allowed MIME types' on the room-videos bucket"));
          } else {
            reject(new Error(`Upload failed (${xhr.status}) ${detail}`.trim()));
          }
        };
        xhr.onerror = () => reject(new Error("Upload failed — check your connection"));
        xhr.send(file);
      });
      await saveVideo({ data: { code, path, name: file.name, type: file.type || "video/x-matroska" } });
      channelRef.current?.send({ type: "broadcast", event: "video", payload: {} });
      await load();
      toast.success("Video ready!");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setProgress(null);
    }
  }

  async function onClose() {
    if (!hostSecret || !confirm("Close the room? The video will be deleted for everyone.")) return;
    try {
      channelRef.current?.send({ type: "broadcast", event: "closed", payload: {} });
      await close({ data: { code, hostSecret } });
      localStorage.removeItem(`duet-host-${code}`);
      navigate({ to: "/" });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(window.location.href);
    toast.success("Room link copied");
  }

  if (status === "loading") return <main className="min-h-screen flex items-center justify-center text-muted-foreground">Opening room…</main>;
  if (status === "gone")
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4 px-5 text-center">
        <h1 className="font-display text-3xl">This room has closed</h1>
        <p className="text-muted-foreground">The video was removed. Start a new room anytime.</p>
        <Button asChild><Link to="/">Back home</Link></Button>
      </main>
    );

  const others = peers.filter((p) => p.id !== me);
  const typers = others.filter((p) => p.typing);
  const mkvOnIOS = video && /\.mkv$/i.test(video.name) && isIOS();
  const incoming = messages.filter((m) => m.from !== me);
  const lastIncoming = incoming[incoming.length - 1] ?? null;
  const unread = incoming.length - seenCount;

  const chatPanel = (
    <>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && <p className="text-center text-sm text-muted-foreground">Say hi to your partner</p>}
        {messages.map((m) => {
          const mine = m.from === me;
          return (
            <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
              {!mine && <span className="mb-0.5 text-xs text-muted-foreground">{m.name}</span>}
              <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm break-words ${mine ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-secondary text-secondary-foreground rounded-bl-sm"}`}>
                {m.text}
              </div>
            </div>
          );
        })}
        {typers.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
            </span>
            {typers.map((t) => t.name).join(", ")} is typing…
          </div>
        )}
        <div data-chat-end />
      </div>
      <form onSubmit={sendMsg} className="flex gap-2 border-t p-3">
        <Input value={text} onChange={(e) => onType(e.target.value)} placeholder={others.length ? "Message…" : "Waiting for your partner…"} className="h-11" />
        <Button type="submit" size="icon" className="h-11 w-11 shrink-0" aria-label="Send"><Send className="h-4 w-4" /></Button>
      </form>
    </>
  );

  return (
    <main className="min-h-screen flex flex-col lg:h-screen">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <Link to="/" className="font-display text-xl font-semibold">Duet</Link>
        <button onClick={copyLink} className="flex items-center gap-2 rounded-full bg-secondary px-3 py-1 font-mono text-sm tracking-widest">
          {code} <Copy className="h-3.5 w-3.5" />
        </button>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Users className="h-4 w-4" />
          {peers.map((p) => (
            <span key={p.id} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
              <span className="h-2 w-2 rounded-full bg-accent" />
              {p.id === me ? "You" : p.name}
            </span>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <label>
            <input type="file" accept="video/*,.mkv" className="hidden" disabled={progress !== null}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
            <span className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground">
              <Upload className="h-4 w-4" /> {video ? "Change video" : "Upload"}
            </span>
          </label>
          {hostSecret && (
            <Button variant="destructive" size="sm" onClick={onClose}><X className="h-4 w-4" /> Close room</Button>
          )}
        </div>
      </header>

      <div className="flex flex-1 flex-col lg:flex-row lg:min-h-0">
        <section className="flex flex-1 flex-col items-center justify-center bg-background p-3 lg:p-6">
          {progress !== null && (
            <div className="mb-4 w-full max-w-xl">
              <div className="mb-1 text-sm text-muted-foreground">Uploading… {progress}%</div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
          {mkvOnIOS && (
            <div className="mb-3 flex max-w-xl items-start gap-2 rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              iPhones and iPads can't play .mkv files. Please watch on Android or a computer, or upload an .mp4.
            </div>
          )}
          {video ? (
            <WatchPlayer
              key={video.path}
              src={video.url}
              videoRef={videoRef}
              onPlay={() => onLocalEvent("play")}
              onPause={() => onLocalEvent("pause")}
              onSeeked={() => onLocalEvent("seek")}
              onReady={onPlayerReady}
              onError={() => toast.error("This device can't play this video format")}
              chat={chatPanel}
              unread={unread}
              onChatOpenChange={onFsChat}
              lastMessage={lastIncoming}
            />
          ) : (
            <div className="flex aspect-video w-full max-w-3xl flex-col items-center justify-center gap-3 rounded-2xl border border-dashed text-center text-muted-foreground">
              <Upload className="h-8 w-8" />
              <p>No video yet — anyone in the room can upload one.</p>
              <p className="text-xs">MP4, WebM, MOV or MKV</p>
            </div>
          )}
          {video && <p className="mt-2 text-xs text-muted-foreground">{video.name} · double-tap sides to skip 10s · chat works in fullscreen</p>}
        </section>

        <aside className="flex h-[60vh] flex-col border-t lg:h-auto lg:w-96 lg:border-l lg:border-t-0">
          {chatPanel}
        </aside>
      </div>
    </main>
  );
}