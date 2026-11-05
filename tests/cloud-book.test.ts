import test from 'node:test';
import assert from 'node:assert/strict';
import dataWorker from '../cloud/data-worker/worker.js';
import { planBook, inspectBook, restoreBook } from '../cloud/data-worker/book-format.js';
import { signDataToken } from '../src/server/cloud/crypto.ts';
import { SQLiteD1 } from './helpers/d1.ts';

interface TestResponseBody {
 status: number; revision: number; rootHash: string; errors: number;
 lease: {id:string}; missing:string[]; blocks:Array<Awaited<ReturnType<typeof import('../cloud/data-worker/book-format.js').encodeBlock>>>;
 head:{rootHash:string;readerId:string}; overrides:unknown[];
}
async function harness() {
  const db = new SQLiteD1();
  const env = { DB: db, DATA_WORKER_VERSION: '5', STORAGE_MODE: 'd1', INSTALLATION_ID: 'installation-book-v2', DATA_SIGNING_SECRET: 'book-contract-secret', ALLOWED_ORIGIN: 'https://canvas.example' };
  const token = await signDataToken({sub:'user-book',aud:env.INSTALLATION_ID,installationId:env.INSTALLATION_ID,scope:['projects:read','projects:write']},env.DATA_SIGNING_SECRET,600);
  const request = async (path: string, method='GET', body?: unknown) => {
    const response = await dataWorker.fetch(new Request(`https://data.example${path}`,{method,headers:{authorization:`Bearer ${token.token}`,origin:env.ALLOWED_ORIGIN,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
    return {status:response.status,body:await response.json() as TestResponseBody};
  };
  await request('/v1/projects','POST',{id:'project-book-v2',name:'验证书籍'});
  const lease = await request('/v1/projects/project-book-v2/lease','POST',{deviceId:'device-book-v2'});
  const identity = {deviceId:'device-book-v2',leaseId:lease.body.lease.id};
  const prefix='/v2/projects/project-book-v2';
  let serial=0;
  const save = async (plan: Awaited<ReturnType<typeof planBook>>, baseRevision:number) => {
    const saveId=`save-book-${++serial}`;
    const staged=await request(`${prefix}/uploads`,'POST',{...identity,saveId,rootHash:plan.rootHash,hashes:plan.hashes,baseRevision});
    assert.equal(staged.status,200,JSON.stringify(staged));
    for(let offset=0;offset<staged.body.missing.length;offset+=16){
      const uploaded=await request(`${prefix}/blocks`,'PUT',{...identity,saveId,blocks:staged.body.missing.slice(offset,offset+16).map((hash:string)=>plan.blocks.get(hash))});
      assert.equal(uploaded.status,200,JSON.stringify(uploaded));
    }
    const result=await request(`${prefix}/commit`,'POST',{...identity,saveId});
    assert.equal(result.status,200,JSON.stringify(result));
    return {revision:Number(result.body.revision),rootHash:String(result.body.rootHash), saveId, uploaded:Number(staged.body.missing.length)};
  };
  return {db,env,request,identity,prefix,save};
}

const source=()=>({document:{revision:1,namespaces:{textNode:{node:{title:'正文',x:12,color:'#aa1111'}},textContentChunk:{chunk:{text:'大文本😀'.repeat(20_000)}},unknownPlugin:{opaque:{keep:true}}}},plugins:[{id:'unknown',version:'1',dataVersion:7,available:false,namespaces:['unknownPlugin']}]});

test('book v2 round trips Unicode, unknown records and appearance; incremental save only encodes changed values',async()=>{
  const h=await harness();
  const original=source();const plan=await planBook(original);
  const first=await h.save(plan,0);
  const updated={document:{revision:2,namespaces:{}},plugins:original.plugins};
  const next=await planBook(updated,plan,[{op:'set',domain:'document',namespace:'textNode',key:'node',value:{title:'正文',x:24,color:'#aa1111'}}]);
  assert.ok(![...next.blocks.values()].some(block=>block.rawBytes===64*1024),'unchanged large text is not re-encoded');
  const second=await h.save(next,first.revision);
  assert.ok(second.uploaded<first.uploaded);
  const head=await h.request(`${h.prefix}/head`);
  const get=async(hash:string)=>{
    const result=await h.request(`${h.prefix}/blocks`,'POST',{readerId:head.body.head.readerId,hashes:[hash]});
    assert.equal(result.status,200);return result.body.blocks[0];
  };
  const inspected=await inspectBook(head.body.head.rootHash,get);
  const restored=await restoreBook(inspected,get);
  original.document.namespaces.textNode.node.x=24;
  original.document.revision=2;
  assert.deepEqual(JSON.parse(JSON.stringify(restored)),original);
  const duplicate=await h.request(`${h.prefix}/commit`,'POST',{...h.identity,saveId:second.saveId});
  assert.equal(duplicate.body.revision,second.revision);
  assert.equal((await h.request('/v1/projects/project-book-v2/bootstrap')).status,426);
});

test('bad hashes, incomplete uploads, stale revisions and taken-over leases cannot replace the current book',async()=>{
  const h=await harness();const plan=await planBook(source());const first=await h.save(plan,0);
  const next=await planBook({document:{revision:2,namespaces:{new:{key:'changed'}}},plugins:[]});
  const saveId='save-incomplete';
  assert.equal((await h.request(`${h.prefix}/uploads`,'POST',{...h.identity,saveId,baseRevision:0,rootHash:next.rootHash,hashes:next.hashes})).status,409);
  const staged=await h.request(`${h.prefix}/uploads`,'POST',{...h.identity,saveId,baseRevision:first.revision,rootHash:next.rootHash,hashes:next.hashes});
  assert.equal(staged.status,200);
  const bad={...next.blocks.get(next.rootHash)!,data:'corrupted'};
  assert.equal((await h.request(`${h.prefix}/blocks`,'PUT',{...h.identity,saveId,blocks:[bad]})).status,400);
  assert.equal((await h.request(`${h.prefix}/commit`,'POST',{...h.identity,saveId})).status,409);
  await h.request('/v1/projects/project-book-v2/lease','POST',{deviceId:'other-device',takeover:true});
  assert.equal((await h.request(`${h.prefix}/blocks`,'PUT',{...h.identity,saveId,blocks:[next.blocks.get(next.rootHash)]})).status,423);
  const head=await h.request(`${h.prefix}/head`);assert.equal(head.body.head.rootHash,plan.rootHash);
});

test('maintenance protects active readers and uploads, removes old generations, and fully purges deleted books',async()=>{
  const h=await harness();const plan=await planBook(source());const first=await h.save(plan,0);
  const reading=await h.request(`${h.prefix}/head`);
  const next=await planBook({document:{revision:2,namespaces:{only:{current:'latest'}}},plugins:[]});
  await h.save(next,first.revision);
  h.db.sqlite.exec('UPDATE book_blocks SET updated_at=0');
  await h.request('/v2/maintenance','POST',{});
  const old=await h.request(`${h.prefix}/blocks`,'POST',{readerId:reading.body.head.readerId,hashes:[plan.rootHash]});
  assert.equal(old.body.blocks.length,1,'reader holds the previous generation until release');
  await h.request(`${h.prefix}/reads`,'DELETE',{readerId:reading.body.head.readerId});
  await h.request('/v2/maintenance','POST',{});
  assert.equal(h.db.sqlite.prepare('SELECT count(*) AS count FROM book_blocks WHERE hash=?').get(plan.rootHash)!.count,0);
  assert.ok(Number(h.db.sqlite.prepare('SELECT count(*) AS count FROM book_blocks').get()!.count)>0);
  await h.request('/v1/projects/project-book-v2','DELETE');
  await h.request('/v2/maintenance','POST',{});
  assert.equal(h.db.sqlite.prepare('SELECT count(*) AS count FROM projects').get()!.count,0);
  assert.equal(h.db.sqlite.prepare('SELECT count(*) AS count FROM book_blocks').get()!.count,0);
});

test('legacy migration verifies a restorable new book before collecting old snapshots and journal rows',async()=>{
  const h=await harness();
  const checkpoint={formatVersion:1,savedAt:1,document:{revision:1,namespaces:{textNode:{node:{title:'旧书籍',x:9}},textContentChunk:{}}},plugins:[],contentChunkIds:['chunk-legacy']};
  await h.request('/v1/projects/project-book-v2/chunks','POST',{...h.identity,chunks:[{id:'chunk-legacy',value:{text:'迁移内容😀'}}]});
  await h.request('/v1/projects/project-book-v2/sync','POST',{...h.identity,baseRevision:0,commits:[],checkpoint,chunks:[]});
  await h.request('/v1/projects/project-book-v2/lease','DELETE',h.identity);
  const result=await h.request('/v2/maintenance','POST',{});
  assert.equal(result.body.errors,0,JSON.stringify(result));
  const head=await h.request(`${h.prefix}/head`);assert.ok(head.body.head.rootHash);
  assert.equal(h.db.sqlite.prepare('SELECT count(*) AS count FROM checkpoint_parts').get()!.count,0);
  const get=async(hash:string)=>(await h.request(`${h.prefix}/blocks`,'POST',{readerId:head.body.head.readerId,hashes:[hash]})).body.blocks[0];
  const restored=await restoreBook(await inspectBook(head.body.head.rootHash,get),get);
  assert.deepEqual(restored.document.namespaces.textContentChunk['chunk-legacy'],{text:'迁移内容😀'});
});

test('shortcut account storage accepts only shortcut fields and uses revision preconditions',async()=>{
  const h=await harness();
  const overrides=[{targetOwner:'canvas',targetId:'canvas.focus',chord:'mod+shift+q'}];
  assert.equal((await h.request('/v2/shortcuts','PUT',{expectedRevision:0,overrides})).status,200);
  assert.equal((await h.request('/v2/shortcuts')).body.revision,1);
  assert.equal((await h.request('/v2/shortcuts','PUT',{expectedRevision:0,overrides:[]})).status,409);
  assert.equal((await h.request('/v2/shortcuts','PUT',{expectedRevision:1,overrides:[{...overrides[0],secret:'not-allowed'}]})).status,400);
  assert.equal((await h.request('/v2/shortcuts','PUT',{expectedRevision:1,overrides:[]})).status,200);
  assert.deepEqual((await h.request('/v2/shortcuts')).body.overrides,[]);
});

import {BookTransport} from '../src/plugins/cloud-sync/book-transport.ts';
test('browser transport bootstraps a real book and incrementally saves after releasing its reader',async()=>{
 const h=await harness();const initial=source();const plan=await planBook(initial);const first=await h.save(plan,0);
 const request=async<T>(path:string,init:RequestInit={})=>{
  const result=await h.request(path,init.method??'GET',init.body?JSON.parse(String(init.body)):undefined);
  assert.equal(result.status,200,JSON.stringify(result));return result.body as unknown as T;
 };
 const transport=new BookTransport(request);await transport.bootstrap('project-book-v2');
 initial.document.namespaces.textNode.node.x=777;initial.document.revision=2;
 const saved=await transport.save({projectId:'project-book-v2',baseRevision:first.revision,...h.identity,
  commits:[{id:'transaction-move',label:'move',timestamp:1,sourceMessageId:'test',historyAction:'record',forward:[{op:'set',domain:'document',namespace:'textNode',key:'node',value:initial.document.namespaces.textNode.node}],inverse:[]}],
  source:async()=>initial,catalog:async()=>initial.plugins,
 });
 assert.equal(saved.revision,2);
});

test('a lost cloud acknowledgement is recovered without losing edits made during the retry',async()=>{
 const h=await harness();const initial=source();const base=await h.save(await planBook(initial),0);
 let loseAck=true;
 const transport=new BookTransport(async<T>(path:string,init:RequestInit={})=>{
  const response=await h.request(path,init.method??'GET',init.body?JSON.parse(String(init.body)):undefined);
  assert.equal(response.status,200,JSON.stringify(response));
  if(path.endsWith('/commit')&&loseAck){loseAck=false;throw new Error('connection lost after commit');}
  return response.body as unknown as T;
 });
 await transport.bootstrap('project-book-v2');
 const change=(id:string,x:number):import('../src/protocols/state.ts').TransactionCommitRecord=>({id,label:'move',sourceMessageId:id,timestamp:1,historyAction:'record',forward:[{op:'set',domain:'document',namespace:'textNode',key:'node',value:{x}}],inverse:[]});
 const options={projectId:'project-book-v2',baseRevision:base.revision,...h.identity,source:async()=>initial,catalog:async()=>initial.plugins};
 await assert.rejects(transport.save({...options,commits:[change('first-change',2)]}),/connection lost/u);
 const recovered=await transport.save({...options,commits:[change('second-change',3)]});
 assert.deepEqual(recovered.acceptedIds,['first-change']);assert.equal(recovered.revision,2);
 const next=await transport.save({...options,baseRevision:recovered.revision,commits:[change('second-change',3)]});
 assert.deepEqual(next.acceptedIds,['second-change']);assert.equal(next.revision,3);
});

test('atomic head commit rolls back all reference changes if the final project update fails',async()=>{
 const h=await harness();const first=await h.save(await planBook(source()),0);
 const next=await planBook({document:{revision:2,namespaces:{only:{entry:'new'}}},plugins:[]});
 const saveId='save-rollback';
 await h.request(`${h.prefix}/uploads`,'POST',{...h.identity,saveId,baseRevision:first.revision,rootHash:next.rootHash,hashes:next.hashes});
 await h.request(`${h.prefix}/blocks`,'PUT',{...h.identity,saveId,blocks:[...next.blocks.values()]});
 h.db.sqlite.exec("CREATE TRIGGER simulate_disk_failure BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;");
 const rejected=await h.request(`${h.prefix}/commit`,'POST',{...h.identity,saveId});assert.equal(rejected.status,500);
 assert.equal(h.db.sqlite.prepare('SELECT revision FROM book_heads').get()!.revision,first.revision);
 h.db.sqlite.exec('DROP TRIGGER simulate_disk_failure');
 assert.equal((await h.request(`${h.prefix}/commit`,'POST',{...h.identity,saveId})).status,200);
});

test('an interrupted first upload expires and is reclaimed even before a book has a committed head',async()=>{
 const h=await harness();const plan=await planBook(source());const saveId='save-abandoned';
 await h.request(`${h.prefix}/uploads`,'POST',{...h.identity,saveId,baseRevision:0,rootHash:plan.rootHash,hashes:plan.hashes});
 await h.request(`${h.prefix}/blocks`,'PUT',{...h.identity,saveId,blocks:[...plan.blocks.values()].slice(0,1)});
 h.db.sqlite.exec('UPDATE book_uploads SET expires_at=0; UPDATE book_blocks SET updated_at=0');
 await h.request('/v2/maintenance','POST',{});
 assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS count FROM book_blocks').get()!.count,0);
 assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS count FROM projects').get()!.count,1);
});
