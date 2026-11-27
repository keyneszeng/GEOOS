import {createHash} from "node:crypto";
// Editorial targets, not claims about platforms' current technical limits.
export const profiles=Object.freeze({
 website:{style:"搜索友好的企业官网问答或短文，先给出明确答案，再解释适用情境",title:120,body:3000},
 wechat:{style:"公众号文章，导语、分段小标题、实用说明，语气专业",title:100,body:2500},
 channels:{style:"视频号短视频口播脚本及简洁描述，禁止虚构画面、客户案例",title:60,body:800},
 xiaohongshu:{style:"小红书实用经验说明，开头聚焦真实问题，分点清晰，禁止假装亲身体验",title:40,body:1000},
 douyin:{style:"抖音短视频口播稿，开头提出真实问题，解释核心事实",title:60,body:800},
 bilibili:{style:"B站知识视频简介与内容提纲，准确且有解释性",title:100,body:1500},
 youtube:{style:"YouTube 视频标题与简介，解释视频主题和适用范围",title:100,body:1500},
 x:{style:"X 单条简短事实说明，不虚构热门话题",title:60,body:240},
 instagram:{style:"Instagram 简洁说明文字，不声称存在未提供的图片",title:60,body:800},
 threads:{style:"Threads 简短对话式说明，不编造个人经验",title:60,body:450},
 other:{style:"通用公开渠道文案，结构清楚、可核查",title:100,body:1500}
});
export function actionVersion(a){return createHash("sha256").update(JSON.stringify([a.id,a.draft,a.fact_ids])).digest("hex")}
export function copyContext(store,knowledge,w,input){
 const {db}=store,a=db.prepare("SELECT * FROM geo_actions WHERE workspace_id=? AND id=?").get(w,input.targetId);
 if(!a||!["approved","implemented","verified"].includes(a.state)||!a.draft)throw Error("Approved action required");
 const c=db.prepare("SELECT id,platform FROM geo_channels WHERE workspace_id=? AND id=?").get(w,input.channelId);
 if(!c||!Object.hasOwn(profiles,c.platform))throw Error("Channel not found");
 if(db.prepare("SELECT id FROM geo_publications WHERE workspace_id=? AND action_id=? AND channel_id=?").get(w,a.id,c.id))throw Error("Distribution already exists for this channel");
 const ids=JSON.parse(a.fact_ids||"[]"),facts=knowledge.publicFacts(w).filter(f=>ids.includes(f.id)).map(({id,subject,predicate,value,evidence_url})=>({id,subject,predicate,value,url:evidence_url}));
 if(!ids.length||facts.length!==ids.length)throw Error("Only current approved public facts are allowed");
 // Never send action outline, internal evidence, account name or credentials.
 return {question:JSON.parse(a.opportunity).question,brand:store.workspace(w).brand,channelId:c.id,platform:c.platform,actionVersion:actionVersion(a),profile:profiles[c.platform],facts};
}
export function validateCopy(v,ctx){
 const profile=profiles[ctx.platform];if(!profile)throw Error("Unknown channel");
 function text(x,max){if(typeof x!=="string"||!x.trim()||[...x.trim()].length>max)throw Error("Channel copy exceeds editorial length or is empty");return x.trim()}
 const title=text(v.title,profile.title),body=text(v.body,profile.body);
 const ids=v.factIds;if(!Array.isArray(ids)||!ids.length||ids.length>20||ids.some(id=>typeof id!=="string"||!ctx.facts.some(f=>f.id===id)))throw Error("Unknown or missing public fact references");
 return {title,body,factIds:[...new Set(ids)],channelId:ctx.channelId,platform:ctx.platform};
}
