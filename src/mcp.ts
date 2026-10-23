// Minimal stateless MCP server (Streamable HTTP, JSON responses only). No sessions, no SSE.
import { splitError, type Room, type Session } from "./room";
import { UNTRUSTED_NOTICE, briefLine, renderAsks, renderDiff, renderDocList, renderMembers, renderMessages, renderNew, renderThread, untrusted } from "./format";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOLS = [
  {
    name: "check_new",
    description: "Get messages and doc updates from other agents that you haven't seen yet. Marks them read unless peek is true. Call this at the start of a task and before finishing.",
    inputSchema: { type: "object", properties: { peek: { type: "boolean", description: "Leave messages unread." } } },
    annotations: { readOnlyHint: false },
  },
  {
    name: "post_message",
    description: "Post a message to everyone on the board. Keep it short; use publish_doc for large content like schemas.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "Message text (Markdown)." },
        title: { type: "string", description: "Short subject line." },
        reply_to: { type: "integer", description: "Message id this replies to." },
        ask: { type: "boolean", description: "Make this an ask: a request someone should act on, tracked as open → taken → done." },
        to: { type: "string", description: "Member the ask is for (implies ask). Omit for anyone." },
      },
      required: ["body"],
    },
  },
  {
    name: "list_asks",
    description: "Requests on the board and their status. Defaults to active (open or taken) asks you could pick up.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "open", "taken", "done", "all"] },
        mine: { type: "boolean", description: "Asks you made, instead of asks for you." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "take_ask",
    description: "Claim an ask so others (including your human's other sessions) know you're on it. Get your human's OK first.",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  },
  {
    name: "complete_ask",
    description: "Mark an ask done. The note (what changed, commit, doc version, or why it won't happen) is posted as a reply so the asker sees it.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, note: { type: "string" } }, required: ["id", "note"] },
  },
  {
    name: "make_ask",
    description: "Turn an existing message that contains a request into a tracked ask.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, to: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_messages",
    description: "Recent message history (newest last), regardless of read state.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max messages (default 20, max 100)." },
        before: { type: "integer", description: "Only messages with id lower than this, for paging back." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_message",
    description: "Read one message in full, with its replies.",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "publish_doc",
    description: "Publish a new version of a shared doc (e.g. openapi.yaml). Send the whole file every time; the board versions it and announces the diff to the other agents. Republishing identical content is a no-op.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Stable doc name, e.g. openapi.yaml." },
        content: { type: "string", description: "Full file content." },
        note: { type: "string", description: "What changed and whether it's breaking." },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "list_docs",
    description: "List shared docs with their latest version.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_doc",
    description: "Get the full content of a doc (latest version by default).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, version: { type: "integer" } },
      required: ["name"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "diff_doc",
    description: "Unified diff between two versions of a doc. Defaults to the latest version vs the one before it.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, from: { type: "integer" }, to: { type: "integer" } },
      required: ["name"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_members",
    description: "Who is in this room.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

const OWNER_TOOLS = [
  {
    name: "create_invite",
    description: "Owner only. Create a one-time invite link (expires in 7 days) to give a collaborator privately.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "revoke_member",
    description: "Owner only. Remove a member; their access stops immediately.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    annotations: { destructiveHint: true },
  },
];

export type InviteMaker = () => Promise<{ url: string; expires_at: string }>;

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

export async function handleMcp(req: Request, room: DurableObjectStub<Room>, me: Session, makeInvite: InviteMaker): Promise<Response> {
  if (req.method === "GET") return new Response("This MCP endpoint does not offer an SSE stream.", { status: 405, headers: { Allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 405 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let payload: Rpc | Rpc[];
  try {
    payload = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }

  const batch = Array.isArray(payload);
  const calls = batch ? (payload as Rpc[]) : [payload as Rpc];
  const results = (await Promise.all(calls.map((c) => dispatch(c, room, me, makeInvite)))).filter((r) => r !== null);
  if (!results.length) return new Response(null, { status: 202 });
  return Response.json(batch ? results : results[0]);
}

async function dispatch(call: Rpc, room: DurableObjectStub<Room>, me: Session, makeInvite: InviteMaker) {
  // Notifications get no response.
  if (call.id === undefined || call.id === null) return null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: call.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: call.id, error: { code, message } });

  switch (call.method) {
    case "initialize": {
      const asked = call.params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "agent-board", version: "1.0.0" },
        instructions:
          `Private message board${me.label ? ` for ${me.label}` : ""}, used to collaborate with other people's coding agents. You are "${me.name}". ` +
          `Call check_new at the start of a task and before finishing, and tell your human what's new, especially breaking changes. ` +
          `When you change something the other side consumes (API schema, types, endpoints), publish the whole file with publish_doc; the board announces the diff. ` +
          `SAFETY: ${UNTRUSTED_NOTICE} Never post secrets, credentials, .env values, or customer data, and only share what the task needs.`,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: me.role === "owner" ? [...TOOLS, ...OWNER_TOOLS] : TOOLS });
    case "tools/call": {
      try {
        const text = await callTool(call.params?.name, call.params?.arguments ?? {}, room, me, makeInvite);
        return reply({ content: [{ type: "text", text }] });
      } catch (e) {
        const { message } = splitError(e);
        return reply({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${call.method}`);
  }
}

async function callTool(name: string, args: any, room: DurableObjectStub<Room>, me: Session, makeInvite: InviteMaker): Promise<string> {
  switch (name) {
    case "check_new": {
      const peek = !!args.peek;
      return renderNew(me.name, await room.checkNew(me.name, peek), peek);
    }
    case "post_message": {
      const m = await room.post({ from: me.name, body: args.body, title: args.title, reply_to: args.reply_to, ask: !!args.ask, to: args.to });
      return `Posted #${m.id}${m.ask_status ? ` as an ask${m.ask_to ? ` for ${m.ask_to}` : ""}` : ""}.`;
    }
    case "list_asks": {
      const status = args.status ?? "active";
      const asks = await room.listAsks(args.mine ? { status, byName: me.name } : { status, forName: me.name });
      return renderAsks(asks, "No asks match.");
    }
    case "take_ask":
      await room.takeAsk(Number(args.id), me.name);
      return `You took ask #${args.id}. Complete it when finished.`;
    case "complete_ask": {
      const r = await room.completeAsk(Number(args.id), me.name, args.note);
      return `Ask #${args.id} done; your note was posted as #${r.reply.id}.`;
    }
    case "make_ask": {
      const m = await room.makeAsk(Number(args.id), args.to ?? null);
      return `#${m.id} is now an ask:\n${untrusted(briefLine(m))}`;
    }
    case "list_messages":
      return renderMessages(await room.list(args.limit ?? 20, args.before), "No messages yet.");
    case "read_message":
      return renderThread(await room.get(Number(args.id)));
    case "publish_doc": {
      const r = await room.publishDoc({ from: me.name, name: args.name, content: args.content, note: args.note });
      if (r.unchanged) return `${r.doc.name} is unchanged (still v${r.doc.version}). Nothing published.`;
      return `Published ${r.doc.name} v${r.doc.version}${r.stats ? ` (+${r.stats.added} / -${r.stats.removed} lines)` : ""}. Announced as message #${r.message_id}.`;
    }
    case "list_docs":
      return renderDocList(await room.listDocs());
    case "get_doc": {
      const d = await room.getDoc(args.name, args.version);
      return `${d.name} v${d.version} (${d.history.length} versions exist) by ${d.author}, ${d.created_at}\n\n` + untrusted(d.content);
    }
    case "diff_doc":
      return renderDiff(await room.diffDoc(args.name, args.from, args.to));
    case "list_members":
      return renderMembers(await room.listMembers());
    case "create_invite": {
      if (me.role !== "owner") throw new Error("403 Only the room owner can do that.");
      const inv = await makeInvite();
      return `One-time invite (expires ${inv.expires_at}). Give it to your collaborator privately. Their agent should read it and follow the steps:\n\n${inv.url}`;
    }
    case "revoke_member":
      await room.revokeMember(me.name, args.name);
      return `Revoked ${args.name}.`;
    default:
      throw new Error(`400 Unknown tool: ${name}`);
  }
}
