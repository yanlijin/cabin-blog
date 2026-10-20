/* ============================================================
   写作台（/admin）—— 在浏览器里改博客，点一下就发布
   原理：令牌存在本机浏览器，改动通过 GitHub API 提交到仓库，
   Netlify 监听到 push 后自动重新部署。
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- 配置 ---------------- */

  var CONFIG = {
    owner: "yanlijin",
    repo: "cabin-blog",
    branch: "main"
  };

  var API = "https://api.github.com";

  // 本地开发时才允许指向别的地址（避免有人发个链接就把令牌骗走）
  (function () {
    var host = location.hostname;
    var isLocal = host === "localhost" || host === "127.0.0.1" || host === "";
    var override = isLocal && new URLSearchParams(location.search).get("api");
    if (override && /^https?:\/\//.test(override)) API = override.replace(/\/$/, "");
  })();

  var KEY_TOKEN = "cabin-blog.token";
  var KEY_DRAFTS = "cabin-blog.drafts";
  var FILE_POSTS = "posts.js";
  var FILE_SITE = "site.js";

  /* ---------------- 状态 ---------------- */

  var S = {
    token: "",
    posts: [],          // 已发布到 GitHub 的文章
    site: {},           // 已发布的站点配置
    sha: { posts: "", site: "" },
    rawText: { posts: "", site: "" },
    selected: null,
    saving: false
  };

  var drafts = loadDrafts();   // 本地草稿：{ slug: { data, ts, isNew } }
  var saveTimer = 0;

  /* ---------------- 小工具 ---------------- */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(msg, kind) {
    var el = $("toast");
    el.textContent = msg;
    el.className = "toast on" + (kind ? " " + kind : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      el.className = "toast" + (kind ? " " + kind : "");
    }, kind === "err" ? 5200 : 3000);
  }

  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = "";
    var CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  function b64decode(b64) {
    var bin = atob(String(b64 || "").replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function today() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function loadDrafts() {
    try { return JSON.parse(localStorage.getItem(KEY_DRAFTS) || "{}") || {}; }
    catch (e) { return {}; }
  }

  function saveDrafts() {
    try { localStorage.setItem(KEY_DRAFTS, JSON.stringify(drafts)); } catch (e) {}
  }

  function isNewDraft(slug) {
    return !!(slug && drafts[slug] && drafts[slug].isNew);
  }

  function isBlank(d) {
    return !String(d.title || "").trim() && !String(d.content || "").trim();
  }

  /* ---------------- GitHub API ---------------- */

  function headers() {
    return {
      "Authorization": "token " + S.token,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json"
    };
  }

  async function apiError(res) {
    var detail = "";
    try {
      var j = await res.json();
      detail = (j && j.message) || "";
    } catch (e) {}
    if (res.status === 401) return "令牌无效或已过期，请重新生成一个。";
    if (res.status === 403) return "令牌权限不足（需要 repo 权限），或请求太频繁。";
    if (res.status === 404) return "找不到仓库或没有权限：" + CONFIG.owner + "/" + CONFIG.repo + (detail ? "（" + detail + "）" : "");
    if (res.status === 409) return "文件在别处被改过，刷新页面再试。";
    return "GitHub 返回 " + res.status + (detail ? "：" + detail : "");
  }

  async function verify() {
    var res = await fetch(API + "/repos/" + CONFIG.owner + "/" + CONFIG.repo, {
      headers: { "Authorization": "token " + S.token, "Accept": "application/vnd.github+json" }
    });
    if (!res.ok) throw new Error(await apiError(res));
    return res.json();
  }

  async function readFile(path) {
    var res = await fetch(
      API + "/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/" + path +
      "?ref=" + encodeURIComponent(CONFIG.branch),
      { headers: headers(), cache: "no-store" }
    );
    if (!res.ok) throw new Error(await apiError(res));
    var j = await res.json();
    return { text: b64decode(j.content), sha: j.sha };
  }

  async function writeFile(path, text, message, sha) {
    var body = { message: message, content: b64encode(text), branch: CONFIG.branch };
    if (sha) body.sha = sha;

    var res = await fetch(
      API + "/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/" + path,
      { method: "PUT", headers: headers(), body: JSON.stringify(body) }
    );
    if (!res.ok) throw new Error(await apiError(res));
    var j = await res.json();
    return j.content ? j.content.sha : "";
  }

  /* ---------------- 解析数据文件 ---------------- */

  function parsePosts(text) {
    var sandbox = {};
    try {
      new Function("window", text)(sandbox);
    } catch (e) {
      throw new Error("posts.js 有语法错误，无法解析：" + e.message);
    }
    return Array.isArray(sandbox.POSTS) ? sandbox.POSTS : [];
  }

  function parseSite(text) {
    var sandbox = {};
    try {
      new Function("window", text)(sandbox);
    } catch (e) {
      throw new Error("site.js 有语法错误，无法解析：" + e.message);
    }
    return sandbox.SITE && typeof sandbox.SITE === "object" ? sandbox.SITE : {};
  }

  /* ---------------- 序列化回 JS 文件 ---------------- */

  function q(s) { return JSON.stringify(String(s == null ? "" : s)); }

  // 正文用模板字符串：保留换行，手改文件时也好读
  function tpl(s) {
    return "`" + String(s == null ? "" : s)
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${") + "`";
  }

  function renderPosts(posts) {
    var lines = [];
    lines.push("// ============================================================");
    lines.push("//  文章列表（在 /admin 写作台里编辑，也可以直接手改这个文件）");
    lines.push("//  - slug 用英文、数字和短横线，保证唯一（会出现在网址 #/post/xxx 里）");
    lines.push("//  - date 用 YYYY-MM-DD，列表会按日期从新到旧排序");
    lines.push("//  - content 支持：空行分段、## 小标题、### 次小标题、> 引用、- 列表、");
    lines.push("//    **加粗**、*斜体*、[链接](https://…)、--- 分隔线");
    lines.push("// ============================================================");
    lines.push("window.POSTS = [");

    posts.forEach(function (p, i) {
      var pad = "  ";
      lines.push(pad + "{");
      lines.push(pad + "  slug: " + q(p.slug) + ",");
      lines.push(pad + "  title: " + q(p.title) + ",");
      lines.push(pad + "  date: " + q(p.date) + ",");
      lines.push(pad + "  tag: " + q(p.tag) + ",");
      lines.push(pad + "  excerpt: " + q(p.excerpt) + ",");
      lines.push(pad + "  content: " + tpl(p.content));
      lines.push(pad + "}" + (i < posts.length - 1 ? "," : ""));
    });

    lines.push("];");
    lines.push("");
    return lines.join("\n");
  }

  function renderSite(site) {
    function obj(v, indent) {
      var pad = new Array(indent + 1).join("  ");
      var inner = new Array(indent + 2).join("  ");
      var keys = Object.keys(v);
      if (!keys.length) return "{}";

      var out = [];
      keys.forEach(function (k) {
        var val = v[k];
        var key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k);
        if (Array.isArray(val)) {
          var items = val.map(function (it) {
            if (it && typeof it === "object") return inner + "  " + obj(it, indent + 2).replace(/^\s+/, "");
            return inner + "  " + q(it);
          });
          out.push(pad + key + ": [\n" + items.join(",\n") + "\n" + pad + "]");
        } else if (val && typeof val === "object") {
          out.push(pad + key + ": " + obj(val, indent + 1));
        } else {
          out.push(pad + key + ": " + q(val));
        }
      });
      return "{\n" + out.join(",\n") + "\n" + inner + "}";
    }

    return (
      "// ============================================================\n" +
      "//  站点信息（在 /admin 写作台的「站点信息」里编辑）\n" +
      "// ============================================================\n" +
      "window.SITE = " + obj(site, 0) + ";\n"
    );
  }

  /* ---------------- 列表与选中 ---------------- */

  function draftSkeleton(slug) {
    var d = (drafts[slug] && drafts[slug].data) || {};
    return {
      slug: d.slug || slug,
      title: d.title || "",
      date: d.date || today(),
      tag: d.tag || "",
      excerpt: d.excerpt || "",
      content: d.content || "",
      __new: true
    };
  }

  // 列表 = 已发布文章 + 未发布的新文章草稿
  function allEntries() {
    var list = S.posts.slice();
    Object.keys(drafts).forEach(function (slug) {
      if (drafts[slug] && drafts[slug].isNew) list.push(draftSkeleton(slug));
    });
    return list.sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });
  }

  function currentPost() {
    for (var i = 0; i < S.posts.length; i++) {
      if (S.posts[i].slug === S.selected) return S.posts[i];
    }
    if (isNewDraft(S.selected)) return draftSkeleton(S.selected);
    return null;
  }

  function renderList() {
    var box = $("postItems");
    var list = allEntries();

    $("postCount").textContent = S.posts.length;

    if (!list.length) {
      box.innerHTML = '<p class="post-empty">还没有文章，点上面「+ 新文章」开始。</p>';
      return;
    }

    box.innerHTML = list.map(function (p) {
      var note;
      if (p.__new) {
        note = '<span style="color:var(--amber)">未发布</span>';
      } else if (drafts[p.slug]) {
        note = esc(p.tag || "") + ' · <span style="color:var(--amber)">有本地草稿</span>';
      } else {
        note = esc(p.tag || "");
      }
      return (
        '<button class="post-item' + (p.slug === S.selected ? " on" : "") + '" type="button" data-slug="' + esc(p.slug) + '">' +
          "<b>" + esc(p.title || "（无标题）") + "</b>" +
          "<span>" + esc(p.date || "") + " · " + note + "</span>" +
        "</button>"
      );
    }).join("");
  }

  /* ---------------- 编辑器 ---------------- */

  function fillEditor(p) {
    $("editorEmpty").hidden = true;
    $("editorForm").hidden = false;

    var data = drafts[p.slug] ? drafts[p.slug].data : p;

    $("fTitle").value = data.title || "";
    $("fSlug").value = data.slug || p.slug;
    $("fDate").value = data.date || today();
    $("fTag").value = data.tag || "";
    $("fExcerpt").value = data.excerpt || "";
    $("fContent").value = data.content || "";
    $("openPostBtn").href = "/#/post/" + encodeURIComponent(p.slug);

    renderPreview();
    updateDirtyLabel();
  }

  function clearEditor() {
    $("editorEmpty").hidden = false;
    $("editorForm").hidden = true;
    $("editorEmpty").textContent = "在左边选一篇文章，或者新建一篇。";
  }

  function selectPost(slug) {
    // 离开一篇什么都没写的新文章：直接丢掉，不留垃圾
    if (S.selected && S.selected !== slug && isNewDraft(S.selected)) {
      var prev = drafts[S.selected];
      if (prev && isBlank(prev.data)) {
        delete drafts[S.selected];
        saveDrafts();
      }
    }

    S.selected = slug;
    var p = currentPost();
    if (!p && isNewDraft(slug)) p = draftSkeleton(slug);
    renderList();
    if (p) fillEditor(p);
    else clearEditor();
  }

  function readEditor() {
    return {
      slug: $("fSlug").value.trim(),
      title: $("fTitle").value.trim(),
      date: $("fDate").value || today(),
      tag: $("fTag").value.trim(),
      excerpt: $("fExcerpt").value.trim(),
      content: $("fContent").value
    };
  }

  // 是否和「已发布的内容」有差：拿已发布数据当基准，不是拿草稿
  function editorDirty() {
    var p = currentPost();
    if (!p) return false;
    if (p.__new) return true;                    // 新文章只要还没发布就算未保存

    var a = readEditor();
    return (
      a.slug !== (p.slug || "") ||
      a.title !== (p.title || "") ||
      a.date !== (p.date || "") ||
      a.tag !== (p.tag || "") ||
      a.excerpt !== (p.excerpt || "") ||
      a.content !== (p.content || "")
    );
  }

  function updateDirtyLabel() {
    var el = $("statusLabel");
    var dirty = editorDirty() || siteDirty() || rawDirty();
    el.textContent = S.saving ? "正在发布…" : dirty ? "有未保存的修改" : "未修改";
    el.classList.toggle("warnish", dirty && !S.saving);
  }

  /* ---------------- 预览 ---------------- */

  function inline(s) {
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
      return '<a href="' + url + '" target="_blank" rel="noopener">' + text + "</a>";
    });
    return s;
  }

  // 和 app.js 里的解析规则保持一致
  function markdown(md) {
    var lines = String(md || "").replace(/\r/g, "").split("\n");
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }
      if (/^---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

      if (/^###\s+/.test(line)) {
        out.push("<h3>" + inline(esc(line.replace(/^###\s+/, ""))) + "</h3>");
        i++; continue;
      }
      if (/^##\s+/.test(line)) {
        out.push("<h2>" + inline(esc(line.replace(/^##\s+/, ""))) + "</h2>");
        i++; continue;
      }

      if (/^>\s?/.test(line)) {
        var quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quote.push(inline(esc(lines[i].replace(/^>\s?/, ""))));
          i++;
        }
        out.push("<blockquote>" + quote.map(function (x) { return "<p>" + x + "</p>"; }).join("") + "</blockquote>");
        continue;
      }

      if (/^-\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^-\s+/.test(lines[i])) {
          items.push("<li>" + inline(esc(lines[i].replace(/^-\s+/, ""))) + "</li>");
          i++;
        }
        out.push("<ul>" + items.join("") + "</ul>");
        continue;
      }

      var para = [];
      while (i < lines.length && lines[i].trim() && !/^(##|###|>|-\s|---)/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      out.push("<p>" + inline(esc(para.join("\n"))).replace(/\n/g, "<br>") + "</p>");
    }

    return out.join("\n");
  }

  function renderPreview() {
    var md = $("fContent").value;
    $("previewBox").innerHTML = md.trim()
      ? markdown(md)
      : '<p style="color:var(--dim)">左边写点什么，这里会实时预览。</p>';
  }

  /* ---------------- 草稿自动保存 ---------------- */

  function scheduleDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(commitDraft, 500);
  }

  function commitDraft() {
    var p = currentPost();
    if (!p) return;

    var data = readEditor();
    var dirty = editorDirty();
    var oldKey = S.selected;

    if (!dirty && !p.__new) {
      delete drafts[p.slug];
      saveDrafts();
      renderList();
      updateDirtyLabel();
      return;
    }

    // 新草稿改了 slug：把草稿挪到新键上
    if (p.__new && data.slug && data.slug !== oldKey) {
      delete drafts[oldKey];
      drafts[data.slug] = { isNew: true, data: data, ts: Date.now() };
      S.selected = data.slug;
    } else {
      drafts[p.slug] = { isNew: !!p.__new, data: data, ts: Date.now() };
    }

    saveDrafts();
    renderList();
    updateDirtyLabel();
  }

  /* ---------------- 发布：文章 ---------------- */

  function validate(data, originalSlug) {
    if (!data.title) return "标题不能为空。";
    if (!data.slug) return "网址标识 slug 不能为空。";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9\-_]*$/.test(data.slug)) {
      return "slug 只能用英文字母、数字和短横线。";
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return "日期格式要是 YYYY-MM-DD。";
    if (!data.content.trim()) return "正文还是空的。";

    var clash = false;
    S.posts.forEach(function (p) {
      if (p.slug === data.slug && p.slug !== originalSlug) clash = true;
    });
    Object.keys(drafts).forEach(function (slug) {
      if (drafts[slug].isNew && slug === data.slug && slug !== originalSlug) clash = true;
    });
    if (clash) return "slug「" + data.slug + "」已经被另一篇文章占用了。";
    return "";
  }

  async function publishPost() {
    if (S.saving) return;
    var p = currentPost();
    if (!p) return;

    var data = readEditor();
    var err = validate(data, p.slug);
    if (err) { toast(err, "err"); return; }

    var next;
    if (p.__new) {
      next = S.posts.concat([data]);
    } else {
      next = S.posts.map(function (x) { return x.slug === p.slug ? data : x; });
    }
    next.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });

    S.saving = true;
    updateDirtyLabel();
    $("publishPostBtn").disabled = true;

    try {
      var text = renderPosts(next);
      var sha = await writeFile(FILE_POSTS, text, (p.__new ? "post: " : "post: 更新《") + data.title + (p.__new ? "" : "》"), S.sha.posts);

      S.sha.posts = sha;
      S.posts = next;
      S.rawText.posts = text;
      $("rawPosts").value = text;

      delete drafts[p.slug];
      delete drafts[data.slug];
      saveDrafts();

      S.selected = data.slug;
      renderList();
      fillEditor(data);
      toast(p.__new ? "已发布 · 一分钟内网站上就能看到" : "已更新 · 一分钟内生效", "ok");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      S.saving = false;
      $("publishPostBtn").disabled = false;
      updateDirtyLabel();
    }
  }

  async function deletePost() {
    var p = currentPost();
    if (!p) return;

    // 还没发布的新草稿：从本地删掉就行，不碰 GitHub
    if (p.__new) {
      if (!confirm("丢弃这篇还没发布的新文章？")) return;
      delete drafts[p.slug];
      saveDrafts();
      S.selected = null;
      renderList();
      clearEditor();
      updateDirtyLabel();
      toast("已丢弃");
      return;
    }

    if (!confirm("确定删除《" + (p.title || p.slug) + "》吗？\n\n它会从网站和 GitHub 上一起删掉，无法撤销。")) return;

    S.saving = true;
    updateDirtyLabel();
    try {
      var next = S.posts.filter(function (x) { return x.slug !== p.slug; });
      var text = renderPosts(next);
      var sha = await writeFile(FILE_POSTS, text, "post: 删除《" + (p.title || p.slug) + "》", S.sha.posts);
      S.sha.posts = sha;
      S.posts = next;
      S.rawText.posts = text;
      $("rawPosts").value = text;
      delete drafts[p.slug];
      saveDrafts();
      S.selected = null;
      renderList();
      clearEditor();
      updateDirtyLabel();
      toast("已删除", "ok");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      S.saving = false;
      updateDirtyLabel();
    }
  }

  function newPost() {
    var base = "post-" + today().replace(/-/g, "");
    var slug = base;
    var n = 2;
    while (
      S.posts.some(function (p) { return p.slug === slug; }) ||
      drafts[slug]
    ) slug = base + "-" + n++;

    drafts[slug] = {
      isNew: true,
      ts: Date.now(),
      data: { slug: slug, title: "", date: today(), tag: "随笔", excerpt: "", content: "" }
    };
    saveDrafts();

    S.selected = slug;
    renderList();
    fillEditor(draftSkeleton(slug));
    setTimeout(function () { $("fTitle").focus(); }, 30);
    toast("新文章已创建，写完点「保存并发布」");
  }

  /* ---------------- 站点信息 ---------------- */

  function siteModel() {
    var b = S.site;
    return {
      name: b.name || "",
      title: b.title || "",
      accent: b.accent || "",
      tagline: b.tagline || "",
      author: b.author || "",
      avatar: b.avatar || "",
      location: b.location || "",
      since: b.since || "",
      github: b.github || "",
      email: b.email || "",
      footer: b.footer || "",
      about: b.about || { intro: [], sections: [] }
    };
  }

  function fillSite() {
    var s = S.site;
    $("sName").value = s.name || "";
    $("sTitle").value = s.title || "";
    $("sAccent").value = s.accent || "";
    $("sAuthor").value = s.author || "";
    $("sLocation").value = s.location || "";
    $("sSince").value = s.since || "";
    $("sGithub").value = s.github || "";
    $("sEmail").value = s.email || "";
    $("sTagline").value = s.tagline || "";
    $("sFooter").value = s.footer || "";
  }

  function readSiteForm() {
    var m = siteModel();
    return {
      name: $("sName").value.trim(),
      title: $("sTitle").value.trim(),
      accent: $("sAccent").value.trim(),
      tagline: $("sTagline").value.trim(),
      author: $("sAuthor").value.trim(),
      avatar: m.avatar,
      location: $("sLocation").value.trim(),
      since: $("sSince").value.trim(),
      github: $("sGithub").value.trim(),
      email: $("sEmail").value.trim(),
      footer: $("sFooter").value.trim(),
      about: m.about
    };
  }

  function siteDirty() {
    return JSON.stringify(readSiteForm()) !== JSON.stringify(siteModel());
  }

  async function publishSite() {
    if (S.saving) return;
    S.saving = true;
    updateDirtyLabel();
    $("publishSiteBtn").disabled = true;

    try {
      var site = readSiteForm();
      var text = renderSite(site);
      var sha = await writeFile(FILE_SITE, text, "site: 更新站点信息", S.sha.site);
      S.sha.site = sha;
      S.site = site;
      S.rawText.site = text;
      $("rawSite").value = text;
      renderHeader();
      toast("已发布 · 一分钟内生效", "ok");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      S.saving = false;
      $("publishSiteBtn").disabled = false;
      updateDirtyLabel();
    }
  }

  /* ---------------- 源文件 ---------------- */

  function fillRaw() {
    $("rawPosts").value = S.rawText.posts;
    $("rawSite").value = S.rawText.site;
  }

  function rawDirty() {
    return (
      $("rawPosts").value !== S.rawText.posts ||
      $("rawSite").value !== S.rawText.site
    );
  }

  async function publishRaw() {
    if (S.saving) return;

    var postsText = $("rawPosts").value;
    var siteText = $("rawSite").value;

    // 先校验，别把坏文件推上去把网站搞挂
    var nextPosts, nextSite;
    try {
      nextPosts = parsePosts(postsText);
      nextSite = parseSite(siteText);
    } catch (e) {
      toast(e.message, "err");
      return;
    }
    if (!nextPosts.length) { toast("posts.js 里一篇文章都没有，先别发布。", "err"); return; }
    if (!nextSite.name && !nextSite.title) { toast("site.js 好像没有内容，先别发布。", "err"); return; }

    S.saving = true;
    updateDirtyLabel();
    $("publishRawBtn").disabled = true;

    try {
      if (postsText !== S.rawText.posts) {
        S.sha.posts = await writeFile(FILE_POSTS, postsText, "post: 更新文章数据", S.sha.posts);
        S.posts = nextPosts;
        S.rawText.posts = postsText;
      }
      if (siteText !== S.rawText.site) {
        S.sha.site = await writeFile(FILE_SITE, siteText, "site: 更新站点配置", S.sha.site);
        S.site = nextSite;
        S.rawText.site = siteText;
      }
      renderHeader();
      renderList();
      fillSite();
      if (S.selected && currentPost()) fillEditor(currentPost());
      else { S.selected = null; clearEditor(); }
      toast("已发布 · 一分钟内生效", "ok");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      S.saving = false;
      $("publishRawBtn").disabled = false;
      updateDirtyLabel();
    }
  }

  async function reloadRaw() {
    if (rawDirty() && !confirm("放弃当前改动，重新从 GitHub 拉取最新文件？")) return;
    toast("正在拉取…");
    try {
      var a = await readFile(FILE_POSTS);
      var b = await readFile(FILE_SITE);
      S.sha.posts = a.sha;
      S.sha.site = b.sha;
      S.rawText.posts = a.text;
      S.rawText.site = b.text;
      S.posts = parsePosts(a.text);
      S.site = parseSite(b.text);
      fillRaw();
      fillSite();
      renderHeader();
      renderList();
      if (S.selected && currentPost()) fillEditor(currentPost());
      else { S.selected = null; clearEditor(); }
      updateDirtyLabel();
      toast("已是最新", "ok");
    } catch (e) {
      toast(e.message, "err");
    }
  }

  /* ---------------- 顶栏 ---------------- */

  function renderHeader() {
    $("repoLabel").textContent = CONFIG.owner + "/" + CONFIG.repo + " · " + CONFIG.branch;
  }

  /* ---------------- 登录 / 启动 ---------------- */

  async function boot(token) {
    S.token = token;
    $("gateErr").textContent = "";
    $("enterBtn").disabled = true;
    $("enterBtn").textContent = "正在连接…";

    try {
      await verify();

      var a = await readFile(FILE_POSTS);
      var b = await readFile(FILE_SITE);

      S.sha.posts = a.sha;
      S.sha.site = b.sha;
      S.rawText.posts = a.text;
      S.rawText.site = b.text;
      S.posts = parsePosts(a.text);
      S.site = parseSite(b.text);

      $("gate").hidden = true;
      $("desk").hidden = false;

      renderHeader();
      renderList();
      fillSite();
      fillRaw();
      updateDirtyLabel();

      var entries = allEntries();
      if (entries.length) selectPost(entries[0].slug);
      else { S.selected = null; clearEditor(); }
    } catch (e) {
      $("gateErr").textContent = e.message;
      localStorage.removeItem(KEY_TOKEN);
      S.token = "";
      $("enterBtn").disabled = false;
      $("enterBtn").textContent = "进入写作台";
    }
  }

  /* ---------------- 事件 ---------------- */

  function bindGate() {
    var saved = localStorage.getItem(KEY_TOKEN);
    if (saved) {
      $("tokenInput").value = saved;
      boot(saved);
    }

    $("enterBtn").addEventListener("click", function () {
      var token = $("tokenInput").value.trim();
      if (!token) { $("gateErr").textContent = "先粘贴一个令牌。"; return; }
      if ($("rememberInput").checked) localStorage.setItem(KEY_TOKEN, token);
      else localStorage.removeItem(KEY_TOKEN);
      boot(token);
    });

    $("tokenInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") $("enterBtn").click();
    });
  }

  function bindTabs() {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        var name = this.getAttribute("data-tab");
        for (var j = 0; j < tabs.length; j++) {
          tabs[j].classList.toggle("on", tabs[j] === this);
        }
        $("panelPosts").classList.toggle("on", name === "posts");
        $("panelSite").classList.toggle("on", name === "site");
        $("panelRaw").classList.toggle("on", name === "raw");
      });
    }
  }

  function bindEditor() {
    $("postItems").addEventListener("click", function (e) {
      var btn = e.target.closest(".post-item");
      if (!btn) return;
      var slug = btn.getAttribute("data-slug");
      if (!slug || slug === S.selected) return;

      commitDraft();                       // 切换前先把当前这篇存成草稿
      selectPost(slug);
      if (drafts[slug] && !isNewDraft(slug)) {
        toast("已载入本地草稿，点「保存并发布」才正式生效");
      }
    });

    ["fTitle", "fSlug", "fDate", "fTag", "fExcerpt", "fContent"].forEach(function (id) {
      $(id).addEventListener("input", function () {
        if (id === "fContent") renderPreview();
        scheduleDraft();
        updateDirtyLabel();
      });
    });

    $("publishPostBtn").addEventListener("click", publishPost);
    $("deletePostBtn").addEventListener("click", deletePost);
    $("newPostBtn").addEventListener("click", newPost);

    $("revertPostBtn").addEventListener("click", function () {
      var p = currentPost();
      if (!p) return;

      if (p.__new) {
        delete drafts[p.slug];
        saveDrafts();
        S.selected = null;
        renderList();
        clearEditor();
        updateDirtyLabel();
        toast("已丢弃");
        return;
      }

      if (!confirm("撤销这篇的所有修改？（会丢掉本地草稿）")) return;
      delete drafts[p.slug];
      saveDrafts();
      fillEditor(p);
      renderList();
      toast("已撤销");
    });
  }

  function bindSite() {
    ["sName", "sTitle", "sAccent", "sAuthor", "sLocation", "sSince", "sGithub", "sEmail", "sTagline", "sFooter"]
      .forEach(function (id) {
        $(id).addEventListener("input", updateDirtyLabel);
      });

    $("publishSiteBtn").addEventListener("click", publishSite);

    $("revertSiteBtn").addEventListener("click", function () {
      fillSite();
      updateDirtyLabel();
      toast("已撤销");
    });
  }

  function bindRaw() {
    $("rawPosts").addEventListener("input", updateDirtyLabel);
    $("rawSite").addEventListener("input", updateDirtyLabel);
    $("publishRawBtn").addEventListener("click", publishRaw);
    $("revertRawBtn").addEventListener("click", reloadRaw);
  }

  function bindMisc() {
    $("logoutBtn").addEventListener("click", function () {
      if (!confirm("退出写作台？（令牌会从这台设备删掉，未发布的草稿保留）")) return;
      localStorage.removeItem(KEY_TOKEN);
      location.reload();
    });

    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if ($("panelPosts").classList.contains("on") && currentPost()) publishPost();
        else if ($("panelSite").classList.contains("on")) publishSite();
        else if ($("panelRaw").classList.contains("on")) publishRaw();
      }
    });

    window.addEventListener("beforeunload", function (e) {
      if (editorDirty() || siteDirty() || rawDirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  bindGate();
  bindTabs();
  bindEditor();
  bindSite();
  bindRaw();
  bindMisc();
})();
