#!/usr/bin/env node
/**
 * Run 001: reconcile the frozen plan, labeled SQLite receipts, and on-chain
 * transfers before optionally publishing reviews. Never buys or calls an x402
 * endpoint. Audit is the default; publication requires an explicit hash match.
 *
 * Only built-in Node APIs and `curl` are used. Use Node >=22.5 (node:sqlite).
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXPECTED = Object.freeze({ planned: 34, graded: 31, useful: 23, notUseful: 8, transactionBearing: 30, eligibleUseful: 22, eligibleNotUseful: 8, excludedId: 'geo-r-02' })
export const DEFAULT_API = 'https://api.x402spend.dev'
export const DEFAULT_AUDIT = '.backfill/run-001-audit.json'
export const DEFAULT_DELAY_MS = 3500 // Under the Worker demo-route limit of 20/min.

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const amountString = (value) => typeof value === 'string' && /^\d{1,30}$/.test(value)
const addressLike = (value) => typeof value === 'string' && value.length > 0
const isEvm = (network) => network.startsWith('eip155:')
const canonical = (value, network) => isEvm(network) ? value.toLowerCase() : value
const publicUrl = (raw) => { const url = new URL(raw); url.search = ''; url.hash = ''; return url.toString() }
const pause = (ms) => new Promise((finish) => setTimeout(finish, ms))

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function assert(condition, message) { if (!condition) throw new Error(message) }

/** Untrusted receipt data is read with SQLite opened *read-only*. */
export function readReceipts(dbPath) {
  const db = new DatabaseSync(resolve(dbPath), { readOnly: true })
  try {
    return db.prepare('SELECT id, outcome, outcome_reason, settled, json FROM receipts ORDER BY id').all().map((row) => {
      const receipt = JSON.parse(row.json)
      if (receipt.id !== row.id || receipt.outcome !== row.outcome ||
          (receipt.outcomeReason ?? null) !== row.outcome_reason || Number(receipt.settled) !== row.settled) {
        throw new Error(`Receipt ${String(row.id).slice(0, 8)} has inconsistent SQL and JSON fields`)
      }
      return receipt
    })
  } finally { db.close() }
}

/** Results may contain earlier retries; prefer the one settled attempt. */
export function selectedResults(rows) {
  assert(Array.isArray(rows), 'Run 001 results must be an array')
  const grouped = new Map()
  for (const row of rows) {
    assert(typeof row?.id === 'string', 'Every result must have an id')
    const prior = grouped.get(row.id)
    if (prior?.settled && row.settled && prior.receiptId !== row.receiptId) {
      throw new Error(`Multiple distinct settled attempts for ${row.id}; manual reconciliation required`)
    }
    if (!prior?.settled) grouped.set(row.id, row)
  }
  return grouped
}

function validTimestamp(ts) {
  if (typeof ts !== 'string') return false
  const d = new Date(ts)
  return Number.isFinite(d.getTime()) && ts.startsWith('2026-09-15')
}

/** Fail closed on run drift or ambiguous linkage, not only the count. */
export function reconcile({ plan, results, receipts }) {
  const errors = []
  const candidates = []
  const excluded = []
  const missing = (message) => errors.push(message)
  const plans = new Map()
  const local = new Map(receipts.map((r) => [r.id, r]))
  const logged = selectedResults(results)
  if (!Array.isArray(plan)) throw new Error('Run 001 plan must be an array')
  if (plan.length !== EXPECTED.planned) missing(`Expected ${EXPECTED.planned} plan rows, got ${plan.length}`)
  if (receipts.length !== EXPECTED.planned || local.size !== receipts.length) missing(`Expected ${EXPECTED.planned} distinct SQLite receipts, got ${receipts.length} (${local.size} distinct)`)
  if (logged.size !== plan.length) missing(`Expected ${plan.length} distinct results, got ${logged.size}`)
  for (const row of plan) {
    if (!row?.id || plans.has(row.id)) { missing(`Duplicate/invalid plan ID: ${row?.id}`); continue }
    plans.set(row.id, row)
  }
  for (const [id] of logged) if (!plans.has(id)) missing(`Unexpected result ID ${id}`)

  for (const row of plan) {
    const result = logged.get(row.id)
    if (!result) { missing(`Missing result ${row.id}`); continue }
    const receipt = local.get(result.receiptId)
    if (!receipt) { missing(`Missing SQLite receipt for ${row.id}`); continue }
    if (result.settled !== receipt.settled) missing(`${row.id}: result settlement flag contradicts SQLite`)
    if (result.network && result.network !== receipt.network) missing(`${row.id}: network mismatch between result and receipt`)
    if (result.transaction && result.transaction !== receipt.transaction) missing(`${row.id}: transaction mismatch between result and receipt`)
    if (result.asset && canonical(result.asset, receipt.network) !== canonical(receipt.asset, receipt.network)) missing(`${row.id}: asset mismatch`)
    if (result.amount && result.amount !== (receipt.amountSettled ?? receipt.amountAuthorized)) missing(`${row.id}: settled amount mismatch`)
    if (row.category !== receipt.taskClass) missing(`${row.id}: task classification differs from frozen plan`)
    try { if (publicUrl(row.endpoint) !== publicUrl(receipt.resource.url)) missing(`${row.id}: resource differs from frozen plan`) }
    catch { missing(`${row.id}: invalid resource URL`) }
    if (!validTimestamp(receipt.ts)) missing(`${row.id}: receipt timestamp is not September 15 UTC`)
    if (receipt.settled && !['useful', 'not_useful'].includes(receipt.outcome)) missing(`${row.id}: settled receipt is not graded`)
    if (!receipt.settled && receipt.outcome !== 'unlabeled') missing(`${row.id}: unsettled receipt was graded`)
    if (!receipt.settled) continue
    if (receipt.outcome === 'not_useful' && !['no_response', 'empty', 'malformed', 'wrong', 'stale', 'insufficient'].includes(receipt.outcomeReason)) missing(`${row.id}: invalid/missing failure reason`)
    if (receipt.outcome === 'useful' && receipt.outcomeReason) missing(`${row.id}: useful receipt has a failure reason`)
    if (!addressLike(receipt.transaction)) { excluded.push({planId:row.id,receiptId:receipt.id,reason:'no independent transaction hash'});continue }
    if (!amountString(receipt.amountSettled ?? receipt.amountAuthorized) || !addressLike(receipt.asset) || !addressLike(receipt.payTo)) missing(`${row.id}: incomplete asset/amount/recipient`)
    candidates.push({ planId: row.id, receipt })
  }
  const graded = receipts.filter((r) => ['useful', 'not_useful'].includes(r.outcome))
  const useful = graded.filter((r) => r.outcome === 'useful').length
  const notUseful = graded.length - useful
  const eligibleUseful = candidates.filter((c) => c.receipt.outcome === 'useful').length
  const eligibleNotUseful = candidates.length - eligibleUseful
  const distinct = new Set(candidates.map((c) => `${c.receipt.network}:${canonical(c.receipt.transaction, c.receipt.network)}`))
  const originalPayers = candidates.filter((c) => addressLike(c.receipt.payer)).length
  const checks = [
    [graded.length, EXPECTED.graded, 'graded'], [useful, EXPECTED.useful, 'useful'],
    [notUseful, EXPECTED.notUseful, 'not useful'], [candidates.length, EXPECTED.transactionBearing, 'transaction-bearing'],
    [eligibleUseful, EXPECTED.eligibleUseful, 'eligible useful'], [eligibleNotUseful, EXPECTED.eligibleNotUseful, 'eligible not useful'],
    [distinct.size, EXPECTED.transactionBearing, 'distinct transaction hashes'],
  ]
  for (const [got, expected, label] of checks) if (got !== expected) missing(`Expected ${expected} ${label}, got ${got}`)
  if (excluded.length !== 1 || excluded[0].planId !== EXPECTED.excludedId) missing('Expected only geo-r-02 to have no independent transaction hash')
  return { candidates, excluded, errors, stats:{ planned:plan.length, receipts: receipts.length, graded: graded.length, useful, notUseful, candidateReviews:candidates.length, eligibleUseful, eligibleNotUseful, originalPayers, missingPayers:candidates.length-originalPayers } }
}

/** Match the *payment*, not tx.from / a Solana fee-payer. Ambiguity fails closed. */
export function matchTransfer(receipt, description) {
  if (!description || description.found !== true || description.truncated !== false || !Array.isArray(description.transfers)) return { error: 'Transaction not found, response truncated, or malformed verification response' }
  if (description.network !== receipt.network || description.transaction !== receipt.transaction) return { error: 'Verification response does not identify the requested transaction' }
  const network = receipt.network
  const expected = receipt.amountSettled ?? receipt.amountAuthorized
  if (!amountString(expected)) return { error: 'Receipt amount is invalid' }
  const matches = description.transfers.filter((t) => {
    try {
      return t.proof === 'payment_traced' && addressLike(t.payer) &&
        canonical(t.asset, network) === canonical(receipt.asset, network) &&
        canonical(t.payTo, network) === canonical(receipt.payTo, network) &&
        amountString(t.amount) && (isEvm(network) ? BigInt(t.amount) === BigInt(expected) : BigInt(t.amount) >= BigInt(expected))
    } catch { return false }
  })
  if (matches.length !== 1) return { error: `Expected one attributable transfer matching asset, payTo and amount, found ${matches.length}` }
  const payer = matches[0].payer
  if (receipt.payer && canonical(receipt.payer, network) !== canonical(payer, network)) return { error: 'Recorded payer differs from chain transfer authority' }
  if (canonical(payer, network) === canonical(receipt.payTo, network)) return { error: 'Self-payment is not a verifiable review' }
  return { payer, recovered: !receipt.payer }
}

/** Recreates the public ReviewSubmission v2, omitting potentially private notes by default. */
export function submissionFor(receipt, payer) {
  const { outcome } = receipt
  assert(outcome === 'useful' || outcome === 'not_useful', 'Unlabeled response cannot be published')
  assert(outcome !== 'not_useful' || typeof receipt.outcomeReason === 'string', 'Not useful needs reason')
  const paidLeg = [...(receipt.legs ?? [])].reverse().find((leg) => leg.kind === 'paid' || leg.kind === 'recovery')
  const payload = {
    schema: 2,
    resourceUrl: publicUrl(receipt.resource.url),
    ...(receipt.taskClass ? {taskClass:receipt.taskClass} : {}),
    network: receipt.network, asset: receipt.asset,
    amount: receipt.amountSettled ?? receipt.amountAuthorized,
    payTo:receipt.payTo, transaction:receipt.transaction, payer,
    outcome,
    ...(receipt.outcomeReason ? {reason:receipt.outcomeReason} : {}),
    ...(receipt.outcomeRecovery ? {recovery:receipt.outcomeRecovery} : {}),
    ...(Number.isInteger(paidLeg?.ms) && paidLeg.ms >= 0 ? {paidMs:paidLeg.ms} : {}),
    ts:receipt.ts,
  }
  return payload
}

/** Curl is intentional: this Cloudflare deployment rejected Python's urllib but accepted curl. */
export async function curlRequest({ url, method='GET', data, timeout=25 }) {
  const args=['-sS','--max-time',String(timeout),'-w','\n%{http_code}', '-H','Accept: application/json']
  if (data !== undefined) args.push('-H','Content-Type: application/json','--data-binary','@-')
  if (method !== 'GET') args.push('-X',method)
  args.push(url)
  const output = await new Promise((done, fail) => {
    const child=spawn('curl',args,{stdio:['pipe','pipe','pipe']})
    const stdout=[];const stderr=[]
    child.stdout.on('data',(chunk)=>stdout.push(chunk))
    child.stderr.on('data',(chunk)=>stderr.push(chunk))
    child.on('error',fail)
    child.on('close',(code)=> code === 0 ? done(Buffer.concat(stdout).toString('utf8')) : fail(new Error(`curl failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0,200)}`)))
    child.stdin.end(data === undefined ? '' : JSON.stringify(data))
  })
  const cut=output.lastIndexOf('\n')
  if (cut < 0) throw new Error('No HTTP status in curl response')
  const status=Number(output.slice(cut+1).trim())
  let body
  try { body=JSON.parse(output.slice(0,cut)) } catch { body={error:'Non-JSON API response'} }
  return {status,body}
}

const urlFor = (base, path) => `${base.replace(/\/$/,'')}${path}`
const describeApiError = ({status,body}) => `HTTP ${status}: ${String(body?.detail ?? body?.error ?? 'Unknown response').slice(0,250)}`

export async function makeAudit({dbPath='run-001.db',planPath='examples/run-001.json',resultsPath='examples/run-001.results.json',api=DEFAULT_API,delayMs=DEFAULT_DELAY_MS,request=curlRequest,onProgress=()=>{}}={}) {
  const planBytes=readFileSync(planPath)
  const resultsBytes=readFileSync(resultsPath)
  const plan=JSON.parse(planBytes)
  const results=JSON.parse(resultsBytes)
  const receipts=readReceipts(dbPath)
  const reconciled=reconcile({plan,results,receipts})
  const entries=[]
  const errors=[...reconciled.errors]
  const timestamp=new Date().toISOString()
  // The frozen-data reconciliation is a hard prerequisite, not a warning to ignore.
  // If it fails, don't spend RPC calls or generate partially approved payloads.
  const toVerify = errors.length ? [] : reconciled.candidates
  for(const [i,{planId,receipt}] of toVerify.entries()) {
    if (i>0 && delayMs>0) await pause(delayMs)
    let result
    try {
      const answer=await request({url:urlFor(api,'/v1/verify'),method:'POST',data:{network:receipt.network,transaction:receipt.transaction}})
      if(answer.status!==200) result={error:describeApiError(answer)}
      else result=matchTransfer(receipt,answer.body)
    } catch (cause) { result={error:String(cause?.message ?? cause)} }
    if(result.error) {
      errors.push(`${planId}: ${result.error}`)
      entries.push({planId,receiptId:receipt.id,status:'failed',error:result.error})
      onProgress(`${i+1}/${toVerify.length} ${planId}: verification failed`)
    } else {
      entries.push({planId,receiptId:receipt.id,status:'verified',payerRecovered:result.recovered,review:submissionFor(receipt,result.payer),noteOmitted:!!receipt.outcomeNote})
      onProgress(`${i+1}/${toVerify.length} ${planId}: chain payment traced${result.recovered?' (payer recovered)':''}`)
    }
  }
  const content={schema:1,run:'run-001',createdAt:timestamp,api,inputs:{dbPath:resolve(dbPath),planPath:resolve(planPath),resultsPath:resolve(resultsPath),planSha256:sha256(planBytes),resultsSha256:sha256(resultsBytes),receiptsSha256:sha256(JSON.stringify(receipts))},stats:reconciled.stats,excluded:reconciled.excluded,entries,errors,ready:errors.length===0&&entries.length===EXPECTED.transactionBearing&&entries.every((e)=>e.status==='verified')}
  const digest=sha256(JSON.stringify(content))
  return {...content, approvalSha256:digest}
}

export function saveAudit(audit, out=DEFAULT_AUDIT) {
  const file=resolve(out)
  mkdirSync(dirname(file),{recursive:true,mode:0o700})
  // Owner-only: this report contains payment hashes, payer addresses and optional context.
  writeFileSync(file,`${JSON.stringify(audit,null,2)}\n`,{mode:0o600,flag:'w'})
  chmodSync(file,0o600)
  return file
}

function verifyAuditSeal(audit,confirm) {
  const {approvalSha256,...content}=audit
  const digest=sha256(JSON.stringify(content))
  assert(approvalSha256===digest, 'Audit file checksum mismatch: regenerate the audit')
  assert(confirm===digest, 'Approval hash does not match the audited payloads')
  assert(audit.schema===1&&audit.run==='run-001'&&audit.ready===true,'Audit is not ready for publishing')
  assert(audit.errors.length===0 && audit.entries.length===EXPECTED.transactionBearing && audit.entries.every((e)=>e.status==='verified'&&e.review),'Audit has incomplete verification')
  assert(audit.stats.graded===EXPECTED.graded&&audit.stats.eligibleUseful===EXPECTED.eligibleUseful&&audit.stats.eligibleNotUseful===EXPECTED.eligibleNotUseful,'Run 001 counts do not reconcile')
  assert(audit.excluded.length===1&&audit.excluded[0].planId===EXPECTED.excludedId,'Prepaid-credit exclusion is missing')
  assert(Date.now()-new Date(audit.createdAt).getTime()<72*60*60*1000 && Date.now()>=new Date(audit.createdAt).getTime(),'Audit older than 72 hours or invalid; regenerate')
}

/** Publication is an explicit, separately approved operation. No receipt or spending endpoint writes. */
export async function publishAudit({audit,confirm,request=curlRequest,delayMs=DEFAULT_DELAY_MS,onProgress=()=>{}}) {
  verifyAuditSeal(audit,confirm)
  // Recheck local evidence: an audit cannot be used after the user changes a label.
  const p=audit.inputs
  assert(sha256(readFileSync(p.planPath))===p.planSha256,'Frozen plan changed after audit')
  assert(sha256(readFileSync(p.resultsPath))===p.resultsSha256,'Run results changed after audit')
  assert(sha256(JSON.stringify(readReceipts(p.dbPath)))===p.receiptsSha256,'SQLite receipts/labels changed after audit')
  const progress=[]
  const seen=new Set()
  // Validate the entire manifest before the first remote write.
  for(const item of audit.entries) {
    const r=item.review
    assert(item.status==='verified' && r?.schema===2 && r.outcome && ['useful','not_useful'].includes(r.outcome),`${item.planId}: invalid review payload`)
    assert(r.outcome!=='not_useful'||r.reason,`${item.planId}: missing failure reason`)
    assert(addressLike(r.transaction)&&addressLike(r.payer)&&addressLike(r.payTo)&&addressLike(r.asset)&&amountString(r.amount),`${item.planId}: incomplete payment evidence`)
    assert(new URL(r.resourceUrl).toString()===r.resourceUrl && !new URL(r.resourceUrl).search,`${item.planId}: resource URL is not public and normalized`)
    const key=`${r.network}:${canonical(r.transaction,r.network)}`
    assert(!seen.has(key),`${item.planId}: duplicate transaction in audit`)
    seen.add(key)
  }
  seen.clear()
  for(const [i,item] of audit.entries.entries()) {
    if (i>0&&delayMs>0) await pause(delayMs)
    const review=item.review
    const key=`${review.network}:${canonical(review.transaction,review.network)}`
    assert(!seen.has(key),`Duplicate transaction in audit: ${item.planId}`)
    seen.add(key)
    const path=`/v1/reviews?resource=${encodeURIComponent(review.resourceUrl)}`
    let page=await request({url:urlFor(audit.api,path)})
    if (page.status!==200 || !Array.isArray(page.body?.reviews)) throw new Error(`${item.planId}: preflight failed (${describeApiError(page)})`)
    const existing=page.body.reviews.find((row)=>row.network===review.network&&canonical(row.transaction,review.network)===canonical(review.transaction,review.network)&&canonical(row.payer,review.network)===canonical(review.payer,review.network))
    if(existing) {
      assert(existing.outcome===review.outcome && (existing.reason??null)===(review.reason??null),`${item.planId}: existing review has conflicting verdict; refusing to relabel`)
      assert(existing.proof==='payment_traced' && existing.status==='verified',`${item.planId}: existing record is not payment-traced and verified`)
      progress.push({planId:item.planId,status:'already_verified'})
      onProgress(`${i+1}/${audit.entries.length} ${item.planId}: already verified`)
      continue
    }
    const response=await request({url:urlFor(audit.api,'/v1/reviews'),method:'POST',data:review})
    if(![200,201,202].includes(response.status)) throw new Error(`${item.planId}: POST refused (${describeApiError(response)})`)
    if(response.status===202 || response.body.status==='pending') {
      progress.push({planId:item.planId,status:'pending'})
      onProgress(`${i+1}/${audit.entries.length} ${item.planId}: accepted, pending verification`)
      continue
    }
    page=await request({url:urlFor(audit.api,path)})
    if(page.status!==200 || !Array.isArray(page.body?.reviews)) throw new Error(`${item.planId}: submitted but could not confirm registry read`)
    const stored=page.body.reviews.find((row)=>row.network===review.network&&canonical(row.transaction,review.network)===canonical(review.transaction,review.network)&&canonical(row.payer,review.network)===canonical(review.payer,review.network))
    if(!stored || stored.status!=='verified' || stored.proof!=='payment_traced' || stored.outcome!==review.outcome || (stored.reason??null)!==(review.reason??null)) throw new Error(`${item.planId}: submitted but registry did not confirm matching payment-traced review`)
    progress.push({planId:item.planId,status:'verified'})
    onProgress(`${i+1}/${audit.entries.length} ${item.planId}: registry verified`)
  }
  return {attempted:progress.length,verified:progress.filter((r)=>r.status==='verified'||r.status==='already_verified').length,pending:progress.filter((r)=>r.status==='pending').length,results:progress}
}

function parseArgs(argv) {
  const options={ mode:'audit' }
  for(let i=0;i<argv.length;i++){
    const a=argv[i]
    if(a==='--publish'){options.mode='publish';continue}
    const allowed={'--db':'dbPath','--plan':'planPath','--results':'resultsPath','--api':'api','--out':'out','--audit':'auditFile','--confirm':'confirm','--delay-ms':'delayMs'}
    if(!allowed[a]) throw new Error(`Unknown argument: ${a}`)
    if(i+1>=argv.length || argv[i+1].startsWith('--')) throw new Error(`Missing value after ${a}`)
    options[allowed[a]]=argv[++i]
  }
  options.delayMs=options.delayMs===undefined?DEFAULT_DELAY_MS:Number(options.delayMs)
  assert(Number.isInteger(options.delayMs) && options.delayMs>=0,'Invalid --delay-ms')
  if(options.mode==='audit') assert(!options.confirm&&!options.auditFile,'--confirm and --audit are only for --publish')
  if(options.mode==='publish') assert(options.confirm&&options.auditFile,'Publishing requires --audit <file> --confirm <sha256>')
  if(options.api && !/^https:\/\//.test(options.api)) throw new Error('API base must be HTTPS')
  return options
}

export async function main(argv=process.argv.slice(2)) {
  const o=parseArgs(argv)
  if(o.mode==='audit') {
    const audit=await makeAudit({...o,onProgress:(line)=>console.log(line)})
    const file=saveAudit(audit,o.out??DEFAULT_AUDIT)
    console.log(`\nAudit: ${file}\nReconciled: ${audit.stats.graded} graded; ${audit.stats.candidateReviews} transaction-bearing; ${audit.excluded.length} excluded`)
    console.log(`Chain verified: ${audit.entries.filter((r)=>r.status==='verified').length}/${EXPECTED.transactionBearing}; errors: ${audit.errors.length}`)
    console.log(`Payers recovered: ${audit.entries.filter((r)=>r.payerRecovered).length}; original free-text notes omitted: ${audit.entries.filter((r)=>r.noteOmitted).length}`)
    if(audit.errors.length) for(const e of audit.errors) console.error(`  ${e}`)
    console.log(`Ready to publish: ${audit.ready?'YES':'NO'}`)
    if(audit.ready) console.log(`Approval SHA-256: ${audit.approvalSha256}\nRead the owner-only audit file before considering --publish.`)
    return audit.ready?0:1
  }
  const audit=readJson(o.auditFile)
  const result=await publishAudit({audit,confirm:o.confirm,delayMs:o.delayMs,onProgress:console.log})
  console.log(`\nRegistry verified: ${result.verified}/${EXPECTED.transactionBearing}; pending: ${result.pending}`)
  if(result.pending) console.log('Pending is not verified. Recheck after the Worker retry schedule completes.')
  return result.pending===0 && result.verified===EXPECTED.transactionBearing ? 0:1
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().then((code)=>{process.exitCode=code}).catch((error)=>{console.error(`Backfill stopped: ${error.message}`);process.exitCode=1})
}
