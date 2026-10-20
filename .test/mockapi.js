/* 仅用于本地自测：模拟 GitHub contents API，不参与部署 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "out");
const PORT = 8123;

fs.mkdirSync(OUT, { recursive: true });

const files = {};
["posts.js", "site.js"].forEach(function (f) {
  files[f] = fs.readFileSync(path.join(ROOT, f), "utf8");
});

const log = [];

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
      "Access-Control-Allow-Headers": "authorization,content-type,accept"
    });
    res.end();
    return;
  }

  if (p === "/__log") return json(res, 200, log);

  // 每次跑测试前重置，让测试可以反复运行
  if (p === "/__reset") {
    ["posts.js", "site.js"].forEach(function (f) {
      files[f] = fs.readFileSync(path.join(ROOT, f), "utf8");
    });
    log.length = 0;
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    return json(res, 200, { ok: true });
  }

  const auth = req.headers["authorization"] || "";
  if (/bad-token/.test(auth)) return json(res, 401, { message: "Bad credentials" });

  const repoMatch = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repoMatch) return json(res, 200, { full_name: repoMatch[1] + "/" + repoMatch[2], default_branch: "main" });

  const fileMatch = p.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
  if (fileMatch) {
    const name = decodeURIComponent(fileMatch[3]);
    if (!(name in files)) return json(res, 404, { message: "Not Found" });

    if (req.method === "GET") {
      return json(res, 200, {
        name,
        sha: "sha-" + Buffer.from(name + files[name]).length,
        content: Buffer.from(files[name], "utf8").toString("base64").replace(/(.{76})/g, "$1\n")
      });
    }

    if (req.method === "PUT") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        files[name] = Buffer.from(body.content, "base64").toString("utf8");
        fs.writeFileSync(path.join(OUT, name), files[name], "utf8");
        log.push({ file: name, message: body.message, bytes: Buffer.byteLength(files[name]) });
        json(res, 200, { content: { sha: "sha-" + Buffer.from(name + files[name]).length } });
      });
      return;
    }
  }

  json(res, 404, { message: "Not Found: " + p });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("mock github api on http://127.0.0.1:" + PORT);
});
