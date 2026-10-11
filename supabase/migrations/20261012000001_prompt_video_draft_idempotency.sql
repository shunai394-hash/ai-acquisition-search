-- A retry with the same client draft key must not create duplicate publish sources.
CREATE UNIQUE INDEX IF NOT EXISTS social_posts_prompt_draft_key_unique
  ON public.social_posts (user_id, (metadata->>'draft_key'))
  WHERE metadata->>'source_type' = 'prompt_video'
    AND metadata ? 'draft_key';
