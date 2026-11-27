// Descriptive sample statistics, not causal estimates or consumer rankings.
export function wilson(success,n){if(!n)return null;const z=1.96,p=success/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return [Math.max(0,c-h),Math.min(1,c+h)]}
function arr(v){try{const x=JSON.parse(v||"[]");return Array.isArray(x)?x:[]}catch{return []}}
export function analyze(rows){
 const groups=new Map();
 for(const r of rows){const key=JSON.stringify([r.prompt_id,r.provider,r.model]);let g=groups.get(key);if(!g){g={promptId:r.prompt_id,question:r.question,provider:r.provider,model:r.model,attempts:0,valid:0,brand:0,competitors:new Map(),sources:new Map(),missing:[]};groups.set(key,g)}g.attempts++;if(r.status!=="success")continue;g.valid++;g.brand+=Number(r.mentioned===1);
  const hits=[...new Set(arr(r.competitor_hits).filter(x=>typeof x==="string"))];
  for(const c of hits)g.competitors.set(c,(g.competitors.get(c)||0)+1);
  if(r.mentioned!==1&&hits.length&&g.missing.length<5)g.missing.push(r.id);
  const hosts=new Set();for(const u of arr(r.citations)){try{const url=new URL(u);if(["http:","https:"].includes(url.protocol))hosts.add(url.hostname)}catch{}}
  for(const host of hosts)g.sources.set(host,(g.sources.get(host)||0)+1);
 }
 return [...groups.values()].map(g=>{const rate=g.valid?g.brand/g.valid:null;const competitors=[...g.competitors].map(([name,count])=>({name,count,rate:count/g.valid})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name));
  const sources=[...g.sources].map(([host,count])=>({host,count})).sort((a,b)=>b.count-a.count||a.host.localeCompare(b.host));
  const gap=g.valid>=10&&competitors[0]&&competitors[0].rate-rate>=.2?{type:"investigate-mention-gap",competitor:competitors[0].name,delta:competitors[0].rate-rate,sampleIds:g.missing,action:"核查原始回答与竞品信源；确认实体、语境和事实后再制定内容任务。非因果结论。"}:null;
  return {promptId:g.promptId,question:g.question,provider:g.provider,model:g.model,attempts:g.attempts,valid:g.valid,mentionRate:rate,interval95:wilson(g.brand,g.valid),competitors,sources,opportunity:gap};
 });
}
