-- 0009: User profile pictures.
--
-- Only the storage key is persisted. The bytes live under STORAGE_DIR/avatars/
-- and are served exclusively through the authenticated avatar route; neither
-- the key nor a storage path is ever exposed by the API.
--
-- avatar_key and avatar_updated_at are paired: a cached avatarUrl is built
-- from the timestamp, so one cannot exist without the other.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_key text,
  ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;

ALTER TABLE users
  ADD CONSTRAINT users_avatar_pair_check
  CHECK ((avatar_key IS NULL) = (avatar_updated_at IS NULL));
