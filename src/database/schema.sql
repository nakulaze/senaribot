CREATE TABLE IF NOT EXISTS auth_keys (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('pre-key', 'session', 'app-state-sync-key', 'app-state-sync-value', 'sender-key')),
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_auth_keys_type ON auth_keys(type);

CREATE TABLE IF NOT EXISTS auth_credentials (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER))
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  amount REAL NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  currency TEXT DEFAULT 'IDR',
  entry_date INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_date ON ledger_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_category ON ledger_entries(category);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  user_jid TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  trigger_time INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'snoozed', 'completed', 'cancelled')),
  snooze_count INTEGER DEFAULT 0,
  recurrence TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_reminders_user_jid ON reminders(user_jid);
CREATE INDEX IF NOT EXISTS idx_reminders_state ON reminders(state);
CREATE INDEX IF NOT EXISTS idx_reminders_trigger_time ON reminders(trigger_time);

CREATE TABLE IF NOT EXISTS vault_notes (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  tags TEXT,
  user_jid TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER))
);

CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(
  content,
  tags,
  user_jid,
  content=vault_notes,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS vault_fts_ai AFTER INSERT ON vault_notes BEGIN
  INSERT INTO vault_fts(rowid, content, tags, user_jid) VALUES (new.rowid, new.content, new.tags, new.user_jid);
END;

CREATE TRIGGER IF NOT EXISTS vault_fts_ad AFTER DELETE ON vault_notes BEGIN
  INSERT INTO vault_fts(vault_fts, rowid, content, tags, user_jid) VALUES ('delete', old.rowid, old.content, old.tags, old.user_jid);
END;

CREATE TRIGGER IF NOT EXISTS vault_fts_au AFTER UPDATE ON vault_notes BEGIN
  INSERT INTO vault_fts(vault_fts, rowid, content, tags, user_jid) VALUES ('delete', old.rowid, old.content, old.tags, old.user_jid);
  INSERT INTO vault_fts(rowid, content, tags, user_jid) VALUES (new.rowid, new.content, new.tags, new.user_jid);
END;

CREATE TABLE IF NOT EXISTS vault_media (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'audio', 'video', 'document')),
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER)),
  FOREIGN KEY (note_id) REFERENCES vault_notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vault_media_note_id ON vault_media(note_id);

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_jid TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_user_jid ON ai_messages(user_jid, id);

CREATE TABLE IF NOT EXISTS todo_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_jid TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  deadline INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  reminder_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER)),
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_todo_tasks_user_status ON todo_tasks(user_jid, status);
CREATE INDEX IF NOT EXISTS idx_todo_tasks_deadline ON todo_tasks(deadline);


CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_jid TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly')),
  reminder_time TEXT,
  last_reminded_period TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER)),
  UNIQUE (user_jid, name_key)
);

CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_jid);
CREATE INDEX IF NOT EXISTS idx_habits_reminder ON habits(reminder_time);

CREATE TABLE IF NOT EXISTS habit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  logged_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER)),
  UNIQUE (habit_id, period_key)
);

CREATE INDEX IF NOT EXISTS idx_habit_logs_habit ON habit_logs(habit_id, period_key);

CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_jid TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  reminder_minutes INTEGER,
  reminder_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_user ON calendar_events(user_jid);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start_time ON calendar_events(start_time);
CREATE INDEX IF NOT EXISTS idx_calendar_events_user_start ON calendar_events(user_jid, start_time);
