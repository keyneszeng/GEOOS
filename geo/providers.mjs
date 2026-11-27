import {parseProvider} from "./core.mjs";
export function configuredProviders(env=process.env){return [...(env.DEEPSEEK_API_KEY&&env.GEO_DEEPSEEK_MODEL?["deepseek"]:[]),...(env.PERPLEXITY_API_KEY?["perplexity"]:[])]}
export async function sample(provider,prompt,{env=process.env,request=fetch}={}){
 if(!configuredProviders(env).includes(provider))throw Error("Provider not configured");
 const ds=provider==="deepseek";
 const url=ds?"https://api.deepseek.com/chat/completions":"https://api.perplexity.ai/v1/agent";
 const key=ds?env.DEEPSEEK_API_KEY:env.PERPLEXITY_API_KEY;
 const body=ds?{model:env.GEO_DEEPSEEK_MODEL,messages:[{role:"user",content:prompt}],stream:false,max_tokens:2048}:{effort:"fast",input:prompt};
 const response=await request(url,{method:"POST",redirect:"error",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
 if(!response.ok){const e=Error("Provider HTTP "+response.status);e.retryable=response.status===429||response.status>=500;throw e}
 const raw=await response.json();return {...parseProvider(provider,raw),raw};
}
