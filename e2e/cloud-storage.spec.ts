import { test, expect, type Page } from '@playwright/test';
import dataWorker from '../cloud/data-worker/worker.js';
import { SQLiteD1 } from '../tests/helpers/d1.ts';
import { signDataToken } from '../src/server/cloud/crypto.ts';
import { planBook } from '../cloud/data-worker/book-format.js';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import { serializeProject } from '../src/plugins/import-export/codec.ts';

async function command(page:Page,label:string){
  await page.getByRole('button',{name:'命令面板',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'命令面板'});
  await panel.getByRole('textbox',{name:'搜索命令'}).fill(label);
  await panel.getByRole('option',{name:new RegExp(`^${label}`,'u')}).first().click();
}

async function cloud(page:Page){
  const db=new SQLiteD1();
  const env={DB:db,DATA_WORKER_VERSION:'7',STORAGE_MODE:'d1',INSTALLATION_ID:'installation-e2e-book',DATA_SIGNING_SECRET:'e2e-book-secret',ALLOWED_ORIGIN:'http://localhost:3000'};
  const token=await signDataToken({sub:'user-e2e-book',aud:env.INSTALLATION_ID,installationId:env.INSTALLATION_ID,scope:['projects:read','projects:write']},env.DATA_SIGNING_SECRET,600);
  const fetch=async(path:string,method='GET',body?:unknown)=>dataWorker.fetch(new Request('https://book-data.test'+path,{method,headers:{authorization:`Bearer ${token.token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  await fetch('/v1/projects','POST',{id:'project-e2e-book',name:'分块保存测试'});
  const lease=await (await fetch('/v1/projects/project-e2e-book/lease','POST',{deviceId:'seed-device'})).json() as {lease:{id:string}};
  const content=createContentStorage('content-book-e2e','保留的大段正文'.repeat(20_000),1);
  const textContentChunk:Record<string,unknown>={};
  for(const patch of content.chunkPatches)if(patch.op==='set')textContentChunk[patch.key]=patch.value;
  const source={document:{revision:1,namespaces:{textNode:{node:{id:'node',contentId:'content-book-e2e',title:'跨设备节点',x:100,y:120,width:260,height:146,titleColor:'#e95e61',revision:1,createdAt:1,updatedAt:1}},textContent:{'content-book-e2e':content.content},textContentChunk}},plugins:[{id:'text-node',version:'0.1.0',dataVersion:2,namespaces:['textNode','textContent','textContentChunk','textFormat','textFormatMark'],available:true}]};
  const plan=await planBook(source);
  const identity={saveId:'seed-save-e2e',deviceId:'seed-device',leaseId:lease.lease.id};
  await fetch('/v2/projects/project-e2e-book/uploads','POST',{...identity,rootHash:plan.rootHash,hashes:plan.hashes,baseRevision:0});
  const blocks=[...plan.blocks.values()];
  for(let offset=0;offset<blocks.length;offset+=16)await fetch('/v2/projects/project-e2e-book/blocks','PUT',{...identity,blocks:blocks.slice(offset,offset+16)});
  const saved=await fetch('/v2/projects/project-e2e-book/commit','POST',identity);
  expect(saved.status).toBe(200);
  await fetch('/v1/projects/project-e2e-book/lease','DELETE',identity);
  await page.route('**/api/cloud/status',route=>route.fulfill({json:{configured:true,authenticated:true,user:{id:'user-e2e-book',email:'reader@example.test'},accounts:[],installations:[{id:env.INSTALLATION_ID,accountId:'account-test',accountName:'测试账户',workerUrl:'https://book-data.test',workerVersion:7,latestWorkerVersion:7,upgradeAvailable:false,status:'ready'}]}}));
  await page.route('**/api/cloud/token',route=>route.fulfill({json:{installationId:env.INSTALLATION_ID,workerUrl:'https://book-data.test',token:token.token,expiresAt:Date.now()+600_000}}));
  let uploadedRaw=0,holds=false,release=()=>{};
  let held=Promise.resolve();
  await page.route('https://book-data.test/**',async route=>{
    const request=route.request();const path=new URL(request.url()).pathname;
    if(path.endsWith('/blocks')&&request.method()==='PUT'){
      const body=request.postDataJSON() as {blocks:Array<{rawBytes:number}>};
      uploadedRaw+=body.blocks.reduce((sum,block)=>sum+block.rawBytes,0);
    }
    if(holds&&path.endsWith('/commit')){holds=false;held=new Promise<void>(resolve=>{release=resolve;});await held;}
    const response=await dataWorker.fetch(new Request(request.url(),{method:request.method(),headers:request.headers(),...(['GET','HEAD'].includes(request.method())?{}:{body:request.postData()??undefined})}),env);
    const responseText=await response.text();await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:responseText});
  });
  return {db,source,uploaded:()=>uploadedRaw,hold:()=>{holds=true;},release:()=>release(),fetch};
}

for (const failFirstUpload of [false, true]) test(`a local book is saved as a separate named cloud book${failFirstUpload ? ' after a failed upload is retried' : ''}`, async ({ page }) => {
  const backend = await cloud(page);
  const original = await serializeProject(backend.source);
  await page.goto('/');
  const library = page.getByRole('region', { name: 'Echo-8 书库' });
  await expect(library.getByRole('button', { name: '打开书籍：分块保存测试', exact: true })).toBeVisible();
  await library.locator('input[type=file]').setInputFiles({ name: '本地书籍.echo8', mimeType: original.type, buffer: Buffer.from(await original.arrayBuffer()) });
  await expect(library).toHaveCount(0);
  await expect(page.locator('.text-node-card')).toHaveCount(1);
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await expect(page.locator('.text-node-card')).toHaveCount(2);
  expect(backend.db.sqlite.prepare('SELECT COUNT(*) AS count FROM projects').get()!.count).toBe(1);
  if (failFirstUpload) {
    await command(page, '书籍与恢复设置');
    await page.getByRole('region', { name: '书籍与恢复', exact: true }).getByRole('button', { name: '另存到云端', exact: true }).click();
  } else await command(page, '另存到云端');
  const panel = page.getByRole('region', { name: 'Cloudflare 云同步', exact: true });
  const form = panel.getByRole('form', { name: '另存到云端' });
  await expect(form.getByRole('button', { name: '另存到云端', exact: true })).toBeDisabled();
  await form.getByRole('textbox', { name: '云端书籍名称', exact: true }).fill('分块保存测试');
  if (!failFirstUpload) await panel.screenshot({ path: test.info().outputPath('local-save-as-cloud.png') });
  if (failFirstUpload) await page.route('https://book-data.test/v2/projects/*/commit', async route => {
    await page.unroute('https://book-data.test/v2/projects/*/commit');
    await route.fulfill({ status: 503, json: { error: '测试上传中断' } });
  });
  await form.getByRole('button', { name: '另存到云端', exact: true }).click();
  if (failFirstUpload) {
    await expect(panel.locator('.cloud-sync-error')).toContainText('测试上传中断');
    await expect(page.locator('.text-node-card')).toHaveCount(2);
    await panel.getByRole('button', { name: '立即保存到云端', exact: true }).click();
  }
  await expect(panel.getByText('已连接并可编辑', { exact: true })).toBeVisible();
  await expect(panel.locator('.cloud-project-row.active')).toContainText('分块保存测试 (2)');
  expect(backend.db.sqlite.prepare('SELECT COUNT(*) AS count FROM projects').get()!.count).toBe(2);
  expect(backend.db.sqlite.prepare("SELECT revision FROM book_heads WHERE project_id='project-e2e-book'").get()!.revision).toBe(1);
  const savedCloudRevision = () => Number(backend.db.sqlite.prepare("SELECT revision FROM book_heads WHERE project_id <> 'project-e2e-book'").get()?.revision ?? 0);
  await expect.poll(savedCloudRevision).toBeGreaterThan(0);
  await page.getByRole('button', { name: '关闭云同步', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.text-node-card')).toHaveCount(1);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.text-node-card')).toHaveCount(2);
  const beforeSave = savedCloudRevision();
  await command(page, '保存书籍');
  await expect.poll(savedCloudRevision).toBeGreaterThan(beforeSave);
  await page.reload();
  await page.getByRole('button', { name: /^(打开|继续)书籍：分块保存测试 \(2\)$/u }).click();
  await expect(page.locator('.text-node-card')).toHaveCount(2);
  const node = page.getByRole('article', { name: /文本节点：跨设备节点$/u });
  await node.getByRole('paragraph').dblclick({ position: { x: 60, y: 70 } });
  await expect(page.locator('.editor-writing-area').first()).toContainText('保留的大段正文');
});

test('real-time book saving uploads changed blocks, survives a held save and reopens complete content',async({page})=>{
  const backend=await cloud(page);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button',{name:'打开书籍：分块保存测试',exact:true}).click();
  const node=page.getByRole('article',{name:/文本节点：跨设备节点$/u});await expect(node).toBeVisible();
  await command(page,'书籍与恢复设置');
  await page.getByLabel('自动保存当前目标的间隔').selectOption('1000');
  const move=async()=>{const box=(await node.boundingBox())!;await page.mouse.move(box.x+90,box.y+16);await page.mouse.down();await page.mouse.move(box.x+120,box.y+36,{steps:6});await page.mouse.up();};
  const beforeMove=(await node.boundingBox())!;await move();
  await expect.poll(async()=>Math.round((await node.boundingBox())!.x)).not.toBe(Math.round(beforeMove.x));
  await expect.poll(()=>Number(backend.db.sqlite.prepare('SELECT revision FROM book_heads').get()!.revision)).toBeGreaterThan(1);
  expect(backend.uploaded()).toBeLessThan(100_000);
  backend.hold();await move();
  await page.waitForTimeout(1_200);
  // A manual save joining a background save must not deadlock the formal lane.
  const save=command(page,'保存书籍');
  await page.waitForTimeout(200);backend.release();await save;
  await expect.poll(()=>Number(backend.db.sqlite.prepare('SELECT revision FROM book_heads').get()!.revision)).toBeGreaterThan(2);
  await expect(page.getByText(/Illegal interaction|nested.*dispatch|操作没有完成/u)).toHaveCount(0);
  await page.reload();await page.getByRole('button',{name:/^(打开|继续)书籍：分块保存测试$/u}).click();
  await expect(node).toBeVisible();
  await node.getByRole('paragraph').dblclick({position:{x:60,y:70}});
  await expect(page.locator('.editor-writing-area').first()).toContainText('保留的大段正文');
  expect(errors).toEqual([]);
});

test('local storage cleanup preserves recovery records, pending drafts and shortcut settings',async({page})=>{
  await page.goto('/');await page.getByRole('region',{name:'Echo-8 书库'}).press('Escape');
  await page.getByRole('button',{name:'新建文本',exact:true}).click();
  await command(page,'书籍与恢复设置');
  await page.getByRole('button',{name:'创建手动恢复点',exact:true}).click();
  const rows=page.locator('.recovery-row');await expect(rows).toHaveCount(1);
  const cleanup=page.getByRole('region',{name:'浏览器本地数据占用与清理',exact:true});
  await expect(cleanup.getByRole('button',{name:'清理无引用缓存',exact:true})).toBeVisible();
  await expect(cleanup.getByRole('button',{name:'清理已备份的多余恢复副本',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'清理无引用缓存',exact:true}).click();
  await expect(page.getByText(/已清理.*条无引用/u)).toBeVisible();
  await expect(rows).toHaveCount(1);
  await page.getByRole('button',{name:'清理已备份的多余恢复副本',exact:true}).click();
  await expect(rows).toHaveCount(1);
  await expect(page.locator('.text-node-card')).toHaveCount(3);
});


test('custom shortcuts restore from the account and edits update a single account record',async({page})=>{
 const backend=await cloud(page);
 const remote=[{targetOwner:'canvas',targetId:'canvas.focus-selection-shortcut',chord:'mod+alt+9'}];
 const response=await backend.fetch('/v2/shortcuts','PUT',{expectedRevision:0,overrides:remote});expect(response.status).toBe(200);
 await page.goto('/');await page.getByRole('button',{name:'打开书籍：分块保存测试',exact:true}).click();
 await command(page,'打开快捷键中心');
 const panel=page.getByRole('region',{name:'快捷键中心'});await panel.getByPlaceholder('搜索操作或分类…').fill('聚焦选中项');
 const binding=panel.getByRole('textbox',{name:'修改聚焦选中项的快捷键'});
 await expect(binding).toHaveValue(/Ctrl.*Alt.*9/u);
 await binding.focus();await page.keyboard.press('Control+Alt+8');
 await expect.poll(()=>Number(backend.db.sqlite.prepare('SELECT revision FROM account_shortcuts').get()!.revision)).toBe(2);
 expect(backend.db.sqlite.prepare('SELECT COUNT(*) AS count FROM account_shortcuts').get()!.count).toBe(1);
 await page.reload();await page.getByRole('region',{name:'Echo-8 书库'}).press('Escape');
 await command(page,'打开快捷键中心');await page.getByRole('region',{name:'快捷键中心'}).getByPlaceholder('搜索操作或分类…').fill('聚焦选中项');
 await expect(page.getByRole('textbox',{name:'修改聚焦选中项的快捷键'})).toHaveValue(/Ctrl.*Alt.*8/u);
});
