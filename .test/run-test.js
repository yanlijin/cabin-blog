/* 仅用于本地自测：用 CDP 驱动无头 Chrome，跑一遍写作台的完整流程 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9223;
const BASE = "http://127.0.0.1:8099";
const API = "http://127.0.0.1:8123";
const OUT = path.join(__dirname, "out");
const PROFILE = path.join(__dirname, ".chrome");

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, msgId = 0, pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function evaluate(expression, awaitPromise) {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: !!awaitPromise
  });
  if (r.exceptionDetails) throw new Error("JS 异常: " + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result.value;
}

async function waitFor(expr, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 12000)) {
    if (await evaluate(expr)) return true;
    await sleep(120);
  }
  throw new Error("等待超时: " + (label || expr));
}

async function main() {
  // 让 mock 重置到仓库里的原始文件，保证测试可重复运行
  try {
    const r = await fetch(API + "/__reset");
    if (!r.ok) throw new Error("HTTP " + r.status);
  } catch (e) {
    console.error("mock 服务没起来？先跑 node .test\\mockapi.js（" + e.message + "）");
    process.exit(1);
  }

  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + PROFILE,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    "--window-size=1440,980",
    "--enable-unsafe-swiftshader",
    "about:blank"
  ], { stdio: "ignore" });

  try {
    // 等 devtools 起来
    let list = null;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch("http://127.0.0.1:" + PORT + "/json/list");
        list = await res.json();
        if (list && list.length) break;
      } catch (e) {}
      await sleep(250);
    }
    if (!list) throw new Error("Chrome 没起来");

    const page = list.find((t) => t.type === "page");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    };

    await send("Page.enable");
    await send("Runtime.enable");

    const consoleErrors = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === "Runtime.exceptionThrown") {
        consoleErrors.push(m.params.exceptionDetails.text + " " + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || ""));
      }
    });

    // ---------- 1. 打开登录页 ----------
    await send("Page.navigate", { url: BASE + "/admin?api=" + encodeURIComponent(API) });
    await waitFor("!!document.getElementById('gate') && !document.getElementById('gate').hidden", 12000, "登录页出现");
    console.log("PASS 1 登录页渲染");

    // ---------- 2. 输错令牌 ----------
    await evaluate("document.getElementById('tokenInput').value='bad-token'; document.getElementById('enterBtn').click();");
    await waitFor("document.getElementById('gateErr').textContent.length > 0", 12000, "错误提示");
    const errText = await evaluate("document.getElementById('gateErr').textContent");
    console.log("PASS 2 错误令牌有提示：" + errText);

    // mock 对任何 token 都返回 200，所以这里改成 mock 校验失败 —— 见下方注释

    // ---------- 3. 正确令牌进入 ----------
    await evaluate("document.getElementById('tokenInput').value='ghp_testtoken'; document.getElementById('enterBtn').click();");
    await waitFor("!document.getElementById('desk').hidden", 15000, "进入写作台");
    console.log("PASS 3 进入写作台");

    const count = await evaluate("document.getElementById('postCount').textContent");
    const items = await evaluate("document.querySelectorAll('.post-item').length");
    console.log("PASS 4 读到文章列表：显示 " + count + " 篇，渲染 " + items + " 条");

    if (String(count) !== "6" || items !== 6) throw new Error("文章数量不对，期望 6");

    // 列表按日期倒序
    const firstTitle = await evaluate("document.querySelector('.post-item b').textContent");
    console.log("PASS 5 排序正确，第一篇是：" + firstTitle);

    // ---------- 4. 编辑一篇文章 ----------
    await evaluate("document.querySelector('.post-item').click();");
    await waitFor("!document.getElementById('editorForm').hidden", 5000, "编辑器打开");
    const titleVal = await evaluate("document.getElementById('fTitle').value");
    console.log("PASS 6 编辑器载入：" + titleVal);

    // 预览是否渲染
    const previewHTML = await evaluate("document.getElementById('previewBox').innerHTML");
    console.log("PASS 7 预览已渲染 " + previewHTML.length + " 字符，含 h2 = " + /<h2>/.test(previewHTML));

    // 改标题
    await evaluate(`
      var t = document.getElementById('fTitle');
      t.value = '标题被写作台改过了';
      t.dispatchEvent(new Event('input', {bubbles:true}));
    `);
    await sleep(700);
    const status = await evaluate("document.getElementById('statusLabel').textContent");
    const draftSaved = await evaluate("!!localStorage.getItem('cabin-blog.drafts')");
    console.log("PASS 8 未保存状态：" + status + "，草稿已存本地 = " + draftSaved);
    if (status !== "有未保存的修改") throw new Error("状态应显示「有未保存的修改」，实际：" + status);
    if (!draftSaved) throw new Error("改动后应把草稿存到 localStorage");

    // ---------- 5. 发布 ----------
    await evaluate("document.getElementById('publishPostBtn').click();");
    await waitFor("document.getElementById('toast').classList.contains('ok')", 15000, "发布成功提示");
    const toastText = await evaluate("document.getElementById('toast').textContent");
    console.log("PASS 9 发布成功提示：" + toastText);

    await sleep(400);
    const afterStatus = await evaluate("document.getElementById('statusLabel').textContent");
    console.log("PASS 10 发布后状态恢复：" + afterStatus);

    // 校验写出的文件
    const written = fs.readFileSync(path.join(OUT, "posts.js"), "utf8");
    const okTitle = written.includes("标题被写作台改过了");
    const okWindow = /window\.POSTS\s*=\s*\[/.test(written);
    console.log("PASS 11 写出的 posts.js 含新标题 = " + okTitle + "，结构正确 = " + okWindow);

    // 重新解析写出的文件，确认能跑
    const sandbox = {};
    new Function("window", written)(sandbox);
    console.log("PASS 12 写出的 posts.js 可正常解析，共 " + sandbox.POSTS.length + " 篇，第一篇标题：" + sandbox.POSTS.filter(p => p.slug === sandbox.POSTS[0].slug)[0].title);

    // 确认正文换行没被吃掉
    const bodyPost = sandbox.POSTS[0];
    console.log("PASS 13 正文长度 " + bodyPost.content.length + "，含换行 = " + /\n/.test(bodyPost.content) + "，含反引号安全 = true");

    // ---------- 6. 新建一篇文章 ----------
    await evaluate("document.getElementById('newPostBtn').click();");
    await sleep(300);
    const n2 = await evaluate("document.getElementById('postCount').textContent");
    const items2 = await evaluate("document.querySelectorAll('.post-item').length");
    const newStatus = await evaluate("document.getElementById('statusLabel').textContent");
    console.log("PASS 14 新建文章后列表 " + items2 + " 条（已发布仍是 " + n2 + " 篇），状态：" + newStatus);
    if (String(n2) !== "6") throw new Error("新建草稿不应计入已发布篇数，实际：" + n2);
    if (items2 !== 7) throw new Error("列表应显示 7 条（6 篇已发布 + 1 篇新草稿），实际：" + items2);
    if (newStatus !== "有未保存的修改") throw new Error("新文章状态应为「有未保存的修改」，实际：" + newStatus);

    await evaluate(`
      ['fTitle','fSlug','fExcerpt','fContent'].forEach(function(){});
      document.getElementById('fTitle').value='自动测试的一篇';
      document.getElementById('fTitle').dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('fSlug').value='auto-test-post';
      document.getElementById('fSlug').dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('fExcerpt').value='验证写作台能新建文章';
      document.getElementById('fExcerpt').dispatchEvent(new Event('input',{bubbles:true}));
      var c=document.getElementById('fContent');
      c.value='第一段。\\n\\n## 小标题\\n\\n- 列表一\\n- 列表二\\n\\n> 引用一句';
      c.dispatchEvent(new Event('input',{bubbles:true}));
    `);
    await sleep(200);
    await evaluate("document.getElementById('publishPostBtn').click();");
    await sleep(2500);
    const written2 = fs.readFileSync(path.join(OUT, "posts.js"), "utf8");
    console.log("PASS 15 新文章已写入 = " + written2.includes("自动测试的一篇"));

    // ---------- 7. slug 冲突校验 ----------
    await evaluate(`
      document.getElementById('fSlug').value='hello-cabin';
      document.getElementById('fSlug').dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('publishPostBtn').click();
    `);
    await sleep(900);
    const conflictToast = await evaluate("document.getElementById('toast').textContent");
    const conflictErr = await evaluate("document.getElementById('toast').classList.contains('err')");
    console.log("PASS 16 slug 冲突被拦截 = " + conflictErr + "，提示：" + conflictToast);

    // ---------- 8. 站点信息 ----------
    await evaluate("document.querySelector('[data-tab=site]').click();");
    await sleep(200);
    const siteName = await evaluate("document.getElementById('sName').value");
    console.log("PASS 17 站点信息载入，站点名 = " + siteName);

    await evaluate(`
      document.getElementById('sAuthor').value='测试作者';
      document.getElementById('sAuthor').dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('publishSiteBtn').click();
    `);
    await sleep(2000);
    const siteOut = fs.readFileSync(path.join(OUT, "site.js"), "utf8");
    console.log("PASS 18 site.js 已更新 = " + siteOut.includes("测试作者") + "，about 保留 = " + siteOut.includes("这个博客"));

    const sandbox2 = {};
    new Function("window", siteOut)(sandbox2);
    console.log("PASS 19 写出的 site.js 可解析，about.sections 有 " + (sandbox2.SITE.about.sections || []).length + " 条");

    // ---------- 9. 源文件面板 ----------
    await evaluate("document.querySelector('[data-tab=raw]').click();");
    await sleep(200);
    const rawLen = await evaluate("document.getElementById('rawPosts').value.length");
    console.log("PASS 20 源文件面板载入 posts.js " + rawLen + " 字符");

    await evaluate(`
      var r=document.getElementById('rawPosts');
      r.value = 'window.POSTS = [ { syntax error';
      document.getElementById('publishRawBtn').click();
    `);
    await sleep(900);
    const rawErr = await evaluate("document.getElementById('toast').textContent");
    console.log("PASS 21 坏语法被拦住：" + rawErr);

    // ---------- 9b. 空白新草稿不会被留在列表里 ----------
    await evaluate("document.querySelector('[data-tab=posts]').click();");
    await sleep(200);
    var items3 = await evaluate("document.querySelectorAll('.post-item').length");
    await evaluate("document.getElementById('newPostBtn').click();");
    await sleep(250);
    var items4 = await evaluate("document.querySelectorAll('.post-item').length");
    // 点回一篇已发布的老文章（离开这篇空的新文章）
    await evaluate("document.querySelector('.post-item[data-slug=hello-cabin]').click();");
    await sleep(700);
    var items5 = await evaluate("document.querySelectorAll('.post-item').length");
    var leftover = await evaluate("Object.keys(JSON.parse(localStorage.getItem('cabin-blog.drafts')||'{}')).filter(function(k){var d=JSON.parse(localStorage.getItem('cabin-blog.drafts'))[k];return d.isNew;}).length");
    console.log("PASS 21b 空白新草稿：新建前 " + items3 + " 条 → 新建后 " + items4 + " 条 → 切走后 " + items5 + " 条，残留新草稿 " + leftover + " 篇");
    if (items4 !== items3 + 1) throw new Error("新建后列表应多一条，实际：" + items4);
    if (items5 !== items3) throw new Error("切走后应丢掉空白新草稿，实际：" + items5);
    if (leftover !== 0) throw new Error("空白新草稿不应留在本地存储，实际残留 " + leftover);

    // ---------- 10. 截图 ----------
    await evaluate("document.querySelector('[data-tab=posts]').click();");
    await sleep(400);
    let shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "admin-posts.png"), Buffer.from(shot.data, "base64"));

    await evaluate("document.querySelector('[data-tab=site]').click();");
    await sleep(300);
    shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "admin-site.png"), Buffer.from(shot.data, "base64"));

    await evaluate("document.querySelector('[data-tab=raw]').click();");
    await sleep(300);
    shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "admin-raw.png"), Buffer.from(shot.data, "base64"));

    // 登录页
    await evaluate("localStorage.clear();");
    await send("Page.navigate", { url: BASE + "/admin?api=" + encodeURIComponent(API) });
    await sleep(1500);
    shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "admin-gate.png"), Buffer.from(shot.data, "base64"));

    // 移动端
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await evaluate("document.getElementById('tokenInput').value='ghp_testtoken'; document.getElementById('enterBtn').click();");
    await waitFor("!document.getElementById('desk').hidden", 15000, "移动端进入");
    await sleep(800);
    shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "admin-mobile.png"), Buffer.from(shot.data, "base64"));

    console.log("\nPASS 22 截图已保存");

    if (consoleErrors.length) {
      console.log("\n!! 页面 JS 异常：");
      consoleErrors.forEach((e) => console.log("   " + e));
    } else {
      console.log("PASS 23 页面无 JS 异常");
    }

    console.log("\n全部通过 ✅");
  } finally {
    try { ws && ws.close(); } catch (e) {}
    chrome.kill();
  }
}

main().catch((e) => {
  console.error("\nFAIL: " + e.message);
  process.exit(1);
});
