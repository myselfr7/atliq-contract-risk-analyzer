// Local test server with no extra dependencies: serves ./dist (run `npm run build` first) and
// routes POST /api/review to the Vercel-style handler in api/review.js.
// Run: node scripts/dev_server.mjs   then open http://localhost:3000
import "./load_env.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import handler from "../api/review.js";

const PORT = Number(process.env.PORT || 3000);
const DIST = path.join(process.cwd(), "dist");
const PUBLIC = path.join(process.cwd(), "public");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/review")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    req.body = body ? JSON.parse(body) : {};
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
    return handler(req, res);
  }
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  for (const base of [DIST, PUBLIC]) {
    const f = path.join(base, p);
    if (f.startsWith(base) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.setHeader("Content-Type", types[path.extname(f)] || "application/octet-stream");
      return fs.createReadStream(f).pipe(res);
    }
  }
  res.statusCode = 404; res.end("not found");
}).listen(PORT, () => console.log(`dev server on http://localhost:${PORT}`));
