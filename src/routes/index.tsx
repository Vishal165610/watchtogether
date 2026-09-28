import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Heart, Film, MessageCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createRoom } from "@/lib/rooms.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Duet — Watch videos together" },
      { name: "description", content: "Create a private room, upload any video (even .mkv) and watch in sync with your partner while you chat." },
      { property: "og:title", content: "Duet — Watch videos together" },
      { property: "og:description", content: "Private watch rooms for two: synced playback, live chat and typing indicators." },
    ],
  }),
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const create = useServerFn(createRoom);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function onCreate() {
    setBusy(true);
    try {
      const r = await create();
      localStorage.setItem(`duet-host-${r.code}`, r.hostSecret);
      navigate({ to: "/room/$code", params: { code: r.code } });
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  function onJoin(e: React.FormEvent) {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(c)) {
      toast.error("Enter the 6-character room code");
      return;
    }
    navigate({ to: "/room/$code", params: { code: c } });
  }

  return (
    <main className="min-h-screen px-5 py-12 flex flex-col items-center justify-center">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-primary/15">
          <Heart className="h-8 w-8 text-primary fill-primary" />
        </div>
        <h1 className="font-display text-5xl font-semibold tracking-tight">Duet</h1>
        <p className="mt-3 text-muted-foreground">
          Your private little cinema for two. Upload a video, press play, and watch it together — from anywhere.
        </p>

        <div className="mt-10 rounded-3xl border bg-card p-6 text-left space-y-5">
          <Button size="lg" className="w-full h-12 text-base" onClick={onCreate} disabled={busy}>
            {busy ? "Creating…" : "Create a room"}
          </Button>
          <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-muted-foreground">
            <span className="h-px flex-1 bg-border" /> or join <span className="h-px flex-1 bg-border" />
          </div>
          <form onSubmit={onJoin} className="flex gap-2">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ROOM CODE"
              maxLength={6}
              className="h-12 text-center font-mono tracking-[0.3em] text-lg"
            />
            <Button type="submit" variant="secondary" className="h-12 px-6">Join</Button>
          </form>
        </div>

        <ul className="mt-10 grid grid-cols-3 gap-3 text-xs text-muted-foreground">
          <li className="flex flex-col items-center gap-2"><Film className="h-5 w-5 text-accent" />MP4 & MKV</li>
          <li className="flex flex-col items-center gap-2"><RefreshCw className="h-5 w-5 text-accent" />Synced playback</li>
          <li className="flex flex-col items-center gap-2"><MessageCircle className="h-5 w-5 text-accent" />Live chat</li>
        </ul>
      </div>
    </main>
  );
}
