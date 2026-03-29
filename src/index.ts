import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "hono/bun";
import Anthropic from "@anthropic-ai/sdk";

const app = new Hono();

const SPEEDTEST_API = "http://speed.ada.local/api/v1";
const API_KEY = process.env.SPEEDTEST_API_KEY!;
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY!;

const stHeaders = {
  Accept: "application/json",
  Authorization: `Bearer ${API_KEY}`,
};

// --- Speedtest API helpers ---

async function fetchSpeedtest(path: string) {
  const res = await fetch(`${SPEEDTEST_API}${path}`, { headers: stHeaders });
  return res.json();
}

// --- Proxy endpoints (for dashboard) ---

app.get("/api/latest", async (c) => {
  return c.json(await fetchSpeedtest("/results/latest"));
});

app.get("/api/stats", async (c) => {
  const url = new URL(`${SPEEDTEST_API}/stats`);
  const start = c.req.query("start_at");
  if (start) url.searchParams.set("filter[start_at]", `>=${start}`);
  const res = await fetch(url.toString(), { headers: stHeaders });
  return c.json(await res.json());
});

app.get("/api/results", async (c) => {
  const url = new URL(`${SPEEDTEST_API}/results`);
  url.searchParams.set("page[size]", c.req.query("per_page") ?? "500");
  url.searchParams.set("sort", c.req.query("sort") ?? "-created_at");
  const page = c.req.query("page");
  if (page) url.searchParams.set("page[number]", page);
  const start = c.req.query("start_at");
  if (start) url.searchParams.set("filter[start_at]", `>=${start}`);
  const res = await fetch(url.toString(), { headers: stHeaders });
  return c.json(await res.json());
});

// --- Claude chat with tool use ---

const tools: Anthropic.Tool[] = [
  {
    name: "get_latest_result",
    description:
      "Get the most recent speedtest result with full details including download/upload speeds, ping, ISP, server info, and packet loss.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_stats",
    description:
      "Get aggregate statistics (avg/min/max) for download, upload, and ping. Optionally filter by start date.",
    input_schema: {
      type: "object" as const,
      properties: {
        start_at: {
          type: "string",
          description:
            "Filter results from this date onward. Format: YYYY-MM-DD HH:MM:SS",
        },
      },
      required: [],
    },
  },
  {
    name: "get_results",
    description:
      "Get a list of speedtest results, sorted by most recent first. Use this to analyze trends, find failures, or look at specific time periods. Each result includes: id, ping (ms), download (bytes/sec), upload (bytes/sec), status (completed/failed), scheduled (bool), created_at.",
    input_schema: {
      type: "object" as const,
      properties: {
        start_at: {
          type: "string",
          description:
            "Filter results from this date onward. Format: YYYY-MM-DD HH:MM:SS",
        },
        per_page: {
          type: "number",
          description: "Number of results to return (max 500, default 50)",
        },
        sort: {
          type: "string",
          enum: [
            "created_at",
            "-created_at",
            "download",
            "-download",
            "upload",
            "-upload",
            "ping",
            "-ping",
          ],
          description: "Sort field and direction. Prefix with - for descending.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_single_result",
    description: "Get a single speedtest result by its ID, with full details including nested data (latency breakdown, server info, ISP, interface).",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "The result ID" },
      },
      required: ["id"],
    },
  },
];

function summarizeResult(r: any) {
  return {
    id: r.id,
    status: r.status,
    ping: r.ping,
    download_mbps: r.download ? +((r.download * 8) / 1e6).toFixed(1) : null,
    upload_mbps: r.upload ? +((r.upload * 8) / 1e6).toFixed(1) : null,
    scheduled: r.scheduled,
    created_at: r.created_at,
  };
}

async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "get_latest_result": {
      const res = await fetchSpeedtest("/results/latest");
      const r = res.data;
      return JSON.stringify({
        ...summarizeResult(r),
        packet_loss: r.data?.packetLoss,
        isp: r.data?.isp,
        server: r.data?.server
          ? { name: r.data.server.name, location: r.data.server.location, country: r.data.server.country }
          : null,
        ping_detail: r.data?.ping,
        download_latency: r.data?.download?.latency,
        upload_latency: r.data?.upload?.latency,
        external_ip: r.data?.interface?.externalIp,
      });
    }
    case "get_stats": {
      const url = new URL(`${SPEEDTEST_API}/stats`);
      if (input.start_at)
        url.searchParams.set("filter[start_at]", `>=${input.start_at}`);
      const res = await fetch(url.toString(), { headers: stHeaders });
      return JSON.stringify(await res.json());
    }
    case "get_results": {
      const url = new URL(`${SPEEDTEST_API}/results`);
      url.searchParams.set("page[size]", String(input.per_page ?? 50));
      url.searchParams.set("sort", (input.sort as string) ?? "-created_at");
      if (input.start_at)
        url.searchParams.set("filter[start_at]", `>=${input.start_at}`);
      const res = await fetch(url.toString(), { headers: stHeaders });
      const json = await res.json();
      return JSON.stringify({
        results: (json.data || []).map(summarizeResult),
        total: json.meta?.total,
        per_page: json.meta?.per_page,
        current_page: json.meta?.current_page,
      });
    }
    case "get_single_result": {
      const res = await fetchSpeedtest(`/results/${input.id}`);
      const r = res.data;
      return JSON.stringify({
        ...summarizeResult(r),
        packet_loss: r.data?.packetLoss,
        isp: r.data?.isp,
        server: r.data?.server
          ? { name: r.data.server.name, location: r.data.server.location, country: r.data.server.country }
          : null,
        ping_detail: r.data?.ping,
        download_latency: r.data?.download?.latency,
        upload_latency: r.data?.upload?.latency,
        external_ip: r.data?.interface?.externalIp,
        error_message: r.data?.error,
      });
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

const SYSTEM_PROMPT = `You are a helpful assistant embedded in a speedtest monitoring dashboard. You help the user analyze their internet speed test data.

You have tools to query the Speedtest Tracker API. Key facts about the data:
- Download and upload speeds in tool results are already in Mbps.
- Ping is in milliseconds.
- Tests run hourly and can be "completed" or "failed".
- The ISP is Telefonica de Espana, testing against a Vodafone ES server in Madrid, Spain.
- The user is on a 1 Gbps fiber plan.

When analyzing performance:
- Be honest and critical. The user wants to know if they're getting what they pay for, not to be reassured.
- Fiber connections should consistently deliver 90%+ of advertised speeds. Averages below 850 Mbps on a 1 Gbps fiber plan are underperforming.
- Do NOT dismiss shortfalls as "typical" or "normal for ISPs." That applies to cable/DSL, not fiber.
- Compare upload vs download consistency — if upload is significantly better, the download shortfall is not just overhead.
- Flag failure rates above 3%, frequent dips below 500 Mbps, and any patterns (time of day, clustering).
- When the data shows a problem, say so clearly and suggest the user raise it with their ISP.

When answering:
- Be concise but thorough.
- Use markdown formatting (headers, bold, lists, tables) for readability.
- If the user asks about trends, fetch enough data to give a meaningful answer.
- Today's date is ${new Date().toISOString().split("T")[0]}.`;

app.post("/api/chat", async (c) => {
  try {
    const { messages } = await c.req.json<{
      messages: Anthropic.MessageParam[];
    }>();

    if (!CLAUDE_API_KEY) {
      return c.json({ error: "ANTHROPIC_API_KEY is not configured on the server." }, 500);
    }

    const client = new Anthropic({ apiKey: CLAUDE_API_KEY });

    // Only send the last 20 messages to avoid token bloat
    let currentMessages = messages.slice(-20);

    // Haiku 4.5 pricing per million tokens
    const INPUT_COST_PER_MTOK = 1.0;
    const OUTPUT_COST_PER_MTOK = 5.0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Tool use loop — run tools until we get a final text response
    for (let i = 0; i < 10; i++) {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages: currentMessages,
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      if (response.stop_reason === "tool_use") {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            try {
              const result = await executeTool(
                block.name,
                block.input as Record<string, unknown>
              );
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: result,
              });
            } catch (toolErr: any) {
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify({ error: toolErr.message }),
                is_error: true,
              });
            }
          }
        }

        currentMessages.push({ role: "assistant", content: response.content });
        currentMessages.push({ role: "user", content: toolResults });
      } else {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");

        const cost = (totalInputTokens / 1e6) * INPUT_COST_PER_MTOK
                   + (totalOutputTokens / 1e6) * OUTPUT_COST_PER_MTOK;

        return c.json({
          response: text,
          usage: {
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            cost: `$${cost.toFixed(4)}`,
          },
        });
      }
    }

    const cost = (totalInputTokens / 1e6) * INPUT_COST_PER_MTOK
               + (totalOutputTokens / 1e6) * OUTPUT_COST_PER_MTOK;
    return c.json({
      response: "Sorry, I hit my tool use limit. Try a simpler question.",
      usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens, cost: `$${cost.toFixed(4)}` },
    });
  } catch (err: any) {
    const status = err.status ?? 500;
    const msg = err.error?.error?.message ?? err.message ?? "Unknown error";
    console.error("Chat error:", msg);
    return c.json({ error: msg }, status);
  }
});

// Serve static files
app.use("/*", serveStatic({ root: "./public" }));

export default {
  port: 3547,
  fetch: app.fetch,
};
