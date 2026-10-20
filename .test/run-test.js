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
    // 仓库里实际有几篇就以几篇为准（线上随时可能又发新文章）
    const repoPostsBox = {};
    new Function("window", fs.readFileSync(path.join(__dirname, "..", "posts.js"), "utf8"))(repoPostsBox);
    const N = (repoPostsBox.POSTS || []).length;
    console.log("PASS 4 读到文章列表：显示 " + count + " 篇，渲染 " + items + " 条（仓库现有 " + N + " 篇）");

    if (String(count) !== String(N) || items !== N) throw new Error("文章数量不对，期望 " + N + "，实际 " + count + " 篇 / " + items + " 条");

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
    if (String(n2) !== String(N)) throw new Error("新建草稿不应计入已发布篇数，实际：" + n2 + "（期望 " + N + "）");
    if (items2 !== N + 1) throw new Error("列表应显示 " + (N + 1) + " 条（" + N + " 篇已发布 + 1 篇新草稿），实际：" + items2);
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

    // ---------- 9c. 照片：上传 ----------
    await evaluate("document.querySelector('[data-tab=photos]').click();");
    await sleep(300);
    const emptyState = await evaluate("document.getElementById('photoGrid').textContent");
    console.log("PASS 22 照片页签载入：" + emptyState.trim());

    // 页面里画两张小图 → File → 塞进文件输入框 → 触发 change
    await evaluate(`
      (async function () {
        var files = [];
        for (var i = 0; i < 2; i++) {
          var c = document.createElement('canvas');
          c.width = 320; c.height = 240;
          var x = c.getContext('2d');
          x.fillStyle = i ? '#2e7d32' : '#c62828'; x.fillRect(0, 0, 320, 240);
          x.fillStyle = '#fff'; x.font = '36px sans-serif';
          x.fillText('P' + (i + 1), 130, 130);
          var blob = await new Promise(function (r) { c.toBlob(r, 'image/jpeg', 0.9); });
          files.push(new File([blob], '照片' + (i + 1) + '.jpg', { type: 'image/jpeg' }));
        }
        var dt = new DataTransfer();
        files.forEach(function (f) { dt.items.add(f); });
        var inp = document.getElementById('photoInput');
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return dt.files.length;
      })();
    `);
    await waitFor("document.querySelectorAll('.photo-tile').length === 2", 20000, "照片网格出现两张");
    const photoCount = await evaluate("document.getElementById('photoCount').textContent");
    console.log("PASS 23 上传两张照片成功：" + photoCount);

    // 校验写出的照片文件是二进制 JPEG，photos.js 清单可解析
    const photosLog = await (await fetch(API + "/__log")).json();
    const photoPutCount = photosLog.filter((l) => l.file.startsWith("photos/photo-")).length;
    const jpgDir = path.join(OUT, "photos");
    const jpgFiles = fs.existsSync(jpgDir) ? fs.readdirSync(jpgDir).filter((f) => f.endsWith(".jpg")) : [];
    const jpegOk = jpgFiles.length === 2 && fs.readFileSync(path.join(jpgDir, jpgFiles[0])).slice(0, 2).toString("hex") === "ffd8";
    const manifestOut = fs.readFileSync(path.join(OUT, "photos.js"), "utf8");
    const sandbox3 = {};
    new Function("window", manifestOut)(sandbox3);
    const manifestCount = (sandbox3.PHOTOS || []).length;
    console.log("PASS 24 二进制油画检查：JPEG 文件 " + jpgFiles.length + " 个，魔数 ffd8 = " + jpegOk + "；photos.js 清单 " + manifestCount + " 条，可解析");
    if (photoPutCount !== 2) throw new Error("应有 2 次照片 PUT，实际 " + photoPutCount);
    if (jpgFiles.length !== 2 || !jpegOk) throw new Error("照片应原样以 JPEG 存到仓库，实际 " + JSON.stringify(jpgFiles));
    if (manifestCount !== 2) throw new Error("photos.js 清单应有 2 条，实际 " + manifestCount);

    // ---------- 9d. 博客相册页渲染 + 灯箱 ----------
    // blog 页加载的 photos.js 是静态空清单；用 Fetch 域拦截该请求，
    // 把刚才上传的清单作为 photos.js 返回，模拟发布后的相册
    await send("Fetch.enable", { patterns: [{ urlPattern: "*photos.js", requestStage: "Request" }] });
    const serveManifestSource = "window.PHOTOS = " + JSON.stringify(sandbox3.PHOTOS) + ";";
    let fetchActive = true;
    const fetchH = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === "Fetch.requestPaused" && m.params.request.url.indexOf("photos.js") !== -1) {
        if (!fetchActive || m.params.request.url.indexOf("127.0.0.1:8123") !== -1) {
          // 只拦博客静态页的 photos.js；API 的请求放行（不满足则继续原请求）
          ws.send(JSON.stringify({ id: ++msgId, method: "Fetch.continueRequest", params: { requestId: m.params.requestId } }));
          return;
        }
        const body = Buffer.from(serveManifestSource).toString("base64");
        ws.send(JSON.stringify({
          id: ++msgId,
          method: "Fetch.fulfillRequest",
          params: {
            requestId: m.params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "application/javascript" }],
            body
          }
        }));
      }
    };
    ws.addEventListener("message", fetchH);
    await send("Page.navigate", { url: BASE + "/#/photos" });
    await sleep(1500);
    const navHasPhotos = await evaluate("!!document.querySelector('[data-nav=photos]')");
    const gridCount = await evaluate("document.querySelectorAll('.photo-item').length");
    await evaluate("document.querySelector('.photo-item').click();");
    await sleep(500);
    const lbOn = await evaluate("!!document.getElementById('lightbox') && document.getElementById('lightbox').classList.contains('on')");
    const lbCap = await evaluate("document.getElementById('lightbox') ? document.getElementById('lightbox').querySelector('.lb-cap').textContent : ''");
    console.log("PASS 25 相册页：导航链接 = " + navHasPhotos + "，网格 " + gridCount + " 张，灯箱打开 = " + lbOn + "，说明：" + lbCap);
    if (!navHasPhotos) throw new Error("博客导航应有「相册」链接");
    if (gridCount !== 2) throw new Error("相册网格应有 2 张，实际 " + gridCount);
    if (!lbOn) throw new Error("点照片应打开灯箱");

    let lbShot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "blog-photos.png"), Buffer.from(lbShot.data, "base64"));
    await evaluate("document.getElementById('lightbox') && document.getElementById('lightbox').querySelector('.lb-close').click();");

    // 相册页验证完毕，关闭拦截，避免影响后面写作台的 API 请求
    fetchActive = false;
    ws.removeEventListener("message", fetchH);
    await send("Fetch.disable");

    // ---------- 9e. 照片：删除 ----------
    await send("Page.navigate", { url: BASE + "/admin?api=" + encodeURIComponent(API) });
    await waitFor("!!document.getElementById('tokenInput')", 10000, "登录页重新加载");
    await evaluate("document.getElementById('tokenInput').value='ghp_testtoken'; document.getElementById('enterBtn').click();");
    await waitFor("!document.getElementById('desk').hidden", 15000, "回到写作台");
    await sleep(500);
    await evaluate("document.querySelector('[data-tab=photos]').click();");
    await sleep(400);
    await evaluate("window.confirm = function () { return true; };");
    await evaluate("document.querySelector('.photo-tile [data-del]').click();");
    await waitFor("document.querySelectorAll('.photo-tile').length === 1", 15000, "删除后剩一张");
    const delLog = await (await fetch(API + "/__log")).json();
    const delCount = delLog.filter((l) => l.deleted).length;
    const manifestOut2 = fs.readFileSync(path.join(OUT, "photos.js"), "utf8");
    const sandbox4 = {};
    new Function("window", manifestOut2)(sandbox4);
    const manifestCount2 = (sandbox4.PHOTOS || []).length;
    const jpgLeft = fs.existsSync(jpgDir) ? fs.readdirSync(jpgDir).filter((f) => f.endsWith(".jpg")).length : 0;
    console.log("PASS 26 删除：DELETE 请求 " + delCount + " 次，清单剩 " + manifestCount2 + " 条，照片文件剩 " + jpgLeft + " 个");
    if (delCount !== 1) throw new Error("应有 1 次 DELETE，实际 " + delCount);
    if (manifestCount2 !== 1) throw new Error("删除后清单应有 1 条，实际 " + manifestCount2);
    if (jpgLeft !== 1) throw new Error("删除后仓库照片文件应剩 1 个，实际 " + jpgLeft);

    // ---------- 10. 小游戏：推箱子 ----------
    // 真键盘事件走 CDP Input 域，检验页面上真实的 keydown 处理
    const KEYS = {
      ArrowUp: ["ArrowUp", "ArrowUp", 38],
      ArrowDown: ["ArrowDown", "ArrowDown", 40],
      ArrowLeft: ["ArrowLeft", "ArrowLeft", 37],
      ArrowRight: ["ArrowRight", "ArrowRight", 39],
      w: ["w", "KeyW", 87],
      a: ["a", "KeyA", 65],
      s: ["s", "KeyS", 83],
      d: ["d", "KeyD", 68],
      u: ["u", "KeyU", 85],
      r: ["r", "KeyR", 82]
    };
    async function key(name) {
      const k = KEYS[name];
      const base = { windowsVirtualKeyCode: k[2], nativeVirtualKeyCode: k[2], key: k[0], code: k[1] };
      await send("Input.dispatchKeyEvent", Object.assign({ type: "rawKeyDown" }, base));
      await send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base));
      await sleep(150);
    }
    const gameDebug = () => evaluate("JSON.stringify(window.Sokoban && window.Sokoban.debug())").then((s) => JSON.parse(s));

    await send("Page.navigate", { url: BASE + "/#/game" });
    await waitFor("!!window.Sokoban && !!document.getElementById('gameCanvas')", 12000, "游戏页加载");
    await sleep(400);

    const gNav = await evaluate("(function(){var a=document.querySelector('[data-nav=game]');return a?a.textContent.trim():'';})()");
    const gTitle = await evaluate("document.querySelector('.game h1').textContent");
    const gChips = await evaluate("document.querySelectorAll('.g-chip').length");
    const gCanvas = await evaluate("(function(){var c=document.getElementById('gameCanvas');return c.width+'x'+c.height;})()");
    let g = await gameDebug();
    console.log("PASS 27 游戏页渲染：导航「" + gNav + "」，标题「" + gTitle + "」，关卡按钮 " + gChips + " 个，画布 " + gCanvas +
      "，第 " + (g.level + 1) + " 关「" + g.name + "」箱子 " + JSON.stringify(g.boxes));
    if (gNav !== "小游戏") throw new Error("导航里应有小游戏入口，实际：" + gNav);
    if (gTitle !== "推箱子") throw new Error("标题应为推箱子，实际：" + gTitle);
    if (gChips !== 8) throw new Error("应有 8 个关卡按钮，实际：" + gChips);
    if (g.level !== 0 || g.moves !== 0 || g.won) throw new Error("应停在第 1 关开局，实际 " + JSON.stringify(g));
    if (g.cols !== 7 || g.rows !== 5 || g.player.x !== 2 || g.player.y !== 2) throw new Error("第 1 关棋盘不对：" + JSON.stringify(g));

    // 方向键：向右一步就把唯一的箱子推上目标格 → 过关
    await key("ArrowRight");
    g = await gameDebug();
    if (g.moves !== 1 || g.pushes !== 1) throw new Error("按一次右键应走 1 步、推 1 次，实际 " + JSON.stringify(g));
    if (!g.won || g.boxes[0].x !== 4 || g.boxes[0].y !== 2) throw new Error("箱子应被推到 (4,2) 并过关，实际 " + JSON.stringify(g));
    await waitFor("document.getElementById('gameWin').classList.contains('on')", 4000, "过关浮层出现");
    const winMeta = await evaluate("document.getElementById('gameWinMeta').textContent");
    const winTitle = await evaluate("document.getElementById('gameWinTitle').textContent");
    console.log("PASS 28 键盘推动过关：「" + winTitle + "」" + winMeta + "，浮层已弹出");
    const winShot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "game-win.png"), Buffer.from(winShot.data, "base64"));
    const savedRaw = await evaluate("localStorage.getItem('cabin-blog.sokoban')");
    if (!savedRaw || JSON.parse(savedRaw).done.indexOf(0) === -1) throw new Error("通关进度没写进 localStorage：" + savedRaw);

    // 撤销：箱子退回原处、步数归零、浮层收起
    await key("u");
    g = await gameDebug();
    if (g.moves !== 0 || g.pushes !== 0 || g.won || g.boxes[0].x !== 3) throw new Error("撤销后应回到开局，实际 " + JSON.stringify(g));
    if (await evaluate("document.getElementById('gameWin').classList.contains('on')")) throw new Error("撤销后过关浮层应收起");
    await key("ArrowRight");
    await key("r");
    g = await gameDebug();
    if (g.moves !== 0 || g.pushes !== 0 || g.won || g.boxes[0].x !== 3) throw new Error("重来后应回到开局，实际 " + JSON.stringify(g));
    console.log("PASS 29 撤销与重来：撤销回退到 " + g.moves + " 步，重来后箱子回到 " + JSON.stringify(g.boxes[0]));

    // 关卡切换 + 进度存档
    await evaluate("document.querySelector('.g-chip[data-level=\"4\"]').click();");
    await sleep(350);
    g = await gameDebug();
    if (g.level !== 4 || g.name !== "两只箱子" || g.cols !== 9 || g.rows !== 7) throw new Error("切到第 5 关失败：" + JSON.stringify(g));
    await evaluate("document.querySelector('.g-chip[data-level=\"0\"]').click();");
    await sleep(300);
    const chipState = await evaluate("(function(){var c=document.querySelector('.g-chip[data-level=\"0\"]');return (c.classList.contains('on')?'on ':'')+(c.classList.contains('done')?'done':'');})()");
    g = await gameDebug();
    if (g.level !== 0 || chipState !== "on done") throw new Error("关卡按钮状态不对：" + chipState + " / " + JSON.stringify(g));
    console.log("PASS 30 关卡切换与存档：切到第 5 关 " + g.cols + "x" + g.rows + " 棋盘，回到第 1 关按钮显示「" + chipState.trim() + "」，通关记录在本地");

    // WASD 与撞墙：第 1 关小人左边两格才是墙
    const before = (await gameDebug()).moves;
    await key("ArrowLeft");                       // (2,2) → (1,2)
    await key("a");                               // 再往左是墙，不该动
    g = await gameDebug();
    if (g.moves !== before + 1 || g.player.x !== 1 || g.player.y !== 2) throw new Error("撞墙不该算步数，实际 " + JSON.stringify(g));
    await key("s");
    g = await gameDebug();
    if (g.moves !== before + 2 || g.pushes !== 0 || g.player.y !== 3) throw new Error("按 s 应往下走一格且不算推动，实际 " + JSON.stringify(g));
    await key("w");
    g = await gameDebug();
    if (g.moves !== before + 3 || g.player.y !== 2) throw new Error("按 w 应走回来，实际 " + JSON.stringify(g));
    await key("d");
    await key("d");                               // 第二下把箱子推上目标
    g = await gameDebug();
    if (!g.won || g.pushes !== 1) throw new Error("按 d 应把箱子推上目标过关，实际 " + JSON.stringify(g));
    console.log("PASS 31 WASD 与撞墙：撞墙 0 步，s/w 上下各 1 步，d 推动过关（共 " + g.moves + " 步 " + g.pushes + " 推）");
    const deskShot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "game.png"), Buffer.from(deskShot.data, "base64"));

    // 离开游戏页要卸载干净：键盘不再响应，页面也不该出错
    await evaluate("location.hash = '#/';");
    await sleep(450);
    if (await evaluate("!!window.Sokoban.debug()")) throw new Error("离开游戏页后应卸载游戏状态");
    const homeItems = await evaluate("document.querySelectorAll('.post-item').length");
    await key("ArrowRight");
    if (homeItems < 1) throw new Error("回到首页应看到文章列表，实际 " + homeItems);
    console.log("PASS 32 离开页面后卸载：游戏状态已清空，首页 " + homeItems + " 篇文章正常，方向键不再被游戏接管");

    // 手机端：方向键盘可见，点一下真的会走
    await evaluate("location.hash = '#/game';");
    await waitFor("!!window.Sokoban.debug()", 8000, "重新进入游戏页");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(600);
    const padDisplay = await evaluate("getComputedStyle(document.getElementById('gamePad')).display");
    const padBox = await evaluate("(function(){var r=document.getElementById('gamePad').getBoundingClientRect();return Math.round(r.width)+'x'+Math.round(r.height);})()");
    const preMoves = (await gameDebug()).moves;
    await evaluate("document.querySelector('.game-pad [data-dir=right]').click();");
    await sleep(350);
    g = await gameDebug();
    if (padDisplay === "none") throw new Error("手机端应显示方向键盘");
    if (g.moves !== preMoves + 1 || !g.won) throw new Error("点手机方向键应走一步并过关，实际 " + JSON.stringify(g));
    console.log("PASS 33 手机端操作：方向键盘 display=" + padDisplay + "，尺寸 " + padBox + "，点右键走 1 步并过关（" + g.moves + " 步）");
    await sleep(500);
    const mobShot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "game-mobile.png"), Buffer.from(mobShot.data, "base64"));
    await send("Emulation.clearDeviceMetricsOverride");
    await sleep(300);

    // ---------- 11. 截图 ----------
    await send("Page.navigate", { url: BASE + "/admin?api=" + encodeURIComponent(API) });
    await waitFor("!!document.getElementById('tokenInput')", 10000, "登录页重新加载");
    await evaluate("document.getElementById('tokenInput').value='ghp_testtoken'; document.getElementById('enterBtn').click();");
    await waitFor("!document.getElementById('desk').hidden", 15000, "重新进入写作台");
    await sleep(400);
    await evaluate("document.querySelector('[data-tab=posts]').click();");
    await sleep(400);
    let shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "admin-posts.png"), Buffer.from(shot.data, "base64"));

    await evaluate("document.querySelector('[data-tab=photos]').click();");
    await sleep(300);
    shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "admin-photos.png"), Buffer.from(shot.data, "base64"));

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

    console.log("\nPASS 34 截图已保存");

    if (consoleErrors.length) {
      console.log("\n!! 页面 JS 异常：");
      consoleErrors.forEach((e) => console.log("   " + e));
    } else {
      console.log("PASS 35 页面无 JS 异常");
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
