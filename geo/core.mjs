export function normalize(s){return String(s??"").normalize("NFKC").toLowerCase().trim()}

export function mentions(answer,aliases){const t=normalize(answer);return aliases.some(v=>{const a=normalize(v);if(!a)return false;if(/^[a-z0-9][a-z0-9 ._-]*$/i.test(a)){const e=a.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");return new RegExp("(^|[^a-z0-9])"+e+"(?=$|[^a-z0-9])","i").test(t)}return t.includes(a)})}

export function metrics(rows){const groups=new Map();for(const r of rows){const key=JSON.stringify([r.provider,r.model]);const g=groups.get(key)||{provider:r.provider,model:r.model,total:0,valid:0,mentioned:0,cited:0};g.total++;if(r.status==="success"){g.valid++;g.mentioned+=Number(r.mentioned===1);g.cited+=Number(r.citation_count>0)}groups.set(key,g)}return [...groups.values()].map(g=>({...g,mentionRate:g.valid?g.mentioned/g.valid:null,citationPresenceRate:g.valid?g.cited/g.valid:null}))}
export function validUrls(values){return [...new Set(values.filter(v=>typeof v==="string").flatMap(v=>{try{const u=new URL(v);return ["https:","http:"].includes(u.protocol)&&!u.username&&!u.password?[u.href]:[]}catch{return []}}))]}
export function parseProvider(provider,data){
 if(provider==="deepseek"){const answer=data.choices?.[0]?.message?.content;if(typeof answer!=="string"||!answer.trim()||data.choices?.[0]?.finish_reason!=="stop")throw Error("Incomplete or empty answer");return {answer,model:data.model||"unknown",citations:[],sources:[],usage:data.usage??null}}
 if(provider==="perplexity"){if(data.status!=="completed")throw Error("Incomplete agent response");const parts=(data.output??[]).filter(x=>x.type==="message"&&x.role==="assistant").flatMap(x=>x.content??[]).filter(x=>x.type==="output_text");const answer=parts.map(x=>x.text).join("\n").trim();if(!answer)throw Error("Empty answer");return {answer,model:data.model||"unknown",citations:validUrls(parts.flatMap(x=>(x.annotations??[]).filter(a=>a.type==="url_citation").map(a=>a.url??a.url_citation?.url))),sources:validUrls((data.output??[]).filter(x=>x.type==="search_results").flatMap(x=>(x.results??[]).map(r=>r.url))),usage:data.usage??null}}
 if(provider==="openai"||provider==="openai-web"){
  if(data.status!=="completed")throw Error("Incomplete response");
  const output=data.output??[],messages=output.filter(x=>x.type==="message"&&x.role==="assistant");
  if(messages.some(m=>m.status!=="completed"||(m.content??[]).some(c=>c.type==="refusal")))throw Error("Incomplete or refused response");
  const parts=messages.flatMap(x=>x.content??[]).filter(x=>x.type==="output_text");
  const answer=parts.map(x=>typeof x.text==="string"?x.text:"").join("\n").trim();if(!answer)throw Error("Empty response");
  const searches=output.filter(x=>x.type==="web_search_call"&&x.status==="completed");
  if(provider==="openai-web"&&!searches.length)throw Error("Expected completed search");
  return {answer,model:data.model||"unknown",citations:validUrls(parts.flatMap(x=>(x.annotations??[]).filter(a=>a.type==="url_citation").map(a=>a.url))),sources:validUrls(searches.flatMap(x=>(x.action?.sources??[]).map(s=>s.url))),usage:data.usage??null};
 }
 if(provider==="gemini"){
  const c=data.candidates?.[0];if(c?.finishReason!=="STOP")throw Error("Incomplete or blocked response");
  const answer=(c.content?.parts??[]).filter(p=>p.thought!==true&&typeof p.text==="string").map(p=>p.text).join("\n").trim();if(!answer)throw Error("Empty response");
  // Citation metadata is distinct from a search-grounding result; this profile does not enable search.
  return {answer,model:data.modelVersion||"unknown",citations:validUrls((c.citationMetadata?.citationSources??[]).map(s=>s.uri)),sources:[],usage:data.usageMetadata??null};
 }
 throw Error("Unsupported provider");
}
