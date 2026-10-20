/* 关卡可用性验证：把 sokoban.js 里的关卡跑一遍 BFS 求解器，
   确认每一关都能解，并打印最少步数与解法（用于自测脚本里驱动第 1 关）。
   用法：node .test/verify-levels.js            */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "sokoban.js"), "utf8");
const sandbox = {};
new Function("window", src)(sandbox);
const LEVELS = sandbox.Sokoban.levels;

const DIRS = [
  ["U", 0, -1],
  ["D", 0, 1],
  ["L", -1, 0],
  ["R", 1, 0]
];

function parse(map) {
  const cols = Math.max.apply(null, map.map((r) => r.length));
  const rows = map.length;
  const grid = [];
  let boxes = [];
  let player = null;
  for (let y = 0; y < rows; y++) {
    const line = [];
    for (let x = 0; x < cols; x++) {
      const c = map[y][x] || " ";
      line.push(c === "#" ? 1 : c === "." || c === "*" || c === "+" ? 2 : 0);
      if (c === "$" || c === "*") boxes.push(y * cols + x);
      if (c === "@" || c === "+") player = y * cols + x;
    }
    grid.push(line);
  }
  boxes.sort((a, b) => a - b);
  return { cols, rows, grid, boxes, player };
}

/* 箱子少的关卡 A* 能给出最少步数；箱子多的（5 只）换成
   二叉堆 + 目标指派启发式 + 2x2 冻结剪枝，只求「可解 + 见证解法」，不保证最优。 */
function astarSearch(level, cap) {
  const { cols, rows, grid, boxes, player } = parse(level.map);
  const cell = (p) => grid[(p / cols) | 0][p % cols];
  const isWall = (p) => cell(p) === 1;
  const goals = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (grid[y][x] === 2) goals.push(y * cols + x);
  const goalSet = new Set(goals);

  function wallAt(x, y) {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return true;
    return grid[y][x] === 1;
  }

  // 死锁：不在目标上的箱子被推进死角，或和墙组成 2x2 冻结块
  function stuck(p, all) {
    if (goalSet.has(p)) return false;
    const x = p % cols, y = (p / cols) | 0;
    const up = wallAt(x, y - 1), dn = wallAt(x, y + 1), lf = wallAt(x - 1, y), rt = wallAt(x + 1, y);
    if ((up || dn) && (lf || rt)) return true;
    if (up && lf && (wallAt(x - 1, y - 1) || all.has((y - 1) * cols + x - 1))) return true;
    if (up && rt && (wallAt(x + 1, y - 1) || all.has((y - 1) * cols + x + 1))) return true;
    if (dn && lf && (wallAt(x - 1, y + 1) || all.has((y + 1) * cols + x - 1))) return true;
    if (dn && rt && (wallAt(x + 1, y + 1) || all.has((y + 1) * cols + x + 1))) return true;
    return false;
  }

  // 贪心「各目标只用一次」的指派距离：比单纯取最近目标强得多
  function h(bs) {
    const pairs = [];
    for (let i = 0; i < bs.length; i++) {
      const bx = bs[i] % cols, by = (bs[i] / cols) | 0;
      for (let j = 0; j < goals.length; j++) {
        const g = goals[j];
        pairs.push([Math.abs((g % cols) - bx) + Math.abs(((g / cols) | 0) - by), i, j]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const usedB = new Set(), usedG = new Set();
    let sum = 0;
    for (const [d, i, j] of pairs) {
      if (usedB.has(i) || usedG.has(j)) continue;
      usedB.add(i); usedG.add(j); sum += d;
    }
    return sum;
  }

  const heap = [];
  function push(n) {
    heap.push(n);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].f <= heap[i].f) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      i = p;
    }
  }
  function pop() {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
        i = m;
      }
    }
    return top;
  }

  push({ f: h(boxes), g: 0, p: player, b: boxes, path: "" });
  const seen = new Map();
  seen.set(player + "|" + boxes.join(","), 0);
  let visited = 0;

  while (heap.length) {
    const s = pop();

    if (s.b.every((p) => goalSet.has(p))) return { ok: true, moves: s.g, path: s.path, visited };
    if (++visited > cap) return { ok: false, reason: "状态数超上限 " + cap, visited };

    for (const [ch, dx, dy] of DIRS) {
      const nx = (s.p % cols) + dx;
      const ny = ((s.p / cols) | 0) + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const np = ny * cols + nx;
      if (isWall(np)) continue;
      let nb = s.b;
      const k = s.b.indexOf(np);
      if (k !== -1) {
        const bx = nx + dx, by = ny + dy;
        if (bx < 0 || by < 0 || bx >= cols || by >= rows) continue;
        const bp = by * cols + bx;
        if (isWall(bp) || s.b.indexOf(bp) !== -1) continue;
        nb = s.b.slice();
        nb[k] = bp;
        nb.sort((a, b) => a - b);
        const all = new Set(nb);
        if (nb.some((p) => stuck(p, all))) continue;
      }
      const key = np + "|" + nb.join(",");
      const g = s.g + 1;
      const prev = seen.get(key);
      if (prev !== undefined && prev <= g) continue;
      seen.set(key, g);
      push({ f: g + h(nb), g, p: np, b: nb, path: s.path + ch });
    }
  }
  return { ok: false, reason: "无解", visited };
}

function solve(level, cap = 400000) {
  return astarSearch(level, cap);
}

/* 逐条模拟一串走法，确认合法并且真的过关（用于箱子多、A* 跑不动的关卡） */
function simulate(level, moves) {
  const { cols, rows, grid, boxes, player } = parse(level.map);
  const cell = (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows ? 1 : grid[y][x]);
  const goal = (x, y) => cell(x, y) === 2;
  const bs = boxes.map((p) => ({ x: p % cols, y: (p / cols) | 0 }));
  let p = { x: player % cols, y: (player / cols) | 0 };
  const D = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };

  for (let i = 0; i < moves.length; i++) {
    const d = D[moves[i]];
    if (!d) return { ok: false, reason: "第 " + (i + 1) + " 步方向非法： " + moves[i] };
    const nx = p.x + d[0], ny = p.y + d[1];
    if (cell(nx, ny) === 1) return { ok: false, reason: "第 " + (i + 1) + " 步撞墙（" + moves[i] + "）" };
    const bi = bs.findIndex((b) => b.x === nx && b.y === ny);
    if (bi !== -1) {
      const bx = nx + d[0], by = ny + d[1];
      if (cell(bx, by) === 1) return { ok: false, reason: "第 " + (i + 1) + " 步把箱子推进墙里" };
      if (bs.some((b) => b.x === bx && b.y === by)) return { ok: false, reason: "第 " + (i + 1) + " 步箱子叠箱子" };
      bs[bi] = { x: bx, y: by };
    }
    p = { x: nx, y: ny };
  }

  const bad = bs.filter((b) => !goal(b.x, b.y));
  if (bad.length) return { ok: false, reason: "走完还有 " + bad.length + " 只箱子没到位：" + JSON.stringify(bad) };
  return { ok: true, moves: moves.length, path: moves };
}

/* 箱子多到 A* 也啃不动的关卡：给出人工构造的走法，上面这台模拟器逐条校验 */
const WITNESS = {
  7: "UUULLLUURURDURRRRDLULDLLLLDDDDRDRURRDRRULDLU"
};

let bad = 0;
const results = [];
LEVELS.forEach((lv, i) => {
  const boxCount = lv.map.join("").split("").filter((c) => c === "$" || c === "*").length;
  const goals = lv.map.join("").split("").filter((c) => c === "." || c === "*" || c === "+").length;
  let r = solve(lv);
  let how = "A* 搜索";
  if (!r.ok && WITNESS[i]) {
    const w = simulate(lv, WITNESS[i]);
    if (w.ok) { r = w; how = "人工构造解法 + 模拟校验"; }
    else r = { ok: false, reason: w.reason + "（A*：" + r.reason + "）" };
  }
  results.push({ i: i + 1, name: lv.name, boxes: boxCount, goals, ...r });
  const tag = r.ok ? "OK  " : "FAIL";
  console.log(
    tag + " 第" + (i + 1) + "关 「" + lv.name + "」 箱子 " + boxCount + " / 目标 " + goals +
    (r.ok ? " → 可解（" + how + "），解法 " + r.moves + " 步" + (r.visited ? "，探索 " + r.visited + " 状态" : "") : " → " + r.reason)
  );
  if (r.ok) console.log("      解法：" + r.path);
  else bad++;
});

console.log("\n共 " + LEVELS.length + " 关，" + (LEVELS.length - bad) + " 关可解" + (bad ? "，" + bad + " 关有问题" : ""));
console.log("第 1 关解法（自测用）：" + (results[0].ok ? results[0].path : "N/A"));
process.exit(bad ? 1 : 0);