import { describe, expect, it } from 'vitest';
import { CRASH_LIMIT, plan, type Container, type PlanInput } from '../src/plan.js';
import type { Desired } from '../src/types.js';
import { exited, running } from './helpers/fake-docker.js';

const HOST = 'lab';
const NOW = Date.parse('2026-10-24T12:00:00Z');

function desired(over: Partial<Desired> = {}): Desired {
  return { authoritative: true, count: 2, image: 'img:1', version: '1', vnc_ports: { 'lab-1': 5901, 'lab-2': 5902 }, roll: null, ...over };
}

function run(containers: Container[], over: Partial<PlanInput> = {}, d: Partial<Desired> = {}) {
  return plan({ hostId: HOST, desired: desired(d), containers, online: true, now: NOW, lastStartAt: null, restarts: {}, ...over });
}

function kinds(p: { actions: { kind: string; worker_id: string }[] }) {
  return p.actions.map((a) => [a.kind, a.worker_id]);
}

function ago(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
}

describe('scale up', () => {
  it('runs the lowest missing id, one per tick', () => {
    const p = run([], {}, { count: 3 });
    expect(kinds(p)).toEqual([['run', 'lab-1']]);
    expect(p.actions[0]).toMatchObject({ container: 'rs-fleet-lab-1', image: 'img:1', port: 5901 });
    expect(p.notes).toContain('lab-2: missing; waits for its turn');
  });

  it('fills the gap, not the end', () => {
    const p = run([running('lab-1'), running('lab-3')], {}, { count: 3 });
    expect(kinds(p)).toEqual([['run', 'lab-2']]);
  });

  it('maps the port the ERP names, else the conventional one', () => {
    expect(run([], {}, { count: 1, vnc_ports: { 'lab-1': 6001 } }).actions[0]).toMatchObject({ port: 6001 });
    expect(run([], {}, { count: 1, vnc_ports: {} }).actions[0]).toMatchObject({ port: 5901 });
  });

  it('does nothing when every desired worker runs', () => {
    expect(run([running('lab-1'), running('lab-2')]).actions).toEqual([]);
  });
});

describe('scale down', () => {
  it('removes extras, highest first, all in one tick', () => {
    const p = run([running('lab-1'), running('lab-2'), running('lab-3'), running('lab-4')]);
    expect(kinds(p)).toEqual([['remove', 'lab-4'], ['remove', 'lab-3']]);
  });

  it('removes an exited extra too', () => {
    const p = run([running('lab-1'), exited('lab-3', 0, ago(5))], {}, { count: 1 });
    expect(kinds(p)).toEqual([['remove', 'lab-3']]);
  });

  it('never touches a container whose id this host did not assign', () => {
    const stray: Container = { ...running('other-1'), name: 'rs-fleet-other-1' };
    const odd: Container = { ...running('lab-x'), name: 'rs-fleet-lab-x' };
    const p = run([running('lab-1'), running('lab-2'), stray, odd]);
    expect(p.actions).toEqual([]);
    expect(p.notes.join('\n')).toMatch(/other-1.*left alone/);
    expect(p.notes.join('\n')).toMatch(/lab-x.*left alone/);
  });
});

describe('duplicates', () => {
  it('leaves two containers with one worker id alone, missing or extra', () => {
    const twin: Container = { ...running('lab-1'), name: 'rs-fleet-lab-1-copy' };
    const extraTwin: Container = { ...running('lab-3'), name: 'rs-fleet-lab-3-copy' };
    const p = run([running('lab-1'), twin, running('lab-3'), extraTwin], {}, { count: 2 });
    expect(kinds(p)).toEqual([['run', 'lab-2']]);
    expect(p.notes.join('\n')).toMatch(/lab-1: more than one container/);
    expect(p.notes.join('\n')).toMatch(/lab-3: more than one container/);
  });
});

describe('roll', () => {
  it('replaces the named worker when its image differs', () => {
    const p = run([running('lab-1', 'img:1'), running('lab-2', 'img:1')], {}, { image: 'img:2', roll: { replace: 'lab-2' } });
    expect(kinds(p)).toEqual([['replace', 'lab-2']]);
    expect(p.actions[0]).toMatchObject({ image: 'img:2', port: 5902, reason: 'image img:1 -> img:2' });
  });

  it('leaves the other out-of-date workers alone', () => {
    const p = run([running('lab-1', 'img:1'), running('lab-2', 'img:1')], {}, { image: 'img:2', roll: { replace: 'lab-1' } });
    expect(kinds(p)).toEqual([['replace', 'lab-1']]);
  });

  it('does not replace a worker already on the image', () => {
    const p = run([running('lab-1', 'img:2'), running('lab-2', 'img:1')], {}, { image: 'img:2', roll: { replace: 'lab-1' } });
    expect(p.actions).toEqual([]);
  });

  it('is one of the tick\'s single start: a missing worker goes first', () => {
    const p = run([running('lab-2', 'img:1')], {}, { image: 'img:2', roll: { replace: 'lab-2' } });
    expect(kinds(p)).toEqual([['run', 'lab-1']]);
    expect(p.notes).toContain('lab-2: replacement waits for its turn');
  });
});

describe('restarts', () => {
  it('exit 75: after 60 s', () => {
    expect(run([running('lab-1'), exited('lab-2', 75, ago(30))]).actions).toEqual([]);
    const p = run([running('lab-1'), exited('lab-2', 75, ago(61))]);
    expect(kinds(p)).toEqual([['start', 'lab-2']]);
    expect(p.actions[0]).toMatchObject({ counted: false, reason: 'exit 75' });
  });

  it('exit 70: after 10 minutes', () => {
    expect(run([running('lab-1'), exited('lab-2', 70, ago(5 * 60))]).actions).toEqual([]);
    expect(kinds(run([running('lab-1'), exited('lab-2', 70, ago(10 * 60 + 1))]))).toEqual([['start', 'lab-2']]);
  });

  it('another exit: after 60 s, and it counts', () => {
    expect(run([running('lab-1'), exited('lab-2', 1, ago(59))]).actions).toEqual([]);
    const p = run([running('lab-1'), exited('lab-2', 1, ago(60))]);
    expect(p.actions[0]).toMatchObject({ kind: 'start', counted: true });
  });

  it('five crashes in thirty minutes leave it stopped', () => {
    const recent = Array.from({ length: CRASH_LIMIT }, (_, i) => NOW - (i + 1) * 60_000);
    const p = run([running('lab-1'), exited('lab-2', 137, ago(120))], { restarts: { 'lab-2': recent } });
    expect(p.actions).toEqual([]);
    expect(p.notes.join('\n')).toMatch(/lab-2: 5 restarts in 30 min.*left stopped/);
    // Older restarts have aged out.
    const old = recent.map((t) => t - 31 * 60_000);
    expect(kinds(run([running('lab-1'), exited('lab-2', 137, ago(120))], { restarts: { 'lab-2': old } }))).toEqual([['start', 'lab-2']]);
  });

  it('exit 75 does not count toward the limit', () => {
    const recent = Array.from({ length: CRASH_LIMIT + 2 }, (_, i) => NOW - (i + 1) * 60_000);
    expect(kinds(run([running('lab-1'), exited('lab-2', 75, ago(120))], { restarts: { 'lab-2': recent } }))).toEqual([['start', 'lab-2']]);
  });
});

describe('not authoritative', () => {
  it('starts, stops and restarts nothing', () => {
    const p = run([running('lab-3'), exited('lab-1', 1, ago(600))], {}, { authoritative: false, count: 2 });
    expect(p.actions).toEqual([]);
    expect(p.notes).toContain('not authoritative: observing only');
  });
});

describe('offline', () => {
  it('restarts an exited worker but creates, removes and replaces nothing', () => {
    const p = run([exited('lab-1', 75, ago(120)), running('lab-3', 'img:1')], { online: false }, { count: 2, image: 'img:2', roll: { replace: 'lab-3' } });
    expect(kinds(p)).toEqual([['start', 'lab-1']]);
    expect(p.notes).toContain('lab-3: beyond count 2 but offline; kept');
  });
});

describe('stagger', () => {
  it('holds every start within the stagger of the last one', () => {
    const p = run([exited('lab-1', 75, ago(120))], { lastStartAt: NOW - 60_000 });
    expect(p.actions).toEqual([]);
    expect(p.notes[0]).toMatch(/last start 60 s ago; next in 120 s/);
    expect(kinds(run([exited('lab-1', 75, ago(120))], { lastStartAt: NOW - 180_000 }))).toEqual([['start', 'lab-1'], ]);
  });

  it('allows one start per tick, but any number of removals', () => {
    const p = run([exited('lab-1', 75, ago(120)), running('lab-5'), running('lab-6')], {}, { count: 3 });
    expect(kinds(p)).toEqual([['remove', 'lab-6'], ['remove', 'lab-5'], ['start', 'lab-1']]);
    expect(p.notes).toContain('lab-2: missing; waits for its turn');
  });

  it('honours a custom stagger', () => {
    expect(kinds(run([], { lastStartAt: NOW - 1000, staggerMs: 500 }))).toEqual([['run', 'lab-1']]);
  });
});
