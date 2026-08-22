-- Web sources cited by an assistant message, kept so a reloaded conversation can still
-- render its citations.
--
-- Notes on the design:
--   * `position` is stored, not derived. It is the source's rank in the provider's result set
--     and the order the frontend numbers citations by ([1], [2], [3]). `created_at` cannot
--     stand in for it: a whole batch is inserted in one statement and therefore shares NOW(),
--     so ordering by the timestamp would leave the citations in an arbitrary order. UNIQUE
--     (message_id, position) makes two sources at the same rank impossible.
--   * No `user_id` column. Ownership is reachable as message_sources -> messages ->
--     conversations -> user_id, and duplicating the owner here would create a second copy
--     that could disagree with the first. Every repository query joins up that chain instead.
--   * No index on `message_id` alone. UNIQUE (message_id, position) is backed by a btree on
--     (message_id, position) whose leading column is message_id, so it already serves both
--     "every source for this message" and the ORDER BY position that follows it, and it
--     covers the ON DELETE CASCADE lookup. A second index would be dead weight.
--   * `content` and `favicon` are nullable: not every provider returns a snippet, and not
--     every result has a resolvable icon. `url` and `title` are the minimum a citation needs
--     to be renderable at all, so both are NOT NULL and checked non-blank.
--   * "Not blank" is `~ '\S'` — at least one non-whitespace character — rather than
--     `length(btrim(...)) > 0`. btrim() with no second argument strips spaces only, so the
--     btrim form would accept a url or title consisting of a tab or a newline.
--   * URL validation stops there. Anything stricter in SQL — a regex for scheme and
--     host — would reject valid URLs and still admit unreachable ones; that judgement belongs
--     to the application, which normalises before it writes.
--   * Nothing here restricts sources to assistant messages. The FK cannot express it without
--     a trigger or a denormalised role column, and both cost more than they are worth; the
--     service enforces it when attaching (messageSource.services.ts).
--   * No updated_at. A source is written once with its message and never edited — replacing a
--     message's sources deletes the old rows outright rather than mutating them, so there is
--     no update for a trigger to observe.

CREATE TABLE IF NOT EXISTS message_sources (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    url        TEXT NOT NULL,
    title      TEXT NOT NULL,
    content    TEXT,
    favicon    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT message_sources_position_positive CHECK (position >= 1),
    CONSTRAINT message_sources_url_not_blank CHECK (url ~ '\S'),
    CONSTRAINT message_sources_title_not_blank CHECK (title ~ '\S'),
    CONSTRAINT message_sources_message_position_uniq UNIQUE (message_id, position)
);
