-- Apply through deploy/migrate-multi-user.sql before deploying the code that stores attachment, unsupported and
-- deleted DMs (#20). Existing rows stay valid: they are text or postback rows with no attachments and no deletion.
-- The running code writes only text and postback rows with neither column, so it keeps working between this
-- migration and the deploy.
-- attachments holds the kind and optional title of each received attachment, never a media URL or media ID.
ALTER TABLE instagram_inbox_messages ADD COLUMN IF NOT EXISTS attachments jsonb;
-- deleted_at records when the sender withdrew the message; the stored text is cleared at the same time.
ALTER TABLE instagram_inbox_messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
DO $$ BEGIN
  -- Migration 012's unnamed kind CHECK allowed text and postback only.
  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint WHERE conrelid='instagram_inbox_messages'::regclass AND conname='instagram_inbox_messages_kind_check'
      AND pg_get_constraintdef(oid) LIKE '%unsupported%'
  ) THEN
    ALTER TABLE instagram_inbox_messages DROP CONSTRAINT IF EXISTS instagram_inbox_messages_kind_check;
    ALTER TABLE instagram_inbox_messages ADD CONSTRAINT instagram_inbox_messages_kind_check
      CHECK(kind IN ('text','postback','attachment','unsupported','deleted'));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_inbox_messages'::regclass AND conname='instagram_inbox_messages_content') THEN
    ALTER TABLE instagram_inbox_messages ADD CONSTRAINT instagram_inbox_messages_content CHECK(
      (attachments IS NULL OR (jsonb_typeof(attachments)='array' AND jsonb_array_length(attachments) BETWEEN 1 AND 10))
      AND (kind<>'attachment' OR attachments IS NOT NULL OR deleted_at IS NOT NULL)
      AND (kind NOT IN ('attachment','unsupported','deleted') OR text='')
      AND (kind<>'deleted' OR deleted_at IS NOT NULL)
      AND (kind<>'postback' OR attachments IS NULL)
      AND (deleted_at IS NULL OR (text='' AND attachments IS NULL))
    );
  END IF;
END $$;
