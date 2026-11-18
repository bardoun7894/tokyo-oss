import Database from "better-sqlite3";
import path from "path";
import { localToday, sqliteTzModifier } from "./utils";
import { decideArea, isArea, type Area } from "./area";
import { ensureLaptopQueue, laptopTaskOpenForRun as laptopOpen } from "./laptop-open";

// TOKYO_DB_PATH lets a test run against a scratch file instead of the live
// life.db. Unset in production, where the path next to the source is right.
const DB_PATH = process.env.TOKYO_DB_PATH || path.join(__dirname, "..", "life.db");

const db: import("better-sqlite3").Database = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

/** SQLite date() with timezone offset — converts UTC stored time to local date */
function ld(column: string): string {
  return `date(${column}, '${sqliteTzModifier()}')`;
}

// --- Schema Init ---

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'client',
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
      due_date TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'cancelled')),
      parent_id INTEGER REFERENCES tasks(id),
      client_id INTEGER,
      project_id INTEGER,
      estimated_hours REAL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      frequency TEXT DEFAULT 'daily' CHECK(frequency IN ('daily', 'weekly')),
      category TEXT DEFAULT 'personal',
      schedule_days TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS habit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER NOT NULL,
      logged_date TEXT NOT NULL,
      done INTEGER DEFAULT 1,
      FOREIGN KEY (habit_id) REFERENCES habits(id),
      UNIQUE(habit_id, logged_date)
    );

    CREATE TABLE IF NOT EXISTS work_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('work_start', 'work_end', 'break_start', 'break_end', 'personal')),
      note TEXT,
      project_id INTEGER,
      work_type TEXT DEFAULT 'dev',
      logged_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      day_of_week TEXT,
      time TEXT,
      recurring INTEGER DEFAULT 0,
      date TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry TEXT NOT NULL,
      mood TEXT,
      energy_level INTEGER,
      category TEXT DEFAULT 'general',
      logged_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      platform TEXT CHECK(platform IN ('mostaql', 'upwork', 'direct', 'other')),
      contact_info TEXT,
      notes TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id),
      name TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'client' CHECK(category IN ('client', 'product', 'shop', 'internal')),
      status TEXT DEFAULT 'active' CHECK(status IN ('proposal', 'active', 'paused', 'completed', 'cancelled')),
      budget REAL,
      currency TEXT DEFAULT 'DH',
      deadline TEXT,
      estimated_hours REAL,
      actual_hours REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS income (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'DH',
      source TEXT CHECK(source IN ('mostaql', 'upwork', 'direct', 'shop', 'saas', 'other')),
      project_id INTEGER REFERENCES projects(id),
      description TEXT,
      date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shop_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      total_revenue REAL NOT NULL,
      items_sold INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );


    CREATE TABLE IF NOT EXISTS shop_sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      sender TEXT,
      sender_name TEXT,
      amount_dh REAL NOT NULL,
      source TEXT CHECK(source IN ('text','voice')) DEFAULT 'text',
      raw_content TEXT,
      logged_date TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_shop_items_date ON shop_sale_items(logged_date);

    CREATE TABLE IF NOT EXISTS quran_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      juz INTEGER,
      surah TEXT,
      pages_read REAL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS adhkar_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('morning', 'evening', 'post_prayer', 'general')),
      logged_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS neighborhood_shops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_name TEXT,
      phone TEXT,
      category TEXT,
      interest_level TEXT DEFAULT 'cold' CHECK(interest_level IN ('cold', 'warm', 'hot', 'onboarded')),
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS weekly_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      report_text TEXT NOT NULL,
      productivity_score INTEGER,
      deen_score INTEGER,
      balance_score INTEGER,
      total_income REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS coaching_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario TEXT NOT NULL,
      message_summary TEXT,
      sent_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      metric TEXT NOT NULL,
      target_value REAL NOT NULL,
      current_value REAL DEFAULT 0,
      period TEXT DEFAULT 'monthly',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'claude',
      embedding TEXT,
      domain TEXT DEFAULT 'general',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      project_path TEXT NOT NULL,
      status TEXT DEFAULT 'running',
      turns INTEGER DEFAULT 0,
      last_prompt TEXT,
      last_result TEXT,
      pid INTEGER,
      started_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      message_type TEXT DEFAULT 'text',
      from_me INTEGER DEFAULT 0,
      is_group INTEGER DEFAULT 0,
      replied INTEGER DEFAULT 0,
      reply_content TEXT,
      timestamp INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_wa_jid ON whatsapp_messages(jid);
    CREATE INDEX IF NOT EXISTS idx_wa_timestamp ON whatsapp_messages(timestamp);

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_promises_status ON promises(status);
    CREATE INDEX IF NOT EXISTS idx_promises_due_date ON promises(due_date);
    CREATE INDEX IF NOT EXISTS idx_work_logs_logged_at ON work_logs(logged_at);
    CREATE INDEX IF NOT EXISTS idx_activity_events_logged_at ON activity_events(logged_at);
    CREATE INDEX IF NOT EXISTS idx_income_date ON income(date);
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);

    CREATE TABLE IF NOT EXISTS whatsapp_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT,
      rule_type TEXT NOT NULL,
      condition TEXT,
      response TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'MAD',
      category TEXT DEFAULT 'other' CHECK(category IN ('rent', 'food', 'internet', 'transport', 'shop_supplies', 'server', 'tools', 'health', 'family', 'other')),
      description TEXT,
      date TEXT NOT NULL,
      recurring INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS learning_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'other' CHECK(type IN ('course', 'book', 'video', 'article', 'tutorial', 'practice', 'other')),
      topic TEXT,
      source TEXT,
      notes TEXT,
      minutes_spent INTEGER,
      date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS whatsapp_contacts (
      jid TEXT PRIMARY KEY,
      category TEXT DEFAULT 'other' CHECK(category IN ('client', 'shop', 'family', 'personal', 'other')),
      display_name TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      confidence TEXT DEFAULT 'high' CHECK(confidence IN ('high', 'medium', 'low')),
      title TEXT,
      project TEXT,
      category TEXT DEFAULT 'dev',
      duration_minutes INTEGER,
      metadata TEXT,
      related_id INTEGER,
      logged_at TEXT DEFAULT (datetime('now')),
      confirmed INTEGER DEFAULT 0,
      confirmed_at TEXT,
      work_log_id INTEGER REFERENCES work_logs(id)
    );

    CREATE TABLE IF NOT EXISTS promises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      made_to TEXT,
      project_id INTEGER REFERENCES projects(id),
      task_id INTEGER REFERENCES tasks(id),
      due_date TEXT,
      due_context TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'due_soon', 'overdue', 'fulfilled', 'broken')),
      source_type TEXT DEFAULT 'manual' CHECK(source_type IN ('chat', 'whatsapp', 'manual', 'ai_detected')),
      source_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      fulfilled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT NOT NULL,
      source TEXT DEFAULT 'auto' CHECK(source IN ('auto', 'manual', 'ai_inferred')),
      note TEXT,
      set_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS wa_reply_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      contact_name TEXT,
      contact_category TEXT,
      their_message TEXT NOT NULL,
      my_reply TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS message_sentiment (
      message_id INTEGER PRIMARY KEY,
      sentiment TEXT NOT NULL CHECK(sentiment IN ('positive','negative','neutral')),
      confidence REAL NOT NULL,
      classified_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (message_id) REFERENCES whatsapp_messages(id)
    );

    CREATE TABLE IF NOT EXISTS chat_analytics_cache (
      cache_key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      computed_at TEXT DEFAULT (datetime('now'))
    );

  `);

  // Migrations — add columns safely
  const cols = db.prepare("PRAGMA table_info(whatsapp_messages)").all() as any[];
  const colNames = new Set(cols.map((c: any) => c.name));
  if (!colNames.has("media_path")) {
    db.exec("ALTER TABLE whatsapp_messages ADD COLUMN media_path TEXT");
  }
  if (!colNames.has("transcription")) {
    db.exec("ALTER TABLE whatsapp_messages ADD COLUMN transcription TEXT");
  }
  // Voice-coach columns (006-voice-coach)
  if (!colNames.has("duration_seconds")) {
    db.exec("ALTER TABLE whatsapp_messages ADD COLUMN duration_seconds REAL");
  }
  if (!colNames.has("wpm")) {
    db.exec("ALTER TABLE whatsapp_messages ADD COLUMN wpm REAL");
  }
  if (!colNames.has("coherence")) {
    db.exec("ALTER TABLE whatsapp_messages ADD COLUMN coherence TEXT");
  }
  if (!colNames.has("coach_reason")) {
    db.exec("ALTER TABLE whatsapp_messages ADD COLUMN coach_reason TEXT");
  }
  if (!colNames.has("coach_analyzed_at")) {
    db.exec("ALTER TABLE whatsapp_messages ADD COLUMN coach_analyzed_at INTEGER");
  }
  // History backfill needs an identity to dedupe on: the same WA message arrives
  // once live and again in messaging-history.set after a re-pair. Rows written
  // before this column exists keep NULL, and SQLite treats NULLs as distinct,
  // so the unique index never fires on them.
  if (!colNames.has("wa_msg_id")) {
    db.exec("ALTER TABLE whatsapp_messages ADD COLUMN wa_msg_id TEXT");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_msgid ON whatsapp_messages(jid, wa_msg_id)");
  // Ground truth for which photo a supplier price reply belongs to: the
  // WhatsApp quoted/reply message id (`contextInfo.stanzaId`), captured at
  // ingest (see extractQuotedMsgId in src/whatsapp.ts). Joins back to an
  // image's own wa_msg_id in src/products/pairing.ts — replacing the old
  // (wrong) positional pairing. Rows written before this column exists keep
  // NULL, same idempotent-migration shape as wa_msg_id above.
  if (!colNames.has("quoted_msg_id")) {
    db.exec("ALTER TABLE whatsapp_messages ADD COLUMN quoted_msg_id TEXT");
  }
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as any[];
  const taskColNames = new Set(taskCols.map((c: any) => c.name));
  if (!taskColNames.has("source_type")) {
    db.exec("ALTER TABLE tasks ADD COLUMN source_type TEXT DEFAULT 'manual'");
  }
  if (!taskColNames.has("source_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN source_id INTEGER");
  }
  // area: work / personal / learn, decided by Jev when the row is created (src/area.ts)
  if (!taskColNames.has("area")) {
    db.exec("ALTER TABLE tasks ADD COLUMN area TEXT");
  }
  // settings: dashboard-editable values (src/settings.ts). scope = 'owner' here, one per user in Tokyo Life.
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      scope TEXT NOT NULL DEFAULT 'owner',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (scope, key)
    );
  `);
  // auto_transcribe: NULL = follow the default (work contacts only), 'on' / 'off' = override
  const waContactCols = new Set((db.prepare("PRAGMA table_info(whatsapp_contacts)").all() as any[]).map((c: any) => c.name));
  if (!waContactCols.has("auto_transcribe")) {
    db.exec("ALTER TABLE whatsapp_contacts ADD COLUMN auto_transcribe TEXT");
  }
  const journalCols = new Set((db.prepare("PRAGMA table_info(journal)").all() as any[]).map((c: any) => c.name));
  if (!journalCols.has("area")) {
    db.exec("ALTER TABLE journal ADD COLUMN area TEXT");
  }

  // laptop_queue — offline Claude-run fallback queue (schema and additive migrations in laptop-open.ts)
  ensureLaptopQueue(db);

  // laptop_pending — persisted confirmation map (survives PM2 restarts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS laptop_pending (
      id TEXT PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      cmd TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_laptop_pending_created ON laptop_pending(created_at);
  `);

    // sdk_replies — log of every SDK-quick layer reply (auto-sent to WA + mirrored to Telegram)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sdk_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_jid TEXT NOT NULL,
      sender_name TEXT,
      content_preview TEXT NOT NULL,
      layer TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      reply TEXT NOT NULL,
      undo INTEGER DEFAULT 0,
      corrected INTEGER DEFAULT 0,
      fallback_reason TEXT,
      latency_ms INTEGER,
      created_at INTEGER NOT NULL
    );
  `);

  // products-catalog: supplier product catalog synced from WhatsApp image bursts.
  if (!waContactCols.has("supplier")) {
    db.exec("ALTER TABLE whatsapp_contacts ADD COLUMN supplier INTEGER DEFAULT 0");
  }
  db.exec(`
    INSERT INTO whatsapp_contacts (jid, supplier, created_at)
    VALUES ('182012157624438@lid', 1, datetime('now'))
    ON CONFLICT(jid) DO UPDATE SET supplier = 1
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id       INTEGER NOT NULL UNIQUE,
      jid              TEXT NOT NULL,
      media_file       TEXT NOT NULL,
      title            TEXT,
      brand            TEXT,
      price            REAL,
      currency         TEXT NOT NULL DEFAULT 'DH',
      price_source     TEXT NOT NULL DEFAULT 'none',
      confidence       TEXT NOT NULL DEFAULT 'low',
      batch_id         TEXT,
      price_message_id INTEGER,
      status           TEXT NOT NULL DEFAULT 'new',
      notes            TEXT,
      timestamp        INTEGER NOT NULL,
      created_at       TEXT DEFAULT (datetime('now')),
      updated_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_products_price  ON products(price);
    CREATE INDEX IF NOT EXISTS idx_products_ts     ON products(timestamp);
    CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
    CREATE INDEX IF NOT EXISTS idx_products_batch  ON products(batch_id);
  `);

  // supplier price-entry page: token+PIN sessions scoped to one jid, so a
  // supplier can only ever read/write their own products. See
  // specs/products-catalog/SUPPLIER-CONTRACT.md and src/supplier/*.
  db.exec(`
    CREATE TABLE IF NOT EXISTS supplier_sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash   TEXT NOT NULL UNIQUE,
      jid          TEXT NOT NULL,
      pin_hash     TEXT NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      locked       INTEGER NOT NULL DEFAULT 0,
      expires_at   INTEGER NOT NULL,
      created_at   TEXT DEFAULT (datetime('now')),
      last_used_at TEXT,
      session_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_sessions_token ON supplier_sessions(token_hash);
  `);

  // SECURITY fix (auth-bypass, 2026-09-20): session_hash was added AFTER this
  // table was already live in production (9,537-row products DB, deployed).
  // CREATE TABLE IF NOT EXISTS above is a no-op against the existing table,
  // so the column needs its own additive, idempotent ALTER — same
  // has(...)-guarded pattern as the whatsapp_contacts.supplier column above.
  // A NULL session_hash means the token was never exchanged for a
  // PIN-verified session and must never resolve — see
  // src/supplier/sessions.ts resolveSession() / verifySession().
  const supplierSessionCols = new Set(
    (db.prepare("PRAGMA table_info(supplier_sessions)").all() as any[]).map((c: any) => c.name)
  );
  if (!supplierSessionCols.has("session_hash")) {
    db.exec("ALTER TABLE supplier_sessions ADD COLUMN session_hash TEXT");
  }
  // UNIQUE: SQLite indexes ignore NULLs for uniqueness (each NULL is
  // distinct), so the many not-yet-authenticated rows are unaffected — only
  // an actual session_hash collision would ever be rejected.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_sessions_session_hash ON supplier_sessions(session_hash)");
}

// ========================
// AGENT SESSIONS
// ========================

export function createAgentSession(project: string, projectPath: string, prompt: string): number {
  const result = db.prepare("INSERT INTO agent_sessions (project, project_path, last_prompt, turns) VALUES (?, ?, ?, 1)").run(project, projectPath, prompt);
  return result.lastInsertRowid as number;
}

export function updateAgentSession(id: number, fields: { status?: string; last_result?: string; pid?: number; turns?: number }) {
  const updates: string[] = ["updated_at = datetime('now')"];
  const values: any[] = [];
  if (fields.status) { updates.push("status = ?"); values.push(fields.status); }
  if (fields.last_result !== undefined) { updates.push("last_result = ?"); values.push(fields.last_result); }
  if (fields.pid !== undefined) { updates.push("pid = ?"); values.push(fields.pid); }
  if (fields.turns !== undefined) { updates.push("turns = ?"); values.push(fields.turns); }
  values.push(id);
  db.prepare(`UPDATE agent_sessions SET ${updates.join(", ")} WHERE id = ?`).run(...values);
}

export function getAgentSession(id: number) {
  return db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as any;
}

export function getActiveAgentForProject(project: string) {
  return db.prepare("SELECT * FROM agent_sessions WHERE project = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(project) as any;
}

export function getRecentAgentSessions(limit = 10) {
  return db.prepare("SELECT * FROM agent_sessions ORDER BY updated_at DESC LIMIT ?").all(limit) as any[];
}

// ========================
// COACHING LOG
// ========================

export function logCoachingMessage(scenario: string, summary: string) {
  return db.prepare("INSERT INTO coaching_log (scenario, message_summary) VALUES (?, ?)").run(scenario, summary);
}

export function getLastCoachingMessage(scenario: string) {
  return db.prepare("SELECT * FROM coaching_log WHERE scenario = ? ORDER BY sent_at DESC LIMIT 1").get(scenario) as { scenario: string; sent_at: string; message_summary: string } | undefined;
}

export function getCoachingCountToday(): number {
  const today = localToday();
  const row = db.prepare(`SELECT COUNT(*) as count FROM coaching_log WHERE ${ld('sent_at')} = ? AND scenario NOT IN ('prayer_wrapup', 'overwork')`).get(today) as { count: number };
  return row.count;
}

export function getActiveWorkSession() {
  return db.prepare(`
    SELECT *, (julianday('now') - julianday(logged_at)) * 24 * 60 as minutes_active
    FROM work_logs
    WHERE type = 'work_start'
    AND id > COALESCE((SELECT MAX(id) FROM work_logs WHERE type = 'work_end'), 0)
    ORDER BY logged_at DESC LIMIT 1
  `).get() as { id: number; type: string; note: string; work_type: string; project_id: number | null; logged_at: string; minutes_active: number } | undefined;
}

// ========================
// TASKS
// ========================

export function addTask(title: string, category = "client", priority = "medium", dueDate?: string, description?: string, parentId?: number, projectId?: number, estimatedHours?: number) {
  const result = db.prepare(
    "INSERT INTO tasks (title, category, priority, due_date, description, parent_id, project_id, estimated_hours) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(title, category, priority, dueDate ?? null, description ?? null, parentId ?? null, projectId ?? null, estimatedHours ?? null);
  assignArea("tasks", Number(result.lastInsertRowid), { kind: "task", text: [title, description].filter(Boolean).join("\n"), category, projectId });
  return result;
}

// The area is decided after the insert and written back, so creating a row never
// waits on Jev. A row whose area cannot be decided keeps area NULL (unsorted).
function assignArea(table: "tasks" | "journal", id: number, item: Parameters<typeof decideArea>[0]): void {
  decideArea(item)
    .then((area) => { if (area) db.prepare(`UPDATE ${table} SET area = ? WHERE id = ? AND area IS NULL`).run(area, id); })
    .catch((err) => console.warn(`[area] ${table} #${id}:`, err?.message || err));
}

export function setTaskArea(id: number, area: Area | null) {
  return db.prepare("UPDATE tasks SET area = ? WHERE id = ?").run(area, id);
}

/** Open tasks and journal entries with no area yet, for the one-off backfill. */
export function getUnsortedForArea(): { table: "tasks" | "journal"; id: number; text: string; category: string | null; projectId?: number | null }[] {
  const tasks = db.prepare("SELECT id, title, description, category, project_id FROM tasks WHERE area IS NULL AND status IN ('pending', 'in_progress')").all() as any[];
  const journal = db.prepare("SELECT id, entry, category FROM journal WHERE area IS NULL").all() as any[];
  return [
    ...tasks.map((t) => ({ table: "tasks" as const, id: t.id, text: [t.title, t.description].filter(Boolean).join("\n"), category: t.category, projectId: t.project_id })),
    ...journal.map((j) => ({ table: "journal" as const, id: j.id, text: j.entry, category: j.category })),
  ];
}

export function setArea(table: "tasks" | "journal", id: number, area: Area): void {
  if (!isArea(area)) throw new Error(`bad area: ${area}`);
  db.prepare(`UPDATE ${table} SET area = ? WHERE id = ?`).run(area, id);
}

export function getTasks(status = "pending") {
  return db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, due_date ASC").all(status);
}

export function getAllActiveTasks() {
  return db.prepare("SELECT * FROM tasks WHERE status IN ('pending', 'in_progress') AND parent_id IS NULL ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END").all();
}

export function getSubtasks(parentId: number) {
  return db.prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END").all(parentId);
}

export function completeTask(id: number) {
  return db.prepare("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ?").run(id);
}

export function startTask(id: number) {
  return db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(id);
}

export function reopenTask(id: number) {
  return db.prepare("UPDATE tasks SET status = 'pending', completed_at = NULL WHERE id = ?").run(id);
}

export function getTask(id: number) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
}

export function updateTask(id: number, fields: Record<string, any>) {
  const allowed = ["title", "description", "category", "priority", "due_date", "status", "notes", "estimated_hours", "project_id"];
  const updates: string[] = [];
  const values: any[] = [];
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (updates.length === 0) return;
  values.push(id);
  return db.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...values);
}

export function addSubtask(parentId: number, title: string, priority = "medium") {
  const parent = db.prepare("SELECT category, project_id FROM tasks WHERE id = ?").get(parentId) as any;
  return db.prepare(
    "INSERT INTO tasks (title, parent_id, category, project_id, priority) VALUES (?, ?, ?, ?, ?)"
  ).run(title, parentId, parent?.category ?? "client", parent?.project_id ?? null, priority);
}

export function deleteTask(id: number) {
  db.prepare("DELETE FROM tasks WHERE parent_id = ?").run(id); // delete subtasks
  return db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

export function getCompletedTasksInRange(startDate: string, endDate: string) {
  return db.prepare("SELECT * FROM tasks WHERE status = 'done' AND completed_at BETWEEN ? AND ?").all(startDate, endDate);
}

// ========================
// HABITS
// ========================

export function addHabit(name: string, frequency = "daily", category = "personal", scheduleDays?: string[]) {
  return db.prepare("INSERT INTO habits (name, frequency, category, schedule_days) VALUES (?, ?, ?, ?)").run(
    name, frequency, category, scheduleDays ? JSON.stringify(scheduleDays) : null
  );
}

export function getHabits() {
  return db.prepare("SELECT * FROM habits WHERE active = 1").all();
}

export function deactivateHabit(id: number) {
  return db.prepare("UPDATE habits SET active = 0 WHERE id = ?").run(id);
}

export function logHabit(habitId: number, date: string) {
  return db.prepare("INSERT OR IGNORE INTO habit_logs (habit_id, logged_date) VALUES (?, ?)").run(habitId, date);
}

export function getHabitLogsForDate(date: string) {
  return db.prepare(`
    SELECT h.id, h.name, h.category, COALESCE(hl.done, 0) as done
    FROM habits h
    LEFT JOIN habit_logs hl ON h.id = hl.habit_id AND hl.logged_date = ?
    WHERE h.active = 1
  `).all(date);
}

export function getHabitStreak(habitId: number): number {
  const rows = db.prepare(
    "SELECT logged_date FROM habit_logs WHERE habit_id = ? ORDER BY logged_date DESC"
  ).all(habitId) as { logged_date: string }[];

  let streak = 0;
  const todayStr = localToday();
  const todayDate = new Date(todayStr + "T12:00:00Z");
  for (let i = 0; i < rows.length; i++) {
    const expected = new Date(todayDate);
    expected.setDate(expected.getDate() - i);
    const expectedStr = expected.toISOString().split("T")[0];
    if (rows[i].logged_date === expectedStr) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

export function getHabitCompletionInRange(startDate: string, endDate: string) {
  return db.prepare(`
    SELECT COUNT(DISTINCT hl.id) as completed, COUNT(DISTINCT h.id) *
      (julianday(?) - julianday(?) + 1) as total
    FROM habits h
    LEFT JOIN habit_logs hl ON h.id = hl.habit_id AND hl.logged_date BETWEEN ? AND ?
    WHERE h.active = 1
  `).get(endDate, startDate, startDate, endDate) as { completed: number; total: number };
}

// ========================
// WORK LOGS
// ========================

export function logWork(type: string, note?: string, workType = "dev", projectId?: number) {
  return db.prepare("INSERT INTO work_logs (type, note, work_type, project_id) VALUES (?, ?, ?, ?)").run(
    type, note ?? null, workType, projectId ?? null
  );
}

export function getWorkLogsForDate(date: string) {
  return db.prepare(`SELECT * FROM work_logs WHERE ${ld('logged_at')} = ? ORDER BY logged_at ASC`).all(date);
}

export function getWorkStats(date: string) {
  const logs = getWorkLogsForDate(date) as { type: string; logged_at: string; work_type: string; note: string }[];
  let totalWorkMinutes = 0;
  let totalBreakMinutes = 0;
  let workStart: Date | null = null;
  let breakStart: Date | null = null;
  const byType: Record<string, number> = {};

  for (const log of logs) {
    const time = new Date(log.logged_at);
    if (log.type === "work_start") {
      workStart = time;
    }
    if (log.type === "work_end" && workStart) {
      const mins = (time.getTime() - workStart.getTime()) / 60000;
      totalWorkMinutes += mins;
      const wt = log.work_type || "dev";
      byType[wt] = (byType[wt] || 0) + mins;
      workStart = null;
    }
    if (log.type === "break_start") breakStart = time;
    if (log.type === "break_end" && breakStart) {
      totalBreakMinutes += (time.getTime() - breakStart.getTime()) / 60000;
      breakStart = null;
    }
  }

  return {
    totalWorkMinutes: Math.round(totalWorkMinutes),
    totalBreakMinutes: Math.round(totalBreakMinutes),
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v)])),
  };
}

export function getWorkStatsForRange(startDate: string, endDate: string) {
  const logs = db.prepare(
    `SELECT * FROM work_logs WHERE ${ld('logged_at')} BETWEEN ? AND ? ORDER BY logged_at ASC`
  ).all(startDate, endDate) as { type: string; logged_at: string; work_type: string }[];

  let totalMinutes = 0;
  let workStart: Date | null = null;
  const byType: Record<string, number> = {};

  for (const log of logs) {
    const time = new Date(log.logged_at);
    if (log.type === "work_start") workStart = time;
    if (log.type === "work_end" && workStart) {
      const mins = (time.getTime() - workStart.getTime()) / 60000;
      totalMinutes += mins;
      const wt = log.work_type || "dev";
      byType[wt] = (byType[wt] || 0) + mins;
      workStart = null;
    }
  }

  return { totalMinutes: Math.round(totalMinutes), byType };
}

// ========================
// SCHEDULE
// ========================

export function addScheduleItem(title: string, time: string, date?: string, dayOfWeek?: string, recurring = false, description?: string) {
  return db.prepare(
    "INSERT INTO schedule (title, time, date, day_of_week, recurring, description) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(title, time, date ?? null, dayOfWeek ?? null, recurring ? 1 : 0, description ?? null);
}

export function getScheduleForDate(date: string) {
  const dayOfWeek = new Date(date).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
  return db.prepare(
    "SELECT * FROM schedule WHERE date = ? OR (recurring = 1 AND day_of_week = ?) ORDER BY time ASC"
  ).all(date, dayOfWeek);
}

// ========================
// JOURNAL
// ========================

export function addJournalEntry(entry: string, mood?: string, energyLevel?: number, category = "general") {
  const result = db.prepare("INSERT INTO journal (entry, mood, energy_level, category) VALUES (?, ?, ?, ?)").run(
    entry, mood ?? null, energyLevel ?? null, category
  );
  assignArea("journal", Number(result.lastInsertRowid), { kind: "journal", text: entry, category });
  return result;
}

export function getRecentJournals(limit = 5) {
  return db.prepare("SELECT * FROM journal ORDER BY logged_at DESC LIMIT ?").all(limit);
}

// ========================
// CLIENTS
// ========================

export function addClient(name: string, platform = "direct", contactInfo?: string, notes?: string) {
  return db.prepare("INSERT INTO clients (name, platform, contact_info, notes) VALUES (?, ?, ?, ?)").run(
    name, platform, contactInfo ?? null, notes ?? null
  );
}

export function getActiveClients() {
  return db.prepare("SELECT * FROM clients WHERE active = 1 ORDER BY created_at DESC").all();
}

export function getClient(id: number) {
  return db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
}

// ========================
// PROJECTS
// ========================

export function addProject(name: string, clientId?: number, category = "client", budget?: number, currency = "DH", deadline?: string, estimatedHours?: number, description?: string) {
  return db.prepare(
    "INSERT INTO projects (name, client_id, category, budget, currency, deadline, estimated_hours, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(name, clientId ?? null, category, budget ?? null, currency, deadline ?? null, estimatedHours ?? null, description ?? null);
}

export function getActiveProjects() {
  return db.prepare(`
    SELECT p.*, c.name as client_name
    FROM projects p
    LEFT JOIN clients c ON p.client_id = c.id
    WHERE p.status IN ('proposal', 'active')
    ORDER BY p.deadline ASC NULLS LAST
  `).all();
}

export function getProject(id: number) {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

export function updateProject(id: number, fields: Record<string, any>) {
  const allowed = ["name", "description", "category", "status", "budget", "currency", "deadline", "estimated_hours", "actual_hours"];
  const updates: string[] = [];
  const values: any[] = [];
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (updates.length === 0) return;
  if (fields.status === "completed") {
    updates.push("completed_at = datetime('now')");
  }
  values.push(id);
  return db.prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`).run(...values);
}

export function updateProjectHours(projectId: number, hoursToAdd: number) {
  return db.prepare("UPDATE projects SET actual_hours = actual_hours + ? WHERE id = ?").run(hoursToAdd, projectId);
}

export function getUpcomingDeadlines(days = 3) {
  const today = localToday();
  const future = new Date();
  future.setDate(future.getDate() + days);
  const futureStr = future.toISOString().split("T")[0];
  return db.prepare(`
    SELECT p.*, c.name as client_name
    FROM projects p
    LEFT JOIN clients c ON p.client_id = c.id
    WHERE p.status = 'active' AND p.deadline BETWEEN ? AND ?
    ORDER BY p.deadline ASC
  `).all(today, futureStr);
}

// ========================
// INCOME
// ========================

export function logIncome(amount: number, source = "direct", date?: string, projectId?: number, description?: string, currency = "DH") {
  const d = date ?? localToday();
  return db.prepare("INSERT INTO income (amount, currency, source, project_id, description, date) VALUES (?, ?, ?, ?, ?, ?)").run(
    amount, currency, source, projectId ?? null, description ?? null, d
  );
}

export function getIncomeForPeriod(startDate: string, endDate: string) {
  return db.prepare("SELECT * FROM income WHERE date BETWEEN ? AND ? ORDER BY date DESC").all(startDate, endDate);
}

export function getIncomeSummary(startDate: string, endDate: string) {
  return db.prepare(`
    SELECT source, SUM(amount) as total, currency
    FROM income WHERE date BETWEEN ? AND ?
    GROUP BY source, currency
  `).all(startDate, endDate) as { source: string; total: number; currency: string }[];
}

// ========================
// SHOP SALES
// ========================

export function logShopSale(date: string, revenue: number, itemsSold?: number, notes?: string) {
  return db.prepare("INSERT INTO shop_sales (date, total_revenue, items_sold, notes) VALUES (?, ?, ?, ?)").run(
    date, revenue, itemsSold ?? null, notes ?? null
  );
}

export function getShopSalesForPeriod(startDate: string, endDate: string) {
  return db.prepare("SELECT * FROM shop_sales WHERE date BETWEEN ? AND ? ORDER BY date DESC").all(startDate, endDate);
}

export function getShopSalesSummary(startDate: string, endDate: string) {
  return db.prepare(
    "SELECT SUM(total_revenue) as total, COUNT(*) as days_tracked, SUM(items_sold) as total_items FROM shop_sales WHERE date BETWEEN ? AND ?"
  ).get(startDate, endDate) as { total: number; days_tracked: number; total_items: number };
}


// ========================
// SHOP SALE ITEMS (per-item tracker)
// ========================

export interface ShopSaleTotals {
  today: { amount: number; count: number };
  week: { amount: number; count: number };
  month: { amount: number; count: number };
  allTime: { amount: number; count: number };
}

export function logShopSaleItem(
  params: {
    jid: string;
    sender: string | null;
    senderName: string | null;
    amount: number;
    source: "text" | "voice";
    rawContent: string | null;
    timestamp: number;
  },
  dbOverride?: import("better-sqlite3").Database,
): void {
  const { localDateFromTimestamp } = require("./utils");
  const loggedDate = localDateFromTimestamp(params.timestamp);
  const target = dbOverride ?? db;
  target.prepare(
    `INSERT INTO shop_sale_items (jid, sender, sender_name, amount_dh, source, raw_content, logged_date, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.jid,
    params.sender ?? null,
    params.senderName ?? null,
    params.amount,
    params.source,
    params.rawContent ? params.rawContent.slice(0, 200) : null,
    loggedDate,
    params.timestamp,
  );

  // Lazy rollup: if yesterday has items but no shop_sales row, aggregate it
  try {
    const yesterday = new Date(params.timestamp * 1000 - 86400000).toLocaleDateString("en-CA", { timeZone: process.env.TIMEZONE || "Africa/Casablanca" });
    const existingRollup = (target as any).prepare("SELECT id FROM shop_sales WHERE date = ?").get(yesterday);
    if (!existingRollup) {
      const agg = (target as any).prepare(
        "SELECT SUM(amount_dh) as total, COUNT(*) as cnt FROM shop_sale_items WHERE logged_date = ?"
      ).get(yesterday) as { total: number | null; cnt: number } | undefined;
      if (agg && agg.total != null && agg.cnt > 0) {
        (target as any).prepare(
          "INSERT OR IGNORE INTO shop_sales (date, total_revenue, items_sold, notes) VALUES (?, ?, ?, ?)"
        ).run(yesterday, agg.total, agg.cnt, "auto-aggregated from shop_sale_items");
      }
    }
  } catch (_e) { /* rollup is best-effort */ }
}

export function getShopItemsTotals(
  dbOverride?: import("better-sqlite3").Database,
  sumFn?: (amounts: number[]) => number,
): ShopSaleTotals {
  const { localToday: today, weekStartDate } = require("./utils");
  // Use Python-backed Decimal sum to avoid JS float drift (e.g. 0.1+0.2 problem).
  // Lazy-require to avoid circular dependency at module load time.
  const { sumDhPython } = require("./shop-group");
  const doSum: (amounts: number[]) => number = sumFn ?? sumDhPython;

  const target = dbOverride ?? db;
  const todayStr = today();
  const weekStart = weekStartDate();
  const monthStart = todayStr.slice(0, 7) + "-01";

  function q(from: string, to?: string): { amount: number; count: number } {
    const rows: Array<{ amount_dh: number }> = to
      ? (target as any).prepare(
          "SELECT amount_dh FROM shop_sale_items WHERE logged_date BETWEEN ? AND ?"
        ).all(from, to) as any
      : (target as any).prepare(
          "SELECT amount_dh FROM shop_sale_items WHERE logged_date = ?"
        ).all(from) as any;
    const amounts = rows.map((r) => r.amount_dh);
    return { amount: doSum(amounts), count: rows.length };
  }

  return {
    today: q(todayStr),
    week: q(weekStart, todayStr),
    month: q(monthStart, todayStr),
    allTime: q("0000-00-00", "9999-99-99"),
  };
}

export interface ShopSaleItemRow {
  amount_dh: number;
  logged_date: string;
  timestamp: number;
  sender_name: string | null;
  source: string | null;
}

/**
 * Every logged sale item, oldest first — the input the shop rollups run over.
 *
 * Reads shop_sale_items rather than re-parsing the WhatsApp log, because this
 * table is what the live handler writes and it is already indexed by date.
 */
export function getAllShopSaleItems(
  dbOverride?: import("better-sqlite3").Database,
): ShopSaleItemRow[] {
  const target = dbOverride ?? db;
  return (target as any)
    .prepare(
      "SELECT amount_dh, logged_date, timestamp, sender_name, source FROM shop_sale_items ORDER BY timestamp ASC",
    )
    .all() as ShopSaleItemRow[];
}

export function getShopItemsForDate(dateStr: string, dbOverride?: import("better-sqlite3").Database) {
  const target = dbOverride ?? db;
  return (target as any).prepare(
    "SELECT * FROM shop_sale_items WHERE logged_date = ? ORDER BY timestamp ASC"
  ).all(dateStr) as any[];
}

export function deleteLastShopSaleItem(jid: string, dbOverride?: import("better-sqlite3").Database): { id: number; amount_dh: number } | null {
  const target = dbOverride ?? db;
  const row = (target as any).prepare(
    "SELECT id, amount_dh FROM shop_sale_items WHERE jid = ? ORDER BY id DESC LIMIT 1"
  ).get(jid) as { id: number; amount_dh: number } | undefined;
  if (!row) return null;
  (target as any).prepare("DELETE FROM shop_sale_items WHERE id = ?").run(row.id);
  return row;
}

// ========================
// QURAN
// ========================

export function logQuranReading(pages: number, juz?: number, surah?: string, notes?: string) {
  const today = localToday();
  return db.prepare("INSERT INTO quran_progress (date, pages_read, juz, surah, notes) VALUES (?, ?, ?, ?, ?)").run(
    today, pages, juz ?? null, surah ?? null, notes ?? null
  );
}

export function getQuranProgress() {
  const total = db.prepare("SELECT SUM(pages_read) as total_pages, COUNT(DISTINCT date) as days_read FROM quran_progress").get() as { total_pages: number; days_read: number };
  const latest = db.prepare("SELECT * FROM quran_progress ORDER BY created_at DESC LIMIT 1").get() as any;
  return { totalPages: total.total_pages || 0, daysRead: total.days_read || 0, latest };
}

export function getQuranPagesInRange(startDate: string, endDate: string): number {
  const row = db.prepare("SELECT SUM(pages_read) as total FROM quran_progress WHERE date BETWEEN ? AND ?").get(startDate, endDate) as { total: number };
  return row.total || 0;
}

/** The last `days` local dates as YYYY-MM-DD, oldest first, ending today. */
export function recentDates(days: number): string[] {
  const today = new Date(localToday() + "T00:00:00Z");
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}

export function getHabitHistory(days: number): { date: string; habits: Record<number, boolean> }[] {
  const dates = recentDates(days);
  const rows = db.prepare("SELECT habit_id, logged_date FROM habit_logs WHERE done = 1 AND logged_date BETWEEN ? AND ?")
    .all(dates[0], dates[dates.length - 1]) as { habit_id: number; logged_date: string }[];
  return dates.map((date) => {
    const habits: Record<number, boolean> = {};
    for (const r of rows) if (r.logged_date === date) habits[r.habit_id] = true;
    return { date, habits };
  });
}

export function getQuranHistory(days: number): { date: string; pages: number }[] {
  const dates = recentDates(days);
  const rows = db.prepare("SELECT date, SUM(pages_read) as pages FROM quran_progress WHERE date BETWEEN ? AND ? GROUP BY date")
    .all(dates[0], dates[dates.length - 1]) as { date: string; pages: number }[];
  const byDate = new Map(rows.map((r) => [r.date, r.pages || 0]));
  return dates.map((date) => ({ date, pages: byDate.get(date) ?? 0 }));
}

// ========================
// ADHKAR
// ========================

export function getAdhkarHistory(days: number): { date: string; morning: boolean; evening: boolean; post_prayer: boolean }[] {
  const dates = recentDates(days);
  const rows = db.prepare("SELECT DISTINCT type, logged_date FROM adhkar_logs WHERE logged_date BETWEEN ? AND ?")
    .all(dates[0], dates[dates.length - 1]) as { type: string; logged_date: string }[];
  const has = (date: string, type: string) => rows.some((r) => r.logged_date === date && r.type === type);
  return dates.map((date) => ({
    date,
    morning: has(date, "morning"),
    evening: has(date, "evening"),
    post_prayer: has(date, "post_prayer"),
  }));
}

export function logAdhkar(type: string) {
  const today = localToday();
  return db.prepare("INSERT INTO adhkar_logs (type, logged_date) VALUES (?, ?)").run(type, today);
}

export function getAdhkarStatus(date: string) {
  const logs = db.prepare("SELECT type FROM adhkar_logs WHERE logged_date = ?").all(date) as { type: string }[];
  const types = new Set(logs.map((l) => l.type));
  return { morning: types.has("morning"), evening: types.has("evening"), postPrayer: types.has("post_prayer") };
}

export function getAdhkarDaysInRange(startDate: string, endDate: string) {
  const rows = db.prepare(`
    SELECT type, COUNT(DISTINCT logged_date) as days
    FROM adhkar_logs WHERE logged_date BETWEEN ? AND ?
    GROUP BY type
  `).all(startDate, endDate) as { type: string; days: number }[];
  const result: Record<string, number> = {};
  for (const row of rows) result[row.type] = row.days;
  return result;
}

// ========================
// NEIGHBORHOOD SHOPS
// ========================

export function addNeighborhoodShop(name: string, ownerName?: string, phone?: string, category?: string, notes?: string) {
  return db.prepare("INSERT INTO neighborhood_shops (name, owner_name, phone, category, notes) VALUES (?, ?, ?, ?, ?)").run(
    name, ownerName ?? null, phone ?? null, category ?? null, notes ?? null
  );
}

export function getNeighborhoodShops() {
  return db.prepare("SELECT * FROM neighborhood_shops ORDER BY interest_level DESC, created_at DESC").all();
}

export function updateNeighborhoodShop(id: number, fields: Record<string, any>) {
  const allowed = ["name", "owner_name", "phone", "category", "interest_level", "notes"];
  const updates: string[] = [];
  const values: any[] = [];
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (updates.length === 0) return;
  values.push(id);
  return db.prepare(`UPDATE neighborhood_shops SET ${updates.join(", ")} WHERE id = ?`).run(...values);
}

// ========================
// CONVERSATIONS
// ========================

export function saveConversation(role: string, content: string) {
  return db.prepare("INSERT INTO conversations (role, content) VALUES (?, ?)").run(role, content);
}

export function getRecentConversations(limit = 20) {
  return db.prepare("SELECT role, content FROM conversations ORDER BY created_at DESC LIMIT ?").all(limit);
}

export function clearOldConversations(keepDays = 7) {
  return db.prepare("DELETE FROM conversations WHERE created_at < datetime('now', ? || ' days')").run(-keepDays);
}

// ========================
// VOICE TRANSCRIPTS
// ========================

export interface TranscriptRow {
  id: number;
  jid: string;
  sender_name: string | null;
  from_me: number;
  is_group: number;
  timestamp: number;
  transcription: string;
  duration_seconds: number | null;
}

/**
 * Voice notes that have a transcript, newest first. `q` matches transcript text or
 * sender name. Rows with a NULL transcription are excluded rather than shown as blanks:
 * a NULL means transcription was off or failed, which is a different thing from silence.
 */
export function getTranscripts(limit = 50, offset = 0, q?: string): TranscriptRow[] {
  const term = q?.trim();
  const where = term
    ? "AND (transcription LIKE @like ESCAPE '\\' OR COALESCE(sender_name,'') LIKE @like ESCAPE '\\')"
    : "";
  return db.prepare(`
    SELECT id, jid, sender_name, from_me, is_group, timestamp, transcription, duration_seconds
    FROM whatsapp_messages
    WHERE message_type = 'audio' AND transcription IS NOT NULL AND TRIM(transcription) <> ''
    ${where}
    ORDER BY timestamp DESC
    LIMIT @limit OFFSET @offset
  `).all({ limit, offset, ...(term ? { like: likeContains(term) } : {}) }) as TranscriptRow[];
}

/**
 * Wrap a user's search term for a LIKE ... ESCAPE '\' contains-match. Without escaping,
 * a term of "%" or "_" is a wildcard and silently matches everything — searching "50%"
 * would return every row rather than the rows mentioning it.
 */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Total transcripts matching the same filter, so the UI can page without over-fetching. */
export function countTranscripts(q?: string): number {
  const term = q?.trim();
  const where = term
    ? "AND (transcription LIKE @like ESCAPE '\\' OR COALESCE(sender_name,'') LIKE @like ESCAPE '\\')"
    : "";
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM whatsapp_messages
    WHERE message_type = 'audio' AND transcription IS NOT NULL AND TRIM(transcription) <> ''
    ${where}
  `).get(term ? { like: likeContains(term) } : {}) as { n: number };
  return row.n;
}

export interface PendingAudioRow {
  id: number;
  jid: string;
  sender_name: string | null;
  from_me: number;
  is_group: number;
  timestamp: number;
  media_path: string;
}

/**
 * Untranscribed voice notes that still have their audio file recorded, newest first.
 * Rows whose media_path is NULL are skipped: the audio is gone, so no button on the
 * dashboard could ever transcribe them and listing them would just be a dead end.
 */
export function getPendingAudio(limit = 50, offset = 0): PendingAudioRow[] {
  return db.prepare(`
    SELECT id, jid, sender_name, from_me, is_group, timestamp, media_path
    FROM whatsapp_messages
    WHERE message_type = 'audio'
      AND (transcription IS NULL OR TRIM(transcription) = '')
      AND media_path IS NOT NULL AND TRIM(media_path) <> ''
    ORDER BY timestamp DESC
    LIMIT @limit OFFSET @offset
  `).all({ limit, offset }) as PendingAudioRow[];
}

/** One audio row by id, for the transcribe-on-demand endpoint. */
export function getAudioRow(id: number): PendingAudioRow | undefined {
  return db.prepare(`
    SELECT id, jid, sender_name, from_me, is_group, timestamp, media_path
    FROM whatsapp_messages
    WHERE id = ? AND message_type = 'audio'
  `).get(id) as PendingAudioRow | undefined;
}

/** How many voice notes are still untranscribed — the backlog indicator on the card. */
export function countUntranscribedAudio(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM whatsapp_messages
    WHERE message_type = 'audio' AND (transcription IS NULL OR TRIM(transcription) = '')
  `).get() as { n: number };
  return row.n;
}

// ========================
// WEEKLY REPORTS
// ========================

export function saveWeeklyReport(weekStart: string, weekEnd: string, reportText: string, scores: { productivity?: number; deen?: number; balance?: number; totalIncome?: number }) {
  return db.prepare(
    "INSERT INTO weekly_reports (week_start, week_end, report_text, productivity_score, deen_score, balance_score, total_income) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(weekStart, weekEnd, reportText, scores.productivity ?? null, scores.deen ?? null, scores.balance ?? null, scores.totalIncome ?? null);
}

export function getLatestWeeklyReport() {
  return db.prepare("SELECT * FROM weekly_reports ORDER BY created_at DESC LIMIT 1").get();
}

// ========================
// GOALS
// ========================

export function addGoal(title: string, metric: string, targetValue: number, period = "monthly") {
  return db.prepare("INSERT INTO goals (title, metric, target_value, period) VALUES (?, ?, ?, ?)").run(title, metric, targetValue, period);
}

export function getGoals() {
  return db.prepare("SELECT * FROM goals ORDER BY created_at DESC").all();
}

export function updateGoalValue(id: number, currentValue: number) {
  return db.prepare("UPDATE goals SET current_value = ? WHERE id = ?").run(currentValue, id);
}

export function deleteGoal(id: number) {
  return db.prepare("DELETE FROM goals WHERE id = ?").run(id);
}

// ========================
// EXPENSES
// ========================

export function logExpense(amount: number, category = "other", description?: string, date?: string, currency = "MAD", recurring = false) {
  const d = date ?? localToday();
  return db.prepare("INSERT INTO expenses (amount, currency, category, description, date, recurring) VALUES (?, ?, ?, ?, ?, ?)").run(
    amount, currency, category, description ?? null, d, recurring ? 1 : 0
  );
}

export function getExpensesForPeriod(startDate: string, endDate: string) {
  return db.prepare("SELECT * FROM expenses WHERE date BETWEEN ? AND ? ORDER BY date DESC").all(startDate, endDate) as any[];
}

export function getExpenseSummary(startDate: string, endDate: string) {
  return db.prepare(`
    SELECT category, SUM(amount) as total, currency, COUNT(*) as count
    FROM expenses WHERE date BETWEEN ? AND ?
    GROUP BY category, currency ORDER BY total DESC
  `).all(startDate, endDate) as { category: string; total: number; currency: string; count: number }[];
}

export function getExpenseTotal(startDate: string, endDate: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date BETWEEN ? AND ?").get(startDate, endDate) as { total: number };
  return row.total;
}

// ========================
// LEARNING LOG
// ========================

export function logLearning(title: string, type = "other", topic?: string, source?: string, notes?: string, minutesSpent?: number, date?: string) {
  const d = date ?? localToday();
  return db.prepare("INSERT INTO learning_log (title, type, topic, source, notes, minutes_spent, date) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    title, type, topic ?? null, source ?? null, notes ?? null, minutesSpent ?? null, d
  );
}

export function getRecentLearning(limit = 10) {
  return db.prepare("SELECT * FROM learning_log ORDER BY date DESC, created_at DESC LIMIT ?").all(limit) as any[];
}

export function getLearningForPeriod(startDate: string, endDate: string) {
  return db.prepare("SELECT * FROM learning_log WHERE date BETWEEN ? AND ? ORDER BY date DESC").all(startDate, endDate) as any[];
}

export function getLearningStats(startDate: string, endDate: string) {
  return {
    total: (db.prepare("SELECT COUNT(*) as c FROM learning_log WHERE date BETWEEN ? AND ?").get(startDate, endDate) as any).c,
    totalMinutes: (db.prepare("SELECT COALESCE(SUM(minutes_spent), 0) as m FROM learning_log WHERE date BETWEEN ? AND ?").get(startDate, endDate) as any).m,
    byType: db.prepare("SELECT type, COUNT(*) as count FROM learning_log WHERE date BETWEEN ? AND ? GROUP BY type").all(startDate, endDate) as any[],
    byTopic: db.prepare("SELECT topic, COUNT(*) as count FROM learning_log WHERE date BETWEEN ? AND ? AND topic IS NOT NULL GROUP BY topic ORDER BY count DESC LIMIT 5").all(startDate, endDate) as any[],
    days: (db.prepare("SELECT COUNT(DISTINCT date) as d FROM learning_log WHERE date BETWEEN ? AND ?").get(startDate, endDate) as any).d,
  };
}

// ========================
// CLIENT FOLLOW-UP
// ========================

export function getClientLastContact(): { client_name: string; client_id: number; last_contact: string; days_ago: number }[] {
  // Check last task activity, WA message, or income for each client
  const clients = db.prepare("SELECT * FROM clients WHERE active = 1").all() as any[];
  const results: any[] = [];

  for (const c of clients) {
    let lastDate = c.created_at?.split(" ")[0] || "2020-01-01";

    // Last task completed for this client
    const lastTask = db.prepare("SELECT MAX(completed_at) as d FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE client_id = ?) AND status = 'done'").get(c.id) as any;
    if (lastTask?.d && lastTask.d > lastDate) lastDate = lastTask.d.split(" ")[0];

    // Last income from this client
    const lastIncome = db.prepare("SELECT MAX(date) as d FROM income WHERE project_id IN (SELECT id FROM projects WHERE client_id = ?)").get(c.id) as any;
    if (lastIncome?.d && lastIncome.d > lastDate) lastDate = lastIncome.d;

    // Last WA message from a contact linked to this client
    const contact = db.prepare("SELECT jid FROM whatsapp_contacts WHERE notes LIKE ? OR display_name LIKE ?").get(`%${c.name}%`, `%${c.name}%`) as any;
    if (contact) {
      const lastWA = db.prepare("SELECT MAX(timestamp) as t FROM whatsapp_messages WHERE jid = ?").get(contact.jid) as any;
      if (lastWA?.t) {
        const waDate = new Date(lastWA.t * 1000).toISOString().split("T")[0];
        if (waDate > lastDate) lastDate = waDate;
      }
    }

    const daysAgo = Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000);
    results.push({ client_name: c.name, client_id: c.id, last_contact: lastDate, days_ago: daysAgo });
  }

  return results.sort((a, b) => b.days_ago - a.days_ago);
}

// ========================
// DASHBOARD HELPERS
// ========================

export function getCompletedTasksForDate(date: string) {
  return db.prepare(`SELECT * FROM tasks WHERE status = 'done' AND ${ld('completed_at')} = ? ORDER BY completed_at DESC`).all(date);
}

export function getLatestCoachingToday() {
  const td = localToday();
  return db.prepare(`SELECT * FROM coaching_log WHERE ${ld('sent_at')} = ? ORDER BY sent_at DESC LIMIT 1`).get(td) as { scenario: string; sent_at: string; message_summary: string } | undefined;
}

export function toggleHabit(habitId: number, date: string): boolean {
  const existing = db.prepare("SELECT id FROM habit_logs WHERE habit_id = ? AND logged_date = ?").get(habitId, date) as { id: number } | undefined;
  if (existing) {
    db.prepare("DELETE FROM habit_logs WHERE habit_id = ? AND logged_date = ?").run(habitId, date);
    return false;
  }
  db.prepare("INSERT INTO habit_logs (habit_id, logged_date) VALUES (?, ?)").run(habitId, date);
  return true;
}

export function getActiveBreak() {
  return db.prepare(`
    SELECT *, (julianday('now') - julianday(logged_at)) * 24 * 60 as minutes_active
    FROM work_logs
    WHERE type = 'break_start'
    AND id > COALESCE((SELECT MAX(id) FROM work_logs WHERE type IN ('break_end', 'work_end')), 0)
    ORDER BY logged_at DESC LIMIT 1
  `).get() as { id: number; minutes_active: number } | undefined;
}

export function getIncomeByProject(projectId: number): number {
  const row = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM income WHERE project_id = ?").get(projectId) as { total: number };
  return row.total;
}

// ========================
// CALENDAR & PROGRESS
// ========================

export function getJournalsForDate(date: string) {
  return db.prepare(`SELECT * FROM journal WHERE ${ld('logged_at')} = ? ORDER BY logged_at DESC`).all(date);
}

export function getJournalsInRange(startDate: string, endDate: string) {
  return db.prepare(`SELECT * FROM journal WHERE ${ld('logged_at')} BETWEEN ? AND ? ORDER BY logged_at DESC`).all(startDate, endDate);
}

export function getTasksCreatedInRange(startDate: string, endDate: string) {
  return db.prepare(`SELECT * FROM tasks WHERE ${ld('created_at')} BETWEEN ? AND ? ORDER BY created_at DESC`).all(startDate, endDate);
}

export function getDailyActivity(date: string) {
  const tasksCompleted = db.prepare(`SELECT * FROM tasks WHERE status = 'done' AND ${ld('completed_at')} = ? ORDER BY completed_at`).all(date) as any[];
  const tasksCreated = db.prepare(`SELECT * FROM tasks WHERE ${ld('created_at')} = ? ORDER BY created_at`).all(date) as any[];
  const habitsLog = getHabitLogsForDate(date) as any[];
  const workStats = getWorkStats(date);
  const workLogs = getWorkLogsForDate(date) as any[];
  const journals = getJournalsForDate(date) as any[];
  const quranPages = getQuranPagesInRange(date, date);
  const adhkar = getAdhkarStatus(date);
  const schedule = getScheduleForDate(date) as any[];
  const incomeEntries = db.prepare("SELECT * FROM income WHERE date = ?").all(date) as any[];
  const shopSales = db.prepare("SELECT * FROM shop_sales WHERE date = ?").all(date) as any[];

  // Include active tasks as of this date
  const activeTasks = db.prepare(`SELECT * FROM tasks WHERE status IN ('pending','in_progress') AND ${ld('created_at')} <= ? ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END`).all(date + " 23:59:59") as any[];

  // WhatsApp messages for the day
  const waMessages = getWAMessagesForDate(date);
  const waStats = getWAMessageCountForDate(date);

  // Telegram conversations for the day
  const conversations = getConversationsForDate(date);

  // Expenses for the day
  const expenses = db.prepare("SELECT * FROM expenses WHERE date = ?").all(date) as any[];

  // Learning for the day
  const learning = db.prepare("SELECT * FROM learning_log WHERE date = ?").all(date) as any[];

  return {
    date,
    tasksCompleted,
    tasksCreated,
    activeTasks,
    habits: habitsLog,
    work: {
      totalMinutes: workStats.totalWorkMinutes,
      breakMinutes: workStats.totalBreakMinutes,
      byType: workStats.byType,
      sessions: workLogs,
    },
    journals,
    quranPages,
    adhkar,
    schedule,
    income: incomeEntries,
    shopSales,
    whatsapp: {
      messages: waMessages.slice(-30), // last 30 for the day
      received: waStats.received,
      sent: waStats.sent,
      chats: waStats.chats,
    },
    conversations: conversations.slice(-20),
    expenses,
    learning,
  };
}

export function getDateRangeSummaries(startDate: string, endDate: string) {
  // Get all dates that have ANY activity in the range
  const days: { date: string; tasksCompleted: number; tasksCreated: number; workMinutes: number; habitsCompleted: number; habitsTotal: number; quranPages: number; journalCount: number; income: number; waMessages: number; conversations: number }[] = [];

  // Use string-based date iteration to avoid timezone/DST issues
  let dateStr = startDate;
  const seen = new Set<string>();

  while (dateStr <= endDate) {
    if (seen.has(dateStr)) { // safety: skip duplicates
      const next = new Date(dateStr + "T12:00:00Z");
      next.setDate(next.getDate() + 1);
      dateStr = next.toISOString().split("T")[0];
      continue;
    }
    seen.add(dateStr);

    const completed = (db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE status = 'done' AND ${ld('completed_at')} = ?`).get(dateStr) as any).c;
    const created = (db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE ${ld('created_at')} = ?`).get(dateStr) as any).c;

    const habitStats = db.prepare(`
      SELECT COUNT(CASE WHEN hl.done = 1 THEN 1 END) as completed, COUNT(h.id) as total
      FROM habits h LEFT JOIN habit_logs hl ON h.id = hl.habit_id AND hl.logged_date = ?
      WHERE h.active = 1
    `).get(dateStr) as { completed: number; total: number };

    const quran = (db.prepare("SELECT COALESCE(SUM(pages_read), 0) as p FROM quran_progress WHERE date = ?").get(dateStr) as any).p;
    const jCount = (db.prepare(`SELECT COUNT(*) as c FROM journal WHERE ${ld('logged_at')} = ?`).get(dateStr) as any).c;
    const incomeTotal = (db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM income WHERE date = ?").get(dateStr) as any).t;
    const shopTotal = (db.prepare("SELECT COALESCE(SUM(total_revenue), 0) as t FROM shop_sales WHERE date = ?").get(dateStr) as any).t;

    const workStats = getWorkStatsForRange(dateStr, dateStr);
    const waStats = getWAMessageCountForDate(dateStr);
    const convCount = getConversationCountForDate(dateStr);

    // Only include days with any activity
    if (completed > 0 || created > 0 || habitStats.completed > 0 || workStats.totalMinutes > 0 || quran > 0 || jCount > 0 || incomeTotal > 0 || shopTotal > 0 || waStats.received > 0 || convCount > 0) {
      days.push({
        date: dateStr,
        tasksCompleted: completed,
        tasksCreated: created,
        workMinutes: workStats.totalMinutes,
        habitsCompleted: habitStats.completed,
        habitsTotal: habitStats.total,
        quranPages: quran,
        journalCount: jCount,
        income: incomeTotal + shopTotal,
        waMessages: waStats.received + waStats.sent,
        conversations: convCount,
      });
    }

    // Advance to next day using noon UTC to avoid DST edge cases
    const next = new Date(dateStr + "T12:00:00Z");
    next.setDate(next.getDate() + 1);
    dateStr = next.toISOString().split("T")[0];
  }

  return days;
}

export function getProgressData(startDate: string, endDate: string) {
  const completedTasks = getCompletedTasksInRange(startDate, endDate) as any[];
  const createdTasks = getTasksCreatedInRange(startDate, endDate) as any[];
  const workStats = getWorkStatsForRange(startDate, endDate);
  const habitCompletion = getHabitCompletionInRange(startDate, endDate);
  const quranPages = getQuranPagesInRange(startDate, endDate);
  const adhkarDays = getAdhkarDaysInRange(startDate, endDate);
  const incomeSummary = getIncomeSummary(startDate, endDate);
  const shopSummary = getShopSalesSummary(startDate, endDate);
  const journals = getJournalsInRange(startDate, endDate) as any[];

  // Group completed tasks by category
  const tasksByCategory: Record<string, number> = {};
  for (const t of completedTasks) {
    tasksByCategory[t.category] = (tasksByCategory[t.category] || 0) + 1;
  }

  // Income breakdown
  let devIncome = 0;
  const incomeBySource: Record<string, number> = {};
  for (const row of incomeSummary) {
    incomeBySource[row.source] = row.total;
    if (row.source !== "shop") devIncome += row.total;
  }

  // Days count
  const start = new Date(startDate);
  const end = new Date(endDate);
  const totalDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1);

  // Work days (days with any work logged)
  const workDays = (db.prepare(`
    SELECT COUNT(DISTINCT ${ld('logged_at')}) as c FROM work_logs
    WHERE type = 'work_start' AND ${ld('logged_at')} BETWEEN ? AND ?
  `).get(startDate, endDate) as any).c;

  // Journal days
  const journalDays = (db.prepare(`
    SELECT COUNT(DISTINCT ${ld('logged_at')}) as c FROM journal
    WHERE ${ld('logged_at')} BETWEEN ? AND ?
  `).get(startDate, endDate) as any).c;

  // Quran days
  const quranDays = (db.prepare(`
    SELECT COUNT(DISTINCT date) as c FROM quran_progress
    WHERE date BETWEEN ? AND ?
  `).get(startDate, endDate) as any).c;

  return {
    period: { start: startDate, end: endDate, totalDays },
    tasks: {
      completed: completedTasks.length,
      created: createdTasks.length,
      byCategory: tasksByCategory,
      completionRate: createdTasks.length > 0 ? Math.round((completedTasks.length / createdTasks.length) * 100) : 0,
    },
    work: {
      totalHours: Math.round((workStats.totalMinutes / 60) * 10) / 10,
      byType: Object.fromEntries(Object.entries(workStats.byType).map(([k, v]) => [k, Math.round((v / 60) * 10) / 10])),
      daysWorked: workDays,
      avgHoursPerWorkDay: workDays > 0 ? Math.round((workStats.totalMinutes / 60 / workDays) * 10) / 10 : 0,
    },
    habits: {
      completed: habitCompletion.completed,
      total: habitCompletion.total,
      rate: habitCompletion.total > 0 ? Math.round((habitCompletion.completed / habitCompletion.total) * 100) : 0,
    },
    deen: {
      quranPages,
      quranDays,
      quranAvgPerDay: quranDays > 0 ? Math.round((quranPages / quranDays) * 10) / 10 : 0,
      adhkarMorning: adhkarDays["morning"] || 0,
      adhkarEvening: adhkarDays["evening"] || 0,
    },
    finance: {
      devIncome,
      shopRevenue: shopSummary.total || 0,
      total: devIncome + (shopSummary.total || 0),
      bySource: incomeBySource,
    },
    journal: {
      entries: journals.length,
      daysJournaled: journalDays,
      recentMoods: journals.slice(0, 10).map((j: any) => j.mood).filter(Boolean),
    },
    goals: getGoals() as any[],
  };
}

// ========================
// AI MEMORY
// ========================

export function saveAiMemory(question: string, answer: string, source: string, embedding: number[], domain = "general") {
  return db.prepare("INSERT INTO ai_memory (question, answer, source, embedding, domain) VALUES (?, ?, ?, ?, ?)").run(
    question, answer, source, JSON.stringify(embedding), domain
  );
}

export function getAllAiMemories(): { id: number; question: string; answer: string; source: string; embedding: string; domain: string; created_at: string }[] {
  return db.prepare("SELECT * FROM ai_memory ORDER BY created_at DESC").all() as any[];
}

export function getAiMemoryStats(): { total: number; fromClaude: number; fromLocal: number; fromMemory: number } {
  const total = (db.prepare("SELECT COUNT(*) as c FROM ai_memory").get() as any).c;
  const fromClaude = (db.prepare("SELECT COUNT(*) as c FROM ai_memory WHERE source = 'claude'").get() as any).c;
  const fromLocal = (db.prepare("SELECT COUNT(*) as c FROM ai_memory WHERE source = 'local'").get() as any).c;
  return { total, fromClaude, fromLocal, fromMemory: 0 };
}

// ========================
// WHATSAPP MESSAGES
// ========================

export function updateWAMessageMedia(id: number, mediaPath: string, transcription?: string) {
  if (transcription) {
    db.prepare("UPDATE whatsapp_messages SET media_path = ?, transcription = ?, content = content || ' [Transcription: ' || ? || ']' WHERE id = ?")
      .run(mediaPath, transcription, transcription, id);
  } else {
    db.prepare("UPDATE whatsapp_messages SET media_path = ? WHERE id = ?").run(mediaPath, id);
  }
}

export function saveWAMessage(msg: {
  jid: string; sender?: string; sender_name?: string; content: string;
  message_type?: string; from_me?: boolean; is_group?: boolean; timestamp?: number;
  wa_msg_id?: string | null; quoted_msg_id?: string | null;
}) {
  // OR IGNORE + the (jid, wa_msg_id) unique index makes a replayed history
  // message a no-op instead of a duplicate row. changes === 0 means "already had it".
  return db.prepare(
    `INSERT OR IGNORE INTO whatsapp_messages (jid, sender, sender_name, content, message_type, from_me, is_group, timestamp, wa_msg_id, quoted_msg_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(msg.jid, msg.sender, msg.sender_name, msg.content, msg.message_type || "text",
    msg.from_me ? 1 : 0, msg.is_group ? 1 : 0, msg.timestamp || Math.floor(Date.now() / 1000),
    msg.wa_msg_id ?? null, msg.quoted_msg_id ?? null);
}

function dateToTsRange(date: string): { startTs: number; endTs: number } {
  const tzOffset = parseInt(sqliteTzModifier()) || 0;
  const dayStart = new Date(date + "T00:00:00Z");
  dayStart.setHours(dayStart.getHours() - tzOffset);
  const dayEnd = new Date(date + "T23:59:59Z");
  dayEnd.setHours(dayEnd.getHours() - tzOffset);
  return { startTs: Math.floor(dayStart.getTime() / 1000), endTs: Math.floor(dayEnd.getTime() / 1000) };
}

export function getWAMessagesForDate(date: string) {
  const { startTs, endTs } = dateToTsRange(date);
  return db.prepare(`
    SELECT wm.*, COALESCE(wc.category, 'other') as contact_category, wc.display_name as contact_display_name
    FROM whatsapp_messages wm
    LEFT JOIN whatsapp_contacts wc ON wm.jid = wc.jid
    WHERE wm.timestamp BETWEEN ? AND ?
    ORDER BY wm.timestamp ASC
  `).all(startTs, endTs) as any[];
}

export function getWAMessageCountForDate(date: string): { received: number; sent: number; chats: number } {
  const { startTs, endTs } = dateToTsRange(date);
  const received = (db.prepare("SELECT COUNT(*) as c FROM whatsapp_messages WHERE timestamp BETWEEN ? AND ? AND from_me = 0").get(startTs, endTs) as any).c;
  const sent = (db.prepare("SELECT COUNT(*) as c FROM whatsapp_messages WHERE timestamp BETWEEN ? AND ? AND from_me = 1").get(startTs, endTs) as any).c;
  const chatsCount = (db.prepare("SELECT COUNT(DISTINCT jid) as c FROM whatsapp_messages WHERE timestamp BETWEEN ? AND ?").get(startTs, endTs) as any).c;
  return { received, sent, chats: chatsCount };
}

export function getConversationsForDate(date: string) {
  return db.prepare(`SELECT * FROM conversations WHERE ${ld('created_at')} = ? ORDER BY created_at ASC`).all(date) as any[];
}

export function getConversationCountForDate(date: string): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM conversations WHERE ${ld('created_at')} = ?`).get(date) as any).c;
}

export function searchWAMessages(query: string, limit = 20) {
  return db.prepare(`
    SELECT wm.*, COALESCE(wc.category, 'other') as contact_category,
           COALESCE(wc.display_name, wm.sender_name) as display_name
    FROM whatsapp_messages wm
    LEFT JOIN whatsapp_contacts wc ON wm.jid = wc.jid
    WHERE wm.sender_name LIKE ? OR wm.content LIKE ? OR wc.display_name LIKE ? OR wc.notes LIKE ?
    ORDER BY wm.timestamp DESC LIMIT ?
  `).all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, limit) as any[];
}

/** Auto-update display_name from latest WA sender_name when it changes */
export function syncWAContactName(jid: string, currentName: string) {
  const contact = db.prepare("SELECT * FROM whatsapp_contacts WHERE jid = ?").get(jid) as any;
  if (contact && !contact.display_name?.includes("(")) {
    // Only auto-update if display_name doesn't have a role label like "Alice (Dev Client)"
    return;
  }
  if (!contact) return; // not categorized yet, skip
  // Update display_name preserving the role part
  const roleMatch = contact.display_name?.match(/\(([^)]+)\)/);
  const role = roleMatch ? ` (${roleMatch[1]})` : "";
  const newName = currentName + role;
  if (newName !== contact.display_name) {
    db.prepare("UPDATE whatsapp_contacts SET display_name = ? WHERE jid = ?").run(newName, jid);
  }
}

export function getWAMessages(jid: string, limit = 20) {
  return db.prepare("SELECT * FROM whatsapp_messages WHERE jid = ? ORDER BY timestamp DESC LIMIT ?").all(jid, limit) as any[];
}

/** Single WA message row by primary key — used by the Temporal wa-chat activity
 *  to resolve the ids collected during a debounced burst back into full rows. */
export function getWAMessageById(id: number) {
  return db.prepare("SELECT * FROM whatsapp_messages WHERE id = ?").get(id) as any;
}

export function getOutgoingTextsToJid(jid: string, limit = 15): { content: string; timestamp: number }[] {
  return db.prepare(
    "SELECT content, timestamp FROM whatsapp_messages WHERE jid = ? AND from_me = 1 AND message_type = 'text' AND content IS NOT NULL AND content != '' ORDER BY timestamp DESC LIMIT ?"
  ).all(jid, limit) as any[];
}

/**
 * Global voice sample: The owner's recent outgoing texts across all contacts,
 * used as a fallback style fingerprint when drafting for a contact with no
 * prior history. Prefers meaningful messages (length >= 10) to filter out
 * "ok" / "la" / "نعم" boilerplate.
 */
export function getRecentOutgoingTexts(limit = 30): { content: string; timestamp: number; jid: string }[] {
  return db.prepare(
    "SELECT content, timestamp, jid FROM whatsapp_messages WHERE from_me = 1 AND message_type = 'text' AND content IS NOT NULL AND LENGTH(content) >= 10 AND LENGTH(content) <= 200 ORDER BY timestamp DESC LIMIT ?"
  ).all(limit) as any[];
}

export function getRecentWAMessages(limit = 50) {
  return db.prepare("SELECT * FROM whatsapp_messages WHERE from_me = 0 ORDER BY timestamp DESC LIMIT ?").all(limit) as any[];
}

export function getWAMessagesSince(sinceTimestamp: number) {
  return db.prepare(`
    SELECT wm.*, COALESCE(wc.category, 'other') as contact_category,
           COALESCE(wc.display_name, wm.sender_name) as display_name
    FROM whatsapp_messages wm
    LEFT JOIN whatsapp_contacts wc ON wm.jid = wc.jid
    WHERE wm.timestamp >= ? AND wm.from_me = 0
    ORDER BY wm.timestamp ASC
  `).all(sinceTimestamp) as any[];
}

export function markWAReplied(id: number, replyContent: string) {
  db.prepare("UPDATE whatsapp_messages SET replied = 1, reply_content = ? WHERE id = ?").run(replyContent, id);
}

export function getUnrepliedWAMessages(jid?: string, limit = 10) {
  if (jid) {
    return db.prepare("SELECT * FROM whatsapp_messages WHERE jid = ? AND from_me = 0 AND replied = 0 ORDER BY timestamp DESC LIMIT ?").all(jid, limit) as any[];
  }
  // Muted chats (rule_type = 'ignore') stay in the DB but never surface in
  // reminders / digests — data kept, notifications suppressed.
  return db.prepare(`
    SELECT * FROM whatsapp_messages
    WHERE from_me = 0 AND replied = 0
      AND jid NOT IN (SELECT jid FROM whatsapp_rules WHERE rule_type = 'ignore' AND active = 1 AND jid IS NOT NULL)
    ORDER BY timestamp DESC LIMIT ?
  `).all(limit) as any[];
}

// ========================
// WHATSAPP RULES
// ========================

export function addWARule(jid: string | null, ruleType: string, condition?: string, response?: string) {
  return db.prepare("INSERT INTO whatsapp_rules (jid, rule_type, condition, response) VALUES (?, ?, ?, ?)").run(jid, ruleType, condition, response);
}

export function getWARules(activeOnly = true) {
  if (activeOnly) {
    return db.prepare("SELECT * FROM whatsapp_rules WHERE active = 1 ORDER BY id DESC").all() as any[];
  }
  return db.prepare("SELECT * FROM whatsapp_rules ORDER BY id DESC").all() as any[];
}

export function getWARulesForJid(jid: string) {
  return db.prepare("SELECT * FROM whatsapp_rules WHERE (jid = ? OR jid IS NULL) AND active = 1 ORDER BY jid DESC").all(jid) as any[];
}

// ========================
// WHATSAPP CONTACTS
// ========================

export function setWAContactCategory(jid: string, category: string, displayName?: string, notes?: string) {
  return db.prepare(`
    INSERT INTO whatsapp_contacts (jid, category, display_name, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      category = excluded.category,
      display_name = COALESCE(excluded.display_name, display_name),
      notes = COALESCE(excluded.notes, notes)
  `).run(jid, category, displayName ?? null, notes ?? null);
}

export function getWAContactCategory(jid: string) {
  return db.prepare("SELECT * FROM whatsapp_contacts WHERE jid = ?").get(jid) as { jid: string; category: string; display_name: string | null; notes: string | null; auto_transcribe: string | null } | undefined;
}

/**
 * Rename a contact for the dashboard. Empty clears it, and the WhatsApp sender
 * name shows again. Category is untouched: renaming is not recategorising.
 */
export function setWAContactName(jid: string, name: string) {
  const value = name.trim().slice(0, 80) || null;
  return db.prepare(`
    INSERT INTO whatsapp_contacts (jid, category, display_name) VALUES (?, 'other', ?)
    ON CONFLICT(jid) DO UPDATE SET display_name = excluded.display_name
  `).run(jid, value);
}

/** 'default' stores NULL. Creates the contact row (category 'other') if it does not exist. */
export function setWAAutoTranscribe(jid: string, setting: "default" | "on" | "off") {
  const value = setting === "default" ? null : setting;
  return db.prepare(`
    INSERT INTO whatsapp_contacts (jid, category, auto_transcribe) VALUES (?, 'other', ?)
    ON CONFLICT(jid) DO UPDATE SET auto_transcribe = excluded.auto_transcribe
  `).run(jid, value);
}

export interface VoiceContactRow {
  jid: string;
  name: string | null;
  category: string | null;
  auto_transcribe: string | null;
  voice_notes: number;
  last_at: number | null;
}

/** Every chat that has sent voice notes, plus any contact with an override, busiest first. */
export function listVoiceContacts(): VoiceContactRow[] {
  return db.prepare(`
    WITH voice AS (
      SELECT jid, COUNT(*) AS voice_notes, MAX(timestamp) AS last_at,
             (SELECT sender_name FROM whatsapp_messages w2
               WHERE w2.jid = w.jid AND w2.from_me = 0 AND w2.sender_name IS NOT NULL
               ORDER BY timestamp DESC LIMIT 1) AS sender_name
      FROM whatsapp_messages w
      WHERE message_type = 'audio' AND from_me = 0
      GROUP BY jid
    )
    SELECT v.jid, COALESCE(c.display_name, v.sender_name) AS name, c.category, c.auto_transcribe,
           v.voice_notes, v.last_at
    FROM voice v LEFT JOIN whatsapp_contacts c ON c.jid = v.jid
    UNION ALL
    SELECT c.jid, c.display_name, c.category, c.auto_transcribe, 0, NULL
    FROM whatsapp_contacts c
    WHERE c.auto_transcribe IS NOT NULL AND c.jid NOT IN (SELECT jid FROM voice)
    ORDER BY voice_notes DESC
  `).all() as VoiceContactRow[];
}

export function getAllWAContacts() {
  return db.prepare("SELECT * FROM whatsapp_contacts ORDER BY category, display_name").all() as any[];
}

export function getUnrepliedByCategory(): Record<string, any[]> {
  const msgs = db.prepare(`
    SELECT wm.*, COALESCE(wc.category, 'other') as contact_category,
           COALESCE(wc.display_name, wm.sender_name) as display_name
    FROM whatsapp_messages wm
    LEFT JOIN whatsapp_contacts wc ON wm.jid = wc.jid
    WHERE wm.from_me = 0 AND wm.replied = 0
      AND wm.jid NOT IN (SELECT jid FROM whatsapp_rules WHERE rule_type = 'ignore' AND active = 1 AND jid IS NOT NULL)
    ORDER BY CASE COALESCE(wc.category, 'other')
      WHEN 'client' THEN 1 WHEN 'shop' THEN 2 WHEN 'family' THEN 3
      WHEN 'personal' THEN 4 ELSE 5 END,
      wm.timestamp DESC
  `).all() as any[];
  const grouped: Record<string, any[]> = {};
  for (const m of msgs) {
    const cat = m.contact_category || "other";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(m);
  }
  return grouped;
}

export function deleteWARule(id: number) {
  db.prepare("UPDATE whatsapp_rules SET active = 0 WHERE id = ?").run(id);
}

export function isJidIgnored(jid: string): boolean {
  const rule = db.prepare("SELECT id FROM whatsapp_rules WHERE jid = ? AND rule_type = 'ignore' AND active = 1 LIMIT 1").get(jid);
  return !!rule;
}

// ========================
// REPLY PATTERNS (learn from manual replies)
// ========================

export function saveReplyPattern(jid: string, contactName: string, category: string, theirMessage: string, myReply: string) {
  return db.prepare(
    `INSERT INTO wa_reply_patterns (jid, contact_name, contact_category, their_message, my_reply)
     VALUES (?, ?, ?, ?, ?)`
  ).run(jid, contactName, category, theirMessage, myReply);
}

export function getReplyPatterns(category?: string, limit = 5): any[] {
  if (category) {
    return db.prepare(
      "SELECT * FROM wa_reply_patterns WHERE contact_category = ? ORDER BY created_at DESC LIMIT ?"
    ).all(category, limit) as any[];
  }
  return db.prepare(
    "SELECT * FROM wa_reply_patterns ORDER BY created_at DESC LIMIT ?"
  ).all(limit) as any[];
}

// ========================
// ACTIVITY EVENTS
// ========================

export function createActivityEvent(event: { source: string; event_type: string; confidence?: string; title?: string; project?: string; category?: string; duration_minutes?: number; metadata?: string; related_id?: number }) {
  return db.prepare("INSERT INTO activity_events (source, event_type, confidence, title, project, category, duration_minutes, metadata, related_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    event.source, event.event_type, event.confidence ?? 'high', event.title ?? null, event.project ?? null, event.category ?? 'dev', event.duration_minutes ?? null, event.metadata ?? null, event.related_id ?? null
  );
}

export function getActivityEventsForDate(date: string) {
  return db.prepare("SELECT * FROM activity_events WHERE date(logged_at) = date(?) ORDER BY logged_at DESC").all(date) as any[];
}

export function getUnconfirmedEvents() {
  return db.prepare("SELECT * FROM activity_events WHERE confirmed = 0 ORDER BY logged_at DESC").all() as any[];
}

export function confirmActivityEvent(id: number, category?: string) {
  if (category) {
    return db.prepare("UPDATE activity_events SET confirmed = 1, confirmed_at = datetime('now'), category = ? WHERE id = ?").run(category, id);
  }
  return db.prepare("UPDATE activity_events SET confirmed = 1, confirmed_at = datetime('now') WHERE id = ?").run(id);
}

export function rejectActivityEvent(id: number) {
  return db.prepare("DELETE FROM activity_events WHERE id = ?").run(id);
}

// ========================
// PROMISES
// ========================

export function addPromise(promise: { content: string; made_to?: string; project_id?: number; due_date?: string; due_context?: string; source_type?: string; source_id?: number }) {
  return db.prepare("INSERT INTO promises (content, made_to, project_id, due_date, due_context, source_type, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    promise.content, promise.made_to ?? null, promise.project_id ?? null, promise.due_date ?? null, promise.due_context ?? null, promise.source_type ?? 'manual', promise.source_id ?? null
  );
}

export function getPromises(status?: string) {
  if (status) {
    return db.prepare("SELECT * FROM promises WHERE status = ? ORDER BY due_date ASC, created_at DESC").all(status) as any[];
  }
  return db.prepare("SELECT * FROM promises ORDER BY CASE status WHEN 'overdue' THEN 1 WHEN 'due_soon' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END, due_date ASC, created_at DESC").all() as any[];
}

export function getOverduePromises() {
  return db.prepare("SELECT * FROM promises WHERE status IN ('pending', 'due_soon', 'overdue') AND due_date IS NOT NULL AND date(due_date) < date('now') ORDER BY due_date ASC").all() as any[];
}

export function getDueTodayPromises() {
  return db.prepare("SELECT * FROM promises WHERE status IN ('pending', 'due_soon') AND due_date IS NOT NULL AND date(due_date) <= date('now') ORDER BY due_date ASC").all() as any[];
}

export function fulfillPromise(id: number) {
  return db.prepare("UPDATE promises SET status = 'fulfilled', fulfilled_at = datetime('now') WHERE id = ?").run(id);
}

export function breakPromise(id: number) {
  return db.prepare("UPDATE promises SET status = 'broken' WHERE id = ?").run(id);
}

export function updatePromiseStatuses() {
  db.prepare("UPDATE promises SET status = 'overdue' WHERE status IN ('pending', 'due_soon') AND due_date IS NOT NULL AND date(due_date) < date('now')").run();
  db.prepare("UPDATE promises SET status = 'due_soon' WHERE status = 'pending' AND due_date IS NOT NULL AND date(due_date) <= date('now', '+3 days') AND date(due_date) >= date('now')").run();
}

export function linkPromiseToTask(promiseId: number, taskId: number) {
  return db.prepare("UPDATE promises SET task_id = ? WHERE id = ?").run(taskId, promiseId);
}

// ========================
// USER STATE
// ========================

export function getCurrentUserState() {
  return db.prepare("SELECT * FROM user_state ORDER BY set_at DESC LIMIT 1").get() as any;
}

export function setUserState(state: string, source: string, note?: string) {
  const current = getCurrentUserState();
  if (current) {
    db.prepare("UPDATE user_state SET ended_at = datetime('now') WHERE id = ? AND ended_at IS NULL").run(current.id);
  }
  return db.prepare("INSERT INTO user_state (state, source, note) VALUES (?, ?, ?)").run(state, source, note ?? null);
}

export function endUserState() {
  return db.prepare("UPDATE user_state SET ended_at = datetime('now') WHERE ended_at IS NULL").run();
}

// ========================
// TASK SCORING HELPERS
// ========================

export function getOverdueTasks() {
  return db.prepare("SELECT * FROM tasks WHERE status IN ('pending', 'in_progress') AND due_date IS NOT NULL AND date(due_date) < date('now') ORDER BY due_date ASC").all() as any[];
}

export function getTasksWithProject() {
  return db.prepare("SELECT t.*, p.name as project_name, p.priority as project_priority FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.status IN ('pending', 'in_progress') ORDER BY t.due_date ASC, p.priority DESC").all() as any[];
}

export default db;

// ========================
// LAPTOP QUEUE (offline Claude-run fallback)
// ========================

export interface LaptopQueueRow {
  id: number;
  project: string;
  prompt: string;
  reason: string | null;
  chat_id: number;
  created_at: number;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  started_at: number | null;
  finished_at: number | null;
  output: string | null;
  layer: "claude-code" | "tech-company";
  /** Set when the task answers a Control run (a queued deploy); null for rows from before the link columns. */
  control_run_id: string | null;
  offer_id: string | null;
}

export function enqueueLaptopTask(
  project: string,
  prompt: string,
  reason: string,
  chatId: number,
  layer: "claude-code" | "tech-company" = "claude-code",
  link: { controlRunId?: string; offerId?: string } = {},
): number {
  const result = db
    .prepare(
      `INSERT INTO laptop_queue (project, prompt, reason, chat_id, created_at, status, layer, control_run_id, offer_id)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(project, prompt, reason || null, chatId, Date.now(), layer, link.controlRunId ?? null, link.offerId ?? null);
  return Number(result.lastInsertRowid);
}

export const laptopTaskOpenForRun = (controlRunId: string): boolean => laptopOpen(db, controlRunId);

// ========================
// SDK REPLIES (layer 1: sdk-quick)
// ========================

export interface SdkReplyRow {
  id: number;
  wa_jid: string;
  sender_name: string | null;
  content_preview: string;
  layer: string;
  provider: string;
  model: string;
  reply: string;
  undo: number;
  corrected: number;
  fallback_reason: string | null;
  latency_ms: number | null;
  created_at: number;
}

export function insertSdkReply(row: {
  wa_jid: string;
  sender_name: string | null;
  content_preview: string;
  layer: string;
  provider: string;
  model: string;
  reply: string;
  fallback_reason?: string | null;
  latency_ms?: number | null;
}): number {
  const result = db
    .prepare(
      `INSERT INTO sdk_replies (wa_jid, sender_name, content_preview, layer, provider, model, reply, fallback_reason, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.wa_jid,
      row.sender_name,
      row.content_preview.slice(0, 400),
      row.layer,
      row.provider,
      row.model,
      row.reply,
      row.fallback_reason ?? null,
      row.latency_ms ?? null,
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

export function getSdkReply(id: number): SdkReplyRow | undefined {
  return db.prepare(`SELECT * FROM sdk_replies WHERE id = ?`).get(id) as
    | SdkReplyRow
    | undefined;
}

export function markSdkReplyUndo(id: number): void {
  db.prepare(`UPDATE sdk_replies SET undo = 1 WHERE id = ?`).run(id);
}

export function markSdkReplyCorrected(id: number, newReply: string): void {
  db.prepare(`UPDATE sdk_replies SET corrected = 1, reply = ? WHERE id = ?`).run(
    newReply,
    id,
  );
}

export function nextPendingLaptopTask(): LaptopQueueRow | undefined {
  return db
    .prepare(
      `SELECT * FROM laptop_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as LaptopQueueRow | undefined;
}

export function countPendingLaptopTasks(): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM laptop_queue WHERE status = 'pending'`)
    .get() as { n: number };
  return row.n;
}

export function markLaptopTaskRunning(id: number): void {
  db.prepare(`UPDATE laptop_queue SET status = 'running', started_at = ? WHERE id = ?`).run(
    Date.now(),
    id,
  );
}

export function finishLaptopTask(id: number, ok: boolean, output: string): void {
  db.prepare(
    `UPDATE laptop_queue SET status = ?, finished_at = ?, output = ? WHERE id = ?`,
  ).run(ok ? "done" : "failed", Date.now(), output.slice(0, 50_000), id);
}

export function listLaptopQueue(limit = 20): LaptopQueueRow[] {
  return db
    .prepare(`SELECT * FROM laptop_queue ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as LaptopQueueRow[];
}

// ========================
// LAPTOP PENDING CONFIRMATIONS
// ========================

export function createLaptopPending(id: string, chatId: number, cmd: string, dbOverride?: import("better-sqlite3").Database): void {
  const d = dbOverride ?? db;
  d.prepare("INSERT INTO laptop_pending (id, chat_id, cmd, created_at) VALUES (?, ?, ?, ?)").run(id, chatId, cmd, Date.now());
}

export function getLaptopPending(id: string, dbOverride?: import("better-sqlite3").Database): { id: string; chat_id: number; cmd: string; created_at: number } | undefined {
  const d = dbOverride ?? db;
  return d.prepare("SELECT id, chat_id, cmd, created_at FROM laptop_pending WHERE id = ?").get(id) as any;
}

export function deleteLaptopPending(id: string, dbOverride?: import("better-sqlite3").Database): void {
  const d = dbOverride ?? db;
  d.prepare("DELETE FROM laptop_pending WHERE id = ?").run(id);
}

export function purgeExpiredLaptopPending(olderThanMs: number, dbOverride?: import("better-sqlite3").Database): number {
  const d = dbOverride ?? db;
  const cutoff = Date.now() - olderThanMs;
  return ((d.prepare("DELETE FROM laptop_pending WHERE created_at < ?").run(cutoff)) as any).changes ?? 0;
}

// ========================
// VOICE COACH HELPERS (006-voice-coach)
// ========================

export interface UnscoredAudioRow {
  id: number;
  jid: string;
  sender: string | null;
  sender_name: string | null;
  transcription: string;
  duration_seconds: number | null;
  wpm: number | null;
  timestamp: number | null;
  coach_analyzed_at: number | null;
}

export function listUnscoredOutgoingAudio(limit = 20): UnscoredAudioRow[] {
  return db.prepare(`
    SELECT id, jid, sender, sender_name, transcription, duration_seconds, wpm, timestamp, coach_analyzed_at
    FROM whatsapp_messages
    WHERE from_me = 1
      AND message_type = 'audio'
      AND transcription IS NOT NULL
      AND transcription != ''
      AND coach_analyzed_at IS NULL
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as UnscoredAudioRow[];
}

export function getCoachRow(id: number): UnscoredAudioRow | undefined {
  return db.prepare(`
    SELECT id, jid, sender, sender_name, transcription, duration_seconds, wpm, timestamp, coach_analyzed_at
    FROM whatsapp_messages WHERE id = ?
  `).get(id) as UnscoredAudioRow | undefined;
}

export function markCoachVerdict(id: number, coherence: string, reason: string, analyzedAt: number): void {
  db.prepare(
    "UPDATE whatsapp_messages SET coherence = ?, coach_reason = ?, coach_analyzed_at = ? WHERE id = ?"
  ).run(coherence, reason, analyzedAt, id);
}

export function updateWATranscriptionWithDuration(id: number, transcription: string, durationSeconds: number | null, wpm: number | null): void {
  db.prepare(
    "UPDATE whatsapp_messages SET transcription = ?, duration_seconds = ?, wpm = ?, content = content || ' [Transcription: ' || ? || ']' WHERE id = ?"
  ).run(transcription, durationSeconds ?? null, wpm ?? null, transcription, id);
}

export function getCoachRowsForRange(range: "today" | "week" | "all", coherenceFilter?: string[]): any[] {
  const tz = process.env.TIMEZONE || "Africa/Casablanca";
  const modifier = sqliteTzModifier ? `, '${sqliteTzModifier()}'` : "";
  let dateClause = "";
  if (range === "today") {
    dateClause = `AND date(coach_analyzed_at, 'unixepoch'${modifier}) = date('now'${modifier})`;
  } else if (range === "week") {
    dateClause = `AND date(coach_analyzed_at, 'unixepoch'${modifier}) >= date('now', '-7 days'${modifier})`;
  }
  const cohClause = coherenceFilter && coherenceFilter.length > 0
    ? `AND coherence IN (${coherenceFilter.map(() => "?").join(",")})`
    : "";
  const params: any[] = coherenceFilter ? [...coherenceFilter] : [];
  return db.prepare(`
    SELECT id, jid, sender_name, transcription, duration_seconds, wpm, coherence, coach_reason, coach_analyzed_at
    FROM whatsapp_messages
    WHERE from_me = 1
      AND message_type = 'audio'
      AND coach_analyzed_at IS NOT NULL
      ${dateClause}
      ${cohClause}
    ORDER BY coach_analyzed_at DESC
  `).all(...params) as any[];
}

// ========================
// CHAT ANALYZER HELPERS (009-chat-analyzer)
// ========================

export interface UnclassifiedMessage {
  id: number;
  jid: string;
  sender_name: string | null;
  content: string | null;
  transcription: string | null;
  message_type: string;
  timestamp: number;
}

export function getUnclassifiedMessages(limit: number): UnclassifiedMessage[] {
  return db.prepare(`
    SELECT wm.id, wm.jid, wm.sender_name, wm.content, wm.transcription, wm.message_type, wm.timestamp
    FROM whatsapp_messages wm
    LEFT JOIN message_sentiment ms ON wm.id = ms.message_id
    WHERE ms.message_id IS NULL
    ORDER BY wm.id DESC
    LIMIT ?
  `).all(limit) as UnclassifiedMessage[];
}

export function insertSentiment(messageId: number, sentiment: string, confidence: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO message_sentiment (message_id, sentiment, confidence) VALUES (?, ?, ?)"
  ).run(messageId, sentiment, confidence);
}

export function getSentimentAggregation(startDate: string, endDate: string): any[] {
  return db.prepare(`
    SELECT date(wm.timestamp, 'unixepoch', '+3 hours') as date,
      SUM(CASE WHEN ms.sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
      SUM(CASE WHEN ms.sentiment = 'negative' THEN 1 ELSE 0 END) as negative,
      SUM(CASE WHEN ms.sentiment = 'neutral' THEN 1 ELSE 0 END) as neutral
    FROM whatsapp_messages wm
    JOIN message_sentiment ms ON wm.id = ms.message_id
    WHERE date(wm.timestamp, 'unixepoch', '+3 hours') BETWEEN ? AND ?
    GROUP BY date
    ORDER BY date
  `).all(startDate, endDate) as any[];
}

export function getSentimentByContact(): any[] {
  return db.prepare(`
    SELECT wm.jid, MAX(wm.sender_name) as sender_name,
      SUM(CASE WHEN ms.sentiment = 'positive' THEN 1 ELSE 0 END) as positive,
      SUM(CASE WHEN ms.sentiment = 'negative' THEN 1 ELSE 0 END) as negative,
      SUM(CASE WHEN ms.sentiment = 'neutral' THEN 1 ELSE 0 END) as neutral,
      COUNT(*) as total
    FROM whatsapp_messages wm
    JOIN message_sentiment ms ON wm.id = ms.message_id
    GROUP BY wm.jid
    ORDER BY total DESC
  `).all() as any[];
}

export interface MessageTimestamp {
  id: number;
  jid: string;
  sender_name: string | null;
  timestamp: number;
  from_me: number;
  content: string | null;
}

export function getAllMessageTimestamps(limit: number): MessageTimestamp[] {
  return db.prepare(`
    SELECT id, jid, sender_name, timestamp, from_me, content
    FROM whatsapp_messages
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as MessageTimestamp[];
}

export function getMessageLengths(): any[] {
  const tz = process.env.TIMEZONE || "Africa/Casablanca";
  return db.prepare(`
    SELECT date(timestamp, 'unixepoch', '+3 hours') as date,
      ROUND(AVG(LENGTH(content))) as avgChars,
      COUNT(*) as count
    FROM whatsapp_messages
    WHERE content IS NOT NULL AND LENGTH(content) > 0
    GROUP BY date
    ORDER BY date
  `).all() as any[];
}

// ---------------------------------------------------------------------------
// Shop group sales — read straight from whatsapp_messages (source of truth).
// shop_sale_items only holds what the live tracker captured; the group JID has
// changed at least once, so the message log is the authoritative history.
// ---------------------------------------------------------------------------
export interface ShopGroupMessage {
  id: number;
  jid: string;
  sender: string | null;
  sender_name: string | null;
  content: string | null;
  message_type: string | null;
  transcription: string | null;
  timestamp: number;
}

export function getShopGroupMessages(jids: string[]): ShopGroupMessage[] {
  if (!jids.length) return [];
  const placeholders = jids.map(() => "?").join(",");
  return db.prepare(`
    SELECT id, jid, sender, sender_name, content, message_type, transcription, timestamp
    FROM whatsapp_messages
    WHERE jid IN (${placeholders})
      AND from_me = 0
      AND timestamp IS NOT NULL
    ORDER BY timestamp ASC
  `).all(...jids) as ShopGroupMessage[];
}

/**
 * Unix seconds of the most recent WhatsApp message ever stored, or null.
 *
 * Used by the ingestion watchdog in whatsapp.ts: the socket can report itself
 * connected while delivering nothing, so the only trustworthy health signal is
 * whether rows are still arriving.
 */
export function getLastWhatsAppMessageTs(): number | null {
  const row = db
    .prepare("SELECT MAX(timestamp) AS last FROM whatsapp_messages")
    .get() as { last: number | null } | undefined;
  return row?.last ?? null;
}

// ========================
// WhatsApp media gallery
// ========================

export interface WAMediaRow {
  id: number;
  jid: string;
  sender_name: string | null;
  from_me: number;
  is_group: number;
  timestamp: number;
  message_type: string;
  media_path: string;
  content: string | null;
}

export function getWAMediaPage(opts: { types: string[]; jid?: string; beforeId?: number; limit: number }): WAMediaRow[] {
  const where = [`message_type IN (${opts.types.map(() => "?").join(",")})`, "media_path IS NOT NULL"];
  const params: (string | number)[] = [...opts.types];
  if (opts.jid) { where.push("jid = ?"); params.push(opts.jid); }
  if (opts.beforeId) { where.push("id < ?"); params.push(opts.beforeId); }
  return db.prepare(
    `SELECT id, jid, sender_name, from_me, is_group, timestamp, message_type, media_path, content
     FROM whatsapp_messages WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`
  ).all(...params, opts.limit) as WAMediaRow[];
}

export function getAllWAMediaPaths(): { id: number; jid: string; media_path: string; sender_name: string | null; from_me: number; is_group: number }[] {
  return db.prepare(
    `SELECT id, jid, media_path, sender_name, from_me, is_group FROM whatsapp_messages
     WHERE message_type IN ('image', 'video') AND media_path IS NOT NULL ORDER BY id DESC`
  ).all() as any[];
}

export function getWAMediaByIds(ids: number[]): { id: number; message_type: string; media_path: string | null }[] {
  if (ids.length === 0) return [];
  return db.prepare(
    `SELECT id, message_type, media_path FROM whatsapp_messages WHERE id IN (${ids.map(() => "?").join(",")})`
  ).all(...ids) as any[];
}

export function clearWAMessageMedia(id: number) {
  db.prepare("UPDATE whatsapp_messages SET media_path = NULL WHERE id = ?").run(id);
}

// ========================
// PRODUCTS — supplier catalog synced from WhatsApp image bursts (products-catalog)
// ========================

export interface ProductRow {
  id: number;
  message_id: number;
  jid: string;
  media_file: string;
  title: string | null;
  brand: string | null;
  price: number | null;
  currency: string;
  price_source: string;
  confidence: string;
  batch_id: string | null;
  price_message_id: number | null;
  status: string;
  notes: string | null;
  timestamp: number;
  created_at: string;
  updated_at: string | null;
}

export interface ProductWithCaption extends ProductRow {
  caption: string | null;
}

export interface RawJidMessage {
  id: number;
  jid: string;
  content: string | null;
  type: string;
  from_me: number;
  timestamp: number;
  media_path: string | null;
  transcription: string | null;
  wa_msg_id: string | null;
  quoted_msg_id: string | null;
}

/** Contacts flagged as a product supplier (see D2 — gate on a flag, not a hardcoded jid). */
export function getSupplierJids(): string[] {
  return (db.prepare("SELECT jid FROM whatsapp_contacts WHERE supplier = 1").all() as { jid: string }[]).map((r) => r.jid);
}

/** Every message for a jid, oldest first — the full context pairPrices needs to build runs correctly. */
export function getMessagesForJid(jid: string): RawJidMessage[] {
  return db.prepare(
    `SELECT id, jid, content, message_type AS type, from_me, timestamp, media_path, transcription, wa_msg_id, quoted_msg_id
     FROM whatsapp_messages WHERE jid = ? ORDER BY id`
  ).all(jid) as RawJidMessage[];
}

/** message_id -> price_source, for the whole products table. Used to protect manual rows and to count "added" during sync. */
export function getExistingProductSources(): Map<number, string> {
  const rows = db.prepare("SELECT message_id, price_source FROM products").all() as { message_id: number; price_source: string }[];
  const map = new Map<number, string>();
  for (const r of rows) map.set(r.message_id, r.price_source);
  return map;
}

export interface ProductUpsert {
  messageId: number;
  jid: string;
  mediaFile: string;
  title: string;
  brand: string | null;
  price: number | null;
  priceSource: string;
  confidence: string;
  batchId: string;
  priceMessageId: number | null;
  timestamp: number;
}

/**
 * Bulk upsert in one transaction. Never overwrites a row whose price_source
 * is 'manual' — the user's correction always wins over a re-sync.
 */
export function upsertProducts(rows: ProductUpsert[]): void {
  const insert = db.prepare(`
    INSERT INTO products (message_id, jid, media_file, title, brand, price, currency, price_source, confidence, batch_id, price_message_id, status, timestamp, updated_at)
    VALUES (@messageId, @jid, @mediaFile, @title, @brand, @price, 'DH', @priceSource, @confidence, @batchId, @priceMessageId, 'new', @timestamp, datetime('now'))
    ON CONFLICT(message_id) DO UPDATE SET
      title = excluded.title,
      brand = excluded.brand,
      price = excluded.price,
      price_source = excluded.price_source,
      confidence = excluded.confidence,
      batch_id = excluded.batch_id,
      price_message_id = excluded.price_message_id,
      updated_at = datetime('now')
    WHERE products.price_source <> 'manual'
  `);
  const tx = db.transaction((items: ProductUpsert[]) => {
    for (const r of items) insert.run(r as any);
  });
  tx(rows);
}

function orderByForProducts(sort: string | undefined): string {
  switch (sort) {
    case "price_asc": return "ORDER BY (p.price IS NULL), p.price ASC";
    case "price_desc": return "ORDER BY (p.price IS NULL), p.price DESC";
    case "name_asc": return "ORDER BY p.title COLLATE NOCASE ASC";
    case "name_desc": return "ORDER BY p.title COLLATE NOCASE DESC";
    case "date_asc": return "ORDER BY p.timestamp ASC";
    case "date_desc":
    default: return "ORDER BY p.timestamp DESC";
  }
}

export interface ListProductsOpts {
  sort?: string;
  q?: string;
  min?: number;
  max?: number;
  status?: string; // 'new' | 'kept' | 'hidden' | 'all', default excludes hidden
  unpriced?: boolean;
  batch?: string;
  limit: number;
  offset: number;
}

export function listProducts(opts: ListProductsOpts): { items: ProductWithCaption[]; total: number } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts.status === "new" || opts.status === "kept" || opts.status === "hidden") {
    where.push("p.status = @status");
    params.status = opts.status;
  } else if (opts.status !== "all") {
    where.push("p.status <> 'hidden'");
  }
  if (opts.unpriced) where.push("p.price IS NULL");
  if (opts.min !== undefined) { where.push("p.price >= @min"); params.min = opts.min; }
  if (opts.max !== undefined) { where.push("p.price <= @max"); params.max = opts.max; }
  if (opts.batch) { where.push("p.batch_id = @batch"); params.batch = opts.batch; }
  if (opts.q) { where.push("(p.title LIKE @q OR p.brand LIKE @q OR m.content LIKE @q)"); params.q = `%${opts.q}%`; }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderSql = orderByForProducts(opts.sort);

  const total = (db.prepare(
    `SELECT COUNT(*) AS c FROM products p LEFT JOIN whatsapp_messages m ON m.id = p.message_id ${whereSql}`
  ).get(params) as { c: number }).c;

  const items = db.prepare(
    `SELECT p.*, m.content AS caption FROM products p LEFT JOIN whatsapp_messages m ON m.id = p.message_id
     ${whereSql} ${orderSql} LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: opts.limit, offset: opts.offset }) as ProductWithCaption[];

  return { items, total };
}

export function getProductStats(): {
  total: number; priced: number; unpriced: number; lowConfidence: number;
  minPrice: number | null; maxPrice: number | null; batches: number;
} {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
           SUM(CASE WHEN price IS NULL THEN 1 ELSE 0 END) AS unpriced,
           SUM(CASE WHEN confidence = 'low' THEN 1 ELSE 0 END) AS lowConfidence,
           MIN(price) AS minPrice, MAX(price) AS maxPrice,
           COUNT(DISTINCT batch_id) AS batches
    FROM products WHERE status <> 'hidden'
  `).get() as any;
  return {
    total: row.total ?? 0,
    priced: row.priced ?? 0,
    unpriced: row.unpriced ?? 0,
    lowConfidence: row.lowConfidence ?? 0,
    minPrice: row.minPrice ?? null,
    maxPrice: row.maxPrice ?? null,
    batches: row.batches ?? 0,
  };
}

export function getProduct(id: number): ProductRow | undefined {
  return db.prepare("SELECT * FROM products WHERE id = ?").get(id) as ProductRow | undefined;
}

export function updateProductFields(id: number, fields: {
  price?: number | null; title?: string; brand?: string | null; status?: string; notes?: string;
}): ProductRow | undefined {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (fields.price !== undefined) {
    sets.push("price = @price", "price_source = 'manual'", "confidence = 'high'");
    params.price = fields.price;
  }
  if (fields.title !== undefined) { sets.push("title = @title"); params.title = fields.title; }
  if (fields.brand !== undefined) { sets.push("brand = @brand"); params.brand = fields.brand; }
  if (fields.status !== undefined) { sets.push("status = @status"); params.status = fields.status; }
  if (fields.notes !== undefined) { sets.push("notes = @notes"); params.notes = fields.notes; }
  if (sets.length === 0) return getProduct(id);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = @id`).run(params);
  return getProduct(id);
}

export function listProductBatches(): {
  batchId: string; date: string; imageCount: number; priceCount: number; unpriced: number; confidence: "high" | "low";
}[] {
  const rows = db.prepare(`
    SELECT batch_id AS batchId, MIN(timestamp) AS ts,
           COUNT(*) AS imageCount,
           SUM(CASE WHEN price IS NOT NULL THEN 1 ELSE 0 END) AS priceCount,
           SUM(CASE WHEN price IS NULL THEN 1 ELSE 0 END) AS unpriced,
           SUM(CASE WHEN confidence = 'low' THEN 1 ELSE 0 END) AS lowCount
    FROM products WHERE batch_id IS NOT NULL AND status <> 'hidden'
    GROUP BY batch_id ORDER BY ts DESC
  `).all() as any[];
  return rows.map((r) => ({
    batchId: r.batchId,
    date: new Date(r.ts * 1000).toISOString().slice(0, 10),
    imageCount: r.imageCount,
    priceCount: r.priceCount,
    unpriced: r.unpriced,
    confidence: r.lowCount > 0 ? "low" : "high",
  }));
}

export function getBatchImages(batchId: string): ProductWithCaption[] {
  return db.prepare(`
    SELECT p.*, m.content AS caption FROM products p LEFT JOIN whatsapp_messages m ON m.id = p.message_id
    WHERE p.batch_id = ? ORDER BY p.timestamp ASC, p.message_id ASC
  `).all(batchId) as ProductWithCaption[];
}

/** All products in a batch, keyed by jid — used to know which jid's raw messages to re-scan for the batch's full price run. */
export function getBatchJid(batchId: string): string | undefined {
  const row = db.prepare("SELECT jid FROM products WHERE batch_id = ? LIMIT 1").get(batchId) as { jid: string } | undefined;
  return row?.jid;
}

/** Full re-assignment for a batch: sets price/price_source/confidence for every product named, and clears price for everything else in the batch. */
export function assignBatchPairs(batchId: string, pairs: { productId: number; priceMessageId: number }[]): number {
  const priceRow = db.prepare("SELECT content FROM whatsapp_messages WHERE id = ?");
  const clearAll = db.prepare(
    "UPDATE products SET price = NULL, price_message_id = NULL, price_source = 'manual', confidence = 'high', updated_at = datetime('now') WHERE batch_id = ?"
  );
  const setPair = db.prepare(
    "UPDATE products SET price = @price, price_message_id = @priceMessageId, price_source = 'manual', confidence = 'high', updated_at = datetime('now') WHERE id = @productId AND batch_id = @batchId"
  );
  let updated = 0;
  const tx = db.transaction(() => {
    clearAll.run(batchId);
    for (const pair of pairs) {
      const row = priceRow.get(pair.priceMessageId) as { content: string } | undefined;
      const value = row ? Number(String(row.content).trim().replace(",", ".")) : null;
      if (value === null || !Number.isFinite(value)) continue;
      const info = setPair.run({ price: value, priceMessageId: pair.priceMessageId, productId: pair.productId, batchId });
      if (info.changes > 0) updated++;
    }
  });
  tx();
  return updated;
}

// ========================
// Dashboard password (set from the Settings modal)
// ========================
// No row = the password is still DASHBOARD_PASS from .env.
db.exec(`CREATE TABLE IF NOT EXISTS dashboard_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
)`);

// ========================
// OBLIGATIONS — money owed: recurring bills (rent) and loans with a balance.
// The date maths and status live in src/obligations.ts; this only stores rows.
// ========================
db.exec(`
  CREATE TABLE IF NOT EXISTS obligations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('bill','loan')),
    counterparty TEXT,
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'DH',
    due_day INTEGER,
    principal REAL,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS obligation_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    obligation_id INTEGER NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    paid_at TEXT NOT NULL,
    period TEXT,
    proof_path TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_oblig_pay ON obligation_payments(obligation_id);
  -- One reminder per obligation per period per stage, so a daily cron cannot
  -- send the same nudge twice.
  CREATE TABLE IF NOT EXISTS obligation_reminders (
    obligation_id INTEGER NOT NULL,
    period TEXT NOT NULL,
    stage TEXT NOT NULL,
    sent_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (obligation_id, period, stage)
  );
`);

export function listObligations(includeInactive = false) {
  const where = includeInactive ? "" : "WHERE active = 1";
  return db.prepare(`SELECT * FROM obligations ${where} ORDER BY kind, name`).all() as import("./obligations").Obligation[];
}

export function getObligation(id: number) {
  return db.prepare("SELECT * FROM obligations WHERE id = ?").get(id) as import("./obligations").Obligation | undefined;
}

export function addObligation(o: {
  name: string; kind: "bill" | "loan"; counterparty?: string | null; amount?: number;
  currency?: string; dueDay?: number | null; principal?: number | null; notes?: string | null;
}) {
  return db.prepare(`
    INSERT INTO obligations (name, kind, counterparty, amount, currency, due_day, principal, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(o.name, o.kind, o.counterparty ?? null, o.amount ?? 0, o.currency ?? "DH",
         o.dueDay ?? null, o.principal ?? null, o.notes ?? null);
}

/** Edit the fields a person can change later: amounts move, landlords change. */
export function updateObligation(id: number, fields: {
  name?: string; counterparty?: string | null; amount?: number; currency?: string;
  dueDay?: number | null; principal?: number | null; notes?: string | null;
}) {
  const cols: Record<string, unknown> = {};
  if (fields.name !== undefined) cols.name = fields.name;
  if (fields.counterparty !== undefined) cols.counterparty = fields.counterparty;
  if (fields.amount !== undefined) cols.amount = fields.amount;
  if (fields.currency !== undefined) cols.currency = fields.currency;
  if (fields.dueDay !== undefined) cols.due_day = fields.dueDay;
  if (fields.principal !== undefined) cols.principal = fields.principal;
  if (fields.notes !== undefined) cols.notes = fields.notes;
  const keys = Object.keys(cols);
  if (keys.length === 0) return;
  return db.prepare(`UPDATE obligations SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => cols[k]), id);
}

export function setObligationActive(id: number, active: boolean) {
  return db.prepare("UPDATE obligations SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

export function deleteObligation(id: number) {
  db.prepare("DELETE FROM obligation_payments WHERE obligation_id = ?").run(id);
  return db.prepare("DELETE FROM obligations WHERE id = ?").run(id);
}

export function listObligationPayments(obligationId?: number) {
  const sql = obligationId
    ? "SELECT * FROM obligation_payments WHERE obligation_id = ? ORDER BY paid_at DESC, id DESC"
    : "SELECT * FROM obligation_payments ORDER BY paid_at DESC, id DESC";
  const rows = obligationId ? db.prepare(sql).all(obligationId) : db.prepare(sql).all();
  return rows as import("./obligations").Payment[];
}

export function addObligationPayment(p: {
  obligationId: number; amount: number; paidAt: string; period?: string | null;
  proofPath?: string | null; note?: string | null;
}) {
  return db.prepare(`
    INSERT INTO obligation_payments (obligation_id, amount, paid_at, period, proof_path, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(p.obligationId, p.amount, p.paidAt, p.period ?? null, p.proofPath ?? null, p.note ?? null);
}

export function deleteObligationPayment(id: number) {
  return db.prepare("DELETE FROM obligation_payments WHERE id = ?").run(id);
}

/** True when this exact nudge has not been sent yet, and records it. */
export function claimObligationReminder(obligationId: number, period: string, stage: string): boolean {
  const done = db.prepare("SELECT 1 FROM obligation_reminders WHERE obligation_id = ? AND period = ? AND stage = ?")
    .get(obligationId, period, stage);
  if (done) return false;
  db.prepare("INSERT INTO obligation_reminders (obligation_id, period, stage) VALUES (?, ?, ?)")
    .run(obligationId, period, stage);
  return true;
}

// Dashboard sessions live here, not in memory: a pm2 restart used to sign every
// device out. Only the SHA-256 of a token is stored, so the file cannot hand
// anyone a usable cookie.
db.exec(`CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`);

export function saveDashboardSession(tokenHash: string, expiresAt: number): void {
  db.prepare("INSERT OR REPLACE INTO dashboard_sessions (token_hash, expires_at) VALUES (?, ?)").run(tokenHash, expiresAt);
}

/** Expiry timestamp, or undefined when unknown. Expired rows are dropped as they are read. */
export function getDashboardSession(tokenHash: string): number | undefined {
  const row = db.prepare("SELECT expires_at FROM dashboard_sessions WHERE token_hash = ?").get(tokenHash) as { expires_at: number } | undefined;
  if (!row) return undefined;
  if (Date.now() > row.expires_at) {
    db.prepare("DELETE FROM dashboard_sessions WHERE token_hash = ?").run(tokenHash);
    return undefined;
  }
  return row.expires_at;
}

/** Sign out every device, except the one whose token hash is kept. */
export function clearDashboardSessions(keepTokenHash?: string): void {
  if (keepTokenHash) db.prepare("DELETE FROM dashboard_sessions WHERE token_hash <> ?").run(keepTokenHash);
  else db.prepare("DELETE FROM dashboard_sessions").run();
}

export function pruneDashboardSessions(): number {
  return db.prepare("DELETE FROM dashboard_sessions WHERE expires_at < ?").run(Date.now()).changes;
}

export function getDashboardPasswordHash(): { salt: string; hash: string } | undefined {
  return db.prepare("SELECT salt, hash FROM dashboard_auth WHERE id = 1").get() as { salt: string; hash: string } | undefined;
}

export function setDashboardPasswordHash(salt: string, hash: string) {
  db.prepare(
    `INSERT INTO dashboard_auth (id, salt, hash, updated_at) VALUES (1, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET salt = excluded.salt, hash = excluded.hash, updated_at = excluded.updated_at`
  ).run(salt, hash);
}

export interface ForwardTarget {
  jid: string;
  name: string;
  isGroup: boolean;
  lastActive: number;
}

/**
 * Chats you can forward products to, read from the message history.
 *
 * The obvious source, getWhatsAppChats() in whatsapp.ts, is an in-memory Map
 * that only fills as messages arrive, so it is empty after every restart --
 * which made the forward picker show a handful of contacts instead of the 222
 * that exist. Forwarding is a deliberate action taken long after a chat was
 * last active, so the target list has to come from durable storage.
 *
 * Name precedence: the name you gave the contact, else the most recent
 * sender_name WhatsApp reported, else the raw jid.
 */
export function listForwardTargets(limit = 300): ForwardTarget[] {
  return db
    .prepare(
      `SELECT m.jid                                            AS jid,
              COALESCE(
                NULLIF(TRIM(c.display_name), ''),
                NULLIF(TRIM((SELECT sender_name FROM whatsapp_messages s
                             WHERE s.jid = m.jid AND s.from_me = 0
                               AND TRIM(COALESCE(s.sender_name, '')) <> ''
                             ORDER BY s.timestamp DESC LIMIT 1)), ''),
                m.jid
              )                                                AS name,
              MAX(m.timestamp)                                 AS lastActive,
              CASE WHEN m.jid LIKE '%@g.us' THEN 1 ELSE 0 END  AS isGroup
         FROM whatsapp_messages m
         LEFT JOIN whatsapp_contacts c ON c.jid = m.jid
        GROUP BY m.jid
        ORDER BY lastActive DESC
        LIMIT ?`,
    )
    .all(limit)
    .map((r: any) => ({
      jid: r.jid as string,
      name: r.name as string,
      isGroup: r.isGroup === 1,
      lastActive: (r.lastActive as number) ?? 0,
    }));
}
