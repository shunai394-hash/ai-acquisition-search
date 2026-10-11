-- Standalone video projects may be published to social platforms without
-- requiring a commerce product or acquisition creative.
ALTER TABLE public.social_posts
  ALTER COLUMN creative_id DROP NOT NULL;

COMMENT ON COLUMN public.social_posts.creative_id IS
  'Optional link to a marketing creative; NULL for prompt-first standalone video projects.';
