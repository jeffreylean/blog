CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  note TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  is_approved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookmark_tags (
  bookmark_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (bookmark_id, tag_id),
  FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id),
  FOREIGN KEY (tag_id) REFERENCES tags(id)
);

-- Seed 14 approved tags
INSERT OR IGNORE INTO tags (name, is_approved) VALUES
  ('rust', 1),
  ('go', 1),
  ('networking', 1),
  ('systems', 1),
  ('databases', 1),
  ('distributed-systems', 1),
  ('security', 1),
  ('performance', 1),
  ('linux', 1),
  ('kubernetes', 1),
  ('web', 1),
  ('cloud', 1),
  ('architecture', 1),
  ('career', 1);
