#!/usr/bin/env node
// Seed Postgres with users, warehouses, ref_prices, and a backlog of orders
// matching the prototype's data.jsx generator (deterministic via fixed seed).

import postgres from 'postgres';
import bcrypt from 'bcryptjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';

const here = dirname(fileURLToPath(import.meta.url));
function loadDevVars() {
  try {
    const raw = readFileSync(join(here, '..', '.dev.vars'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch (_) {}
}
loadDevVars();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const sql = postgres(url, { onnotice: () => {} });

// ── Deterministic PRNG (mirrors data.jsx) ────────────────────────────────────
const seed = (s) => () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
const rand = seed(42);
const pick = (a) => a[Math.floor(rand() * a.length)];
const randInt = (a, b) => Math.floor(rand() * (b - a + 1)) + a;

// ── Users ───────────────────────────────────────────────────────────────────
const USERS = [
  { id: 'u1', name: 'Alex Chen',     initials: 'AC', role: 'manager',   email: 'alex@recycleservers.io',   team: 'HK Ops' },
  { id: 'u2', name: 'Marcus Wright', initials: 'MW', role: 'purchaser', email: 'marcus@recycleservers.io', team: 'HK Ops' },
  { id: 'u3', name: 'Priya Shah',    initials: 'PS', role: 'purchaser', email: 'priya@recycleservers.io',  team: 'HK Ops' },
  { id: 'u4', name: 'Diego Ramos',   initials: 'DR', role: 'purchaser', email: 'diego@recycleservers.io',  team: 'SG Ops' },
  { id: 'u5', name: 'Yuki Tanaka',   initials: 'YT', role: 'purchaser', email: 'yuki@recycleservers.io',   team: 'SG Ops' },
  { id: 'u6', name: 'Lina Park',     initials: 'LP', role: 'purchaser', email: 'lina@recycleservers.io',   team: 'HK Ops' },
];

const WAREHOUSES = [
  { id: 'WH-LA1', name: 'Los Angeles · LA1', short: 'LA1', region: 'US-West',
    address: '2401 E. 8th St, Los Angeles, CA 90021',
    timezone: 'America/Los_Angeles' },
  { id: 'WH-DAL', name: 'Dallas · DAL', short: 'DAL', region: 'US-Central',
    address: '6900 Ambassador Row, Dallas, TX 75247',
    timezone: 'America/Chicago' },
  { id: 'WH-NJ2', name: 'Newark · NJ2', short: 'NJ2', region: 'US-East',
    address: '180 Raymond Blvd, Newark, NJ 07102',
    timezone: 'America/New_York' },
  { id: 'WH-HK', name: 'Hong Kong · HK', short: 'HK', region: 'APAC',
    address: 'Unit 12, Goodman Tsing Yi, Hong Kong',
    timezone: 'Asia/Hong_Kong' },
  { id: 'WH-AMS', name: 'Amsterdam · AMS', short: 'AMS', region: 'EMEA',
    address: 'Schiphol Logistics Park, 1118 BE Amsterdam',
    timezone: 'Europe/Amsterdam' },
];

const RAM_BRANDS = ['Samsung', 'SK Hynix', 'Micron', 'Kingston', 'Other'];
const RAM_TYPES  = ['DDR3', 'DDR4', 'DDR5'];
const RAM_CLASS  = ['UDIMM', 'RDIMM', 'LRDIMM', 'SODIMM'];
const RAM_RANK   = ['1Rx16', '1Rx8', '1Rx4', '2Rx16', '2Rx8', '2Rx4', '4Rx8', '4Rx4', '8Rx4'];
const RAM_CAP    = ['4GB','8GB','16GB','32GB','64GB','128GB'];
const RAM_SPEED  = ['800','1066','1333','1600','1866','2133','2400','2666','2933','3200','4000','4400','4800','5200','5600','6000','6400','6800','7200','7600','8000'];
const SSD_BRANDS = ['Samsung','Intel','Micron','WD','Seagate','Kioxia'];
const SSD_IFACE  = ['SATA','SAS','NVMe','U.2'];
const SSD_FORM   = ['2.5"','M.2 2280','M.2 22110','U.2','AIC'];
const SSD_CAP    = ['240GB','480GB','960GB','1.92TB','3.84TB','7.68TB'];
const HDD_BRANDS = ['Seagate','WD','Toshiba','HGST'];
const HDD_IFACE  = ['SATA','SAS'];
const HDD_FORM   = ['2.5"','3.5"'];
const HDD_CAP    = ['500GB','1TB','2TB','4TB','8TB','16TB'];
const HDD_RPM    = [5400, 7200, 10000, 15000];
const CONDITIONS = ['New','Pulled — Tested','Pulled — Untested','Used'];
// Per-line statuses match the desktop bundle's data.jsx:
//   Draft (purchaser is preparing) → In Transit → Reviewing → Done.
const STATUSES   = ['Draft','In Transit','In Transit','Reviewing','Reviewing','Reviewing','Done','Done'];

function makePartNumber(brand, type, cap) {
  const codes = { Samsung:'M393A', 'SK Hynix':'HMA', Micron:'MTA', Kingston:'KSM' };
  const code = codes[brand] || 'XXX';
  return `${code}${randInt(1000,9999)}${type.replace('DDR','D')}-${cap.replace('GB','')}`;
}

function pickLifecycle(status) {
  if (status === 'In Transit') return 'in_transit';
  if (status === 'Reviewing')  return 'reviewing';
  if (status === 'Done')       return 'done';
  return 'draft';
}

// ── Build submissions, then collapse into orders (one order per
//    user+date+category, mirroring how the phone screen groups them).
function buildSubmissions() {
  const out = [];
  const now = new Date('2026-04-26T10:00:00Z');
  let id = 1000;
  for (let i = 0; i < 84; i++) {
    const user = USERS[randInt(1, 5)];
    const cat = ['RAM','RAM','SSD','SSD','HDD','HDD','Other'][randInt(0,6)];
    const daysAgo = randInt(0, 60);
    const date = new Date(now.getTime() - daysAgo*86400000 - randInt(0,86400)*1000);
    const qty = randInt(1, 12);
    let row = { category: cat };
    if (cat === 'RAM') {
      const brand = pick(RAM_BRANDS), type = pick(RAM_TYPES), cap = pick(RAM_CAP);
      Object.assign(row, {
        brand, capacity: cap, type,
        classification: pick(RAM_CLASS), rank: pick(RAM_RANK), speed: pick(RAM_SPEED),
        partNumber: makePartNumber(brand, type, cap),
        condition: pick(CONDITIONS),
        unitCost: +(randInt(8,220)+rand()).toFixed(2),
      });
      row.sellPrice = +(row.unitCost * (1.25 + rand()*0.6)).toFixed(2);
    } else if (cat === 'SSD') {
      const brand = pick(SSD_BRANDS), cap = pick(SSD_CAP);
      Object.assign(row, {
        brand, capacity: cap,
        interface: pick(SSD_IFACE), formFactor: pick(SSD_FORM),
        partNumber: `${brand.slice(0,3).toUpperCase()}-${cap.replace('TB','000').replace('GB','')}-${randInt(100,999)}`,
        condition: pick(CONDITIONS),
        unitCost: +(randInt(25,480)+rand()).toFixed(2),
        health: +(60 + rand()*40).toFixed(1),
      });
      row.sellPrice = +(row.unitCost * (1.22 + rand()*0.5)).toFixed(2);
    } else if (cat === 'HDD') {
      const brand = pick(HDD_BRANDS), cap = pick(HDD_CAP);
      Object.assign(row, {
        brand, capacity: cap,
        interface: pick(HDD_IFACE), formFactor: pick(HDD_FORM),
        rpm: pick(HDD_RPM),
        partNumber: `${brand.slice(0,3).toUpperCase()}-${cap.replace('TB','000').replace('GB','')}-${randInt(100,999)}`,
        condition: pick(CONDITIONS),
        unitCost: +(randInt(15,320)+rand()).toFixed(2),
        health: +(60 + rand()*40).toFixed(1),
      });
      row.sellPrice = +(row.unitCost * (1.20 + rand()*0.45)).toFixed(2);
    } else {
      const items = ['CPU — Xeon Gold 6248','PSU — 750W Platinum','NIC — Mellanox CX5','GPU Cooler','Heatsink — 2U','Riser Card 1x16'];
      Object.assign(row, {
        description: pick(items),
        partNumber: 'OTH-' + randInt(10000,99999),
        condition: pick(CONDITIONS),
        unitCost: +(randInt(15,320)+rand()).toFixed(2),
      });
      row.sellPrice = +(row.unitCost * (1.2 + rand()*0.55)).toFixed(2);
    }
    row.qty = qty;
    row.warehouse = pick(WAREHOUSES);
    row.id = 'SO-LINE-' + (id++);
    row.userId = user.id;
    row.date = date;
    row.status = STATUSES[randInt(0, STATUSES.length-1)];
    row.lifecycle = pickLifecycle(row.status);
    out.push(row);
  }
  return out.sort((a,b) => b.date - a.date);
}

function buildOrders(subs) {
  const byKey = {};
  subs.forEach(r => {
    const k = r.userId + '|' + r.date.toDateString() + '|' + r.category;
    (byKey[k] ||= []).push(r);
  });
  let oid = 1289;
  const orders = [];
  for (const group of Object.values(byKey)) {
    let i = 0;
    while (i < group.length) {
      const size = Math.min(group.length - i, 1 + (group[i].id.charCodeAt(group[i].id.length-1) % 3));
      const lines = group.slice(i, i+size);
      const totalCost = lines.reduce((a,l) => a + l.unitCost*l.qty, 0);
      orders.push({
        id: 'SO-' + (oid++),
        user_id: lines[0].userId,
        category: lines[0].category,
        warehouse_id: lines[0].warehouse.id,
        payment: rand() > 0.4 ? 'company' : 'self',
        notes: null,
        total_cost: +totalCost.toFixed(2),
        lifecycle: lines[0].lifecycle,
        created_at: lines[0].date,
        lines: lines.map((l, idx) => ({
          category: l.category,
          brand: l.brand || null,
          capacity: l.capacity || null,
          type: l.type || null,
          classification: l.classification || null,
          rank_: l.rank || null,
          speed: l.speed || null,
          interface: l.interface || null,
          form_factor: l.formFactor || null,
          description: l.description || null,
          part_number: l.partNumber,
          condition: l.condition,
          qty: l.qty,
          unit_cost: l.unitCost,
          sell_price: l.sellPrice,
          status: l.status,
          position: idx,
          health: l.health ?? null,
          rpm: l.rpm ?? null,
        })),
      });
      i += size;
    }
  }
  return orders;
}

// ── Reference prices (matrix that mirrors REF_PRICES in data.jsx) ───────────
function buildRefPrices() {
  const out = [];
  let id = 5000;
  const ramSpec = [
    { brand:'Samsung', type:'DDR4', cap:'32GB', cls:'RDIMM', rank:'2Rx4', speed:'3200', base:78 },
    { brand:'Samsung', type:'DDR4', cap:'64GB', cls:'RDIMM', rank:'2Rx4', speed:'3200', base:142 },
    { brand:'Samsung', type:'DDR5', cap:'32GB', cls:'RDIMM', rank:'2Rx8', speed:'4800', base:165 },
    { brand:'Samsung', type:'DDR5', cap:'64GB', cls:'RDIMM', rank:'2Rx4', speed:'5600', base:285 },
    { brand:'Hynix',   type:'DDR4', cap:'32GB', cls:'RDIMM', rank:'2Rx4', speed:'2933', base:72 },
    { brand:'Hynix',   type:'DDR4', cap:'64GB', cls:'LRDIMM',rank:'4Rx4', speed:'2666', base:128 },
    { brand:'Hynix',   type:'DDR5', cap:'32GB', cls:'RDIMM', rank:'2Rx8', speed:'4800', base:158 },
    { brand:'Micron',  type:'DDR4', cap:'16GB', cls:'RDIMM', rank:'1Rx4', speed:'2666', base:38 },
    { brand:'Micron',  type:'DDR4', cap:'32GB', cls:'RDIMM', rank:'2Rx8', speed:'3200', base:75 },
    { brand:'Micron',  type:'DDR5', cap:'64GB', cls:'RDIMM', rank:'2Rx4', speed:'4800', base:270 },
    { brand:'Kingston',type:'DDR4', cap:'16GB', cls:'UDIMM', rank:'1Rx8', speed:'3200', base:32 },
    { brand:'Kingston',type:'DDR4', cap:'32GB', cls:'UDIMM', rank:'2Rx8', speed:'3200', base:68 },
    { brand:'Samsung', type:'DDR3', cap:'8GB',  cls:'RDIMM', rank:'2Rx8', speed:'1866', base:12 },
    { brand:'Hynix',   type:'DDR3', cap:'16GB', cls:'RDIMM', rank:'2Rx4', speed:'1600', base:18 },
  ];
  ramSpec.forEach(r => {
    const variance = 0.06 + rand()*0.04;
    const trend = (rand() - 0.45) * 0.18;
    out.push({
      id: 'RP-' + (id++), category: 'RAM',
      brand: r.brand, type: r.type, capacity: r.cap, classification: r.cls, rank: r.rank, speed: r.speed,
      part_number: makePartNumber(r.brand, r.type, r.cap),
      label: `${r.brand} ${r.cap} ${r.type}`,
      sub_label: `${r.cls} · ${r.speed}MHz`,
      target: +r.base.toFixed(2),
      low_price: +(r.base * (1 - variance)).toFixed(2),
      high_price: +(r.base * (1 + variance)).toFixed(2),
      avg_sell: +(r.base * (1.3 + rand()*0.3)).toFixed(2),
      trend: +trend.toFixed(3),
      samples: randInt(8,64),
      source: pick(['Internal — last 30d','Broker quotes','Market index','Supplier list']),
      stock: randInt(0,80),
      demand: ['high','high','medium','medium','low'][randInt(0,4)],
      updated_at: new Date(Date.now() - randInt(1,14)*86400000),
    });
  });

  const ssdSpec = [
    { brand:'Samsung', cap:'960GB',  iface:'SATA', form:'2.5"',     base:58 },
    { brand:'Samsung', cap:'1.92TB', iface:'NVMe', form:'M.2 22110',base:178 },
    { brand:'Samsung', cap:'3.84TB', iface:'NVMe', form:'U.2',      base:320 },
    { brand:'Intel',   cap:'960GB',  iface:'SATA', form:'2.5"',     base:52 },
    { brand:'Intel',   cap:'1.92TB', iface:'NVMe', form:'U.2',      base:165 },
    { brand:'Intel',   cap:'3.84TB', iface:'NVMe', form:'U.2',      base:305 },
    { brand:'Micron',  cap:'480GB',  iface:'SATA', form:'2.5"',     base:28 },
    { brand:'Micron',  cap:'1.92TB', iface:'NVMe', form:'M.2 2280', base:158 },
    { brand:'WD',      cap:'960GB',  iface:'NVMe', form:'M.2 2280', base:72 },
    { brand:'Kioxia',  cap:'7.68TB', iface:'NVMe', form:'U.2',      base:540 },
  ];
  ssdSpec.forEach(s => {
    const variance = 0.07 + rand()*0.05;
    const trend = (rand() - 0.5) * 0.15;
    out.push({
      id: 'RP-' + (id++), category: 'SSD',
      brand: s.brand, capacity: s.cap, interface: s.iface, form_factor: s.form,
      part_number: `${s.brand.slice(0,3).toUpperCase()}-${s.cap.replace('TB','000').replace('GB','')}-${randInt(100,999)}`,
      label: `${s.brand} ${s.cap}`,
      sub_label: `${s.iface} · ${s.form}`,
      target: +s.base.toFixed(2),
      low_price: +(s.base * (1 - variance)).toFixed(2),
      high_price: +(s.base * (1 + variance)).toFixed(2),
      avg_sell: +(s.base * (1.28 + rand()*0.3)).toFixed(2),
      trend: +trend.toFixed(3),
      samples: randInt(6,42),
      source: pick(['Internal — last 30d','Broker quotes','Market index','Supplier list']),
      stock: randInt(0,60),
      demand: ['high','medium','medium','low'][randInt(0,3)],
      updated_at: new Date(Date.now() - randInt(1,14)*86400000),
    });
  });

  const hddSpec = [
    { brand:'Seagate', cap:'2TB',  iface:'SATA', form:'3.5"', rpm:7200, base:35 },
    { brand:'Seagate', cap:'4TB',  iface:'SAS',  form:'3.5"', rpm:7200, base:62 },
    { brand:'Seagate', cap:'8TB',  iface:'SAS',  form:'3.5"', rpm:7200, base:128 },
    { brand:'WD',      cap:'4TB',  iface:'SATA', form:'3.5"', rpm:5400, base:48 },
    { brand:'WD',      cap:'8TB',  iface:'SATA', form:'3.5"', rpm:7200, base:115 },
    { brand:'Toshiba', cap:'2TB',  iface:'SATA', form:'2.5"', rpm:7200, base:42 },
    { brand:'HGST',    cap:'4TB',  iface:'SAS',  form:'3.5"', rpm:10000,base:78 },
    { brand:'HGST',    cap:'16TB', iface:'SAS',  form:'3.5"', rpm:7200, base:285 },
  ];
  hddSpec.forEach(h => {
    const variance = 0.08 + rand()*0.05;
    const trend = (rand() - 0.5) * 0.12;
    out.push({
      id: 'RP-' + (id++), category: 'HDD',
      brand: h.brand, capacity: h.cap, interface: h.iface, form_factor: h.form, rpm: h.rpm,
      part_number: `${h.brand.slice(0,3).toUpperCase()}-${h.cap.replace('TB','000').replace('GB','')}-${randInt(100,999)}`,
      label: `${h.brand} ${h.cap}`,
      sub_label: `${h.iface} · ${h.form} · ${h.rpm}rpm`,
      target: +h.base.toFixed(2),
      low_price: +(h.base * (1 - variance)).toFixed(2),
      high_price: +(h.base * (1 + variance)).toFixed(2),
      avg_sell: +(h.base * (1.25 + rand()*0.3)).toFixed(2),
      trend: +trend.toFixed(3),
      samples: randInt(4,30),
      source: pick(['Internal — last 30d','Broker quotes','Market index','Supplier list']),
      stock: randInt(0,40),
      demand: ['medium','medium','low','low'][randInt(0,3)],
      updated_at: new Date(Date.now() - randInt(1,14)*86400000),
    });
  });

  const otherSpec = [
    { desc:'Intel Xeon Gold 6248',     base:195 },
    { desc:'Intel Xeon Gold 6230',     base:158 },
    { desc:'Intel Xeon Silver 4214',   base:88 },
    { desc:'Mellanox CX5 100GbE NIC',  base:245 },
    { desc:'Broadcom 9361-8i HBA',     base:105 },
    { desc:'PSU — 750W Platinum',      base:78 },
    { desc:'PSU — 1100W Platinum',     base:142 },
    { desc:'NVIDIA T4 GPU',            base:685 },
  ];
  otherSpec.forEach(o => {
    const variance = 0.08 + rand()*0.06;
    const trend = (rand() - 0.5) * 0.2;
    out.push({
      id: 'RP-' + (id++), category: 'Other',
      description: o.desc,
      part_number: 'OTH-' + randInt(10000,99999),
      label: o.desc,
      sub_label: 'Component',
      target: +o.base.toFixed(2),
      low_price: +(o.base * (1 - variance)).toFixed(2),
      high_price: +(o.base * (1 + variance)).toFixed(2),
      avg_sell: +(o.base * (1.25 + rand()*0.3)).toFixed(2),
      trend: +trend.toFixed(3),
      samples: randInt(4,28),
      source: pick(['Internal — last 30d','Broker quotes','Market index','Supplier list']),
      stock: randInt(0,30),
      demand: ['high','medium','low'][randInt(0,2)],
      updated_at: new Date(Date.now() - randInt(1,21)*86400000),
    });
  });

  // 12-week sparkline history per item
  out.forEach(p => {
    const arr = [];
    let v = p.target * (1 - p.trend);
    for (let i = 0; i < 12; i++) {
      v = v * (1 + (rand() - 0.5) * 0.05 + p.trend / 12);
      arr.push(+v.toFixed(2));
    }
    p.history = arr;
  });
  return out;
}

function buildNotificationsForUser(userId) {
  const min = (n) => new Date(Date.now() - n*60*1000);
  const hr  = (n) => new Date(Date.now() - n*3600*1000);
  const d   = (n) => new Date(Date.now() - n*86400*1000);
  return [
    { user_id:userId, kind:'status',     tone:'pos',    icon:'check2',    title:'Sold — commission released',         body:'Samsung 32GB DDR4 · qty 4 cleared. $84 added to your balance.', unread:true,  created_at: min(8) },
    { user_id:userId, kind:'price',      tone:'accent', icon:'trending',  title:'Price watch — Samsung 32GB DDR5',     body:'Avg sell up 4.2% this week. Buy ceiling now $114 — more headroom.', unread:true, created_at: min(42) },
    { user_id:userId, kind:'mention',    tone:'info',   icon:'mail',      title:'Alex mentioned you',                  body:'"Marcus — can we re-quote SO-1287? Customer pushing for 6% off."', unread:true, created_at: hr(2) },
    { user_id:userId, kind:'status',     tone:'info',   icon:'truck',     title:'Hynix 64GB DDR4 → In Transit',        body:'Carrier picked up at HK warehouse. ETA Wed, 14 May.', unread:false, created_at: hr(5) },
    { user_id:userId, kind:'price',      tone:'warn',   icon:'trendDown', title:'Price watch — Intel 3.84TB U.2',      body:'Avg sell down 3.1%. Tighten buy targets — last paid $498 vs new ceiling $462.', unread:false, created_at: hr(9) },
    { user_id:userId, kind:'commission', tone:'pos',    icon:'cash',      title:'Weekly commission paid',              body:'$342 deposited from 6 closed orders. Statement in Profile.', unread:false, created_at: d(1) },
    { user_id:userId, kind:'system',     tone:'muted',  icon:'sparkles',  title:'AI label scan got better',            body:'New model reads worn DDR3 labels 22% more accurately. No action needed.', unread:false, created_at: d(2) },
    { user_id:userId, kind:'status',     tone:'accent', icon:'eye',       title:'Micron 1.92TB → Listed',              body:"Live for customer offers at $124/unit. We'll ping when an offer lands.", unread:false, created_at: d(3) },
  ];
}

// ── Run ──────────────────────────────────────────────────────────────────────
try {
  console.log('· Seeding users…');
  const passwordHash = await bcrypt.hash('demo', 10);
  for (const u of USERS) {
    await sql`
      INSERT INTO users (email, name, initials, role, team, password_hash)
      VALUES (${u.email}, ${u.name}, ${u.initials}, ${u.role}, ${u.team}, ${passwordHash})
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name, initials = EXCLUDED.initials,
        role = EXCLUDED.role, team = EXCLUDED.team
    `;
  }
  // Map prototype IDs (u1..u6) → real UUIDs from the DB so order seeding works
  const dbUsers = await sql`SELECT id, email FROM users`;
  const emailToUuid = Object.fromEntries(dbUsers.map(r => [r.email, r.id]));
  const protoToUuid = {};
  for (const u of USERS) protoToUuid[u.id] = emailToUuid[u.email];

  console.log('· Seeding warehouses…');
  for (const w of WAREHOUSES) {
    await sql`
      INSERT INTO warehouses (
        id, name, short, region,
        address, timezone
      )
      VALUES (
        ${w.id}, ${w.name}, ${w.short}, ${w.region},
        ${w.address}, ${w.timezone}
      )
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name, short=EXCLUDED.short, region=EXCLUDED.region,
        address=EXCLUDED.address, timezone=EXCLUDED.timezone
    `;
  }

  console.log('· Seeding lookup tables…');
  // Catalog dropdowns — same option lists the frontend constants used to
  // hardcode in apps/frontend/src/lib/catalog.ts.
  const CATALOG_GROUPS = {
    RAM_BRAND:     RAM_BRANDS,
    RAM_TYPE:      RAM_TYPES,
    RAM_CLASS:     RAM_CLASS,
    RAM_RANK:      RAM_RANK,
    RAM_CAP:       RAM_CAP,
    RAM_SPEED:     RAM_SPEED,
    SSD_BRAND:     SSD_BRANDS,
    SSD_INTERFACE: SSD_IFACE,
    SSD_FORM:      SSD_FORM,
    SSD_CAP:       SSD_CAP,
    HDD_BRAND:     HDD_BRANDS,
    HDD_INTERFACE: HDD_IFACE,
    HDD_FORM:      HDD_FORM,
    HDD_CAP:       HDD_CAP,
    HDD_RPM:       HDD_RPM.map(String),
    CONDITION:     CONDITIONS,
  };
  await sql`DELETE FROM catalog_options`;
  for (const [group, values] of Object.entries(CATALOG_GROUPS)) {
    for (let i = 0; i < values.length; i++) {
      await sql`
        INSERT INTO catalog_options ("group", value, position)
        VALUES (${group}, ${values[i]}, ${i})
      `;
    }
  }

  const PRICE_SOURCES = [
    { id: 'internal-sales',   label: 'Internal sales (last 30d)' },
    { id: 'broker-techsurplus', label: 'Broker quote — TechSurplus' },
    { id: 'broker-servermonkey', label: 'Broker quote — ServerMonkey' },
    { id: 'index-ramspot',    label: 'Market index — RAM-spot.io' },
  ];
  await sql`DELETE FROM price_sources`;
  for (let i = 0; i < PRICE_SOURCES.length; i++) {
    const s = PRICE_SOURCES[i];
    await sql`
      INSERT INTO price_sources (id, label, position)
      VALUES (${s.id}, ${s.label}, ${i})
    `;
  }

  const SELL_ORDER_STATUSES = [
    { id: 'Draft',            short: 'Draft',        tone: 'muted', needsMeta: false },
    { id: 'Shipped',          short: 'Shipped',      tone: 'info',  needsMeta: true  },
    { id: 'Awaiting payment', short: 'Awaiting pay', tone: 'warn',  needsMeta: true  },
    { id: 'Done',             short: 'Done',         tone: 'pos',   needsMeta: true  },
  ];
  await sql`DELETE FROM sell_order_statuses`;
  for (let i = 0; i < SELL_ORDER_STATUSES.length; i++) {
    const s = SELL_ORDER_STATUSES[i];
    await sql`
      INSERT INTO sell_order_statuses (id, label, short_label, tone, needs_meta, position)
      VALUES (${s.id}, ${s.id}, ${s.short}, ${s.tone}, ${s.needsMeta}, ${i})
    `;
  }

  console.log('· Seeding ref_prices…');
  await sql`DELETE FROM ref_prices`;
  for (const p of buildRefPrices()) {
    await sql`
      INSERT INTO ref_prices (
        id, category, brand, capacity, type, classification, rank, speed,
        interface, form_factor, description, part_number,
        label, sub_label, target, low_price, high_price, avg_sell,
        trend, samples, source, stock, demand, history, updated_at,
        rpm
      ) VALUES (
        ${p.id}, ${p.category}, ${p.brand ?? null}, ${p.capacity ?? null}, ${p.type ?? null}, ${p.classification ?? null}, ${p.rank ?? null}, ${p.speed ?? null},
        ${p.interface ?? null}, ${p.form_factor ?? null}, ${p.description ?? null}, ${p.part_number},
        ${p.label}, ${p.sub_label}, ${p.target}, ${p.low_price}, ${p.high_price}, ${p.avg_sell},
        ${p.trend}, ${p.samples}, ${p.source}, ${p.stock}, ${p.demand}, ${sql.json(p.history)}, ${p.updated_at},
        ${p.rpm ?? null}
      )
    `;
  }

  console.log('· Seeding orders + lines…');
  await sql`DELETE FROM order_lines`;
  await sql`DELETE FROM orders`;
  const orders = buildOrders(buildSubmissions());
  for (const o of orders) {
    await sql`
      INSERT INTO orders (id, user_id, category, warehouse_id, payment, notes, total_cost, lifecycle, created_at)
      VALUES (${o.id}, ${protoToUuid[o.user_id]}, ${o.category}, ${o.warehouse_id}, ${o.payment}, ${o.notes}, ${o.total_cost}, ${o.lifecycle}, ${o.created_at})
    `;
    for (const l of o.lines) {
      await sql`
        INSERT INTO order_lines (
          order_id, category, brand, capacity, type, classification, rank, speed,
          interface, form_factor, description, part_number, condition, qty,
          unit_cost, sell_price, status, position, health, rpm
        ) VALUES (
          ${o.id}, ${l.category}, ${l.brand}, ${l.capacity}, ${l.type}, ${l.classification}, ${l.rank_}, ${l.speed},
          ${l.interface}, ${l.form_factor}, ${l.description}, ${l.part_number}, ${l.condition}, ${l.qty},
          ${l.unit_cost}, ${l.sell_price}, ${l.status}, ${l.position}, ${l.health}, ${l.rpm}
        )
      `;
    }
  }
  console.log(`  · ${orders.length} orders inserted`);

  console.log('· Seeding customers…');
  await sql`DELETE FROM customers`;
  const customers = [
    { name:'NorthBridge Data Centers', short:'NorthBridge',  contactName:'Dana Ortiz',   contactEmail:'ops@northbridge.io',       contactPhone:'+1-212-555-0147', address:'48 Hudson Yards, Floor 12\nNew York, NY 10001', country:'United States', region:'US-East',    tags:['hyperscaler','priority'] },
    { name:'Helios Cloud Pte Ltd',     short:'Helios Cloud', contactName:'Wei Lim',      contactEmail:'procurement@helios.sg',     contactPhone:'+65-6555-0192',   address:'1 Raffles Place, #20-01\nSingapore 048616',        country:'Singapore',     region:'APAC',       tags:['cloud'] },
    { name:'Verge Reseller Group',     short:'Verge',        contactName:'Maria Gomez',  contactEmail:'buy@vergegroup.com',        contactPhone:'+1-415-555-0173', address:'500 Howard St, Suite 300\nSan Francisco, CA 94105', country:'United States', region:'US-West',    tags:['reseller'] },
    { name:'Atlas Hosting GmbH',       short:'Atlas',        contactName:'Jonas Brandt', contactEmail:'einkauf@atlas-hosting.de',  contactPhone:'+49-30-5550-0188', address:'Friedrichstraße 68\n10117 Berlin',                  country:'Germany',       region:'EMEA',       tags:['hosting'] },
    { name:'Quantra Recyclers',        short:'Quantra',      contactName:'Priya Nair',   contactEmail:'deals@quantra.io',          contactPhone:'+1-312-555-0156', address:'233 S Wacker Dr, Floor 44\nChicago, IL 60606',      country:'United States', region:'US-Central', tags:['recycler'] },
    { name:'Lumen Refurb Co.',         short:'Lumen',        contactName:'Sam Patel',    contactEmail:'orders@lumenrefurb.com',    contactPhone:'+1-617-555-0121', address:'1 Boston Pl, Suite 2600\nBoston, MA 02108',        country:'United States', region:'US-East',    tags:['refurb'] },
  ];
  const customerRows = [];
  for (const c of customers) {
    const r = await sql`
      INSERT INTO customers (name, short_name, contact_name, contact_email, contact_phone, address, country, region, tags)
      VALUES (${c.name}, ${c.short}, ${c.contactName}, ${c.contactEmail}, ${c.contactPhone}, ${c.address}, ${c.country}, ${c.region}, ${c.tags})
      RETURNING id
    `;
    customerRows.push({ ...c, id: r[0].id });
  }

  console.log('· Seeding sell orders + lines…');
  await sql`DELETE FROM sell_order_lines`;
  await sql`DELETE FROM sell_orders`;
  // Pull sellable inventory lines (Selling/Sold) and group into 6 example sell orders.
  const sellable = await sql`
    SELECT l.id, l.category, l.brand, l.capacity, l.type, l.interface, l.form_factor,
           l.description, l.part_number, l.qty, l.sell_price::float AS sell_price,
           l.condition, l.classification, l.speed,
           o.warehouse_id
    FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE l.status IN ('Reviewing','Done') AND l.sell_price IS NOT NULL
    ORDER BY l.id
    LIMIT 36
  `;
  const sample = [
    { custIdx: 0, status: 'Draft',            ago: 1,  count: 6, discount: 0.04 },
    { custIdx: 3, status: 'Draft',            ago: 3,  count: 4, discount: 0.07 },
    { custIdx: 1, status: 'Shipped',          ago: 6,  count: 6, discount: 0.03 },
    { custIdx: 2, status: 'Shipped',          ago: 11, count: 5, discount: 0.05 },
    { custIdx: 4, status: 'Awaiting payment', ago: 18, count: 7, discount: 0.06 },
    { custIdx: 5, status: 'Done',             ago: 25, count: 3, discount: 0.02 },
  ];
  let soId = 4000;
  let cursor = 0;
  for (const s of sample) {
    const lines = sellable.slice(cursor, cursor + s.count);
    cursor += s.count;
    if (lines.length === 0) continue;
    const cust = customerRows[s.custIdx];
    const id = 'SL-' + (++soId);
    const created = new Date(Date.now() - s.ago * 86400000);
    await sql`
      INSERT INTO sell_orders (id, customer_id, status, discount_pct, created_by, created_at, updated_at)
      VALUES (${id}, ${cust.id}, ${s.status}, ${s.discount}, ${protoToUuid['u1']}, ${created}, ${created})
    `;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const label = l.category === 'RAM' ? `${l.brand} ${l.capacity} ${l.type}`
                  : l.category === 'SSD' ? `${l.brand} ${l.capacity}`
                  : l.category === 'HDD' ? `${l.brand} ${l.capacity}`
                  : l.description;
      const sub   = l.category === 'RAM' ? `${l.classification ?? ''} · ${l.speed ?? ''}MHz`
                  : l.category === 'SSD' ? `${l.interface ?? ''} · ${l.form_factor ?? ''}`
                  : l.category === 'HDD' ? `${l.interface ?? ''} · ${l.form_factor ?? ''} · ${l.rpm ?? ''}rpm`
                  : l.part_number;
      await sql`
        INSERT INTO sell_order_lines (
          sell_order_id, inventory_id, category, label, sub_label, part_number,
          qty, unit_price, warehouse_id, condition, position
        ) VALUES (
          ${id}, ${l.id}, ${l.category}, ${label}, ${sub}, ${l.part_number},
          ${l.qty}, ${l.sell_price}, ${l.warehouse_id}, ${l.condition}, ${i}
        )
      `;
    }
  }

  console.log('· Seeding inventory audit events…');
  await sql`DELETE FROM inventory_events`;
  const allLines = await sql`
    SELECT l.id, o.user_id, o.created_at, l.status
    FROM order_lines l JOIN orders o ON o.id = l.order_id
  `;
  for (const l of allLines) {
    await sql`
      INSERT INTO inventory_events (order_line_id, actor_id, kind, detail, created_at)
      VALUES (${l.id}, ${l.user_id}, 'created', ${sql.json({ status: l.status })}, ${l.created_at})
    `;
  }

  console.log('· Seeding notifications (per purchaser)…');
  await sql`DELETE FROM notifications`;
  for (const u of USERS.filter(u => u.role === 'purchaser')) {
    const userId = protoToUuid[u.id];
    for (const n of buildNotificationsForUser(userId)) {
      await sql`
        INSERT INTO notifications (user_id, kind, tone, icon, title, body, unread, created_at)
        VALUES (${n.user_id}, ${n.kind}, ${n.tone}, ${n.icon}, ${n.title}, ${n.body}, ${n.unread}, ${n.created_at})
      `;
    }
  }

  console.log('✓ seed complete');
  console.log('  Demo logins (password "demo"):');
  USERS.forEach(u => console.log(`    ${u.email.padEnd(35)} → ${u.role}`));
} catch (e) {
  console.error('✗ seed failed:', e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
