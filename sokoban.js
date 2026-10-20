/* ============================================================
   推箱子 —— 林间小游戏
   纯手写，不依赖任何库。地图字符：
     #  墙        空格  地面      .  目标格
     $  木箱      @  小人        *  箱子已在目标上     +  小人站在目标上
   关卡都经过求解器验证可解（见 .test/verify-levels.js）。
   ============================================================ */
(function () {
  "use strict";

  var LEVELS = [
    {
      name: "第一步",
      map: [
        "#######",
        "#     #",
        "# @$. #",
        "#     #",
        "#######"
      ]
    },
    {
      name: "上下",
      map: [
        "#######",
        "#  .  #",
        "#  $  #",
        "#  @  #",
        "#  $  #",
        "#  .  #",
        "#######"
      ]
    },
    {
      name: "穿过门",
      map: [
        "#########",
        "#       #",
        "#  $ .  #",
        "#  ###  #",
        "#  @    #",
        "#       #",
        "#   $   #",
        "#   .   #",
        "#########"
      ]
    },
    {
      name: "转个弯",
      map: [
        "########",
        "#      #",
        "#  $   #",
        "#  @   #",
        "#      #",
        "#    . #",
        "########"
      ]
    },
    {
      name: "两只箱子",
      map: [
        "#########",
        "#       #",
        "#  $ .  #",
        "#  @    #",
        "#  $ .  #",
        "#       #",
        "#########"
      ]
    },
    {
      name: "绕过柱子",
      map: [
        "##########",
        "#        #",
        "#        #",
        "#  #  #. #",
        "#  #$ #  #",
        "#  #  #  #",
        "#   @    #",
        "#        #",
        "##########"
      ]
    },
    {
      name: "四只箱子",
      map: [
        "##########",
        "#        #",
        "#  $  $  #",
        "#   ..   #",
        "#   ..   #",
        "#  $  $  #",
        "#    @   #",
        "##########"
      ]
    },
    {
      name: "四方",
      map: [
        "###########",
        "#         #",
        "#  $   $  #",
        "#   ...   #",
        "#   .$.   #",
        "#   ...   #",
        "#  $   $  #",
        "#    @    #",
        "###########"
      ]
    }
  ];

  var STORE_KEY = "cabin-blog.sokoban";
  var DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  /* ---------------- 存档（读不到就当新游戏） ---------------- */
  function loadSave() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      var obj = raw ? JSON.parse(raw) : null;
      if (!obj || typeof obj !== "object") return { level: 0, done: [] };
      var lv = parseInt(obj.level, 10);
      if (isNaN(lv) || lv < 0 || lv >= LEVELS.length) lv = 0;
      return { level: lv, done: Array.isArray(obj.done) ? obj.done.filter(function (d) { return typeof d === "number"; }) : [] };
    } catch (e) {
      return { level: 0, done: [] };
    }
  }

  function persist() {
    if (!save) return;
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify({ level: save.level, done: save.done })); } catch (e) {}
  }

  /* ---------------- 关卡解析 ---------------- */
  function parseLevel(map) {
    var cols = 0, rows = map.length, grid = [], boxes = [], player = { x: 1, y: 1 };
    for (var i = 0; i < map.length; i++) cols = Math.max(cols, map[i].length);

    for (var y = 0; y < rows; y++) {
      var line = [];
      for (var x = 0; x < cols; x++) {
        var c = map[y][x] || " ";
        var t = 0;
        if (c === "#") t = 1;
        else if (c === "." || c === "*" || c === "+") t = 2;
        if (c === "$" || c === "*") boxes.push({ x: x, y: y });
        if (c === "@" || c === "+") player = { x: x, y: y };
        line.push(t);
      }
      grid.push(line);
    }
    return { grid: grid, cols: cols, rows: rows, boxes: boxes, player: player };
  }

  function cellAt(st, x, y) {
    if (y < 0 || y >= st.rows || x < 0 || x >= st.cols) return 1;
    return st.grid[y][x];
  }

  function boxIndexAt(st, x, y) {
    for (var i = 0; i < st.boxes.length; i++) {
      if (st.boxes[i].x === x && st.boxes[i].y === y) return i;
    }
    return -1;
  }

  function isWin(st) {
    for (var i = 0; i < st.boxes.length; i++) {
      if (cellAt(st, st.boxes[i].x, st.boxes[i].y) !== 2) return false;
    }
    return true;
  }

  /* ---------------- 模块状态 ---------------- */
  var el = null;        // DOM 引用
  var ctx = null;
  var st = null;        // 当前关卡状态
  var save = null;      // 存档
  var view = null;      // 用于动画的浮点坐标
  var anim = null;
  var raf = 0;
  var reduced = false;
  var pendingWin = 0;

  /* ---------------- 页面结构 ---------------- */
  function html() {
    var siteName = (window.SITE && window.SITE.name) || "个人博客";
    var chips = LEVELS.map(function (lv, i) {
      return '<button class="g-chip" type="button" data-level="' + i + '" title="' + lv.name + '">' + (i + 1) + "</button>";
    }).join("");

    return (
      '<section class="page game">' +
        '<p class="eyebrow">' + siteName + ' <span class="dot">·</span> MINI GAME</p>' +
        "<h1>推箱子</h1>" +
        '<p class="tagline">把木箱推到发光的圆圈上就过关。方向键或 WASD 移动，U 撤销，R 重来；手机可以直接在棋盘上滑动。</p>' +
        '<div class="game-shell" id="gameShell">' +
          '<div class="game-head">' +
            '<div class="game-chips" id="gameChips">' + chips + "</div>" +
            '<div class="game-stats">' +
              '<span>关卡 <b id="gLevel">1 / ' + LEVELS.length + "</b></span>" +
              '<span>步数 <b id="gMoves">0</b></span>' +
              '<span>推动 <b id="gPushes">0</b></span>' +
            "</div>" +
          "</div>" +
          '<div class="game-stage" id="gameStage">' +
            '<canvas id="gameCanvas" aria-label="推箱子棋盘"></canvas>' +
            '<div class="game-win" id="gameWin">' +
              '<p class="game-win-kicker">过关</p>' +
              '<h2 id="gameWinTitle"></h2>' +
              '<p class="game-win-meta" id="gameWinMeta"></p>' +
              '<div class="game-win-actions">' +
                '<button class="btn primary" type="button" id="gWinNext">下一关</button>' +
                '<button class="btn" type="button" id="gWinAgain">再玩一次</button>' +
              "</div>" +
            "</div>" +
          "</div>" +
          '<div class="game-foot">' +
            '<button class="btn" type="button" id="gUndo">撤销 <kbd>U</kbd></button>' +
            '<button class="btn" type="button" id="gReset">重来 <kbd>R</kbd></button>' +
            '<button class="btn" type="button" id="gNext">下一关</button>' +
          "</div>" +
          '<div class="game-pad" id="gamePad">' +
            '<button class="pad-up" type="button" data-dir="up" aria-label="上">↑</button>' +
            '<button class="pad-left" type="button" data-dir="left" aria-label="左">←</button>' +
            '<button class="pad-down" type="button" data-dir="down" aria-label="下">↓</button>' +
            '<button class="pad-right" type="button" data-dir="right" aria-label="右">→</button>' +
          "</div>" +
          '<p class="game-tip">木头箱子只能推、不能拉；推进死角就按 U 撤销。</p>' +
        "</div>" +
      "</section>"
    );
  }

  /* ---------------- 棋盘绘制 ---------------- */
  function roundRect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function draw() {
    if (!st || !ctx) return;
    var cell = st.cell;
    var pad = cell * 0.07;
    var w = st.cols * cell, h = st.rows * cell;
    var x, y, px, py, i;

    ctx.clearRect(0, 0, w, h);

    // 地面 / 墙
    for (y = 0; y < st.rows; y++) {
      for (x = 0; x < st.cols; x++) {
        px = x * cell; py = y * cell;
        if (st.grid[y][x] === 1) {
          roundRect(ctx, px + pad * 0.6, py + pad * 0.6, cell - pad * 1.2, cell - pad * 1.2, cell * 0.14);
          var g = ctx.createLinearGradient(px, py, px, py + cell);
          g.addColorStop(0, "#3d2e22");
          g.addColorStop(1, "#221810");
          ctx.fillStyle = g;
          ctx.fill();
          ctx.strokeStyle = "rgba(240,164,92,.16)";
          ctx.lineWidth = 1;
          ctx.stroke();
        } else {
          roundRect(ctx, px + pad * 0.7, py + pad * 0.7, cell - pad * 1.4, cell - pad * 1.4, cell * 0.16);
          ctx.fillStyle = "rgba(241,231,212,.035)";
          ctx.fill();
        }
      }
    }

    // 目标格
    for (y = 0; y < st.rows; y++) {
      for (x = 0; x < st.cols; x++) {
        if (st.grid[y][x] !== 2) continue;
        var gx = x * cell + cell / 2, gy = y * cell + cell / 2;
        var rg = ctx.createRadialGradient(gx, gy, 0, gx, gy, cell * 0.46);
        rg.addColorStop(0, "rgba(240,164,92,.22)");
        rg.addColorStop(1, "rgba(240,164,92,0)");
        ctx.fillStyle = rg;
        ctx.fillRect(gx - cell / 2, gy - cell / 2, cell, cell);

        ctx.save();
        ctx.strokeStyle = "rgba(240,164,92,.75)";
        ctx.lineWidth = Math.max(1.2, cell * 0.05);
        ctx.setLineDash([cell * 0.13, cell * 0.1]);
        ctx.beginPath();
        ctx.arc(gx, gy, cell * 0.2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 木箱
    var boxes = (anim && view) ? view.boxes : st.boxes;
    for (i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var onGoal = cellAt(st, st.boxes[i].x, st.boxes[i].y) === 2;
      var scale = (anim && anim.box === i) ? 1 + Math.sin(anim.t * Math.PI) * 0.08 : 1;
      var bx = b.x * cell, by = b.y * cell;
      var inset = cell * 0.11;
      var bw = (cell - inset * 2) * scale;
      var bh = (cell - inset * 2) * scale;
      var ox = bx + cell / 2 - bw / 2, oy = by + cell / 2 - bh / 2;

      ctx.save();
      if (onGoal) {
        ctx.shadowColor = "rgba(240,164,92,.75)";
        ctx.shadowBlur = cell * 0.34;
      }
      roundRect(ctx, ox, oy, bw, bh, cell * 0.14);
      var bg = ctx.createLinearGradient(ox, oy, ox + bw, oy + bh);
      if (onGoal) {
        bg.addColorStop(0, "#f7c98d");
        bg.addColorStop(1, "#d08a3c");
      } else {
        bg.addColorStop(0, "#c08850");
        bg.addColorStop(1, "#8a5a2c");
      }
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.strokeStyle = onGoal ? "rgba(255,236,205,.7)" : "rgba(255,220,180,.3)";
      ctx.lineWidth = Math.max(1, cell * 0.03);
      ctx.stroke();
      ctx.restore();

      // 箱面上的木条
      ctx.save();
      ctx.strokeStyle = "rgba(70,42,18,.5)";
      ctx.lineWidth = Math.max(1, cell * 0.035);
      ctx.beginPath();
      ctx.moveTo(ox + bw * 0.16, oy + bh * 0.5);
      ctx.lineTo(ox + bw * 0.84, oy + bh * 0.5);
      ctx.moveTo(ox + bw * 0.5, oy + bh * 0.16);
      ctx.lineTo(ox + bw * 0.5, oy + bh * 0.84);
      ctx.stroke();
      ctx.restore();

      if (onGoal) {
        ctx.save();
        ctx.strokeStyle = "rgba(60,34,10,.72)";
        ctx.lineWidth = Math.max(1.4, cell * 0.055);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(ox + bw * 0.28, oy + bh * 0.52);
        ctx.lineTo(ox + bw * 0.44, oy + bh * 0.68);
        ctx.lineTo(ox + bw * 0.74, oy + bh * 0.3);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 小人
    var p = (anim && view) ? view.player : st.player;
    var cx = p.x * cell + cell / 2, cy = p.y * cell + cell / 2;
    var bob = (anim && anim.t < 1) ? -Math.sin(anim.t * Math.PI) * cell * 0.06 : 0;

    ctx.save();
    ctx.shadowColor = "rgba(240,164,92,.5)";
    ctx.shadowBlur = cell * 0.3;
    roundRect(ctx, cx - cell * 0.19, cy - cell * 0.02 + bob, cell * 0.38, cell * 0.3, cell * 0.12);
    var pg = ctx.createLinearGradient(cx, cy - cell * 0.2, cx, cy + cell * 0.3);
    pg.addColorStop(0, "#ffcf9a");
    pg.addColorStop(1, "#e0904a");
    ctx.fillStyle = pg;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy - cell * 0.15 + bob, cell * 0.155, 0, Math.PI * 2);
    ctx.fillStyle = "#f6ead6";
    ctx.fill();
    ctx.strokeStyle = "rgba(40,24,10,.45)";
    ctx.lineWidth = Math.max(1, cell * 0.025);
    ctx.stroke();

    // 一顶小屋形状的帽子（呼应站点图标）
    ctx.beginPath();
    ctx.moveTo(cx - cell * 0.16, cy - cell * 0.2 + bob);
    ctx.lineTo(cx, cy - cell * 0.36 + bob);
    ctx.lineTo(cx + cell * 0.16, cy - cell * 0.2 + bob);
    ctx.closePath();
    ctx.fillStyle = "#f0a45c";
    ctx.fill();
  }

  /* ---------------- 布局 ---------------- */
  function layout() {
    if (!st || !el) return;
    var stage = el.stage;
    var avail = stage.clientWidth - 4;
    var maxH = Math.min((window.innerHeight || 800) * 0.5, 430);
    var cell = Math.floor(Math.min(avail / st.cols, maxH / st.rows));
    cell = Math.max(18, Math.min(cell, 62));
    st.cell = cell;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.canvas.width = Math.round(st.cols * cell * dpr);
    el.canvas.height = Math.round(st.rows * cell * dpr);
    el.canvas.style.width = st.cols * cell + "px";
    el.canvas.style.height = st.rows * cell + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  /* ---------------- 动画 ---------------- */
  function tween(from) {
    if (reduced) {
      anim = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      draw();
      return;
    }
    anim = { start: (window.performance || Date).now(), dur: 120, t: 0, from: from, box: from.box };
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function tick() {
    raf = 0;
    if (!anim || !st) return;
    var now = (window.performance || Date).now();
    var t = Math.min(1, (now - anim.start) / anim.dur);
    var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    anim.t = e;

    view.player.x = anim.from.px + (st.player.x - anim.from.px) * e;
    view.player.y = anim.from.py + (st.player.y - anim.from.py) * e;
    for (var i = 0; i < st.boxes.length; i++) {
      view.boxes[i].x = anim.from.boxes[i].x + (st.boxes[i].x - anim.from.boxes[i].x) * e;
      view.boxes[i].y = anim.from.boxes[i].y + (st.boxes[i].y - anim.from.boxes[i].y) * e;
    }

    draw();
    if (t < 1) raf = requestAnimationFrame(tick);
    else { anim = null; draw(); }
  }

  function snapView() {
    view.player.x = st.player.x;
    view.player.y = st.player.y;
    for (var i = 0; i < st.boxes.length; i++) {
      view.boxes[i].x = st.boxes[i].x;
      view.boxes[i].y = st.boxes[i].y;
    }
  }

  /* ---------------- 界面刷新 ---------------- */
  function syncStats() {
    if (!el) return;
    el.level.textContent = (save.level + 1) + " / " + LEVELS.length;
    el.moves.textContent = st.moves;
    el.pushes.textContent = st.pushes;
    var chips = el.chips.querySelectorAll(".g-chip");
    for (var i = 0; i < chips.length; i++) {
      var idx = parseInt(chips[i].getAttribute("data-level"), 10);
      chips[i].classList.toggle("on", idx === save.level);
      chips[i].classList.toggle("done", save.done.indexOf(idx) !== -1);
    }
    el.next.textContent = save.level >= LEVELS.length - 1 ? "回到第一关" : "下一关";
    el.winNext.textContent = save.level >= LEVELS.length - 1 ? "回到第一关" : "下一关";
  }

  function showWin(show) {
    if (!el) return;
    el.win.classList.toggle("on", !!show);
    if (show) {
      el.winTitle.textContent = LEVELS[save.level].name;
      el.winMeta.textContent = "用了 " + st.moves + " 步 · 推动 " + st.pushes + " 次";
    }
  }

  /* ---------------- 游戏动作 ---------------- */
  function goLevel(index, silent) {
    if (index < 0) index = 0;
    if (index >= LEVELS.length) index = 0;
    var base = parseLevel(LEVELS[index].map);
    st = {
      grid: base.grid,
      cols: base.cols,
      rows: base.rows,
      player: base.player,
      boxes: base.boxes,
      moves: 0,
      pushes: 0,
      won: false,
      cell: st ? st.cell : 40,
      history: []
    };
    view = { player: { x: st.player.x, y: st.player.y }, boxes: st.boxes.map(function (b) { return { x: b.x, y: b.y }; }) };
    anim = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (pendingWin) { clearTimeout(pendingWin); pendingWin = 0; }
    save.level = index;
    persist();
    if (el) {
      layout();
      syncStats();
      showWin(false);
    }
    if (!silent) draw();
  }

  function move(dir) {
    if (!st || st.won) return;
    var d = DIRS[dir];
    if (!d) return;

    var nx = st.player.x + d[0], ny = st.player.y + d[1];
    if (cellAt(st, nx, ny) === 1) return;

    var bi = boxIndexAt(st, nx, ny);
    var moved = false;
    var before = {
      px: view.player.x,
      py: view.player.y,
      boxes: view.boxes.map(function (b) { return { x: b.x, y: b.y }; }),
      box: -1
    };

    if (bi !== -1) {
      var bx = nx + d[0], by = ny + d[1];
      if (cellAt(st, bx, by) === 1 || boxIndexAt(st, bx, by) !== -1) return;
      before.box = bi;
      st.history.push({
        px: st.player.x, py: st.player.y,
        boxes: st.boxes.map(function (b) { return { x: b.x, y: b.y }; }),
        moves: st.moves, pushes: st.pushes
      });
      st.boxes[bi] = { x: bx, y: by };
      st.pushes++;
      moved = true;
    } else {
      st.history.push({
        px: st.player.x, py: st.player.y,
        boxes: st.boxes.map(function (b) { return { x: b.x, y: b.y }; }),
        moves: st.moves, pushes: st.pushes
      });
    }

    st.player = { x: nx, y: ny };
    st.moves++;
    if (st.history.length > 400) st.history.shift();

    if (el) syncStats();
    tween(before);

    if (isWin(st)) {
      st.won = true;
      if (save.done.indexOf(save.level) === -1) { save.done.push(save.level); persist(); }
      if (el) {
        syncStats();
        pendingWin = setTimeout(function () { pendingWin = 0; if (st && st.won) showWin(true); }, reduced ? 60 : 420);
      }
    }
    return moved;
  }

  function undo() {
    if (!st || !st.history.length) return;
    var h = st.history.pop();
    st.player = { x: h.px, y: h.py };
    st.boxes = h.boxes.map(function (b) { return { x: b.x, y: b.y }; });
    st.moves = h.moves;
    st.pushes = h.pushes;
    if (st.won) {
      st.won = false;
      if (pendingWin) { clearTimeout(pendingWin); pendingWin = 0; }
      showWin(false);
    }
    snapView();
    anim = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    syncStats();
    draw();
  }

  function reset() {
    if (!st) return;
    goLevel(save.level);
  }

  function nextLevel() {
    goLevel(save.level + 1);
  }

  /* ---------------- 事件 ---------------- */
  function onKey(e) {
    if (!st || !el) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    var dir = null;
    if (k === "ArrowUp" || k === "w" || k === "W") dir = "up";
    else if (k === "ArrowDown" || k === "s" || k === "S") dir = "down";
    else if (k === "ArrowLeft" || k === "a" || k === "A") dir = "left";
    else if (k === "ArrowRight" || k === "d" || k === "D") dir = "right";
    else if (k === "u" || k === "U" || k === "z" || k === "Z") { e.preventDefault(); undo(); return; }
    else if (k === "r" || k === "R") { e.preventDefault(); reset(); return; }
    else return;
    if (dir) { e.preventDefault(); move(dir); }
  }

  function bindSwipe(canvas) {
    var sx = 0, sy = 0, active = false;
    canvas.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; active = true;
    }, { passive: true });
    canvas.addEventListener("touchmove", function (e) { if (active) e.preventDefault(); }, { passive: false });
    canvas.addEventListener("touchend", function (e) {
      if (!active) return;
      active = false;
      var t = e.changedTouches[0];
      var dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 22 && Math.abs(dy) < 22) return;
      if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? "right" : "left");
      else move(dy > 0 ? "down" : "up");
    }, { passive: true });
  }

  function onResize() { layout(); }

  /* ---------------- 挂载 / 卸载 ---------------- */
  function mount(root) {
    if (!root) return;
    unmount();

    reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    el = {
      root: root,
      canvas: root.querySelector("#gameCanvas"),
      stage: root.querySelector("#gameStage"),
      chips: root.querySelector("#gameChips"),
      level: root.querySelector("#gLevel"),
      moves: root.querySelector("#gMoves"),
      pushes: root.querySelector("#gPushes"),
      win: root.querySelector("#gameWin"),
      winTitle: root.querySelector("#gameWinTitle"),
      winMeta: root.querySelector("#gameWinMeta"),
      winNext: root.querySelector("#gWinNext"),
      winAgain: root.querySelector("#gWinAgain"),
      undo: root.querySelector("#gUndo"),
      reset: root.querySelector("#gReset"),
      next: root.querySelector("#gNext"),
      pad: root.querySelector("#gamePad")
    };
    if (!el.canvas || !el.stage) { el = null; return; }
    ctx = el.canvas.getContext("2d");

    save = loadSave();
    goLevel(save.level, true);

    el.undo.addEventListener("click", undo);
    el.reset.addEventListener("click", reset);
    el.next.addEventListener("click", nextLevel);
    el.winNext.addEventListener("click", nextLevel);
    el.winAgain.addEventListener("click", reset);
    el.chips.addEventListener("click", function (e) {
      var chip = e.target.closest("[data-level]");
      if (chip) goLevel(parseInt(chip.getAttribute("data-level"), 10));
    });
    el.pad.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-dir]");
      if (btn) move(btn.getAttribute("data-dir"));
    });

    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    bindSwipe(el.canvas);

    if (window.ResizeObserver) {
      el.observer = new ResizeObserver(function () { layout(); });
      el.observer.observe(el.stage);
    }
    layout();
  }

  function unmount() {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (pendingWin) { clearTimeout(pendingWin); pendingWin = 0; }
    if (el && el.observer) { try { el.observer.disconnect(); } catch (e) {} }
    el = null;
    ctx = null;
    st = null;
    view = null;
    anim = null;
  }

  function debug() {
    if (!st) return null;
    return {
      level: save ? save.level : 0,
      name: LEVELS[save.level].name,
      cols: st.cols,
      rows: st.rows,
      moves: st.moves,
      pushes: st.pushes,
      won: st.won,
      done: save ? save.done.slice() : [],
      player: { x: st.player.x, y: st.player.y },
      boxes: st.boxes.map(function (b) { return { x: b.x, y: b.y }; }),
      onGoal: st.boxes.map(function (b) { return cellAt(st, b.x, b.y) === 2; })
    };
  }

  window.Sokoban = {
    levels: LEVELS,
    html: html,
    mount: mount,
    unmount: unmount,
    debug: debug
  };
})();