// 零依赖静态服务器：把你的页面分享给同一 WiFi 下的手机 / 其他电脑。
// 用法：node serve.js   （或双击 start-share.cmd）
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer(function (req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, rel);

  // 防止 ../ 穿越到项目目录之外
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('\n端口 ' + PORT + ' 已被占用，换一个端口试试：node serve.js 8081\n');
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', function () {
  const nets = os.networkInterfaces();
  const lines = [];
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (ni) {
      if (ni.family !== 'IPv4' || ni.internal) return;
      if (/vmnet|vmware|virtualbox|hyper-v|vethernet|loopback/i.test(name)) return;
      lines.push({ name: name, ip: ni.address });
    });
  });

  console.log('\n  林中小屋 - 局域网分享已启动\n');
  console.log('  本机打开:   http://localhost:' + PORT + '/');
  lines.forEach(function (l) {
    console.log('  他人打开:   http://' + l.ip + ':' + PORT + '/   (' + l.name + ')');
  });
  if (!lines.length) {
    console.log('  （没有检测到局域网 IP，请确认已连上 WiFi）');
  }
  console.log('\n  手机和电脑连同一个 WiFi，在浏览器输入上面的「他人打开」地址。');
  console.log('  Windows 第一次运行如弹出防火墙提示，请勾选「专用网络」并允许。');
  console.log('  按 Ctrl+C 停止分享。\n');
});
