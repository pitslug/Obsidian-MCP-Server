import { createServer } from "node:http";
import { composeWrite } from "./src/vault-model/compose.js";
import { resolveSettings } from "./src/vault-model/settings.js";
const S = resolveSettings({ customChunkSize: 60 });
const docs = new Map();
docs.set("_local/obsydian_livesync_milestone", {_id:"_local/obsydian_livesync_milestone",type:"milestoneinfo",created:1,accepted_nodes:[],node_info:{},locked:false,node_chunk_info:{},tweak_values:{deviceA:{encrypt:false,usePathObfuscation:false,enableCompression:false,hashAlg:"xxhash64",chunkSplitterVersion:"v3-rabin-karp",handleFilenameCaseSensitive:false,minimumChunkSize:20,customChunkSize:60}}});
docs.set("obsydian_livesync_version",{_id:"obsydian_livesync_version",type:"versioninfo",version:12});
for (const [p,t] of [["daily/2026-07-28.md","# Today\n\n- [ ] a task\n"],["projects/big.md","x".repeat(9000)],["notes/unicode.md","日本語 👋 café\n".repeat(200)]]) {
  const c = await composeWrite(p,{kind:"text",text:t},{settings:S,now:1700000000000});
  docs.set(String(c.entry._id),{...c.entry,_rev:"1-a"});
  for (const ch of c.chunks) docs.set(String(ch._id),{...ch,_rev:"1-b"});
}
const srv = createServer((req,res)=>{
  const u = new URL(req.url,"http://x");
  const seg = u.pathname.split("/").filter(Boolean);
  const j=(b,s=200)=>{res.writeHead(s,{"content-type":"application/json"});res.end(JSON.stringify(b));};
  if(seg.length===1) return j({db_name:seg[0],doc_count:docs.size});
  if(seg[1]==="_all_docs"){
    const kp=u.searchParams.get("keys");
    if(kp) return j({rows:JSON.parse(kp).map(id=>docs.has(id)?{id,doc:docs.get(id)}:{key:id,error:"nf"})});
    const sk=JSON.parse(u.searchParams.get("startkey")??'""'), ek=JSON.parse(u.searchParams.get("endkey")??'"￿"');
    const lim=Number(u.searchParams.get("limit")??100);
    return j({rows:[...docs.entries()].filter(([i])=>i>=sk&&i<=ek).sort(([a],[b])=>a<b?-1:1).slice(0,lim).map(([id,doc])=>({id,doc}))});
  }
  const id=decodeURIComponent(seg.slice(1).join("/"));
  return docs.has(id)?j(docs.get(id)):j({error:"nf"},404);
});
srv.listen(0,"127.0.0.1",()=>{ console.log("PORT="+srv.address().port); });
