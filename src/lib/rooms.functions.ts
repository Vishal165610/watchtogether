import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const BUCKET = "room-videos";
const codeSchema = z.string().regex(/^[A-Z0-9]{6}$/);

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const arr = new Uint32Array(6);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join("");
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function openRoom(code: string) {
  const db = await admin();
  const { data } = await db.from("rooms").select("*").eq("code", code).maybeSingle();
  if (!data || data.closed) throw new Error("This room is closed or doesn't exist.");
  return { db, room: data };
}

export const createRoom = createServerFn({ method: "POST" }).handler(async () => {
  const db = await admin();
  const secret = crypto.randomUUID();
  for (let i = 0; i < 5; i++) {
    const code = randomCode();
    const { error } = await db.from("rooms").insert({ code, host_secret: secret });
    if (!error) return { code, hostSecret: secret };
  }
  throw new Error("Couldn't create a room, please try again.");
});

export const getRoom = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ code: codeSchema }).parse(d))
  .handler(async ({ data }) => {
    const db = await admin();
    const { data: room } = await db.from("rooms").select("*").eq("code", data.code).maybeSingle();
    if (!room || room.closed) return { exists: false as const };
    let videoUrl: string | null = null;
    if (room.video_path) {
      const { data: signed } = await db.storage
        .from(BUCKET)
        .createSignedUrl(room.video_path, 60 * 60 * 12);
      videoUrl = signed?.signedUrl ?? null;
    }
    return {
      exists: true as const,
      videoUrl,
      videoName: room.video_name,
      videoType: room.video_type,
    };
  });

export const getUploadTarget = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ code: codeSchema, fileName: z.string().min(1).max(300) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await openRoom(data.code);
    const ext = (data.fileName.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "");
    const path = `${data.code}/${crypto.randomUUID()}.${ext}`;
    const { data: signed, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !signed) throw new Error("Couldn't prepare the upload.");
    return { path, token: signed.token };
  });

export const setRoomVideo = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        code: codeSchema,
        path: z.string().max(200),
        name: z.string().max(300),
        type: z.string().max(100),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { db, room } = await openRoom(data.code);
    if (!data.path.startsWith(`${data.code}/`)) throw new Error("Invalid file.");
    if (room.video_path && room.video_path !== data.path) {
      await db.storage.from(BUCKET).remove([room.video_path]);
    }
    await db
      .from("rooms")
      .update({ video_path: data.path, video_name: data.name, video_type: data.type })
      .eq("code", data.code);
    return { ok: true };
  });

export const closeRoom = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ code: codeSchema, hostSecret: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const db = await admin();
    const { data: room } = await db.from("rooms").select("*").eq("code", data.code).maybeSingle();
    if (!room || room.host_secret !== data.hostSecret) throw new Error("Only the host can close this room.");
    const { data: files } = await db.storage.from(BUCKET).list(data.code);
    if (files?.length) {
      await db.storage.from(BUCKET).remove(files.map((f) => `${data.code}/${f.name}`));
    }
    await db.from("rooms").delete().eq("code", data.code);
    return { ok: true };
  });
