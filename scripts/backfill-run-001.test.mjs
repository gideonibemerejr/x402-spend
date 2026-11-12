import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EXPECTED, readReceipts, reconcile, makeAudit, matchTransfer, submissionFor,
  publishAudit, saveAudit,
} from './backfill-run-001.mjs'

const evmNetwork='eip155:8453'
const svmNetwork='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const payer='0x1111111111111111111111111111111111111111'
const payTo='0x2222222222222222222222222222222222222222'
const solPayer='SolanaPayerExample'
const solPayTo='SolanaSellerExample'
const token='0x3333333333333333333333333333333333333333'

function setup(){
  const dir=mkdtempSync(join(tmpdir(),'backfill-001-'))
  const dbPath=join(dir,'run-001.db')
  const planPath=join(dir,'run-001.json')
  const resultsPath=join(dir,'run-001.results.json')
  const db=new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE receipts (id TEXT PRIMARY KEY, outcome TEXT, outcome_reason TEXT, settled INTEGER, json TEXT)`)
  const insert=db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?)')
  const plan=[];const results=[];const receipts=[]
  for(let i=0;i<34;i++){
    const planId=i===30?'geo-r-02':`row-${String(i).padStart(2,'0')}`
    const labeled=i<31
    const network=i===4||i===5?svmNetwork:evmNetwork
    const key=network===svmNetwork?`SolanaTransaction${i}`:`0x${(i+1).toString(16).padStart(64,'0')}`
    const receipt={schema:2,id:`uuid-${i}`,ts:'2026-09-15T05:59:00.000Z',resource:{url:`https://example.com/api/${i}`},taskClass:'search_known',network,
      asset:network===svmNetwork?'SolanaUsdcMint':token,payTo:network===svmNetwork?solPayTo:payTo,
      amountAuthorized:'1000',amountSettled:labeled?'1000':undefined,settled:labeled,
      ...(labeled && i!==30?{transaction:key}:{}),
      ...(labeled && i!==30 && i>=6?{payer}:{}),
      outcome:!labeled?'unlabeled':i<22||i===30?'useful':'not_useful',
      ...(i>=22&&i<30?{outcomeReason:'wrong'}:{}),
      legs:[{kind:'paid',ms:125,status:200}],
    }
    plan.push({id:planId,endpoint:receipt.resource.url,category:'search_known'})
    results.push({id:planId,receiptId:receipt.id,settled:receipt.settled,network:receipt.network,asset:receipt.asset,
      ...(receipt.transaction?{transaction:receipt.transaction}:{}),amount:receipt.amountSettled??receipt.amountAuthorized})
    receipts.push(receipt)
    insert.run(receipt.id,receipt.outcome,receipt.outcomeReason??null,Number(receipt.settled),JSON.stringify(receipt))
  }
  db.close()
  writeFileSync(planPath,JSON.stringify(plan))
  writeFileSync(resultsPath,JSON.stringify(results))
  return {dir,dbPath,planPath,resultsPath,plan,results,receipts,cleanup:()=>rmSync(dir,{recursive:true,force:true})}
}

function fakeApi(fx){
  const stored=new Map()
  const invoked=[]
  const request=async({url,method='GET',data})=>{
    invoked.push({url,method})
    if(url.endsWith('/v1/verify')){
      assert.equal(method,'POST')
      const receipt=fx.receipts.find(r=>r.transaction===data.transaction&&r.network===data.network)
      assert.ok(receipt)
      const isSol=receipt.network===svmNetwork
      return {status:200,body:{found:true,network:receipt.network,transaction:receipt.transaction,truncated:false,transfers:[{
        asset:receipt.asset,payTo:receipt.payTo,amount:'1000',payer:isSol?solPayer:payer,proof:'payment_traced'}]}}
    }
    if(url.includes('/v1/reviews?resource=')){
      const resource=decodeURIComponent(url.split('resource=')[1])
      return {status:200,body:{reviews:stored.get(resource)??[]}}
    }
    if(url.endsWith('/v1/reviews')){
      assert.equal(method,'POST')
      const list=stored.get(data.resourceUrl)??[]
      stored.set(data.resourceUrl,[...list,{...data,status:'verified',proof:'payment_traced'}])
      return {status:201,body:{status:'verified'}}
    }
    assert.fail(`Unexpected request ${url}`)
  }
  return {request,invoked,stored}
}

test('reconciles exactly 31 graded and 30 independently traced candidates, with geo-r-02 excluded',()=>{
  const fx=setup();try{
    const x=reconcile({plan:fx.plan,results:fx.results,receipts:readReceipts(fx.dbPath)})
    assert.deepEqual(x.errors,[])
    assert.equal(x.stats.graded,EXPECTED.graded)
    assert.equal(x.stats.eligibleUseful,EXPECTED.eligibleUseful)
    assert.equal(x.stats.eligibleNotUseful,EXPECTED.eligibleNotUseful)
    assert.equal(x.candidates.length,EXPECTED.transactionBearing)
    assert.deepEqual(x.excluded.map(x=>x.planId),['geo-r-02'])
  }finally{fx.cleanup()}
})

test('audit reads evidence only and recovers six payer identities without mutating SQLite',async()=>{
  const fx=setup();try{
    const api=fakeApi(fx)
    const before=JSON.stringify(readReceipts(fx.dbPath))
    const audit=await makeAudit({...fx,request:api.request,delayMs:0})
    assert.equal(audit.ready,true)
    assert.equal(audit.errors.length,0)
    assert.equal(audit.entries.filter(e=>e.payerRecovered).length,6)
    assert.equal(audit.entries.length,30)
    assert.equal(audit.entries.filter(e=>e.review.outcome==='not_useful').length,8)
    assert.ok(api.invoked.every(r=>r.url.endsWith('/v1/verify')))
    assert.equal(JSON.stringify(readReceipts(fx.dbPath)),before)
    const path=saveAudit(audit,join(fx.dir,'private','audit.json'))
    assert.ok(path.includes('audit.json'))
  }finally{fx.cleanup()}
})

test('transfer matching fails closed for ambiguity, different payer, missing attribution, and truncated responses',()=>{
  const receipt={network:evmNetwork,transaction:'tx',asset:token,payTo,amountSettled:'1000',payer}
  const transfer={asset:token,payTo,amount:'1000',payer,proof:'payment_traced'}
  const response={found:true,network:evmNetwork,transaction:'tx',truncated:false,transfers:[transfer]}
  assert.equal(matchTransfer(receipt,response).payer,payer)
  assert.match(matchTransfer(receipt,{...response,truncated:true}).error,/truncated/)
  assert.match(matchTransfer(receipt,{...response,transfers:[transfer,transfer]}).error,/found 2/)
  assert.match(matchTransfer(receipt,{...response,transfers:[{...transfer,payer:undefined}]}).error,/found 0/)
  assert.match(matchTransfer(receipt,{...response,transfers:[{...transfer,payer:payTo}]}).error,/differs/)
  assert.match(matchTransfer({...receipt,payer:undefined},{...response,transfers:[{...transfer,payer:payTo}]}).error,/Self-payment/)
})

test('reconciliation rejects a receipt relabeled to disagree with the frozen plan/results and rejects double settlement',()=>{
  const fx=setup();try{
    const tampered=structuredClone(fx.receipts)
    tampered[0].taskClass='weather'
    assert.ok(reconcile({plan:fx.plan,results:fx.results,receipts:tampered}).errors.some(x=>x.includes('task classification')))
    const again=[...fx.results,{...fx.results[0],receiptId:'other-uuid',settled:true}]
    assert.throws(()=>reconcile({plan:fx.plan,results:again,receipts:fx.receipts}),/Multiple distinct settled/)
  }finally{fx.cleanup()}
})

test('publish requires exact audit approval digest, respects existing reviews and validates outcomes on registry reads',async()=>{
  const fx=setup();try{
    const api=fakeApi(fx)
    const audit=await makeAudit({...fx,request:api.request,delayMs:0})
    await assert.rejects(publishAudit({audit,confirm:'bad',request:api.request,delayMs:0}),/Approval hash/)
    assert.equal(api.invoked.filter(x=>x.url.endsWith('/v1/reviews')).length,0)
    const result=await publishAudit({audit,confirm:audit.approvalSha256,request:api.request,delayMs:0})
    assert.equal(result.verified,30)
    assert.equal(result.pending,0)
    assert.equal(api.invoked.filter(x=>x.url.endsWith('/v1/reviews')).length,30)
    const beforePosts=api.invoked.filter(x=>x.url.endsWith('/v1/reviews')).length
    const replay=await publishAudit({audit,confirm:audit.approvalSha256,request:api.request,delayMs:0})
    assert.equal(replay.verified,30)
    assert.equal(api.invoked.filter(x=>x.url.endsWith('/v1/reviews')).length,beforePosts)
  }finally{fx.cleanup()}
})

test('omit locally recorded freeform notes in public submission by default',()=>{
  const receipt={resource:{url:'https://example.com/search?secret=a'},taskClass:'search_known',network:evmNetwork,asset:token,amountSettled:'1000',payTo,transaction:'0x1',outcome:'not_useful',outcomeReason:'wrong',outcomeNote:'private draft note',ts:'2026-09-15T05:59:00.000Z'}
  const payload=submissionFor(receipt,payer)
  assert.equal(payload.resourceUrl,'https://example.com/search')
  assert.equal(payload.reason,'wrong')
  assert.equal(payload.note,undefined)
})
