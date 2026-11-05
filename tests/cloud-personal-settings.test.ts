import assert from 'node:assert/strict';
import test from 'node:test';
import {planShortcutSync,shortcutFingerprint} from '../src/plugins/cloud-sync/shortcut-sync.ts';
import {addPendingBookChange} from '../src/plugins/cloud-sync/pending-book.ts';
import type {TransactionCommitRecord} from '../src/protocols/state.ts';

test('account shortcuts restore on a new device and never overwrite concurrent edits or another account',()=>{
 const settings=[{targetOwner:'canvas',targetId:'focus',chord:'mod+alt+f'}];
 const remote={revision:4,overrides:settings};
 assert.equal(planShortcutSync('user',[],remote).action,'download');
 const saved={userId:'user',revision:4,baseline:shortcutFingerprint(settings),dirty:false};
 assert.equal(planShortcutSync('user',settings,remote,saved).action,'equal');
 assert.equal(planShortcutSync('user',[],remote,{...saved,dirty:true}).action,'upload','a deliberate reset also syncs');
 assert.equal(planShortcutSync('user',[],{...remote,revision:5},{...saved,dirty:true}).action,'conflict');
 assert.equal(planShortcutSync('other',settings,{revision:0,overrides:[]},saved).action,'download','do not upload the old account settings to another account');
});

test('pending book queue collapses repeated edits to latest values while kernel history stays independent',()=>{
 const record=(id:string,x:number):TransactionCommitRecord=>({id,label:'move',timestamp:1,sourceMessageId:id,historyAction:'record',forward:[{op:'set',domain:'document',namespace:'nodes',key:'node',value:{x}}],inverse:[{op:'set',domain:'document',namespace:'nodes',key:'node',value:{x:x-1}}]});
 let pending=addPendingBookChange([],record('first',1),1);
 const inFlight=pending;
 for(let x=2;x<=200;x++)pending=addPendingBookChange(pending,record(`move-${x}`,x),x);
 assert.equal(pending.length,1);assert.deepEqual(pending[0].forward[0].value,{x:200});
 assert.equal(pending[0].documentRevision,200);assert.deepEqual(pending[0].inverse,[]);
 assert.deepEqual(inFlight[0].forward[0].value,{x:1},'in-flight immutable batch cannot be changed by later edits');
 const original=record('kept',9);addPendingBookChange(pending,original,201);assert.equal(original.inverse.length,1);
});
