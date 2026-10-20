(function () {
  "use strict";

  var SITE = window.SITE || {};
  var POSTS = (window.POSTS || []).slice().sort(function (a, b) {
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  });
  var TAGS = ["全部"];
  POSTS.forEach(function (p) {
    if (p.tag && TAGS.indexOf(p.tag) === -1) TAGS.push(p.tag);
  });

  var view = document.getElementById("view");
  var topbar = document.getElementById("topbar");
  var toTop = document.getElementById("toTop");
  var state = { tag: "全部" };

  /* ---------------- 工具 ---------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function dateLabel(d) {
    return String(d || "").replace(/-/g, ".");
  }

  function inline(s) {
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
      return '<a href="' + url + '" target="_blank" rel="noopener">' + text + "</a>";
    });
    return s;
  }

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
        out.push("<blockquote>" + quote.map(function (q) { return "<p>" + q + "</p>"; }).join("") + "</blockquote>");
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

  function heroTitle() {
    var t = esc(SITE.title || SITE.name || "");
    var accent = esc(SITE.accent || "");
    if (accent && t.indexOf(accent) !== -1) {
      return t.replace(accent, '<span class="accent">' + accent + "</span>");
    }
    return t;
  }

  /* ---------------- 视图 ---------------- */

  function heroHTML() {
    var latest = POSTS[0] ? POSTS[0].date : "";
    return (
      '<section class="hero">' +
        '<p class="eyebrow">' + esc(SITE.name || "个人博客") + ' <span class="dot">·</span> PERSONAL BLOG</p>' +
        "<h1>" + heroTitle() + "</h1>" +
        '<p class="tagline">' + esc(SITE.tagline || "") + "</p>" +
        '<div class="hero-actions">' +
          '<button class="btn primary" type="button" data-scroll="posts">开始阅读 <span aria-hidden="true">↓</span></button>' +
          '<a class="btn" href="#/about">关于我</a>' +
        "</div>" +
        '<div class="hero-meta">' +
          '<span>作者 <b>' + esc(SITE.author || "") + "</b></span>" +
          '<span>坐标 <b>' + esc(SITE.location || "") + "</b></span>" +
          "<span>文章 <b>" + POSTS.length + " 篇</b></span>" +
          "<span>更新 <b>" + dateLabel(latest) + "</b></span>" +
        "</div>" +
      "</section>"
    );
  }

  function postListHTML() {
    var list = POSTS.filter(function (p) {
      return state.tag === "全部" || p.tag === state.tag;
    });

    if (!list.length) {
      return '<p class="post-excerpt" style="padding:30px 0">这个分类下还没有文章。</p>';
    }

    return '<ul class="post-list">' + list.map(function (p) {
      return (
        '<li class="post-item">' +
          '<a class="post-link" href="#/post/' + encodeURIComponent(p.slug) + '">' +
            '<div class="post-side">' +
              '<span class="post-date">' + dateLabel(p.date) + "</span>" +
              '<span class="post-tag">' + esc(p.tag || "") + "</span>" +
            "</div>" +
            '<div class="post-body">' +
              "<h3>" + esc(p.title) + "</h3>" +
              '<p class="post-excerpt">' + esc(p.excerpt || "") + "</p>" +
              '<span class="read-more">阅读全文 →</span>' +
            "</div>" +
          "</a>" +
        "</li>"
      );
    }).join("") + "</ul>";
  }

  function postsSectionHTML() {
    return (
      '<section class="posts" id="posts">' +
        '<div class="section-head">' +
          "<h2>最新文章</h2>" +
          '<span class="count">' + POSTS.length + " POSTS</span>" +
        "</div>" +
        '<div class="filters" id="filters">' +
          TAGS.map(function (t) {
            return '<button class="chip' + (t === state.tag ? " on" : "") + '" type="button" data-tag="' + esc(t) + '">' + esc(t) + "</button>";
          }).join("") +
        "</div>" +
        '<div id="postsList">' + postListHTML() + "</div>" +
      "</section>"
    );
  }

  function homeHTML() {
    return '<div class="page">' + heroHTML() + postsSectionHTML() + "</div>";
  }

  function articleHTML(post) {
    var index = POSTS.map(function (p) { return p.slug; }).indexOf(post.slug);
    var newer = index > 0 ? POSTS[index - 1] : null;
    var older = index > -1 && index < POSTS.length - 1 ? POSTS[index + 1] : null;

    var foot = "";
    if (newer || older) {
      foot = '<nav class="article-foot">';
      foot += newer
        ? '<a href="#/post/' + encodeURIComponent(newer.slug) + '"><small>上一篇</small>' + esc(newer.title) + "</a>"
        : "<span></span>";
      foot += older
        ? '<a href="#/post/' + encodeURIComponent(older.slug) + '" style="text-align:right"><small>下一篇</small>' + esc(older.title) + "</a>"
        : "<span></span>";
      foot += "</nav>";
    }

    return (
      '<article class="page article">' +
        '<a class="back" href="#/">← 回到文章列表</a>' +
        '<div class="article-meta">' +
          '<span class="tag">' + esc(post.tag || "") + "</span>" +
          '<span>' + dateLabel(post.date) + "</span>" +
          "<span>" + esc(SITE.author || "") + "</span>" +
        "</div>" +
        "<h1>" + esc(post.title) + "</h1>" +
        '<div class="article-body">' + markdown(post.content) + "</div>" +
        foot +
      "</article>"
    );
  }

  function aboutHTML() {
    var about = SITE.about || {};
    var intro = (about.intro || []).map(function (p) {
      return "<p>" + esc(p) + "</p>";
    }).join("");
    var sections = (about.sections || []).map(function (s) {
      return "<h2>" + esc(s.heading) + "</h2><p>" + esc(s.text) + "</p>";
    }).join("");

    return (
      '<section class="page about">' +
        '<div class="about-card">' +
          '<div class="about-top">' +
            '<div class="avatar" aria-hidden="true">' + esc(SITE.avatar || "林") + "</div>" +
            "<div>" +
              "<h1>关于 · " + esc(SITE.author || "") + "</h1>" +
              "<p>" + esc(SITE.name || "") + " · SINCE " + esc(SITE.since || "") + "</p>" +
            "</div>" +
          "</div>" +
          intro +
          sections +
          '<div class="about-links">' +
            '<a href="' + esc(SITE.github || "#") + '" target="_blank" rel="noopener">GitHub ↗</a>' +
            '<a href="mailto:' + esc(SITE.email || "") + '">写封邮件</a>' +
            '<a href="scene.html" target="_blank" rel="noopener">看看这座 3D 小屋 ↗</a>' +
          "</div>" +
        "</div>" +
      "</section>"
    );
  }

  function notFoundHTML() {
    return (
      '<section class="page empty">' +
        "<div>" +
          "<h1>走丢了</h1>" +
          "<p>这页林子里好像没有路，回首页看看。</p>" +
          '<a class="btn primary" href="#/">回到首页</a>' +
        "</div>" +
      "</section>"
    );
  }

  /* ---------------- 路由 ---------------- */

  function parseHash() {
    var h = location.hash.replace(/^#/, "");
    if (!h || h === "/" || h === "/index.html") return { name: "home" };
    if (h === "/about") return { name: "about" };
    var m = h.match(/^\/post\/([^/]+)$/);
    if (m) return { name: "post", slug: decodeURIComponent(m[1]) };
    return { name: "404" };
  }

  function setNav(name) {
    var links = document.querySelectorAll("[data-nav]");
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle("active", links[i].getAttribute("data-nav") === name);
    }
  }

  function setTitle(title) {
    document.title = title ? title + " · " + (SITE.name || "博客") : (SITE.name || "个人博客");
  }

  function setDescription(text) {
    var meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", text || SITE.tagline || "");
  }

  function render() {
    var route = parseHash();
    var scrollToTop = true;

    if (route.name === "home") {
      view.innerHTML = homeHTML();
      setNav("home");
      setTitle("");
      setDescription(SITE.tagline);
    } else if (route.name === "about") {
      view.innerHTML = aboutHTML();
      setNav("about");
      setTitle("关于");
      setDescription(SITE.tagline);
    } else if (route.name === "post") {
      var post = null;
      for (var i = 0; i < POSTS.length; i++) {
        if (POSTS[i].slug === route.slug) { post = POSTS[i]; break; }
      }
      if (post) {
        view.innerHTML = articleHTML(post);
        setNav("home");
        setTitle(post.title);
        setDescription(post.excerpt);
        scrollToTop = true;
      } else {
        view.innerHTML = notFoundHTML();
        setNav("");
        setTitle("页面走丢了");
      }
    } else {
      view.innerHTML = notFoundHTML();
      setNav("");
      setTitle("页面走丢了");
    }

    if (scrollToTop) window.scrollTo({ top: 0, behavior: "auto" });
  }

  /* ---------------- 交互 ---------------- */

  view.addEventListener("click", function (e) {
    var scrollBtn = e.target.closest("[data-scroll]");
    if (scrollBtn) {
      var target = document.getElementById(scrollBtn.getAttribute("data-scroll"));
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    var chip = e.target.closest(".chip");
    if (chip) {
      state.tag = chip.getAttribute("data-tag") || "全部";
      var filters = document.getElementById("filters");
      var list = document.getElementById("postsList");
      if (filters) {
        var chips = filters.querySelectorAll(".chip");
        for (var i = 0; i < chips.length; i++) {
          chips[i].classList.toggle("on", chips[i].getAttribute("data-tag") === state.tag);
        }
      }
      if (list) list.innerHTML = postListHTML();
    }
  });

  window.addEventListener("hashchange", render);

  window.addEventListener("scroll", function () {
    topbar.classList.toggle("scrolled", window.scrollY > 40);
    toTop.classList.toggle("show", window.scrollY > 620);
  }, { passive: true });

  toTop.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  /* ---------------- 启动 ---------------- */

  var github = document.getElementById("navGithub");
  if (github) github.setAttribute("href", SITE.github || "#");

  var siteName = document.getElementById("siteName");
  if (siteName) siteName.textContent = SITE.name || "个人博客";

  var footerText = document.getElementById("footerText");
  if (footerText) {
    footerText.textContent = "© " + (SITE.since || new Date().getFullYear()) + " " + (SITE.author || "") + " · " + (SITE.footer || "");
  }

  if (!POSTS.length) {
    view.innerHTML = '<section class="page empty"><div><h1>还没有文章</h1><p>在 posts.js 里写下第一篇吧。</p></div></section>';
  } else {
    render();
  }

  /* ---------------- 3D 场景：空闲时再加载，就绪后淡入 ---------------- */

  (function mountScene() {
    var stage = document.getElementById("sceneStage");
    var frameEl = document.getElementById("scene");
    if (!stage || !frameEl) return;

    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var small = window.matchMedia && window.matchMedia("(max-width: 720px)").matches;
    var slowNet = navigator.connection && (navigator.connection.saveData ||
      /(^|-)2g$/.test(navigator.connection.effectiveType || ""));

    // 省流 / 低端 / 用户偏好减少动态：只保留静态背景图
    if (slowNet) return;

    var mounted = false;
    function mount() {
      if (mounted) return;
      mounted = true;
      var src = frameEl.getAttribute("data-src") || frameEl.src;
      if (!src) return;

      frameEl.addEventListener("load", function () {
        // 3D 里还有一帧渲染和淡入动画，稍等一下再切
        setTimeout(function () { stage.classList.add("live"); }, reduced ? 1200 : 900);
      });
      frameEl.src = src;

      // 兜底：8 秒还没 load（WebGL 不可用等），保持静态图
      setTimeout(function () {
        if (!frameEl.src) stage.classList.remove("live");
      }, 8000);
    }

    if (reduced) return;                       // 减少动效：不加载 3D

    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(function () { setTimeout(mount, small ? 900 : 400); }, { timeout: 2500 });
    } else {
      window.addEventListener("load", function () { setTimeout(mount, 700); });
    }
  })();
})();
