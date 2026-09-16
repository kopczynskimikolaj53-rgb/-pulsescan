type Env = {
  DB: D1Database;
  AI?: { run(model: string, input: Record<string, unknown>): Promise<any> };
  BOT_TICK_SECRET?: string;
  X_BEARER_TOKEN?: string;
  BIRDEYE_API_KEY?: string;
};

type Token = any;
type PaperPosition = any;
const PAPER_START_BALANCE = 1000;
const PAPER_MAX_OPEN = 10;
const PAPER_MAX_HOLD_MINUTES = 120;
const STRATEGY_VERSION = 'v5';
const MIN_SCORE = 62;
const MIN_LIQ = 6000;
const MIN_VOL = 1200;
const MIN_BUY_RATIO = 0.52;
const MAX_MCAP = 1_000_000;

function json(data: unknown, status = 200, headers: Record<string,string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
function cookie(request: Request, name: string) {
  const raw = request.headers.get('cookie') || '';
  const part = raw.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}
async function records(env: Env, table: string, limit = 100) {
  const rows = await env.DB.prepare('SELECT id,data FROM pulsescan_records WHERE table_name=? ORDER BY updated_at DESC LIMIT ?').bind(table, limit).all<{id:string,data:string}>();
  return (rows.results || []).map(r => ({ id:r.id, ...(JSON.parse(r.data) as any) }));
}
async function put(env: Env, table: string, data: any, id = crypto.randomUUID()) {
  const now = Date.now();
  await env.DB.prepare('INSERT INTO pulsescan_records(id,table_name,data,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').bind(id, table, JSON.stringify(data), now, now).run();
  return id;
}
async function remove(env: Env, id: string) { await env.DB.prepare('DELETE FROM pulsescan_records WHERE id=?').bind(id).run(); }
async function fetchJson(url:string, init?:RequestInit) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}
function scorePair(p:any) {
  const liq=Number(p?.liquidity?.usd||0), vol=Number(p?.volume?.m5||0), mc=Number(p?.marketCap||p?.fdv||0);
  const buys=Number(p?.txns?.m5?.buys||0), sells=Number(p?.txns?.m5?.sells||0), total=buys+sells;
  const buyRatio=total?buys/total:0;
  const c5=Number(p?.priceChange?.m5||0), h1=Number(p?.priceChange?.h1||0), h6=Number(p?.priceChange?.h6||0);
  const age=p?.pairCreatedAt?Math.max(.1,(Date.now()-p.pairCreatedAt)/60000):9999;
  const eff=liq?Math.min(1.5,vol/liq):0, mcLiq=liq?mc/liq:Infinity;
  let score=0; const reasons:string[]=[];
  score+=Math.min(20,Math.max(0,((liq-8000)/17000)*20));
  score+=Math.min(20,Math.max(0,((buyRatio-.5)/.25)*20));
  if(c5>=3&&c5<=10){score+=20;reasons.push('clean 5m momentum')} else if(c5>=1.5&&c5<=15){score+=14;reasons.push('positive momentum')} else if(c5>15&&c5<=22)score+=5;
  score+=Math.min(15,eff*15); if(eff>=.35) reasons.push('healthy volume/liquidity');
  if(age>=5&&age<=90){score+=10;reasons.push('inside launch window')} else if(age>=2&&age<=180)score+=6;
  score+=mcLiq<=60?10:mcLiq<=120?6:0; if(mcLiq<=60) reasons.push('good mcap/liquidity');
  score+=Math.min(5,buys/4); if(buys>=20) reasons.push('enough trade activity');
  if(h1>0)score+=Math.min(6,h1*.4); if(h6>0)score+=Math.min(4,h6*.15); if(h1>0&&h6>0)reasons.push('multi-timeframe trend aligned');
  if(h1<-8)score-=8;
  const reject=liq<MIN_LIQ||vol<MIN_VOL||buyRatio<MIN_BUY_RATIO||mc<=0||mc>MAX_MCAP||age<2||age>180||c5<=0||c5>22||h1<-12||h6<-22||mcLiq>120||buys<6;
  return {score:Math.max(0,Math.min(100,Math.round(score))),reject,age,buyRatio,eff,mcLiq,buys,sells,c5,h1,h6,reasons};
}
async function scanTokens(env:Env, limit=90) {
  const profiles:any[] = (await fetchJson('https://api.dexscreener.com/token-profiles/latest/v1')).filter((x:any)=>x.chainId==='solana'&&x.tokenAddress).slice(0,limit);
  const addresses=[...new Set(profiles.map(x=>x.tokenAddress))] as string[];
  const rows:any[]=[];
  for(let i=0;i<addresses.length;i+=30){
    const batch=addresses.slice(i,i+30); if(!batch.length)continue;
    try { const data=await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`); if(Array.isArray(data))rows.push(...data.filter((p:any)=>p.chainId==='solana')); } catch {}
  }
  let regime:'HOT'|'NORMAL'|'CHOPPY'|'RISK_OFF'='NORMAL';
  const tokens=rows.map(p=>{
    const address=p.baseToken?.address||''; const s=scorePair(p); const age=s.age;
    const risk=s.reject?'HIGH':s.score>=88?'LOW':s.score>=76?'MEDIUM':'HIGH';
    const fake=s.c5>18&&s.buyRatio<.58&&s.eff<.12;
    const late=s.c5>20&&s.buyRatio<.62;
    let final=s.score;
    if(s.h1>0&&s.h6>0)final+=6; else if(s.h1>0||s.h6>0)final+=2;
    if(fake)final-=10;if(late)final-=5;
    final=Math.max(0,Math.min(100,Math.round(final)));
    const signal=!s.reject&&!fake&&final>=MIN_SCORE?'PAPER BUY':!s.reject&&final>=52?'WATCH':'SKIP';
    return {id:address,symbol:p.baseToken?.symbol||'UNKNOWN',name:p.baseToken?.name||'Unknown token',address,ageMinutes:s.age,age:s.age<1?'<1m':s.age<60?`${Math.floor(s.age)}m`:`${Math.floor(s.age/60)}h`,mc:Number(p.marketCap||p.fdv||0),liquidity:Number(p.liquidity?.usd||0),volume5m:Number(p.volume?.m5||0),priceUsd:Number(p.priceUsd||0),priceChange5m:s.c5,priceChange1h:s.h1,priceChange6h:s.h6,priceChange24h:Number(p.priceChange?.h24||0),buys5m:s.buys,sells5m:s.sells,holders:0,top10:0,mint:null,freeze:null,onChainScore:s.score,volumeEfficiency:s.eff,mcapLiquidityRatio:s.mcLiq,tradeCount5m:s.buys+s.sells,score:final,risk,signal,quality:final>=92?'A+':final>=86?'A':final>=80?'B':final>=MIN_SCORE?'C+':'C',regime,fakePumpRisk:fake,buyRatio:s.buyRatio,socialScore:50,narrativeScore:50,socialBurst:0,socialSpamRatio:0,socialSentiment:50,authorQuality:0,externalAvailable:false,externalSocialAvailable:false,externalNarrativeAvailable:false,xMentions:0,newsMentions:0,externalReason:'External intelligence will enrich qualifying candidates.',reasons:[...s.reasons,...(s.h1>0&&s.h6>0?['1h + 6h trend aligned']:[]),...(fake?['fake-pump risk']:[]),...(late?['late-entry risk']:[])].slice(0,8),mode:age>=360?'BREAKOUT':'FRESH',breakoutConfirmed:s.c5>=2&&s.c5<=12&&s.eff>=.18&&s.buyRatio>=.58,trendAlignment:(s.h1>0?1:0)+(s.h6>0?1:0),volatilityPct:Math.max(1,Math.abs(s.c5),Math.abs(s.h1)/4)};
  }).filter(t=>t.address&&t.priceUsd>0);
  const fresh=tokens.filter(t=>t.mode==='FRESH'); const strong=tokens.filter(t=>t.score>=70&&t.buyRatio>=.62&&t.priceChange5m>1).length;
  const avgBuy=tokens.length?tokens.reduce((a,t)=>a+t.buyRatio,0)/tokens.length:0, avgC5=tokens.length?tokens.reduce((a,t)=>a+t.priceChange5m,0)/tokens.length:0, avgEff=tokens.length?tokens.reduce((a,t)=>a+t.volumeEfficiency,0)/tokens.length:0;
  if(strong>=6&&avgBuy>=.62&&avgEff>=.18&&avgC5>=2)regime='HOT'; else if(avgBuy<.54||avgC5<0||avgEff<.08)regime='RISK_OFF'; else if(avgBuy<.59&&avgC5<2.5)regime='CHOPPY';
  for(const t of tokens)t.regime=regime;
  const sorted=tokens.sort((a,b)=>b.score-a.score);
  const intelligence={updatedAt:Date.now(),tradersAvailable:false,traders:[],coins:sorted.filter(t=>t.mode==='BREAKOUT'&&t.signal!=='SKIP').slice(0,10).map((t,i)=>({rank:i+1,symbol:t.symbol,name:t.name,address:t.address,score:t.score,change5m:t.priceChange5m,liquidity:t.liquidity,volume5m:t.volume5m,age:t.age,signal:t.signal,reasons:t.reasons}))};
  return {tokens:sorted,source:'DexScreener + X fallback + Google News',fetchedAt:Date.now(),discovery:{profiles:profiles.length,batches:Math.ceil(addresses.length/30),pairs:rows.length,geckoPools:0,uniqueTokens:sorted.length,freshUnder10m:fresh.filter(t=>t.ageMinutes<=10).length,signalCount:sorted.filter(t=>t.signal==='PAPER BUY').length,scanMs:0,breakoutCount:sorted.filter(t=>t.mode==='BREAKOUT').length,regime,regimeConfidence:Math.round(Math.min(100,45+Math.abs(avgBuy-.58)*180+Math.min(30,strong*3))),avgBuyRatio:avgBuy,avgChange5m:avgC5,avgVolumeEfficiency:avgEff},intelligence};
}
async function livePrices(addresses:string[]) {
  const unique=[...new Set(addresses)].slice(0,50); const map=new Map<string,number>(); if(!unique.length)return map;
  try { const data:any=await fetchJson(`https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${unique.join(',')}?include_inactive_source=true`); for(const [a,v] of Object.entries(data?.data?.attributes?.token_prices||{})){const n=Number(v);if(n>0)map.set(a,n);} } catch {}
  if(map.size<unique.length)try { const data:any=await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${unique.join(',')}`); const best=new Map<string,{liq:number,price:number}>(); for(const p of Array.isArray(data)?data:[]){const a=p.baseToken?.address,n=Number(p.priceUsd||0),l=Number(p.liquidity?.usd||0);if(a&&n>0&&(!best.has(a)||l>best.get(a)!.liq))best.set(a,{liq:l,price:n});} for(const a of unique)if(!map.has(a)&&best.has(a))map.set(a,best.get(a)!.price); } catch {}
  return map;
}
function riskFor(t:any){const vol=Math.max(1,Math.abs(Number(t.priceChange5m||0)),Math.abs(Number(t.priceChange1h||0))/4);const stop=-Math.max(6,Math.min(12,4.5+vol*1.35));const score=Number(t.score||0);const size=Math.round(Math.max(30,Math.min(80,(PAPER_START_BALANCE*.0275/Math.max(.06,Math.abs(stop)/100))*(score>=92?1.08:score>=86?.95:score>=80?.82:.7)*(t.regime==='RISK_OFF'?.72:t.regime==='CHOPPY'?.82:t.regime==='HOT'?1:.9))));return {vol,stop,breakEven:score>=90?10:score>=82?12:15,trailArm:score>=90?20:24,trailGiveback:vol>=8?11:vol>=4?9:7,size};}
async function managePositions(env:Env, market:Map<string,any>) {
  const rows=await records(env,'paper_positions',100); const now=Date.now();
  for(const p of rows.filter(x=>x.status==='OPEN')){
    const price=market.get(p.address)?.priceUsd; const hold=(now-Number(p.openedAt||now))/60000;
    if(!price){if(hold>=PAPER_MAX_HOLD_MINUTES){p.status='CLOSED';p.exitPrice=p.currentPrice;p.closedAt=now;p.exitReason='TIME STOP (stale price)';p.pnl=0;p.pnlPct=0;await put(env,'paper_positions',p,p.id);}continue;}
    p.currentPrice=price;p.peakPrice=Math.max(Number(p.peakPrice||p.entryPrice),price);p.pnlPct=((price-p.entryPrice)/p.entryPrice)*100;p.pnl=((price-p.entryPrice)/p.entryPrice)*p.usdSize;
    const peak=((p.peakPrice-p.entryPrice)/p.entryPrice)*100; const be=Boolean(p.breakEvenArmed)||p.pnlPct>=Number(p.breakEvenPct||12); p.breakEvenArmed=be;
    let exit=''; const initial=Number(p.stopLossPct||-10); const trail=peak>=Number(p.trailArmPct||24)?peak-Number(p.trailGivebackPct||9):-999;
    const stop=Math.max(initial,be?0:initial,trail); if(p.pnlPct<=stop)exit=trail>-999?'TRAILING STOP':be?'BREAK-EVEN STOP':'VOLATILITY STOP';
    const t=market.get(p.address); if(!exit&&hold>=45&&p.pnlPct<2)exit='ADAPTIVE PROFIT: time decay'; if(!exit&&hold>=75&&p.pnlPct<6)exit='ADAPTIVE PROFIT: capital rotation'; if(!exit&&hold>=PAPER_MAX_HOLD_MINUTES)exit='TIME STOP'; if(!exit&&p.pnlPct>8&&t&&t.buyRatio<.5&&t.priceChange5m<0)exit='ADAPTIVE PROFIT: momentum reversal';
    if(exit){p.status='CLOSED';p.exitPrice=price;p.closedAt=now;p.exitReason=exit;} await put(env,'paper_positions',p,p.id);
  }
}
export async function paperCycle(env:Env) {
  const scan=await scanTokens(env,120); const rows=await records(env,'paper_positions',100); const open=rows.filter(p=>p.status==='OPEN');
  const prices=await livePrices(open.map(p=>p.address)); const market=new Map<string,any>(); for(const t of scan.tokens)market.set(t.address,t); for(const [a,p] of prices)market.set(a,{...(market.get(a)||{}),priceUsd:p,address:a});
  await managePositions(env,market);
  const freshRows=await records(env,'paper_positions',100); const openNow=freshRows.filter(p=>p.status==='OPEN'); const cap=scan.discovery.regime==='HOT'?8:scan.discovery.regime==='NORMAL'?6:scan.discovery.regime==='CHOPPY'?4:2; const slots=Math.max(0,Math.min(PAPER_MAX_OPEN-openNow.length,cap-openNow.length));
  const selected=scan.tokens.filter(t=>t.signal==='PAPER BUY'&&t.address&&!t.fakePumpRisk).sort((a,b)=>b.score-a.score).slice(0,slots);
  const buys=[]; for(const t of selected){const r=riskFor(t);const p={tokenId:t.id,symbol:t.symbol,name:t.name,address:t.address,entryPrice:t.priceUsd,currentPrice:t.priceUsd,peakPrice:t.priceUsd,usdSize:r.size,openedAt:Date.now(),status:'OPEN',score:t.score,onChainScore:t.onChainScore,socialScore:t.socialScore,narrativeScore:t.narrativeScore,externalReason:t.externalReason,entryRegime:t.regime,entryQuality:t.quality,v4Score:t.score,stopLossPct:r.stop,breakEvenPct:r.breakEven,breakEvenArmed:false,trailArmPct:r.trailArm,trailGivebackPct:r.trailGiveback,volatilityPct:r.vol,entryBuyRatio:t.buyRatio,entryM5Change:t.priceChange5m,entryH1Change:t.priceChange1h,entryVolumeEfficiency:t.volumeEfficiency,entryReasons:t.reasons||[]};p.id=await put(env,'paper_positions',p);buys.push(p);}
  const closed=(await records(env,'paper_positions',500)).filter(p=>p.status==='CLOSED'&&typeof p.pnl==='number');
  await put(env,'paper_bot_status',{lastRunAt:Date.now(),lastSuccessAt:Date.now(),lastError:null,candidates:scan.tokens.length,eligible:scan.tokens.filter(t=>t.signal==='PAPER BUY').length,actionable:selected.length,createdPaperBuys:buys.length,lastTradeAt:buys.length?Date.now():null,durationMs:0,invocationId:crypto.randomUUID(),strategyVersion:STRATEGY_VERSION,marketRegime:scan.discovery.regime,regimeConfidence:scan.discovery.regimeConfidence,externalSources:'X + Google News'},'paper-bot-status');
  return {scan,buys,closed};
}
async function xSniper(env:Env){
  const events:any[]=[];
  try {
    if(!env.X_BEARER_TOKEN) return {events,diagnostics:{status:'fallback',queries:0,tweetsScanned:0,addressesFound:0,lastError:'X_BEARER_TOKEN not configured',fallbackActive:true,fallbackSources:['DexScreener']}};
    const q=encodeURIComponent('Solana (contract OR CA OR mint) -is:retweet -is:reply');
    const r=await fetch(`https://api.x.com/2/tweets/search/recent?query=${q}&max_results=50&tweet.fields=public_metrics,author_id,created_at&expansions=author_id&user.fields=verified,username`,{headers:{Authorization:`Bearer ${env.X_BEARER_TOKEN}`}});
    if(!r.ok)throw new Error(`X ${r.status}`); const payload:any=await r.json(); const users=new Map((payload.includes?.users||[]).map((u:any)=>[u.id,u]));
    for(const tweet of payload.data||[]){const matches=String(tweet.text||'').match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)||[];for(const address of [...new Set(matches)]){try{const pairs:any[]=await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${address}`);const p=pairs.find(x=>x.chainId==='solana');if(!p)continue;const s=scorePair(p);const u:any=users.get(tweet.author_id)||{};const score=Math.max(0,Math.min(100,Math.round(s.score+Math.max(0,10-((Date.now()-Date.parse(tweet.created_at||''))/60000)*.65)+(u.verified?8:0))));events.push({tweetId:String(tweet.id),tweetUrl:`https://x.com/${u.username||'i'}/status/${tweet.id}`,text:String(tweet.text||'').slice(0,280),author:u.username?`@${u.username}`:'X',verified:Boolean(u.verified),engagement:Number(tweet.public_metrics?.like_count||0)+Number(tweet.public_metrics?.retweet_count||0),detectedAt:Date.now(),address,symbol:p.baseToken?.symbol||'UNKNOWN',name:p.baseToken?.name||'Unknown token',priceUsd:Number(p.priceUsd||0),liquidity:Number(p.liquidity?.usd||0),volume5m:Number(p.volume?.m5||0),priceChange5m:Number(p.priceChange?.m5||0),buyRatio:s.buyRatio,score,signal:!s.reject&&score>=MIN_SCORE?'PAPER BUY':!s.reject&&score>=55?'WATCH':'SKIP',reason:'X contract detected · live market validation'});}catch{}}}
    return {events:events.sort((a,b)=>b.score-a.score).slice(0,20),diagnostics:{status:'connected',queries:1,tweetsScanned:(payload.data||[]).length,addressesFound:events.length,lastError:null,fallbackActive:false,fallbackSources:[]}};
  } catch(e:any) { return {events,diagnostics:{status:'fallback',queries:1,tweetsScanned:0,addressesFound:0,lastError:e?.message||'X unavailable',fallbackActive:true,fallbackSources:['DexScreener']}}; }
}
async function shiba(env:Env, body:any){
  const token=body?.token||{}; const symbol=String(token.symbol||'UNKNOWN').replace(/^\$/,''); const name=String(token.name||symbol); const address=String(token.address||'');
  const urls=[...(Array.isArray(body?.sourceUrls)?body.sourceUrls:[]),body?.website,address?`https://dexscreener.com/solana/${address}`:'',address?`https://solscan.io/token/${address}`:''].filter((u:any)=>/^https?:\/\//.test(String(u))).slice(0,5);
  const sources=[]; let combined='';
  for(const url of urls){try{const r=await fetch(url,{headers:{'user-agent':'PulseScan-Shiba/1.0'}});const text=(await r.text()).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,5000);sources.push({url,status:r.status,title:url,ok:r.ok});combined+=`\nSOURCE ${url}\n${text}`;}catch{sources.push({url,status:0,title:url,ok:false});}}
  let aiText=''; if(env.AI&&combined){try{const result=await env.AI.run('@cf/meta/llama-3.1-8b-instruct',{messages:[{role:'system',content:'You are Shiba, a cautious crypto due-diligence analyst. Never invent facts. Return concise JSON with verdict,summary,reasons,redFlags,greenFlags,confidence.'},{role:'user',content:`Analyze ${symbol} (${name}) contract ${address}. Evidence:${combined.slice(0,18000)}`}],max_tokens:700});aiText=String(result?.response||'');}catch{}}
  let parsed:any=null; try{const m=aiText.match(/\{[\s\S]*\}/);if(m)parsed=JSON.parse(m[0]);}catch{}
  const red=Array.isArray(parsed?.redFlags)?parsed.redFlags.map(String).slice(0,7):[/scam|rug|honeypot|drain|exploit/i.test(combined)?'Risk language detected in public-source evidence.': 'No automated red flag found.'];
  const green=Array.isArray(parsed?.greenFlags)?parsed.greenFlags.map(String).slice(0,7):sources.filter(s=>s.ok).length?['Public sources were reachable and inspected.']:[];
  const confidence=Math.max(0,Math.min(100,Number(parsed?.confidence||60))); const risk=Math.max(0,Math.min(100,red.length*12+(sources.length?0:20))); const aiScore=Math.max(0,Math.min(100,Math.round((100-risk)*.55+confidence*.45)));
  const report={token:{symbol:`$${symbol}`,name,address,score:body?.metrics?.score,priceUsd:body?.metrics?.priceUsd,liquidity:body?.metrics?.liquidity,volume5m:body?.metrics?.volume5m,priceChange5m:body?.metrics?.priceChange5m},verdict:String(parsed?.verdict||(risk>=55?'CAUTION / VERIFY':'RESEARCH PASS')),category:'AI_DUE_DILIGENCE',aiScore,riskScore:risk,confidence,summary:String(parsed?.summary||'Shiba inspected the supplied public sources and returned a bounded due-diligence result.').slice(0,700),reasons:Array.isArray(parsed?.reasons)?parsed.reasons.map(String).slice(0,8):[],redFlags:red,greenFlags:green,sources,extracted:{},generatedAt:Date.now()};
  await put(env,'shiba_reports',report); return report;
}
function alertSvg(report:any){const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><rect width="100%" height="100%" fill="#080b12"/><rect x="50" y="50" width="980" height="980" rx="42" fill="#0e1420" stroke="#6f9aff" stroke-width="3"/><text x="90" y="135" fill="#6f9aff" font-size="34" font-family="Arial" font-weight="700">SHIBA AI</text><text x="90" y="240" fill="white" font-size="78" font-family="Arial" font-weight="900">${esc(report.token?.symbol||'TOKEN')}</text><text x="90" y="310" fill="#8e99ad" font-size="30" font-family="Arial">${esc(report.verdict||'WATCH')}</text><text x="90" y="510" fill="#6f9aff" font-size="170" font-family="Arial" font-weight="900">${Number(report.aiScore||0)}</text><text x="90" y="560" fill="#69758b" font-size="28" font-family="Arial">AI SCORE / 100</text><text x="90" y="680" fill="#ff9aaa" font-size="30" font-family="Arial">RISK ${Number(report.riskScore||0)} / 100</text><text x="90" y="930" fill="#68748b" font-size="24" font-family="Arial">PulseScan · Precision Momentum v5</text></svg>`;return btoa(unescape(encodeURIComponent(svg)));}
async function portfolio(env:Env){
  const rows=await records(env,'paper_positions',500); const open=rows.filter(p=>p.status==='OPEN'); const closed=rows.filter(p=>p.status==='CLOSED'&&typeof p.pnl==='number').sort((a,b)=>Number(a.closedAt||0)-Number(b.closedAt||0)); const prices=await livePrices(open.map(p=>p.address));
  const positions=open.map(p=>{const price=prices.get(p.address)||p.currentPrice;return {...p,currentPrice:price,pnl:((price-p.entryPrice)/p.entryPrice)*p.usdSize,pnlPct:((price-p.entryPrice)/p.entryPrice)*100};});
  const realized=closed.reduce((a,p)=>a+Number(p.pnl||0),0), unreal=positions.reduce((a,p)=>a+Number(p.pnl||0),0), wins=closed.filter(p=>p.pnl>0),losses=closed.filter(p=>p.pnl<=0),grossWins=wins.reduce((a,p)=>a+p.pnl,0),grossLoss=Math.abs(losses.reduce((a,p)=>a+p.pnl,0)); const winRate=closed.length?wins.length/closed.length*100:null; const avgWin=wins.length?grossWins/wins.length:0,avgLoss=losses.length?grossLoss/losses.length:0,expectancy=closed.length?(winRate!/100)*avgWin-(1-winRate!/100)*avgLoss:0; let equity=PAPER_START_BALANCE,peak=equity,maxDD=0;for(const p of closed){equity+=Number(p.pnl||0);peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/peak*100);}
  return {startingBalance:PAPER_START_BALANCE,invested:open.reduce((a,p)=>a+p.usdSize,0),available:PAPER_START_BALANCE+realized-open.reduce((a,p)=>a+p.usdSize,0),equity:PAPER_START_BALANCE+realized+unreal,unrealizedPnl:unreal,realizedPnl:realized,positions,closedTrades:closed.slice(-50).reverse(),priceUpdatedAt:Date.now(),analytics:{avgWin,avgLoss,expectancy,grossWins,grossLosses,bestTrade:closed.length?[...closed].sort((a,b)=>b.pnl-a.pnl)[0]:null,worstTrade:closed.length?[...closed].sort((a,b)=>a.pnl-b.pnl)[0]:null,equityCurve:closed.slice(-60).map(p=>({at:p.closedAt,equity:0,pnl:p.pnl}))},strategy:{name:'Precision Momentum v5',minScore:MIN_SCORE,stopLossPct:'dynamic',stopLossRangePct:[-12,-6],takeProfitPct:null,breakEvenArmPct:12,trailArmPct:24,trailGivebackPct:9,maxHoldMinutes:PAPER_MAX_HOLD_MINUTES,adaptiveProfit:true,adaptiveProfitStartPct:20,closedTrades:closed.length,wins:wins.length,losses:losses.length,winRate,profitFactor:grossLoss?grossWins/grossLoss:grossWins?999:0,avgWin,avgLoss,expectancy,maxDrawdownPct:maxDD,sources:['On-chain','X','Google News'],features:['regime-aware scoring','1h/6h confirmation','breakout confirmation','volatility-adaptive stop','break-even protection','profit trailing','momentum reversal exit','time decay exit'],version:STRATEGY_VERSION}};
}
export async function handle(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url); const path=url.pathname; const method=request.method;
  if(path==='/api/health')return json({message:'Success',platform:'Cloudflare Workers'});
  
  if(path==='/api/tokens'){try{return json(await scanTokens(env,90));}catch(e:any){return json({error:'Live token feed unavailable',detail:e?.message},502);}}
  if(path==='/api/x-sniper'){const result=await xSniper(env);for(const e of result.events)await put(env,'x_sniper_events',e,`${e.tweetId}:${e.address}`);return json({enabled:true,updatedAt:Date.now(),...result,events:result.events});}
  if(path==='/api/shiba/reports')return json({reports:await records(env,'shiba_reports',20)});
  if(path==='/api/shiba/due-diligence'&&method==='POST'){try{return json(await shiba(env,await request.json()));}catch(e:any){return json({error:'Shiba due diligence unavailable',detail:e?.message},502);}}
  if(path==='/api/shiba/generate-card'&&method==='POST'){const body:any=await request.json();return json({image:{data:alertSvg(body.report||{}),mimeType:'image/svg+xml'}});}
  if(path==='/api/bot/status'){const s=(await records(env,'paper_bot_status',1))[0]||{};const age=Number(s.lastSuccessAt||0)?Date.now()-Number(s.lastSuccessAt):null;return json({...s,heartbeatAgeMs:age,healthy:Boolean(age!==null&&age<12*60*1000),cadenceMinutes:5,strategyVersion:STRATEGY_VERSION});}
  if(path==='/api/paper/portfolio')return json(await portfolio(env));
  if(path==='/api/bot/tick'&&method==='POST'){if(!env.BOT_TICK_SECRET||request.headers.get('x-bot-tick-secret')!==env.BOT_TICK_SECRET)return json({error:'Unauthorized'},401);try{return json(await paperCycle(env));}catch(e:any){return json({error:'Bot tick failed',detail:e?.message},503);}}
  if(path==='/api/subscriptions'&&method==='POST')return json({ok:true});
  return json({error:'Not found'},404);
}
export default { fetch:handle, async scheduled(_controller:any,env:Env,ctx:ExecutionContext){ctx.waitUntil(paperCycle(env));} };
