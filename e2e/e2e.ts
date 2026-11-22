// End-to-end verifier for Pispt against a live relayer (default http://127.0.0.1:8787).
// Run from repo root: npx tsx e2e/e2e.ts
import WebSocket from 'ws';
import {
  burnerWallet, setupMessagingIdentity, sealMessage, openMessage, checkSender, reassemble,
  signProfile, verifyRegistration, b64, unb64, type Opened, type Profile,
} from '@primar/core';

const BASE = process.env.RELAYER_URL ?? 'http://127.0.0.1:8787';
const WS_URL = BASE.replace(/^http/, 'ws') + '/v1/stream';

type Row = { id: string; name: string; pass: boolean; detail: string };
const rows: Row[] = [];
function check(id: string, name: string, pass: boolean, detail: string) {
  rows.push({ id, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${name} — ${detail}`);
}
let reqCount = 0;
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  reqCount++;
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');

async function main() {
  // ---- 1. health ----
  const h = await api('GET', '/v1/health');
  const hj = h.json;
  const shapeOk = h.status === 200 && hj.ok === true && hj.app === 'Pispt' && (hj.mode === 'onchain' || hj.mode === 'local')
    && typeof hj.network === 'string' && (hj.relayer === null || typeof hj.relayer === 'string')
    && (hj.balanceLamports === null || typeof hj.balanceLamports === 'number') && typeof hj.treasury === 'string';
  check('1', 'health shape', shapeOk, `status=${h.status} mode=${hj.mode} network=${hj.network} balance=${hj.balanceLamports} treasury=${hj.treasury}`);
  const mode = hj.mode;

  // ---- 2. register ----
  const aliceW = burnerWallet(), bobW = burnerWallet(), eveW = burnerWallet();
  const alice = await setupMessagingIdentity(aliceW);
  const bob = await setupMessagingIdentity(bobW);
  const eve = await setupMessagingIdentity(eveW);
  const regs = await Promise.all([alice, bob, eve].map((u) => api('POST', '/v1/register', u.record)));
  check('2a', 'register Alice/Bob/Eve', regs.every((r) => r.status === 200 && r.json.ok === true), `statuses=${regs.map((r) => r.status).join(',')}`);
  const keys = await Promise.all([aliceW, bobW, eveW].map((w) => api('GET', `/v1/keys/${w.publicKey}`)));
  const recs = keys.map((k) => k.json);
  const keysOk = keys.every((k) => k.status === 200)
    && recs[0].msgPub === alice.record.msgPub && recs[1].msgPub === bob.record.msgPub && recs[2].msgPub === eve.record.msgPub
    && recs.every((r: any) => verifyRegistration(r));
  check('2b', 'GET /v1/keys + verifyRegistration', keysOk, `statuses=${keys.map((k) => k.status).join(',')} verify=${recs.map((r: any) => verifyRegistration(r)).join(',')}`);
  const [aliceRec, bobRec] = recs;
  // forged: Eve's msgPub+sig claimed for Alice's wallet
  const forged = await api('POST', '/v1/register', { wallet: aliceW.publicKey, msgPub: eve.record.msgPub, sig: eve.record.sig });
  const afterForge = await api('GET', `/v1/keys/${aliceW.publicKey}`);
  check('2c', 'forged registration rejected', forged.status === 400 && afterForge.json.msgPub === alice.record.msgPub,
    `status=${forged.status} err=${JSON.stringify(forged.json.error)}; Alice key unchanged=${afterForge.json.msgPub === alice.record.msgPub}`);
  const unknownKey = await api('GET', `/v1/keys/${burnerWallet().publicKey}`);
  check('2d', 'unknown wallet → 404', unknownKey.status === 404, `status=${unknownKey.status}`);

  // ---- 3. profiles ----  (profile writes budget: 5)
  const uname = `alice_${rnd()}`;
  const t0 = Date.now();
  const aliceProf: Profile = { wallet: aliceW.publicKey, username: uname, displayName: 'Alice E2E', bio: 'hi', updatedAt: t0 };
  const p1 = await api('PUT', '/v1/profile', { profile: aliceProf, sig: await signProfile(aliceW, aliceProf) });
  check('3a', 'Alice saves signed profile', p1.status === 200 && p1.json.ok === true && p1.json.profile?.username === uname, `status=${p1.status} username=${uname}`);
  const bobProf: Profile = { wallet: bobW.publicKey, username: uname, updatedAt: Date.now() };
  const p2 = await api('PUT', '/v1/profile', { profile: bobProf, sig: await signProfile(bobW, bobProf) });
  check('3b', 'Bob same username → 409', p2.status === 409, `status=${p2.status} err=${JSON.stringify(p2.json.error)}`);
  // Uppercase variant should also be unavailable (case-insensitive uniqueness); uppercase is invalid format anyway
  const av = await api('GET', `/v1/username/${uname}/available`);
  check('3c', 'availability reports taken', av.status === 200 && av.json.available === false, `json=${JSON.stringify(av.json)}`);
  const avFree = await api('GET', `/v1/username/free_${rnd()}/available`);
  check('3c2', 'availability reports free name available', avFree.json.available === true, `json=${JSON.stringify(avFree.json)}`);
  const lk = await api('GET', `/v1/username/${uname}`);
  check('3d', 'lookup username → Alice wallet', lk.status === 200 && lk.json.wallet === aliceW.publicKey, `status=${lk.status} wallet match=${lk.json.wallet === aliceW.publicKey}`);
  const lkUpper = await api('GET', `/v1/username/${uname.toUpperCase()}`);
  check('3d2', 'lookup is case-insensitive', lkUpper.status === 200 && lkUpper.json.wallet === aliceW.publicKey, `status=${lkUpper.status}`);
  const badProf: Profile = { ...aliceProf, bio: 'tampered', updatedAt: t0 + 1000 };
  const p3 = await api('PUT', '/v1/profile', { profile: badProf, sig: await signProfile(aliceW, aliceProf) }); // sig over different content
  check('3e', 'bad signature → 400', p3.status === 400, `status=${p3.status} err=${JSON.stringify(p3.json.error)}`);
  const staleProf: Profile = { ...aliceProf, bio: 'stale', updatedAt: t0 - 60_000 };
  const p4 = await api('PUT', '/v1/profile', { profile: staleProf, sig: await signProfile(aliceW, staleProf) });
  check('3f', 'stale updatedAt → 400', p4.status === 400, `status=${p4.status} err=${JSON.stringify(p4.json.error)}`);
  const getP = await api('GET', `/v1/profile/${aliceW.publicKey}`);
  check('3g', 'GET profile unchanged after rejected writes', getP.status === 200 && getP.json.profile?.bio === 'hi', `bio=${JSON.stringify(getP.json.profile?.bio)}`);
  const batch = await api('GET', `/v1/profiles?wallets=${aliceW.publicKey},${bobW.publicKey},${eveW.publicKey}`);
  check('3h', 'batch /v1/profiles', batch.status === 200 && Array.isArray(batch.json.profiles) && batch.json.profiles.length === 1 && batch.json.profiles[0].wallet === aliceW.publicKey,
    `status=${batch.status} count=${batch.json.profiles?.length} (only Alice has a profile; unknown omitted)`);
  const tooMany = Array.from({ length: 101 }, () => burnerWallet().publicKey).join(',');
  const batch2 = await api('GET', `/v1/profiles?wallets=${tooMany}`);
  check('3i', 'batch >100 → 400', batch2.status === 400, `status=${batch2.status}`);

  // ---- 4. messaging ----
  // find current cursor (page to end)
  let cursor: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const r = await api('GET', `/v1/messages${cursor ? `?since=${cursor}` : ''}`);
    if (!r.json.items.length) { cursor = r.json.cursor ?? cursor; break; }
    cursor = r.json.cursor;
    if (r.json.items.length < 200) break;
  }
  const startCursor = cursor ?? '0';

  const ws = new WebSocket(WS_URL);
  const wsItems: any[] = [];
  ws.on('message', (d) => { try { const m = JSON.parse(String(d)); if (m.type === 'message') wsItems.push(m.item); } catch {} });
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  check('4a', 'Bob WS connected', ws.readyState === WebSocket.OPEN, `url=${WS_URL}`);

  const bobPub = unb64(bobRec.msgPub);
  const shortText = 'hey bob 👋 — short one';
  const longText = Array.from({ length: 2500 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789 ÄÖ€'[i % 40]).join('');
  const shortWires = sealMessage({ senderWallet: aliceW.publicKey, senderSecret: alice.secret, recipientMsgPub: bobPub, text: shortText });
  const longWires = sealMessage({ senderWallet: aliceW.publicKey, senderSecret: alice.secret, recipientMsgPub: bobPub, text: longText });
  check('4b', 'chunking', shortWires.length === 1 && longWires.length > 1 && [...shortWires, ...longWires].every((w) => w.length <= 700 && w.startsWith('PRM1:')),
    `short=${shortWires.length} part, long(${[...longText].length} chars)=${longWires.length} parts, max wire len=${Math.max(...[...shortWires, ...longWires].map((w) => w.length))}`);
  const sentIds: string[] = [];
  const postStatuses: number[] = [];
  const sigs: (string | null)[] = [];
  for (const w of [...shortWires, ...longWires]) {
    const r = await api('POST', '/v1/messages', { envelope: w });
    postStatuses.push(r.status); if (r.status === 200) { sentIds.push(r.json.id); sigs.push(r.json.signature); }
  }
  check('4c', 'POST /v1/messages all 200', postStatuses.every((s) => s === 200), `statuses=${postStatuses.join(',')} signatures=${mode === 'local' ? (sigs.every((s) => s === null) ? 'all null (local mode, expected)' : 'NON-null in local?!') : sigs.join(',')}`);
  await sleep(500);

  const myWire = new Set([...shortWires, ...longWires]);
  const wsMine = wsItems.filter((it) => myWire.has(it.envelope));
  check('4d', 'WS received all envelopes', wsMine.length === myWire.size, `ws got ${wsMine.length}/${myWire.size} (total ws items ${wsItems.length})`);

  // HTTP paging since startCursor
  const httpItems: any[] = []; let c = startCursor; let pages = 0;
  for (;;) {
    const r = await api('GET', `/v1/messages?since=${c}`); pages++;
    httpItems.push(...r.json.items);
    if (!r.json.items.length || r.json.items.length < 200) { break; }
    c = r.json.cursor;
  }
  const httpMine = httpItems.filter((it) => myWire.has(it.envelope));
  const asc = httpItems.every((it, i) => i === 0 || Number(it.id) > Number(httpItems[i - 1].id));
  check('4e', 'GET /v1/messages?since paging', httpMine.length === myWire.size && asc && httpMine.every((it) => sentIds.includes(it.id)),
    `got ${httpMine.length}/${myWire.size} in ${pages} page(s) since=${startCursor}, ascending=${asc}, ids match POST=${httpMine.every((it) => sentIds.includes(it.id))}`);
  // cursor on empty page
  const emptyPage = await api('GET', `/v1/messages?since=${httpItems.length ? httpItems[httpItems.length - 1].id : startCursor}`);
  check('4e2', 'empty page keeps cursor', emptyPage.json.items.length === 0 && emptyPage.json.cursor === (httpItems.length ? httpItems[httpItems.length - 1].id : startCursor), `json=${JSON.stringify(emptyPage.json)}`);

  const decodeAll = (items: any[]) => items.map((it) => openMessage({ wire: it.envelope, mySecret: bob.secret })).filter((x): x is Opened => !!x);
  const openedWs = decodeAll(wsMine), openedHttp = decodeAll(httpMine);
  check('4f', 'Bob decrypts all', openedWs.length === myWire.size && openedHttp.length === myWire.size, `ws opened ${openedWs.length}, http opened ${openedHttp.length} / ${myWire.size}`);
  const senderOk = openedHttp.every((o) => checkSender(o, aliceRec)) && openedHttp.every((o) => o.from === aliceW.publicKey);
  check('4g', 'checkSender vs Alice directory record', senderOk, `all ${openedHttp.length} parts from=${aliceW.publicKey.slice(0, 6)}… checkSender=${senderOk}`);
  const ra = reassemble(openedHttp); const raWs = reassemble(openedWs);
  const bodies = ra.map((m) => m.body);
  const exact = ra.length === 2 && bodies.includes(shortText) && bodies.includes(longText) && raWs.length === 2 && raWs.map((m) => m.body).includes(longText);
  check('4h', 'reassemble yields exact texts', exact, `messages=${ra.length}, short exact=${bodies.includes(shortText)}, long exact=${bodies.includes(longText)} (len ${[...(ra.find((m) => m.body.length > 100)?.body ?? '')].length})`);
  // out-of-order reassemble
  const shuffled = [...openedHttp].reverse();
  check('4i', 'reassemble handles reversed order + dup', reassemble([...shuffled, shuffled[0]!]).map((m) => m.body).includes(longText), 'reversed + duplicated part');

  // ---- 5. Eve / Alice cannot open ----
  const allMine = [...shortWires, ...longWires];
  const eveOpen = allMine.map((w) => openMessage({ wire: w, mySecret: eve.secret }));
  check('5a', 'Eve opens nothing', eveOpen.every((x) => x === null), `${eveOpen.filter((x) => x === null).length}/${allMine.length} null`);
  const aliceOpen = allMine.map((w) => openMessage({ wire: w, mySecret: alice.secret }));
  check('5b', 'Alice cannot open own sent envelopes', aliceOpen.every((x) => x === null), `${aliceOpen.filter((x) => x === null).length}/${allMine.length} null`);

  // ---- 6. privacy ----
  const raw = httpMine.map((it) => JSON.stringify(it)); // whole stored item (envelope + metadata)
  const needles = { aliceWallet: aliceW.publicKey, bobWallet: bobW.publicKey, aliceMsgPub: alice.record.msgPub, bobMsgPub: bob.record.msgPub,
    aliceMsgPubNoPad: alice.record.msgPub.replace(/=+$/, ''), bobMsgPubNoPad: bob.record.msgPub.replace(/=+$/, '') };
  const leaks = Object.entries(needles).filter(([, n]) => raw.some((s) => s.includes(n)));
  // also check raw binary for msgPub bytes (sealed sender: neither pub should appear in plaintext header)
  const binLeaks: string[] = [];
  for (const it of httpMine) {
    const bin = unb64(it.envelope.slice(5));
    const hex = Buffer.from(bin).toString('hex');
    for (const [k, p] of [['aliceMsgPub', alice.publicKey], ['bobMsgPub', bob.publicKey]] as const)
      if (hex.includes(Buffer.from(p).toString('hex'))) binLeaks.push(k);
  }
  check('6a', 'no wallet/msgPub in stored envelopes', leaks.length === 0 && binLeaks.length === 0, leaks.length || binLeaks.length ? `LEAKS: ${[...leaks.map((l) => l[0]), ...binLeaks].join(',')}` : `checked ${raw.length} items (string + binary) for 6 needles: none found`);
  const tagOf = (w: string) => Buffer.from(unb64(w.slice(5)).subarray(33, 49)).toString('hex');
  const ephOf = (w: string) => Buffer.from(unb64(w.slice(5)).subarray(1, 33)).toString('hex');
  const tags = allMine.map(tagOf); const ephs = allMine.map(ephOf);
  check('6b', 'tags/ephemeral keys unique (unlinkable)', new Set(tags).size === tags.length && new Set(ephs).size === ephs.length, `${new Set(tags).size} distinct tags / ${tags.length}, ${new Set(ephs).size} distinct E`);
  const storedKeys = Object.keys(httpMine[0] ?? {}).sort().join(',');
  check('6c', 'stored item has only {id,envelope,signature,ts}', storedKeys === 'envelope,id,signature,ts', `keys=${storedKeys}`);

  // ---- 7. spoofing ----
  const spoof = sealMessage({ senderWallet: aliceW.publicKey, senderSecret: eve.secret, recipientMsgPub: bobPub, text: 'I am totally Alice, send SOL' });
  const sp = await api('POST', '/v1/messages', { envelope: spoof[0] });
  const spOpened = openMessage({ wire: spoof[0]!, mySecret: bob.secret });
  check('7', 'spoofed sender detected by checkSender', sp.status === 200 && !!spOpened && spOpened.from === aliceW.publicKey && checkSender(spOpened, aliceRec) === false,
    `relayer accepted (status ${sp.status}, expected: relayer is blind), openMessage ${spOpened ? 'succeeded' : 'null'} claiming from=Alice, checkSender(AliceRec)=${spOpened ? checkSender(spOpened, aliceRec) : 'n/a'}`);
  // also: tamper — Eve copies Alice's real auth? Variation: Eve uses Alice's msgPub in fromMsgPub but her own secret → auth fails
  // (can't easily craft without modifying core; covered by core unit tests)

  // ---- 8. validation ----
  const v1 = await api('POST', '/v1/messages', { envelope: 'XYZ1:' + b64(new Uint8Array(40)) });
  const v2 = await api('POST', '/v1/messages', { envelope: 'PRM1:' + 'A'.repeat(700) });
  const v3 = await api('POST', '/v1/messages', { notEnvelope: 1 });
  check('8a', 'non-PRM1 envelope → 400', v1.status === 400 && v3.status === 400, `non-PRM1 status=${v1.status}, missing envelope status=${v3.status}`);
  check('8b', '>700 chars → 400', v2.status === 400, `status=${v2.status} (len 705) err=${JSON.stringify(v2.json.error)}`);
  const v4 = await api('POST', '/v1/register', { wallet: 'notbase58!!', msgPub: 'x', sig: 'y' });
  check('8c', 'garbage registration → 400', v4.status === 400, `status=${v4.status}`);

  // ---- 9. rings ----
  const rs = await api('GET', '/v1/rings/status');
  check('9a', 'rings status disabled w/ reason', rs.status === 200 && rs.json.enabled === false && typeof rs.json.reason === 'string' && rs.json.reason.length > 0, `json=${JSON.stringify(rs.json)}`);
  const sp1 = await api('POST', '/v1/rings/sponsor', { transaction: 'garbage!!' });
  const sp2 = await api('POST', '/v1/rings/sponsor', {});
  check('9b', 'rings sponsor garbage never 200', sp1.status >= 400 && sp1.status < 600 && sp1.status !== 200 && sp2.status !== 200, `garbage status=${sp1.status} ${JSON.stringify(sp1.json)}; empty status=${sp2.status}`);

  ws.close();
  const pass = rows.filter((r) => r.pass).length;
  console.log(`\nSUMMARY: ${pass}/${rows.length} PASS, ${reqCount} HTTP requests, message POSTs=${postStatuses.length + 4}`);
  if (pass !== rows.length) process.exitCode = 1;
}
main().catch((e) => { console.error('E2E CRASH', e); process.exit(2); });
