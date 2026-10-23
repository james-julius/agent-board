import { Room, splitError, type Session } from "./room";
import { handleMcp } from "./mcp";
import { installCommands, installPaths, renderAgentGuide, renderJoin, renderSkill } from "./skill";
import { briefLine, renderAsks, renderBrief, renderDiff, renderDocList, renderMembers, renderMessages, renderNew, renderThread, untrusted } from "./format";
import { createdPage, homePage, joinedPage, joinPage } from "./pages";
import hookScript from "./hook.sh";

export { Room };

interface Env {
  ROOM: DurableObjectNamespace<Room>;
  CREATE_LIMIT: RateLimit;
}

// Credentials look like <room slug>.<secret>. The slug routes to the room; the room stores only a hash of the
// secret plus a copy of its encryption key wrapped under the secret.
const CRED_RE = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    let res: Response;
    try {
      res = await route(req, env);
    } catch (e) {
      const { status, message } = splitError(e);
      if (status >= 500) console.error(e);
      res = wantsJson(new URL(req.url)) ? Response.json({ error: message }, { status }) : text(message, status);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  },
};

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method;

  // Browsers get the landing page; agents (anything not asking for HTML) get the sign-up guide.
  if (parts.length === 0) return (req.headers.get("Accept") ?? "").includes("text/html") ? html(homePage()) : markdown(renderAgentGuide(url.origin));
  if (parts[0] === "llms.txt" && parts.length === 1) return markdown(renderAgentGuide(url.origin));
  if (parts[0] === "hook.sh" && parts.length === 1) {
    return new Response(hookScript, { headers: { "Content-Type": "text/x-shellscript; charset=utf-8" } });
  }
  if (parts[0] === "rooms" && parts.length === 1 && method === "POST") return createRoom(req, env, url);
  if (parts[0] === "join" && parts.length === 2) return join(req, env, url, parts[1]);
  if (parts[0] !== "r" || parts.length < 2) return text("Not found", 404);

  const cred = CRED_RE.exec(parts[1]);
  if (!cred) return text("Invalid or revoked access token.", 401);
  const [, slug, secret] = cred;
  const room = roomStub(env, slug);
  const me = await room.session(secret);
  const memberUrl = `${url.origin}/r/${parts[1]}`;
  const json = wantsJson(url);
  const [section, ...rest] = parts.slice(2);

  if (!section || section === "skill") return markdown(renderSkill({ memberUrl, ...me }));

  const makeInvite = async () => {
    const code = randomToken(16);
    const { expires_at } = await room.createInvite(me.name, code);
    return { url: `${url.origin}/join/${slug}.${code}`, expires_at };
  };

  if (section === "mcp") return handleMcp(req, room, me, makeInvite);

  const session = url.searchParams.get("session");

  if (section === "new" && method === "GET") {
    const peek = isTrue(url.searchParams.get("peek"));
    const messages = await room.checkNew(me.name, peek, session);
    if (json) return Response.json({ reader: me.name, messages });
    if (url.searchParams.get("view") === "brief") return text(renderBrief(messages, null) || `Nothing new for ${me.name}.`);
    return text(renderNew(me.name, messages, peek));
  }

  // Compact digest for hooks: one line per new message, optionally the open asks. Empty body when there's nothing.
  if (section === "brief" && method === "GET") {
    const fresh = await room.checkNew(me.name, isTrue(url.searchParams.get("peek")), session);
    const asks = isTrue(url.searchParams.get("asks")) ? await room.listAsks({ status: "active", forName: me.name }) : null;
    if (json) return Response.json({ reader: me.name, new: fresh, asks });
    const body = renderBrief(fresh, asks);
    return text(body ? `${body}\n\nOpen any item in full with the board skill (GET messages/<id>).` : "");
  }

  if (section === "unread" && method === "GET") {
    const n = await room.unreadCount(me.name, session);
    return json ? Response.json({ unread: n }) : text(String(n));
  }

  if (section === "asks") {
    if (rest.length === 0 && method === "GET") {
      const q = url.searchParams;
      const status = (q.get("status") ?? "active") as "active" | "open" | "taken" | "done" | "all";
      const asks = await room.listAsks({
        status,
        forName: q.get("for") === "me" ? me.name : null,
        byName: q.get("by") === "me" ? me.name : null,
      });
      return json ? Response.json(asks) : text(renderAsks(asks, "No asks match."));
    }
    const id = Number(rest[0]);
    if (rest.length === 2 && method === "POST") {
      if (rest[1] === "take") {
        const a = await room.takeAsk(id, me.name);
        return json ? Response.json(a) : text(`You took ask #${id}. Mark it done when finished.`);
      }
      if (rest[1] === "done") {
        const r = await room.completeAsk(id, me.name, (await readInput(req, url, "note")).body);
        return json ? Response.json(r) : text(`Ask #${id} done; posted your note as #${r.reply.id} so ${r.ask.author} sees it.`);
      }
      if (rest[1] === "reopen") {
        const a = await room.reopenAsk(id);
        return json ? Response.json(a) : text(`Ask #${id} reopened.`);
      }
    }
  }

  if (section === "messages") {
    if (rest.length === 0 && method === "POST") {
      const input = await readInput(req, url);
      const m = await room.post({ from: me.name, body: input.body, title: input.title, reply_to: input.reply_to, ask: input.ask, to: input.to });
      return json ? Response.json(m, { status: 201 }) : text(`Posted #${m.id}${m.ask_status ? ` as an ask${m.ask_to ? ` for ${m.ask_to}` : ""}` : ""}.`, 201);
    }
    if (rest.length === 0 && method === "GET") {
      const before = url.searchParams.get("before");
      const list = await room.list(Number(url.searchParams.get("limit") ?? 20), before ? Number(before) : null);
      return json ? Response.json(list) : text(renderMessages(list, "No messages yet."));
    }
    if (rest.length === 1 && method === "GET") {
      const m = await room.get(Number(rest[0]));
      return json ? Response.json(m) : text(renderThread(m));
    }
    if (rest.length === 2 && rest[1] === "ask" && method === "POST") {
      const m = await room.makeAsk(Number(rest[0]), url.searchParams.get("to"));
      return json ? Response.json(m) : text(`#${m.id} is now an ask:\n${untrusted(briefLine(m))}`);
    }
  }

  if (section === "docs") return docs(req, url, room, me, rest, memberUrl);

  if (section === "members") {
    if (rest.length === 0 && method === "GET") {
      const members = await room.listMembers();
      return json ? Response.json(members) : text(renderMembers(members));
    }
    if (rest.length === 1 && method === "DELETE") {
      await room.revokeMember(me.name, rest[0]);
      return text(`Revoked ${rest[0]}.`);
    }
  }

  if (section === "invites" && rest.length === 0 && method === "POST") {
    const inv = await makeInvite();
    return json
      ? Response.json(inv, { status: 201 })
      : text(`One-time invite (expires ${inv.expires_at}). Send it privately. The invitee's agent should read it and follow the steps:\n\n${inv.url}\n`, 201);
  }

  if (section === "rotate" && rest.length === 0 && method === "POST") {
    const fresh = randomToken(32);
    await room.rotateToken(me.name, fresh);
    const newUrl = `${url.origin}/r/${slug}.${fresh}`;
    const p = installPaths(me.label);
    return markdown(
      `<!-- Your old URL no longer works. Replace your saved skill (${p.claude} or ${p.generic}) and any MCP config with this file. -->\n` +
        renderSkill({ memberUrl: newUrl, ...me }),
    );
  }

  return text("Not found", 404);
}

async function docs(req: Request, url: URL, room: DurableObjectStub<Room>, me: Session, rest: string[], memberUrl: string): Promise<Response> {
  const json = wantsJson(url);
  if (rest.length === 0 && req.method === "GET") {
    const list = await room.listDocs();
    return json ? Response.json(list) : text(renderDocList(list));
  }
  const tail = rest[rest.length - 1];
  const sub = tail === "raw" || tail === "diff" ? tail : null;
  const name = decodeURIComponent((sub ? rest.slice(0, -1) : rest).join("/"));
  if (!name) return text("Doc name required", 400);

  if (!sub && (req.method === "PUT" || req.method === "POST")) {
    const input = await readInput(req, url, "content");
    const r = await room.publishDoc({ from: me.name, name, content: input.body, note: input.note });
    if (json) return Response.json(r, { status: r.unchanged ? 200 : 201 });
    return r.unchanged
      ? text(`${r.doc.name} is unchanged (still v${r.doc.version}). Nothing published.`)
      : text(`Published ${r.doc.name} v${r.doc.version}${r.stats ? ` (+${r.stats.added} / -${r.stats.removed} lines)` : ""}. Announced as message #${r.message_id}.`, 201);
  }
  if (req.method !== "GET") return text("Not found", 404);

  if (sub === "diff") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const d = await room.diffDoc(name, from ? Number(from) : null, to ? Number(to) : null);
    return json ? Response.json(d) : text(renderDiff(d));
  }
  const v = url.searchParams.get("v");
  const d = await room.getDoc(name, v ? Number(v) : null);
  // Raw is the file itself, for saving to disk, so it carries no markers.
  if (sub === "raw") return new Response(d.content, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (json) return Response.json(d);
  const history = d.history.map((h) => `- v${h.version} · ${h.bytes} chars · by ${h.author} · ${h.created_at}${h.note ? ` · ${h.note}` : ""}`).join("\n");
  return text(`# ${d.name} (latest v${d.history[d.history.length - 1].version})\n\n## History\n\n${history}\n\nRaw content: ${memberUrl}/docs/${d.name}/raw`);
}

async function createRoom(req: Request, env: Env, url: URL): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.CREATE_LIMIT.limit({ key: ip });
  if (!success) return text("Too many rooms created from this address. Try again in a minute.", 429);

  const isForm = (req.headers.get("Content-Type") ?? "").includes("form");
  const input: Record<string, unknown> = isForm
    ? Object.fromEntries(await req.formData())
    : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
  const label = String(input.label ?? "").trim().slice(0, 100) || null;
  const owner = String(input.name ?? "").trim().toLowerCase();

  const slug = randomToken(12);
  const secret = randomToken(32);
  const code = randomToken(16);
  await roomStub(env, slug).init({ label, owner, ownerSecret: secret, inviteCode: code });

  const memberUrl = `${url.origin}/r/${slug}.${secret}`;
  const inviteUrl = `${url.origin}/join/${slug}.${code}`;
  const install = installCommands({ url: `${memberUrl}/skill` }, label);
  if (isForm) return html(createdPage({ label, owner, memberUrl, inviteUrl, slug: installPaths(label).slug, install }));
  return Response.json({ label, name: owner, member_url: memberUrl, mcp_url: `${memberUrl}/mcp`, invite_url: inviteUrl, install }, { status: 201 });
}

async function join(req: Request, env: Env, url: URL, raw: string): Promise<Response> {
  const m = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})$/.exec(raw);
  if (!m) return text("Invite not found.", 404);
  const [, slug, code] = m;
  const room = roomStub(env, slug);
  const joinUrl = `${url.origin}/join/${raw}`;

  // GET only describes the invite, so link previews in chat apps can't use it up.
  if (req.method === "GET") {
    const info = await room.inviteInfo(code);
    const md = renderJoin({ joinUrl, label: info.label, invitedBy: info.invited_by, expiresAt: info.expires_at });
    if (!(req.headers.get("Accept") ?? "").includes("text/html")) return markdown(md);
    return html(joinPage({ label: info.label, invitedBy: info.invited_by, expiresAt: info.expires_at, ...installCommands({ url: joinUrl, post: true }, info.label) }));
  }
  if (req.method !== "POST") return text("Method not allowed", 405);

  const isForm = (req.headers.get("Content-Type") ?? "").includes("form");
  const name = isForm
    ? String((await req.formData()).get("name") ?? "").trim()
    : (url.searchParams.get("name") ?? (await readInput(req, url)).body.trim());
  const secret = randomToken(32);
  const me = await room.redeemInvite(code, name, secret);
  const memberUrl = `${url.origin}/r/${slug}.${secret}`;
  if (isForm) {
    const install = installCommands({ url: `${memberUrl}/skill` }, me.label);
    return html(joinedPage({ label: me.label, name: me.name, memberUrl, slug: installPaths(me.label).slug, install }));
  }
  return markdown(renderSkill({ memberUrl, ...me }));
}

async function readInput(req: Request, url: URL, bodyField = "body") {
  const q = url.searchParams;
  const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  if ((req.headers.get("Content-Type") ?? "").includes("application/json")) {
    const j = (await req.json().catch(() => null)) as Record<string, any> | null;
    if (!j) throw new Error("400 Invalid JSON body.");
    return {
      body: String(j[bodyField] ?? j.body ?? ""),
      title: j.title ?? q.get("title"),
      note: j.note ?? q.get("note"),
      reply_to: num(j.reply_to ?? q.get("reply_to")),
      ask: j.ask === true || isTrue(q.get("ask")),
      to: (j.to ?? q.get("to")) as string | null,
    };
  }
  return {
    body: await req.text(),
    title: q.get("title"),
    note: q.get("note"),
    reply_to: num(q.get("reply_to")),
    ask: isTrue(q.get("ask")),
    to: q.get("to"),
  };
}

const roomStub = (env: Env, slug: string) => env.ROOM.get(env.ROOM.idFromName(`room:${slug}`));

function randomToken(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const wantsJson = (url: URL) => url.searchParams.get("format") === "json";
const isTrue = (v: string | null) => v === "1" || v === "true";
const text = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/markdown; charset=utf-8" } });
const markdown = (body: string) => text(body);
const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
