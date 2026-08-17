const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>LLM Stream Watchdog</title>
  <style>
    :root{color-scheme:dark;--bg:#0b1020;--panel:#151c31;--muted:#91a0be;--text:#eef3ff;--good:#54d6a1;--warn:#ffca58;--bad:#ff718b;--line:#26324f}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#17213c 0,#0b1020 42%);font:14px/1.5 ui-sans-serif,system-ui;color:var(--text)}
    main{max-width:1180px;margin:auto;padding:28px 20px 48px}header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:22px}h1{margin:0;font-size:28px}p{color:var(--muted);margin:6px 0}.status{padding:8px 12px;border:1px solid #2b7058;border-radius:999px;color:var(--good);background:#123326}
    .controls{display:flex;gap:10px;align-items:center;margin:18px 0}select,button{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 11px}button{cursor:pointer}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px}.card,.panel{background:rgba(21,28,49,.94);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 35px #0004}.card{padding:16px}.card strong{display:block;font-size:26px;margin-top:4px}.card span{color:var(--muted)}.good strong{color:var(--good)}.warn strong{color:var(--warn)}.bad strong{color:var(--bad)}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.panel{padding:18px;min-width:0}.panel h2{font-size:16px;margin:0 0 14px}.latency{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.metric{padding:12px;background:#0f1629;border-radius:10px}.metric b{display:block;font-size:19px}.metric small{color:var(--muted)}
    .bars{display:flex;align-items:end;gap:8px;height:180px;border-bottom:1px solid var(--line);padding-top:10px}.barwrap{flex:1;min-width:16px;text-align:center}.bar{margin:auto;width:min(30px,80%);background:linear-gradient(var(--warn),#da5b73);border-radius:5px 5px 0 0;min-height:2px}.barwrap small{display:block;color:var(--muted);font-size:10px;transform:rotate(-35deg);margin-top:12px}
    table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:9px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted)}code{color:#bdd0ff}.empty{color:var(--muted);padding:20px 0}.foot{margin-top:16px;font-size:12px;color:var(--muted)}
    @media(max-width:760px){header{display:block}.status{display:inline-block;margin-top:10px}.grid{grid-template-columns:1fr}.latency{grid-template-columns:1fr 1fr}.panel{overflow:auto}}
  </style>
</head>
<body><main>
<header><div><h1>LLM Stream Watchdog</h1><p>匿名、仅本机的上游稳定性观察面板</p></div><div class="status" id="status">● 正在加载</div></header>
<div class="controls"><label>时间范围 <select id="days"><option value="1">24 小时</option><option value="7">7 天</option><option value="30" selected>30 天</option></select></label><button id="refresh">刷新</button><span id="updated"></span></div>
<section class="cards" id="cards"></section>
<section class="grid"><div class="panel"><h2>延迟</h2><div class="latency" id="latency"></div></div><div class="panel"><h2>每日异常趋势</h2><div class="bars" id="bars"></div></div></section>
<section class="panel" style="margin-top:14px"><h2>最近异常</h2><div id="anomalies"></div></section>
<div class="foot">不保存 prompt、响应正文、API Key 或 Authorization。历史默认保留 30 天，每 15 秒自动刷新。</div>
</main><script>
const esc=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>n==null?'—':n>=1000?(n/1000).toFixed(1)+'s':Math.round(n)+'ms';
const card=(label,value,cls='')=>'<div class="card '+cls+'"><span>'+label+'</span><strong>'+value+'</strong></div>';
async function load(){
  const days=document.querySelector('#days').value;
  try{
    const r=await fetch('/api/dashboard?days='+days,{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);const d=await r.json();const t=d.totals;
    document.querySelector('#status').textContent='● 运行正常';
    document.querySelector('#cards').innerHTML=card('请求',t.requests)+card('正常完成',t.completed,'good')+card('自动重试',t.retries,t.retries?'warn':'')+card('重试后恢复',t.recoveredAfterRetry,'good')+card('首字节超时',t.firstByteTimeouts,t.firstByteTimeouts?'warn':'')+card('流中途停滞',t.streamStalls,t.streamStalls?'bad':'')+card('失败',t.failures,t.failures?'bad':'')+card('客户端取消',t.cancelled);
    const l=d.latency;document.querySelector('#latency').innerHTML=[['首字节 P50',l.firstByteP50Ms],['首字节 P95',l.firstByteP95Ms],['首字节最大',l.firstByteMaxMs],['总耗时 P50',l.durationP50Ms],['总耗时 P95',l.durationP95Ms],['总耗时最大',l.durationMaxMs]].map(x=>'<div class="metric"><small>'+x[0]+'</small><b>'+fmt(x[1])+'</b></div>').join('');
    const max=Math.max(1,...d.daily.map(x=>x.anomalies));document.querySelector('#bars').innerHTML=d.daily.length?d.daily.map(x=>'<div class="barwrap" title="'+x.date+'：'+x.anomalies+' 个异常 / '+x.requests+' 个请求"><div class="bar" style="height:'+(x.anomalies/max*145)+'px"></div><small>'+x.date.slice(5)+'</small></div>').join(''):'<div class="empty">暂无数据</div>';
    document.querySelector('#anomalies').innerHTML=d.recentAnomalies.length?'<table><thead><tr><th>时间</th><th>事件</th><th>原因</th><th>尝试</th><th>路径</th></tr></thead><tbody>'+d.recentAnomalies.map(x=>'<tr><td>'+esc(new Date(x.time).toLocaleString())+'</td><td><code>'+esc(x.event)+'</code></td><td>'+esc(x.reason)+'</td><td>'+esc(x.attempt)+'</td><td>'+esc(x.path)+'</td></tr>').join('')+'</tbody></table>':'<div class="empty">所选时间范围内没有异常。</div>';
    document.querySelector('#updated').textContent='更新于 '+new Date(d.generatedAt).toLocaleTimeString();
  }catch(e){document.querySelector('#status').textContent='● 面板异常';document.querySelector('#status').style.color='var(--bad)';}
}
document.querySelector('#refresh').onclick=load;document.querySelector('#days').onchange=load;load();setInterval(load,15000);
</script></body></html>`;

function send(response, status, type, body) {
  response.statusCode = status;
  response.setHeader('content-type', type);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('content-security-policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  response.end(body);
}

export function handleDashboardRequest(request, response, { store, config }) {
  const url = new URL(request.url || '/', 'http://localhost');
  if (request.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/dashboard/')) {
    send(response, 200, 'text/html; charset=utf-8', DASHBOARD_HTML);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    const summary = store.summary(url.searchParams.get('days'));
    summary.runtime = {
      upstreamConfigured: true,
      retentionDays: config.eventRetentionDays,
      streamingFirstByteTimeoutMs: config.firstByteTimeoutMs,
      nonStreamingFirstByteTimeoutMs: config.nonStreamingFirstByteTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
      maxAttempts: config.maxAttempts,
    };
    send(response, 200, 'application/json; charset=utf-8', JSON.stringify(summary));
    return true;
  }
  return false;
}
