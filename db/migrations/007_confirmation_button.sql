ALTER TABLE instagram_comment_rules ADD COLUMN IF NOT EXISTS confirmation_button_title text NOT NULL DEFAULT '' CHECK(length(confirmation_button_title)<=20);
ALTER TABLE instagram_follow_conversations ADD COLUMN IF NOT EXISTS confirmation_button_title text NOT NULL DEFAULT '' CHECK(length(confirmation_button_title)<=20);
