-- Run through deploy/migrate-multi-user.sql; the caller owns the transaction.

ALTER TABLE instagram_comment_rules
  ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(keywords) <= 20 AND array_position(keywords, NULL) IS NULL),
  ADD COLUMN IF NOT EXISTS match_mode text NOT NULL DEFAULT 'contains' CHECK (match_mode IN ('contains', 'exact', 'all')),
  ADD COLUMN IF NOT EXISTS excluded_keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(excluded_keywords) <= 20 AND array_position(excluded_keywords, NULL) IS NULL);
