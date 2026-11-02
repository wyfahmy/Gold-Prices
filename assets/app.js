
const OZ_G=31.1034768;
const REFRESH_MS=60000;
const HISTORY_REFRESH_MS=6*60*60*1000;

let state={
  us:null,
  usOz:null,
  eg:null,
  fx:null,
  fxDate:null,
  history:null,
  historySource:null,
  historyAt:null,
  selectedRange:'6M',
  fetchedAt:{},
  lastOK:null
};

const $=id=>document.getElementById(id);
const fmt2=n=>new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n);
const fmt3=n=>new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:4}).format(n);
const fmt0=n=>new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(n);

function normalize(s=''){
  const ar='٠١٢٣٤٥٦٧٨٩',fa='۰۱۲۳۴۵۶۷۸۹';
  return String(s)
    .replace(/[٠-٩]/g,d=>ar.indexOf(d))
    .replace(/[۰-۹]/g,d=>fa.indexOf(d))
    .replace(/\u200e|\u200f|\u202a|\u202b|\u202c|\u2066|\u2067|\u2068|\u2069/g,' ')
    .replace(/٬/g,'').replace(/٫/g,'.');
}

function nval(s){
  const n=Number(normalize(s).replace(/,/g,'').replace(/[^\d.-]/g,''));
  return Number.isFinite(n)?n:null;
}

function timeout(p,ms,label){
  return Promise.race([
    p,
    new Promise((_,rej)=>setTimeout(()=>rej(new Error(label+' timed out')),ms))
  ]);
}

async function getJSON(url,ms=15000){
  return timeout(fetch(url,{cache:'no-store'}).then(r=>{
    if(!r.ok)throw new Error('HTTP '+r.status);
    return r.json();
  }),ms,'Request');
}

async function getText(url,ms=30000){
  return timeout(fetch(url,{cache:'no-store'}).then(r=>{
    if(!r.ok)throw new Error('HTTP '+r.status);
    return r.text();
  }),ms,'Request');
}

function setDiag(id,text,cls=''){
  const x=$(id); x.textContent=text; x.className=cls;
}

function save(){
  try{localStorage.setItem('gold24-v8',JSON.stringify(state))}catch(e){}
}

function load(){
  try{
    const x=JSON.parse(localStorage.getItem('gold24-v8')||'null');
    if(x){
      state={...state,...x};
      render();
      if(state.history) renderChart(getRangePoints(state.history,state.selectedRange||'6M'));
      updateFreshness(false);
    }
  }catch(e){}
}

async function fetchUS(){
  const d=await getJSON('https://api.gold-api.com/price/XAU');
  const oz=Number(d.price);
  if(!Number.isFinite(oz)||oz<1000||oz>10000)throw new Error('Invalid gold spot');
  return {oz,gram:oz/OZ_G};
}

async function fetchCBEFx(){
  const d=await getJSON(
    'https://api.frankfurter.dev/v2/rate/USD/EGP?providers=CBE',
    18000
  );

  const rate=Number(d.rate);
  if(!Number.isFinite(rate)||rate<20||rate>100){
    throw new Error('Invalid CBE USD/EGP API response');
  }

  return {rate,date:d.date||null};
}

function parseISagha(raw){
  const t=normalize(raw).replace(/\u00a0/g,' ');
  let eg24=null;

  const k24Start=t.search(/عيار\s*24/);
  let k24Block='';

  if(k24Start>=0){
    const rest=t.slice(k24Start);
    const next=rest.search(/عيار\s*22/);
    k24Block=next>0?rest.slice(0,next):rest.slice(0,1800);
  }

  if(k24Block){
    const egpMatches=[...k24Block.matchAll(/([0-9]{1,5}(?:\.[0-9]+)?)\s*ج\.?\s*م/g)]
      .map(m=>nval(m[1]))
      .filter(Boolean);

    const validGold=egpMatches.filter(v=>v>3000&&v<20000);
    if(validGold.length)eg24=validGold[0];
  }

  if(!eg24){
    const pats=[
      /عيار\s*24[\s\S]{0,250}?([0-9]{4,5}(?:\.[0-9]+)?)\s*ج\.?\s*م/i,
      /عيار\s*24\s*\|[^|\n]*\|\s*([0-9]{4,5}(?:\.[0-9]+)?)\s*ج\.?\s*م/i
    ];

    for(const p of pats){
      const m=t.match(p);
      if(m){
        const v=nval(m[1]);
        if(v>3000&&v<20000){
          eg24=v;
          break;
        }
      }
    }
  }

  if(!eg24)throw new Error('Could not read iSagha 24K price');
  return {eg24};
}

async function fetchEgypt(){
  const target='https://market.isagha.com/prices/eg';
  const tries=[
    ['Jina Reader','https://r.jina.ai/'+target+'?v='+Date.now()],
    ['AllOrigins','https://api.allorigins.win/raw?url='+encodeURIComponent(target+'?v='+Date.now())]
  ];

  let errors=[];

  for(const [name,url] of tries){
    try{
      const raw=await getText(url,32000);
      return {...parseISagha(raw),source:name};
    }catch(e){
      errors.push(name+': '+e.message);
    }
  }

  throw new Error(errors.join(' | '));
}

/* ---------- HISTORY ---------- */

function parseHistoryPayload(payload){
  let d=payload;

  // Direct JSON route.
  if(typeof d==='string'){
    let text=d.trim();

    // Jina may wrap JSON in markdown/code fences or add a short header.
    text=text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();

    const firstBrace=text.indexOf('{');
    const lastBrace=text.lastIndexOf('}');
    if(firstBrace>=0 && lastBrace>firstBrace){
      text=text.slice(firstBrace,lastBrace+1);
    }

    try{
      d=JSON.parse(text);
    }catch(e){
      throw new Error('History proxy returned unreadable data');
    }
  }

  // AllOrigins may return {contents:"..."}.
  if(d && typeof d.contents==='string'){
    return parseHistoryPayload(d.contents);
  }

  if(!d || !Array.isArray(d.points)){
    throw new Error('History response has no points');
  }

  const raw=d.points
    .map(p=>({
      d:p.d || p.date,
      c:Number(p.c ?? p.close)
    }))
    .filter(p=>p.d && Number.isFinite(p.c) && p.c>1000)
    .map(p=>({...p,t:new Date(p.d+'T12:00:00Z').getTime()}))
    .filter(p=>Number.isFinite(p.t))
    .sort((a,b)=>a.t-b.t);

  if(raw.length<30) throw new Error('Not enough historical points');

  return raw;
}

async function fetchHistory(){
  const target='https://xaus.com/api/v1/history';

  const attempts=[
    {
      name:'XAUS direct',
      kind:'json',
      url:target
    },
    {
      name:'XAUS via Jina Reader',
      kind:'text',
      url:'https://r.jina.ai/'+target
    },
    {
      name:'XAUS via AllOrigins',
      kind:'json',
      url:'https://api.allorigins.win/get?url='+encodeURIComponent(target)
    }
  ];

  // Race validated results so a stalled source cannot delay a healthy fallback.
  const controllers=attempts.map(()=>new AbortController());
  const timers=[];
  try{
    return await Promise.any(attempts.map(async(a,i)=>{
      timers[i]=setTimeout(()=>controllers[i].abort(),12000);
      try{
        const response=await fetch(a.url,{cache:'no-store',signal:controllers[i].signal});
        if(!response.ok) throw new Error('HTTP '+response.status);
        const payload=a.kind==='json'?await response.json():await response.text();
        const raw=parseHistoryPayload(payload);
        const today=Date.now();
        const start=today-190*86400000;
        const six=raw.filter(p=>p.t>=start && p.t<=today+86400000);
        if(six.length<20) throw new Error('Six-month history incomplete');
        return {points:six,source:a.name};
      }catch(e){
        throw new Error(a.name+': '+(e.name==='AbortError'?'timed out':e.message));
      }finally{
        clearTimeout(timers[i]);
      }
    }));
  }catch(e){
    throw new Error((e.errors||[e]).map(error=>error.message).join(' | '));
  }finally{
    timers.forEach(clearTimeout);
    controllers.forEach(controller=>controller.abort());
  }
}

/*
  Adaptive timeline:
    >90 days old  : monthly-ish (nearest point to each month marker)
    90→30 days    : weekly
    30→7 days     : every 3 days
    last 7 days   : daily
  Dates keep their true horizontal position, so recent detail is genuinely denser.
*/
function nearestSample(points,targets){
  const picked=[];
  const seen=new Set();

  function nearest(target){
    let best=null,bestDist=Infinity;
    for(const p of points){
      const dist=Math.abs(p.t-target);
      if(dist<bestDist){best=p;bestDist=dist}
    }
    return best;
  }

  for(const t of targets){
    const p=nearest(t);
    if(p && !seen.has(p.d)){
      picked.push(p);
      seen.add(p.d);
    }
  }

  if(points.length){
    const first=points[0],last=points[points.length-1];
    if(!seen.has(first.d)) picked.push(first);
    if(!seen.has(last.d)) picked.push(last);
  }

  return picked.sort((a,b)=>a.t-b.t);
}

function sampleEveryDays(points,days){
  if(points.length<=2) return points;
  const step=days*86400000;
  const targets=[];
  let t=points[0].t;
  const end=points[points.length-1].t;
  while(t<=end){targets.push(t);t+=step}
  targets.push(end);
  return nearestSample(points,targets);
}

function adaptiveSample(points,now){
  const DAY=86400000;
  const targets=[];
  for(let days=180;days>=90;days-=30) targets.push(now-days*DAY);
  for(let days=84;days>=35;days-=7) targets.push(now-days*DAY);
  for(let days=30;days>=9;days-=3) targets.push(now-days*DAY);
  for(let days=7;days>=0;days--) targets.push(now-days*DAY);
  return nearestSample(points,targets);
}

function getRangePoints(raw,range){
  if(!raw || !raw.length) return [];
  const DAY=86400000;
  const now=raw[raw.length-1].t;
  let days=190;
  if(range==='1W') days=7;
  else if(range==='1M') days=31;
  else if(range==='3M') days=92;

  const subset=raw.filter(p=>p.t>=now-days*DAY);
  if(range==='1W') return subset;
  if(range==='1M') return subset;
  if(range==='3M') return sampleEveryDays(subset,3);
  return adaptiveSample(subset,now);
}

function updateRangeLabels(range){
  const labels={
    '1W':{title:'GLOBAL GOLD · 1 WEEK',sub:'USD / troy oz · daily closes',change:'1W CHANGE',left:'Daily',right:'7-day view'},
    '1M':{title:'GLOBAL GOLD · 1 MONTH',sub:'USD / troy oz · daily closes',change:'1M CHANGE',left:'Daily',right:'30-day view'},
    '3M':{title:'GLOBAL GOLD · 3 MONTHS',sub:'USD / troy oz · ~3-day steps',change:'3M CHANGE',left:'Every ~3 days',right:'90-day view'},
    '6M':{title:'GLOBAL GOLD · 6 MONTHS',sub:'USD / troy oz · adaptive detail toward today',change:'6M CHANGE',left:'6M ago: monthly',right:'→ weekly → 3-day → daily'}
  };
  const c=labels[range]||labels['6M'];
  $('goldChart').setAttribute('aria-label',c.title+' price chart');
  if($('chartTitle')) $('chartTitle').textContent=c.title;
  if($('chartSubtitle')) $('chartSubtitle').textContent=c.sub;
  if($('chartChangeLabel')) $('chartChangeLabel').textContent=c.change;
  if($('chartFootLeft')) $('chartFootLeft').textContent=c.left;
  if($('chartFootRight')) $('chartFootRight').textContent=c.right;
}

function setChartRange(range){
  state.selectedRange=range;
  save();
  document.querySelectorAll('.range-btn').forEach(btn=>{
    btn.classList.toggle('active',btn.dataset.range===range);
  });
  updateRangeLabels(range);
  if(state.history) renderChart(getRangePoints(state.history,range));
}

function renderChart(points){
  const svg=$('goldChart');
  const loading=$('chartLoading');

  if(!svg || !points || points.length<2) return;

  loading.style.display='none';
  loading.className='chart-loading';
  svg.innerHTML='';

  const W=340,H=230;
  const pad={l:42,r:9,t:13,b:27};
  const plotW=W-pad.l-pad.r;
  const plotH=H-pad.t-pad.b;

  const minT=points[0].t;
  const maxT=points[points.length-1].t;
  let minY=Math.min(...points.map(p=>p.c));
  let maxY=Math.max(...points.map(p=>p.c));

  const yrange=Math.max(1,maxY-minY);
  minY-=yrange*.10;
  maxY+=yrange*.10;

  const x=t=>pad.l+((t-minT)/(maxT-minT))*plotW;
  const y=v=>pad.t+(1-(v-minY)/(maxY-minY))*plotH;

  const ns='http://www.w3.org/2000/svg';
  const add=(tag,attrs,text)=>{
    const node=document.createElementNS(ns,tag);
    Object.entries(attrs||{}).forEach(([k,v])=>node.setAttribute(k,v));
    if(text!==undefined) node.textContent=text;
    svg.appendChild(node);
    return node;
  };

  // Horizontal grid and y labels.
  for(let i=0;i<4;i++){
    const value=minY+(maxY-minY)*(i/3);
    const yy=y(value);

    add('line',{
      x1:pad.l,y1:yy,x2:W-pad.r,y2:yy,
      stroke:'#272b32','stroke-width':'1',
      'vector-effect':'non-scaling-stroke'
    });

    add('text',{
      x:pad.l-6,y:yy+3.2,
      fill:'#6c7079','font-size':'9',
      'text-anchor':'end',
      'font-family':'system-ui'
    },'$'+fmt0(value));
  }

  // Month/time labels: start, ~3m, ~1m, latest.
  const labelTargets=[
    minT,
    minT+(maxT-minT)*.50,
    minT+(maxT-minT)*.83,
    maxT
  ];

  labelTargets.forEach((t,i)=>{
    const dt=new Date(t);
    const label=dt.toLocaleDateString('en-US',{month:'short',day:'numeric'});

    add('text',{
      x:x(t),
      y:H-7,
      fill:'#696d76','font-size':'9',
      'text-anchor':i===0?'start':i===labelTargets.length-1?'end':'middle',
      'font-family':'system-ui'
    },label);
  });

  // Area gradient.
  const defs=add('defs',{});
  const grad=document.createElementNS(ns,'linearGradient');
  grad.setAttribute('id','chartFill');
  grad.setAttribute('x1','0');grad.setAttribute('y1','0');
  grad.setAttribute('x2','0');grad.setAttribute('y2','1');

  const s1=document.createElementNS(ns,'stop');
  s1.setAttribute('offset','0%');s1.setAttribute('stop-color','#e9bd5b');s1.setAttribute('stop-opacity','.28');
  const s2=document.createElementNS(ns,'stop');
  s2.setAttribute('offset','100%');s2.setAttribute('stop-color','#e9bd5b');s2.setAttribute('stop-opacity','0');
  grad.appendChild(s1);grad.appendChild(s2);
  defs.appendChild(grad);

  const coords=points.map(p=>[x(p.t),y(p.c)]);

  const lineD=coords.map((c,i)=>(i?'L':'M')+c[0].toFixed(2)+' '+c[1].toFixed(2)).join(' ');
  const areaD=lineD+
    ' L '+coords[coords.length-1][0].toFixed(2)+' '+(pad.t+plotH)+
    ' L '+coords[0][0].toFixed(2)+' '+(pad.t+plotH)+' Z';

  add('path',{d:areaD,fill:'url(#chartFill)'});

  add('path',{
    d:lineD,
    fill:'none',
    stroke:'#efc660',
    'stroke-width':'2.2',
    'stroke-linecap':'round',
    'stroke-linejoin':'round',
    'vector-effect':'non-scaling-stroke'
  });

  // Small points only where sampled.
  coords.forEach(([cx,cy],i)=>{
    add('circle',{
      cx,cy,r:i===coords.length-1?'3.6':'2',
      fill:i===coords.length-1?'#f5d783':'#e9bd5b',
      stroke:'#111318','stroke-width':'1.5',
      'vector-effect':'non-scaling-stroke'
    });
  });

  // 6M change.
  const first=points[0].c,last=points[points.length-1].c;
  const pct=((last/first)-1)*100;
  const ch=$('chartChange');
  ch.textContent=(pct>=0?'+':'')+pct.toFixed(1)+'%';
  ch.className='chart-change '+(pct>=0?'up':'down');

  // Keep rendered geometry for touch lookup.
  svg._chartData={points,coords,W,H,pad};
  bindChartInteraction();
}

function bindChartInteraction(){
  const wrap=$('chartWrap');
  const svg=$('goldChart');
  const tip=$('chartTooltip');

  if(wrap.dataset.bound==='1') return;
  wrap.dataset.bound='1';

  const interact=e=>{
    if(!svg._chartData) return;
    const rect=svg.getBoundingClientRect();
    const clientX=e.touches?e.touches[0].clientX:e.clientX;
    const px=(clientX-rect.left)/rect.width*340;

    let idx=0,best=Infinity;
    svg._chartData.coords.forEach((c,i)=>{
      const dist=Math.abs(c[0]-px);
      if(dist<best){best=dist;idx=i}
    });

    const p=svg._chartData.points[idx];
    const c=svg._chartData.coords[idx];

    tip.innerHTML=
      '<strong>$'+fmt2(p.c)+'/oz</strong>'+
      new Date(p.d+'T12:00:00Z').toLocaleDateString('en-US',{
        month:'short',day:'numeric',year:'numeric'
      });

    const left=c[0]/340*rect.width;
    const top=c[1]/230*rect.height;

    tip.style.left=Math.min(rect.width-55,Math.max(55,left))+'px';
    tip.style.top=Math.max(42,top)+'px';
    tip.hidden=false;
  };

  wrap.addEventListener('touchstart',interact,{passive:true});
  wrap.addEventListener('touchmove',interact,{passive:true});
  wrap.addEventListener('mousemove',interact);
  wrap.addEventListener('mouseleave',()=>tip.hidden=true);
  wrap.addEventListener('touchend',()=>setTimeout(()=>tip.hidden=true,700),{passive:true});
}

let historyPending=false;
async function refreshHistory(force=false){
  if(historyPending) return;
  if(!navigator.onLine){
    if(state.history) renderChart(getRangePoints(state.history,state.selectedRange||'6M'));
    else { $('chartLoading').textContent='Offline · connect to load chart history.'; }
    setDiag('diagHistory',state.history?'Cached':'Offline','warn');
    return;
  }
  const loading=$('chartLoading');

  if(!force && state.history && state.historyAt &&
     Date.now()-state.historyAt < HISTORY_REFRESH_MS){
    setDiag('diagHistory','Cached','warn');
    renderChart(getRangePoints(state.history,state.selectedRange||'6M'));
    if(state.historySource){
      $('historySource').textContent='History source · '+state.historySource;
    }
    return;
  }

  if(state.history){
    renderChart(getRangePoints(state.history,state.selectedRange||'6M'));
    $('historySource').textContent='History source · '+(state.historySource||'saved history')+' · saved chart, updating…';
  }else if(loading){
    loading.className='chart-loading';
    loading.style.display='flex';
    loading.textContent='Loading chart history…';
  }

  historyPending=true;
  setDiag('diagHistory',state.history?'Updating saved chart…':'Loading…','warn');

  try{
    const result=await fetchHistory();

    state.history=result.points;
    state.historySource=result.source;
    state.historyAt=Date.now();

    save();

    setDiag('diagHistory','Live','ok');

    if($('historySource')){
      $('historySource').textContent='History source · '+result.source;
    }

    renderChart(getRangePoints(result.points,state.selectedRange||'6M'));

  }catch(e){
    console.warn('History failed',e);

    if(state.history){
      setDiag('diagHistory','Cached','warn');

      if(state.historySource && $('historySource')){
        $('historySource').textContent='History source · '+state.historySource+' · cached';
      }

      renderChart(getRangePoints(state.history,state.selectedRange||'6M'));

    }else if(loading){
      setDiag('diagHistory','Unavailable','bad');
      loading.className='chart-loading error';
      loading.style.display='flex';
      loading.textContent='History feed could not load. Tap Refresh to retry.';
    }
  }finally{historyPending=false;}
}

/* ---------- RENDER ---------- */

function render(){
  if(state.us){
    $('usPrice').innerHTML='$'+fmt2(state.us)+' <span class="unit">USD / g</span>';
    $('usSource').textContent='International 24K spot · Gold-API';
  }

  if(state.usOz){
    $('usOz').textContent='$'+fmt2(state.usOz)+' USD / troy oz';
  }

  if(state.eg){
    $('egPrice').innerHTML=fmt2(state.eg)+' <span class="unit">EGP / g</span>';
    $('egSource').textContent='iSagha · published 24K selling price';
  }

  if(state.fx){
    $('fx').textContent=fmt3(state.fx);
    $('diagFXMethod').textContent='Frankfurter · CBE official provider'+
      (state.fxDate?' · '+state.fxDate:'');

    if(state.eg){
      const egUSD=state.eg/state.fx;
      $('egUsd').textContent='$'+fmt2(egUSD)+' USD / g';

      if(state.us){
        const p=((egUSD/state.us)-1)*100;
        $('premium').textContent=(p>=0?'+':'')+p.toFixed(2)+'%';
        $('premium').className='value '+(p>=0?'gold':'blue');
      }
    }
  }
}

function timeText(){
  return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}

async function refreshAll(){
  const btn=$('refresh');
  if(btn.disabled) return;
  if(!navigator.onLine){updateFreshness(false); return;}
  btn.disabled=true;
  btn.textContent='Updating…';
  $('status').textContent='Refreshing live prices…';

  setDiag('diagUS','Loading…','warn');
  setDiag('diagEG','Loading…','warn');
  setDiag('diagFX','Loading…','warn');
  setDiag('diagFXMethod','Frankfurter · CBE','');

  let usOK=false,egOK=false,fxOK=false;

  const pUS=(async()=>{
    try{
      const d=await fetchUS();
      state.us=d.gram;
      state.usOz=d.oz;
      usOK=true;
      state.fetchedAt.us=Date.now();
      setDiag('diagUS','Live','ok');
      render();save();
    }catch(e){
      console.warn(e);
      setDiag('diagUS',state.us?'Cached':'Unavailable',state.us?'warn':'bad');
    }
  })();

  const pEG=(async()=>{
    try{
      const d=await fetchEgypt();
      state.eg=d.eg24;
      egOK=true;
      state.fetchedAt.eg=Date.now();
      setDiag('diagEG','Live','ok');
      render();save();
    }catch(e){
      console.warn(e);
      setDiag('diagEG',state.eg?'Cached':'Unavailable',state.eg?'warn':'bad');
    }
  })();

  const pFX=(async()=>{
    try{
      const d=await fetchCBEFx();
      state.fx=d.rate;
      state.fxDate=d.date;
      fxOK=true;
      state.fetchedAt.fx=Date.now();
      setDiag('diagFX','Live','ok');
      setDiag(
        'diagFXMethod',
        'Frankfurter · CBE official provider'+(d.date?' · '+d.date:''),
        ''
      );
      render();save();
    }catch(e){
      console.warn(e);
      setDiag('diagFX',state.fx?'Cached':'Unavailable',state.fx?'warn':'bad');
      setDiag(
        'diagFXMethod',
        state.fx
          ? 'Last successful CBE API reading'+(state.fxDate?' · '+state.fxDate:'')
          : 'CBE API unavailable',
        state.fx?'warn':'bad'
      );
    }
  })();

  // History refresh is separate: it can never block the current prices.
  refreshHistory(false);

  await Promise.all([pUS,pEG,pFX]);

  if((usOK||state.us)&&(egOK||state.eg)&&(fxOK||state.fx)){
    if(usOK&&egOK&&fxOK) state.lastOK=Date.now();
    save();

    const allLive=usOK&&egOK&&fxOK;

    $('status').innerHTML=allLive
      ? '<strong>Updated '+timeText()+'</strong> · all required values live.'
      : '<strong>Updated '+timeText()+'</strong> · one feed is using its last successful API reading.';
  }else{
    $('status').innerHTML='<span class="bad">A required value is unavailable. Tap Diagnostics to see which feed failed.</span>';
  }

  updateFreshness(usOK&&egOK&&fxOK);
  btn.disabled=false;
  btn.textContent='Refresh';
}

function toggleDiag(){
  $('diag').hidden=!$('diag').hidden;
}

function updateFreshness(allLive=false){
  const offline=!navigator.onLine;
  const live=allLive&&!offline;
  $('liveLabel').textContent=offline?'OFFLINE':live?'LIVE':'CACHED';
  $('liveIndicator').classList.toggle('stale',!live);
  const notice=$('connectionNotice');
  notice.hidden=live;
  const dates=Object.values(state.fetchedAt||{}).filter(Number.isFinite);
  const stamp=dates.length?new Date(Math.min(...dates)).toLocaleString():null;
  notice.textContent=(offline?'Offline. ':'Some feeds have not refreshed. ')+
    (state.us||state.eg||state.fx?'Showing last-known readings'+(stamp?' · oldest fetched '+stamp:' · fetch time unknown')+'.':'Connect to load prices.');
  if(!live) $('status').textContent=notice.textContent;
}
window.addEventListener('offline',()=>updateFreshness(false));
window.addEventListener('online',()=>refreshAll());
load();
updateRangeLabels(state.selectedRange||'6M');
document.querySelectorAll('.range-btn').forEach(btn=>{
  btn.classList.toggle('active',btn.dataset.range===(state.selectedRange||'6M'));
});
refreshAll();

setInterval(refreshAll,REFRESH_MS);

document.addEventListener('visibilitychange',()=>{
  if(!document.hidden){
    if(!state.lastOK||Date.now()-state.lastOK>REFRESH_MS) refreshAll();
    if(!state.historyAt||Date.now()-state.historyAt>HISTORY_REFRESH_MS) refreshHistory(false);
  }
});
