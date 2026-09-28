CREATE TABLE public.rooms (
  code text PRIMARY KEY,
  host_secret text NOT NULL,
  video_path text,
  video_name text,
  video_type text,
  closed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.rooms TO service_role;
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;