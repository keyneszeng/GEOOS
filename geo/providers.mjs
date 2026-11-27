import {parseProvider} from "./core.mjs";
export const providerIds=["deepseek","perplexity","openai","openai-web","gemini"];
const modelId=v=>typeof v==="string"&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
export function configuredProviders(env=process.env){return [
 ...(env.DEEPSEEK_API_KEY&&modelId(env.GEO_DEEPSEEK_MODEL)?["deepseek"]:[]),
 ...(env.PERPLEXITY_API_KEY?["perplexity"]:[]),
 ...(env.OPENAI_API_KEY&&modelId(env.GEO_OPENAI_MODEL)?["openai"]:[]),
 ...(env.OPENAI_API_KEY&&modelId(env.GEO_OPENAI_WEB_MODEL)?["openai-web"]:[]),
 ...(env.GEMINI_API_KEY&&modelId(env.GEO_GEMINI_MODEL)?["gemini"]:[])
]}
export async function sample(provider,prompt,{env=process.env,request=fetch}={}){
 if(!configuredProviders(env).includes(provider))throw Error("Provider not configured");
 let url,key,body,headers={};
 if(provider==="deepseek"){url="https://api.deepseek.com/chat/completions";key=env.DEEPSEEK_API_KEY;body={model:env.GEO_DEEPSEEK_MODEL,messages:[{role:"user",content:prompt}],stream:false,max_tokens:2048}}
 else if(provider==="perplexity"){url="https://api.perplexity.ai/v1/agent";key=env.PERPLEXITY_API_KEY;body={effort:"fast",input:prompt}}
 else if(provider==="gemini"){url="https://generativelanguage.googleapis.com/v1beta/models/"+env.GEO_GEMINI_MODEL+":generateContent";headers["x-goog-api-key"]=env.GEMINI_API_KEY;body={contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:4096,candidateCount:1}}}
 else{url="https://api.openai.com/v1/responses";key=env.OPENAI_API_KEY;body={model:provider==="openai-web"?env.GEO_OPENAI_WEB_MODEL:env.GEO_OPENAI_MODEL,input:prompt,max_output_tokens:4096,store:false,...(provider==="openai-web"?{tools:[{type:"web_search"}],tool_choice:"required",include:["web_search_call.action.sources"]}:{})}}
 if(key)headers.Authorization="Bearer "+key;
 const response=await request(url,{method:"POST",redirect:"error",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
 if(!response.ok){const e=Error("Provider HTTP "+response.status);e.retryable=response.status===429||response.status>=500;throw e}
 const raw=await response.json();return {...parseProvider(provider,raw),raw};
}
