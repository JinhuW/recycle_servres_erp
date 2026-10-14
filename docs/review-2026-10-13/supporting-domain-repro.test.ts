import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, getTestDb, TEST_DATABASE_URL } from './helpers/db';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';
import { buildXlsxWorkbook } from '../src/lib/xlsx';

describe('support review reproductions', () => {
  beforeEach(resetDb);
  it('package attribution merges distinct Unicode client names', async () => {
    const sql = getTestDb(); const mgr = await loginAs(ALEX);
    const [wrong] = await sql`INSERT INTO suppliers(name,owner_id) VALUES ('王 RAM',${mgr.user.id}) RETURNING id`;
    await sql`INSERT INTO suppliers(name,owner_id) VALUES ('李 RAM',${mgr.user.id})`;
    const [pkg] = await sql`INSERT INTO packages(tracking_number,carrier,seller_name,created_by) VALUES ('999999999991','UPS','李 RAM',${mgr.user.id}) RETURNING id`;
    const res = await api<{orderId:string}>('POST',`/api/packages/${pkg.id}/create-po`,{token:mgr.token});
    expect(res.status).toBe(201);
    const [order] = await sql`SELECT supplier_id FROM orders WHERE id=${res.body.orderId}`;
    expect(order.supplier_id).toBe(wrong.id);
  });
  it('supplier soon filter is evaluated after limiting away soon clients', async () => {
    const sql = getTestDb(); const owner=await loginAs(MARCUS);
    await sql`INSERT INTO suppliers(name,owner_id,next_follow_up_at) VALUES ('Review overdue',${owner.user.id},CURRENT_DATE-1),('Review soon',${owner.user.id},CURRENT_DATE+1)`;
    const res=await api<{items:unknown[];counts:{soon:number}}>('GET','/api/suppliers?limit=1&follow=soon',{token:owner.token});
    expect(res.status).toBe(200); expect(res.body.items).toEqual([]); expect(res.body.counts.soon).toBe(0);
  });
  it('former owner patch commits after ownership handover', async () => {
    const sql=getTestDb(); const owner=await loginAs(MARCUS); const next=await loginAs(PRIYA);
    const [s]=await sql`INSERT INTO suppliers(name,owner_id) VALUES ('Review race',${owner.user.id}) RETURNING id`;
    let release!:()=>void; let locked!:()=>void;
    const gate=new Promise<void>(r=>release=r); const ready=new Promise<void>(r=>locked=r);
    const blocker=sql.begin(async tx=>{ await tx`SELECT id FROM suppliers WHERE id=${s.id} FOR UPDATE`; locked(); await gate; await tx`UPDATE suppliers SET owner_id=${next.user.id} WHERE id=${s.id}`; });
    await ready;
    const pending=api('PATCH',`/api/suppliers/${s.id}`,{token:owner.token,body:{notes:'former owner wrote this'}});
    let waited=false;
    for(let i=0;i<200;i++){ const [v]=await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%UPDATE suppliers SET updated_at%') AS waiting`; if(v.waiting){waited=true;break;} await new Promise(r=>setTimeout(r,10)); }
    release(); await blocker; expect(waited).toBe(true); expect((await pending).status).toBe(200);
    const [after]=await sql`SELECT owner_id,notes FROM suppliers WHERE id=${s.id}`;
    expect(after.owner_id).toBe(next.user.id); expect(after.notes).toBe('former owner wrote this');
  });
  it.each([['A'.repeat(31),'A'.repeat(31)],['RAM','ram'],['A','A','A 2']])('xlsx cannot deconflict sheet names %j',async (...names:string[])=>{
    await expect(buildXlsxWorkbook(names.map(name=>({name,columns:[],rows:[]})))).rejects.toThrow();
  });
  it('failed seed leaves append-only protection disabled',async()=>{
    const sql=getTestDb();
    await sql.unsafe("CREATE FUNCTION review_block_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review injected failure'; END $$");
    await sql.unsafe('CREATE TRIGGER review_block_delete BEFORE DELETE ON inventory_events FOR EACH STATEMENT EXECUTE FUNCTION review_block_delete()');
    const result=spawnSync('node',[fileURLToPath(new URL('../scripts/seed.mjs',import.meta.url))],{env:{...process.env,DATABASE_URL:TEST_DATABASE_URL,NODE_ENV:'test'},encoding:'utf8'});
    expect(result.status).not.toBe(0);
    const [trigger]=await sql`SELECT tgenabled FROM pg_trigger WHERE tgname='inventory_events_no_delete'`;
    expect(trigger.tgenabled).toBe('D');
  });
});
