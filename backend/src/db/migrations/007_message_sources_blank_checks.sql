-- Tightens the blank checks on message_sources.
--
-- 006 originally shipped `length(btrim(url)) > 0`. btrim() with no second argument strips
-- spaces only, so a url or title consisting of a tab or a newline satisfied a constraint
-- named "not_blank" — the DB check was weaker than its name, and weaker than the JS .trim()
-- the service applies. `~ '\S'` requires at least one non-whitespace character and covers
-- every whitespace class.
--
-- 006 now creates these constraints in the tightened form, so on a fresh database this
-- migration drops and re-adds an identical constraint: a deliberate no-op. It exists for
-- databases that already applied the original 006.
--
-- Safe on populated tables: ADD CONSTRAINT validates existing rows, and any row that passes
-- the old check and fails the new one was whitespace-only and should never have been stored.

ALTER TABLE message_sources DROP CONSTRAINT IF EXISTS message_sources_url_not_blank;
ALTER TABLE message_sources DROP CONSTRAINT IF EXISTS message_sources_title_not_blank;

ALTER TABLE message_sources
    ADD CONSTRAINT message_sources_url_not_blank CHECK (url ~ '\S');

ALTER TABLE message_sources
    ADD CONSTRAINT message_sources_title_not_blank CHECK (title ~ '\S');
