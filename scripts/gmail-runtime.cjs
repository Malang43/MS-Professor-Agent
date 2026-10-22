// Exercise native Workers fetch with intercepted outbound traffic only.
const assert=require('node:assert/strict');
const {build}=require('esbuild');
const {Miniflare,convertV4MiniflareOptions}=require(require.resolve('miniflare',{paths:[require.resolve('wrangler/package.json')]}));
(async()=>{
 const code=`import {emailProvider,providerRequest} from './apps/api/src/providers';export default {async fetch(){
 const p=emailProvider('gmail');
 const sent=await p.send('synthetic',{recipient:'controlled@example.invalid',subject:'Exact runtime test',body:'Synthetic only',messageKey:'runtime@ms-professor-agent.invalid',threadId:'original-thread',inReplyTo:'original@ms-professor-agent.invalid',attachments:[]});
 const replies=await p.replies('synthetic','original-thread');
 const refreshed=await providerRequest('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',refresh_token:'synthetic'})});
 return Response.json({sent,replies:replies.events.length,refresh:refreshed.access_token==='synthetic-refreshed'});}}`;
 const bundled=await build({stdin:{contents:code,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'});
 const calls=[];
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-10-01',outboundService:async(req)=>{
  calls.push(req.url);
  if(req.url==='https://gmail.googleapis.com/gmail/v1/users/me/messages/send'){
   const body=await req.json();assert.equal(body.threadId,'original-thread');const mime=Buffer.from(body.raw,'base64url').toString();assert.match(mime,/To: controlled@example.invalid/);assert.match(mime,/In-Reply-To: <original@ms-professor-agent.invalid>/);return Response.json({id:'synthetic-accepted',threadId:'original-thread'});
  }
  if(req.url.includes('/threads/'))return Response.json({messages:[]});
  if(req.url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic-refreshed',expires_in:3600});
  throw new Error('Unexpected outbound request');
 }}));
 try {const response=await mf.dispatchFetch('http://localhost/runtime-test');assert.equal(response.status,200);assert.deepEqual(await response.json(),{sent:{id:'synthetic-accepted',threadId:'original-thread'},replies:0,refresh:true});assert.equal(calls.length,3);console.log('PASS native Workers runtime: Gmail send, threading, reply read and token HTTP with all outbound traffic intercepted. No real network mail.');}finally{await mf.dispose();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
