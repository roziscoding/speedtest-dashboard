import { Hono } from "hono";
import { serveStatic } from "hono/bun";

const app = new Hono();

const SPEEDTEST_API = "http://speed.ada.local/api/v1";
const API_KEY = process.env.SPEEDTEST_API_KEY ?? "fNhTR2Su0Lk2JZDG5FQsPzuXNnJ6b6YI1Lm3JeU5c98c7489";

const headers = {
  Accept: "application/json",
  Authorization: `Bearer ${API_KEY}`,
};

// Proxy: latest result
app.get("/api/latest", async (c) => {
  const res = await fetch(`${SPEEDTEST_API}/results/latest`, { headers });
  return c.json(await res.json());
});

// Proxy: stats with optional date range
app.get("/api/stats", async (c) => {
  const url = new URL(`${SPEEDTEST_API}/stats`);
  const start = c.req.query("start_at");
  const end = c.req.query("end_at");
  if (start) url.searchParams.set("start_at", start);
  if (end) url.searchParams.set("end_at", end);
  const res = await fetch(url.toString(), { headers });
  return c.json(await res.json());
});

// Proxy: paginated results
app.get("/api/results", async (c) => {
  const url = new URL(`${SPEEDTEST_API}/results`);
  url.searchParams.set("per.page", c.req.query("per_page") ?? "500");
  url.searchParams.set("sort", c.req.query("sort") ?? "-created_at");
  const page = c.req.query("page");
  if (page) url.searchParams.set("page[number]", page);
  const start = c.req.query("start_at");
  const end = c.req.query("end_at");
  if (start) url.searchParams.set("filter[start_at]", start);
  if (end) url.searchParams.set("filter[end_at]", end);
  const res = await fetch(url.toString(), { headers });
  return c.json(await res.json());
});

// Serve static files
app.use("/*", serveStatic({ root: "./public" }));

export default {
  port: 3547,
  fetch: app.fetch,
};
