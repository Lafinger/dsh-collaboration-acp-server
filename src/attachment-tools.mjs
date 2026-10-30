import { defineTool } from '@deepseek-ai/dsh-tools';
const output={schema:{type:'json'},render:(_args,value)=>{const {image,...text}=value??{};return [{type:'text',text:JSON.stringify(image?text:value)},...(image?[{type:'image',attachment:image}]:[])];}};
export function registerAttachmentTools(ctx,service,{sessionId,account,authorize,vision}){
  const tool=(name,description,parameters,execute)=>ctx.tools.register(defineTool({name,description,parameters,output,execute:async (args,exec)=>{
    try{authorize?.(name,args);const result=await execute(args,exec.signal);authorize?.(name,args);return result;}catch(error){return {ok:false,error:{code:error.code??'ATTACHMENT_FAILED',message:error.message,...(error.details===undefined?{}:{details:error.details})}};}
  },presentCall:()=>({card:'generic',title:name,kind:'other'})}));
  service.vision=vision;
  tool('attachment_read','Read the full content of one uploaded attachment in this session. The handle comes from the attachment list bound to the message. Text returns inline; images return a bounded image copy (never claim you have seen an image before reading it here).',{handle:{type:'string',required:true}},(args,signal)=>service.read(sessionId,account,args.handle));
  tool('attachment_archive','Archive one uploaded attachment as a new material version of the session-bound project. The material name is the original filename; archiving again creates another version. purpose describes what the material is for; omit role unless a specific role clearly owns it. Does not assign members, approve plans, or create tasks.',{
    handle:{type:'string',required:true},purpose:{type:'string',required:true},role:{type:'string',enum:['pm','product','design','scenemodel','sceneart','data','frontend','backend','ue']},
  },args=>service.archive(sessionId,account,{handle:args.handle,purpose:args.purpose,role:args.role},()=>authorize?.('attachment_archive',args)));
}
