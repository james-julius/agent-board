import { DurableObject } from "cloudflare:workers";
import { createTwoFilesPatch, diffLines } from "diff";
import { findSecret } from "./secrets";

export type AskStatus = "open" | "taken" | "done";

export type Message = {
  id: number;
  author: string;
  kind: "message" | "doc";
  title: string | null;
  body: string;
  reply_to: number | null;
  doc: string | null;
  doc_version: number | null;
  created_at: string;
  // Set when the message is an ask: a request someone should act on.
  ask_status: AskStatus | null;
  ask_to: string | null;
  taken_by: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
};

export type DocVersion = {
  name: string;
  version: number;
  author: string;
  note: string | null;
  created_at: string;
  bytes: number;
};

export type Member = {
  name: string;
  role: "owner" | "member";
  created_at: string;
  revoked_at: string | null;
};

export type Session = { label: string | null; name: string; role: Member["role"] };

// The status rides in the message text because only the message survives a Durable Object RPC hop.
export class BoardError extends Error {
  constructor(status: number, message: string) {
    super(`${status} ${message}`);
  }
}

export function splitError(e: unknown): { status: number; message: string } {
  const text = e instanceof Error ? e.message : String(e);
  const m = /^(\d{3}) ([\s\S]*)$/.exec(text);
  return m ? { status: Number(m[1]), message: m[2] } : { status: 500, message: text };
}

const MAX_BODY = 1_000_000;
const MAX_DOC = 1_500_000;
const MAX_STORED_DIFF = 200_000;
const NEW_SESSION_LOOKBACK_MS = 24 * 3600 * 1000;
const ASK_COLUMNS = ["ask_status TEXT", "ask_to TEXT", "taken_by TEXT", "resolved_by TEXT", "resolved_at TEXT", "resolution TEXT"];
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const DOC_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-\/]{0,99}$/;

export function cleanAgentName(raw: string | null | undefined): string {
  const name = (raw ?? "").trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new BoardError(400, "Invalid name: use lowercase letters, digits, . _ - (max 40), e.g. alex-frontend.");
  }
  return name;
}

function cleanDocName(raw: string | null | undefined): string {
  const name = (raw ?? "").trim();
  if (!DOC_RE.test(name)) throw new BoardError(400, "Invalid doc name (letters, digits, . _ - /, max 100).");
  return name;
}

function refuseSecrets(...texts: (string | null | undefined)[]) {
  for (const t of texts) {
    const hit = findSecret(t);
    if (hit) {
      throw new BoardError(422, `Refused: this looks like it contains a credential (${hit}). Remove it and post again. Never share secrets on the board.`);
    }
  }
}

export class Room extends DurableObject<object> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS members (
        name TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS invites (
        code_hash TEXT PRIMARY KEY,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_by TEXT,
        used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT,
        body TEXT NOT NULL,
        reply_to INTEGER,
        doc TEXT,
        doc_version INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursors (reader TEXT PRIMARY KEY, last_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS docs (
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        author TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (name, version)
      );
    `);
    const have = new Set(this.sql.exec<{ name: string }>("PRAGMA table_info(messages)").toArray().map((c) => c.name));
    for (const col of ASK_COLUMNS) {
      if (!have.has(col.split(" ")[0])) this.sql.exec(`ALTER TABLE messages ADD COLUMN ${col}`);
    }
  }

  // ---- membership ----

  async init(input: { label: string | null; owner: string; ownerTokenHash: string; inviteHash: string }): Promise<void> {
    if (this.meta("created_at")) throw new BoardError(409, "Room already exists.");
    const owner = cleanAgentName(input.owner);
    const now = new Date().toISOString();
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('created_at', ?)", now);
    if (input.label) this.sql.exec("INSERT INTO meta (k, v) VALUES ('label', ?)", input.label.slice(0, 100));
    this.sql.exec("INSERT INTO members (name, token_hash, role, created_at) VALUES (?, ?, 'owner', ?)", owner, input.ownerTokenHash, now);
    this.insertInvite(owner, input.inviteHash);
  }

  async session(tokenHash: string): Promise<Session> {
    const m = this.sql
      .exec<{ name: string; role: Member["role"] }>("SELECT name, role FROM members WHERE token_hash = ? AND revoked_at IS NULL", tokenHash)
      .toArray()[0];
    if (!m) throw new BoardError(401, "Invalid or revoked access token.");
    return { label: this.meta("label"), name: m.name, role: m.role };
  }

  async createInvite(by: string, codeHash: string): Promise<{ expires_at: string }> {
    this.requireOwner(by);
    return { expires_at: this.insertInvite(by, codeHash) };
  }

  async inviteInfo(codeHash: string): Promise<{ label: string | null; invited_by: string; expires_at: string }> {
    const inv = this.usableInvite(codeHash);
    return { label: this.meta("label"), invited_by: inv.created_by, expires_at: inv.expires_at };
  }

  async redeemInvite(codeHash: string, rawName: string, tokenHash: string): Promise<Session> {
    this.usableInvite(codeHash);
    const name = cleanAgentName(rawName);
    const existing = this.sql.exec<Member>("SELECT * FROM members WHERE name = ?", name).toArray()[0];
    if (existing && !existing.revoked_at) throw new BoardError(409, `The name "${name}" is already taken in this room. Pick another.`);
    const now = new Date().toISOString();
    if (existing) {
      // Re-inviting someone whose access was revoked.
      this.sql.exec("UPDATE members SET token_hash = ?, revoked_at = NULL, created_at = ? WHERE name = ?", tokenHash, now, name);
    } else {
      this.sql.exec("INSERT INTO members (name, token_hash, role, created_at) VALUES (?, ?, 'member', ?)", name, tokenHash, now);
    }
    this.sql.exec("UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ?", name, now, codeHash);
    return { label: this.meta("label"), name, role: "member" };
  }

  async listMembers(): Promise<Member[]> {
    return this.sql.exec<Member>("SELECT name, role, created_at, revoked_at FROM members ORDER BY created_at").toArray();
  }

  async revokeMember(by: string, rawName: string): Promise<void> {
    this.requireOwner(by);
    const name = cleanAgentName(rawName);
    if (name === by) throw new BoardError(400, "You can't revoke yourself. Rotate your token instead.");
    const r = this.sql.exec("UPDATE members SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL", new Date().toISOString(), name);
    if (!r.rowsWritten) throw new BoardError(404, `No active member named "${name}".`);
  }

  async rotateToken(name: string, newTokenHash: string): Promise<void> {
    this.sql.exec("UPDATE members SET token_hash = ? WHERE name = ? AND revoked_at IS NULL", newTokenHash, name);
  }

  // ---- messages ----

  async post(input: { from: string; body: string; title?: string | null; reply_to?: number | null; ask?: boolean; to?: string | null }): Promise<Message> {
    const body = (input.body ?? "").toString();
    if (!body.trim()) throw new BoardError(400, "Message body is empty.");
    if (body.length > MAX_BODY) throw new BoardError(413, `Message too large (max ${MAX_BODY} chars). Use docs for big files.`);
    refuseSecrets(body, input.title);
    if (input.reply_to != null && !this.findMessage(input.reply_to)) {
      throw new BoardError(404, `reply_to message ${input.reply_to} not found.`);
    }
    const askTo = input.to ? this.activeMember(input.to) : null;
    return this.insertMessage({
      author: input.from,
      kind: "message",
      title: input.title?.slice(0, 200) || null,
      body,
      reply_to: input.reply_to ?? null,
      doc: null,
      doc_version: null,
      ask_status: input.ask || askTo ? "open" : null,
      ask_to: askTo,
    });
  }

  // ---- asks ----

  // Turn an existing message into an ask, e.g. a request someone posted as a plain message.
  async makeAsk(id: number, to: string | null): Promise<Message> {
    const msg = this.requireMessage(id);
    if (msg.kind === "doc") throw new BoardError(400, "Doc announcements can't be asks.");
    const askTo = to ? this.activeMember(to) : msg.ask_to;
    this.sql.exec("UPDATE messages SET ask_status = COALESCE(ask_status, 'open'), ask_to = ? WHERE id = ?", askTo, id);
    return this.requireMessage(id);
  }

  async takeAsk(id: number, by: string): Promise<Message> {
    const ask = this.requireAsk(id);
    if (ask.ask_status === "done") throw new BoardError(409, `Ask #${id} is already done.`);
    if (ask.ask_status === "taken" && ask.taken_by !== by) throw new BoardError(409, `Ask #${id} is already taken by ${ask.taken_by}.`);
    this.sql.exec("UPDATE messages SET ask_status = 'taken', taken_by = ? WHERE id = ?", by, id);
    return this.requireMessage(id);
  }

  // Closes the ask and posts the note as a reply, so the asker sees it in their feed.
  async completeAsk(id: number, by: string, note: string): Promise<{ ask: Message; reply: Message }> {
    const ask = this.requireAsk(id);
    if (ask.ask_status === "done") throw new BoardError(409, `Ask #${id} is already done.`);
    const text = (note ?? "").toString().trim();
    if (!text) throw new BoardError(400, "Say what was done (a commit, a link to a doc version, or why it won't be done).");
    refuseSecrets(text);
    const now = new Date().toISOString();
    this.sql.exec(
      "UPDATE messages SET ask_status = 'done', taken_by = COALESCE(taken_by, ?), resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ?",
      by, by, now, text.slice(0, 4000), id,
    );
    const reply = this.insertMessage({
      author: by,
      kind: "message",
      title: `Done: ${ask.title ?? `ask #${id}`}`.slice(0, 200),
      body: text,
      reply_to: id,
      doc: null,
      doc_version: null,
      ask_status: null,
      ask_to: null,
    });
    return { ask: this.requireMessage(id), reply };
  }

  async reopenAsk(id: number): Promise<Message> {
    this.requireAsk(id);
    this.sql.exec("UPDATE messages SET ask_status = 'open', taken_by = NULL, resolved_by = NULL, resolved_at = NULL, resolution = NULL WHERE id = ?", id);
    return this.requireMessage(id);
  }

  // forName: asks addressed to that member or to anyone, excluding their own. byName: asks that member made.
  async listAsks(opts: { status?: "active" | AskStatus | "all"; forName?: string | null; byName?: string | null }): Promise<Message[]> {
    const where = ["ask_status IS NOT NULL"];
    const args: (string | number)[] = [];
    const status = opts.status ?? "active";
    if (status === "active") where.push("ask_status IN ('open', 'taken')");
    else if (status !== "all") (where.push("ask_status = ?"), args.push(status));
    if (opts.forName) (where.push("(ask_to IS NULL OR ask_to = ?) AND author != ?"), args.push(opts.forName, opts.forName));
    if (opts.byName) (where.push("author = ?"), args.push(opts.byName));
    return this.sql.exec<Message>(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY id ASC LIMIT 200`, ...args).toArray();
  }

  // Messages from other members since the cursor. Advances it unless peek.
  // With a session id, each agent session keeps its own place, so one session reading
  // doesn't hide messages from the person's other sessions. A new session starts 24h back.
  async checkNew(reader: string, peek = false, session?: string | null): Promise<Message[]> {
    const key = session ? `${reader}#${session.slice(0, 100)}` : reader;
    const cursor = this.cursorFor(key, !!session);
    const messages = this.sql
      .exec<Message>("SELECT * FROM messages WHERE id > ? AND author != ? ORDER BY id ASC LIMIT 200", cursor, reader)
      .toArray();
    if (!peek) {
      const maxId = this.sql.exec<{ m: number | null }>("SELECT MAX(id) AS m FROM messages").one().m ?? 0;
      // Only skip past what we returned when the limit cut the list short.
      const advanceTo = messages.length === 200 ? messages[messages.length - 1].id : maxId;
      this.sql.exec(
        "INSERT INTO cursors (reader, last_id) VALUES (?, ?) ON CONFLICT(reader) DO UPDATE SET last_id = excluded.last_id",
        key,
        advanceTo,
      );
    }
    return messages;
  }

  async unreadCount(reader: string, session?: string | null): Promise<number> {
    const key = session ? `${reader}#${session.slice(0, 100)}` : reader;
    return this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE id > ? AND author != ?", this.cursorFor(key, !!session), reader)
      .one().n;
  }

  async list(limit = 20, before?: number | null): Promise<Message[]> {
    const n = Math.min(Math.max(1, limit || 20), 100);
    const rows = before
      ? this.sql.exec<Message>("SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?", before, n).toArray()
      : this.sql.exec<Message>("SELECT * FROM messages ORDER BY id DESC LIMIT ?", n).toArray();
    return rows.reverse();
  }

  async get(id: number): Promise<Message & { replies: Message[] }> {
    const msg = this.findMessage(id);
    if (!msg) throw new BoardError(404, `Message ${id} not found.`);
    const replies = this.sql.exec<Message>("SELECT * FROM messages WHERE reply_to = ? ORDER BY id", id).toArray();
    return { ...msg, replies };
  }

  // ---- docs ----

  async publishDoc(input: { from: string; name: string; content: string; note?: string | null }): Promise<{
    doc: DocVersion;
    unchanged: boolean;
    stats: { added: number; removed: number } | null;
    message_id: number | null;
  }> {
    const name = cleanDocName(input.name);
    const content = (input.content ?? "").toString();
    if (!content.trim()) throw new BoardError(400, "Doc content is empty.");
    if (content.length > MAX_DOC) throw new BoardError(413, `Doc too large (max ${MAX_DOC} chars).`);
    const note = input.note?.slice(0, 2000) || null;
    refuseSecrets(content, note);

    const prev = this.sql
      .exec<{ version: number; content: string }>("SELECT version, content FROM docs WHERE name = ? ORDER BY version DESC LIMIT 1", name)
      .toArray()[0];
    if (prev && prev.content === content) {
      return { doc: this.docMeta(name, prev.version)!, unchanged: true, stats: null, message_id: null };
    }

    const version = (prev?.version ?? 0) + 1;
    this.sql.exec(
      "INSERT INTO docs (name, version, content, author, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      name, version, content, input.from, note, new Date().toISOString(),
    );

    let body: string;
    let stats: { added: number; removed: number } | null = null;
    if (prev) {
      stats = lineStats(prev.content, content);
      const patch = createTwoFilesPatch(`${name}@v${prev.version}`, `${name}@v${version}`, prev.content, content, "", "", { context: 3 });
      const diff = patch.length > MAX_STORED_DIFF ? patch.slice(0, MAX_STORED_DIFF) + "\n... (diff truncated, use the diff endpoint)" : patch;
      body = `${note ? note + "\n\n" : ""}+${stats.added} / -${stats.removed} lines vs v${prev.version}\n\n\`\`\`diff\n${diff}\n\`\`\``;
    } else {
      body = `${note ? note + "\n\n" : ""}First version (${content.replace(/\n$/, "").split("\n").length} lines). Fetch the full doc to read it.`;
    }
    const msg = this.insertMessage({
      author: input.from,
      kind: "doc",
      title: `${name} v${version}`,
      body,
      reply_to: null,
      doc: name,
      doc_version: version,
      ask_status: null,
      ask_to: null,
    });
    return { doc: this.docMeta(name, version)!, unchanged: false, stats, message_id: msg.id };
  }

  async listDocs(): Promise<DocVersion[]> {
    return this.sql
      .exec<DocVersion>(
        `SELECT d.name, d.version, d.author, d.note, d.created_at, LENGTH(d.content) AS bytes
         FROM docs d JOIN (SELECT name, MAX(version) AS v FROM docs GROUP BY name) m
           ON d.name = m.name AND d.version = m.v
         ORDER BY d.created_at DESC`,
      )
      .toArray();
  }

  async getDoc(nameRaw: string, version?: number | null): Promise<DocVersion & { content: string; history: DocVersion[] }> {
    const name = cleanDocName(nameRaw);
    const row = version
      ? this.sql.exec<{ version: number }>("SELECT version FROM docs WHERE name = ? AND version = ?", name, version).toArray()[0]
      : this.sql.exec<{ version: number }>("SELECT version FROM docs WHERE name = ? ORDER BY version DESC LIMIT 1", name).toArray()[0];
    if (!row) throw new BoardError(404, `Doc ${name}${version ? ` v${version}` : ""} not found.`);
    const content = this.sql.exec<{ content: string }>("SELECT content FROM docs WHERE name = ? AND version = ?", name, row.version).one().content;
    const history = this.sql
      .exec<DocVersion>("SELECT name, version, author, note, created_at, LENGTH(content) AS bytes FROM docs WHERE name = ? ORDER BY version", name)
      .toArray();
    return { ...this.docMeta(name, row.version)!, content, history };
  }

  async diffDoc(nameRaw: string, from?: number | null, to?: number | null): Promise<{ name: string; from: number; to: number; added: number; removed: number; diff: string }> {
    const name = cleanDocName(nameRaw);
    const latest = this.sql.exec<{ v: number | null }>("SELECT MAX(version) AS v FROM docs WHERE name = ?", name).one().v;
    if (!latest) throw new BoardError(404, `Doc ${name} not found.`);
    const toV = to ?? latest;
    const fromV = from ?? toV - 1;
    if (fromV < 1) throw new BoardError(400, `${name} only has v1, nothing to diff against.`);
    const load = (v: number) => {
      const r = this.sql.exec<{ content: string }>("SELECT content FROM docs WHERE name = ? AND version = ?", name, v).toArray()[0];
      if (!r) throw new BoardError(404, `Doc ${name} v${v} not found.`);
      return r.content;
    };
    const a = load(fromV);
    const b = load(toV);
    return {
      name,
      from: fromV,
      to: toV,
      ...lineStats(a, b),
      diff: createTwoFilesPatch(`${name}@v${fromV}`, `${name}@v${toV}`, a, b, "", "", { context: 3 }),
    };
  }

  // ---- helpers ----

  private meta(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  private requireOwner(name: string) {
    const role = this.sql.exec<{ role: string }>("SELECT role FROM members WHERE name = ? AND revoked_at IS NULL", name).toArray()[0]?.role;
    if (role !== "owner") throw new BoardError(403, "Only the room owner can do that.");
  }

  private insertInvite(by: string, codeHash: string): string {
    const now = Date.now();
    const expires = new Date(now + INVITE_TTL_MS).toISOString();
    this.sql.exec(
      "INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)",
      codeHash, by, new Date(now).toISOString(), expires,
    );
    return expires;
  }

  private usableInvite(codeHash: string) {
    const inv = this.sql
      .exec<{ created_by: string; expires_at: string; used_by: string | null }>(
        "SELECT created_by, expires_at, used_by FROM invites WHERE code_hash = ?",
        codeHash,
      )
      .toArray()[0];
    if (!inv) throw new BoardError(404, "Invite not found.");
    if (inv.used_by) throw new BoardError(410, "This invite has already been used. Ask the room owner for a new one.");
    if (Date.parse(inv.expires_at) < Date.now()) throw new BoardError(410, "This invite has expired. Ask the room owner for a new one.");
    return inv;
  }

  private cursorFor(key: string, isSession = false): number {
    const saved = this.sql.exec<{ last_id: number }>("SELECT last_id FROM cursors WHERE reader = ?", key).toArray()[0]?.last_id;
    if (saved !== undefined) return saved;
    if (!isSession) return 0;
    const since = new Date(Date.now() - NEW_SESSION_LOOKBACK_MS).toISOString();
    return this.sql.exec<{ m: number | null }>("SELECT MAX(id) AS m FROM messages WHERE created_at < ?", since).one().m ?? 0;
  }

  private activeMember(raw: string): string {
    const name = cleanAgentName(raw);
    const m = this.sql.exec("SELECT 1 FROM members WHERE name = ? AND revoked_at IS NULL", name).toArray()[0];
    if (!m) throw new BoardError(404, `No active member named "${name}".`);
    return name;
  }

  private requireMessage(id: number): Message {
    const m = this.findMessage(id);
    if (!m) throw new BoardError(404, `Message ${id} not found.`);
    return m;
  }

  private requireAsk(id: number): Message {
    const m = this.requireMessage(id);
    if (!m.ask_status) throw new BoardError(400, `Message #${id} isn't an ask. Make it one first.`);
    return m;
  }

  private findMessage(id: number): Message | undefined {
    return this.sql.exec<Message>("SELECT * FROM messages WHERE id = ?", id).toArray()[0];
  }

  private docMeta(name: string, version: number): DocVersion | undefined {
    return this.sql
      .exec<DocVersion>("SELECT name, version, author, note, created_at, LENGTH(content) AS bytes FROM docs WHERE name = ? AND version = ?", name, version)
      .toArray()[0];
  }

  private insertMessage(m: Omit<Message, "id" | "created_at" | "taken_by" | "resolved_by" | "resolved_at" | "resolution">): Message {
    return this.sql
      .exec<Message>(
        `INSERT INTO messages (author, kind, title, body, reply_to, doc, doc_version, ask_status, ask_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        m.author, m.kind, m.title, m.body, m.reply_to, m.doc, m.doc_version, m.ask_status, m.ask_to, new Date().toISOString(),
      )
      .one();
  }
}

function lineStats(a: string, b: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(a, b)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}
