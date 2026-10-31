// A9-01 repro: loop.stop() does not interrupt RedditPacer.acquire(); after SIGTERM the
// poll iteration still waits out the pacer gap and then CLAIMS. Gap scaled to 2 s here
// (maxRpm=30); production default REDDIT_MAX_RPM=1 => 60 s gap.
import {startLoop} from '../../../../trackers/reddit/src/loops/runner.ts';
import {RedditPacer} from '../../../../trackers/reddit/src/pacing.ts';
const log = {info() {}, warn() {}, error() {}, debug() {}, event() {}, child() { return log; }} as any;
const pacer = new RedditPacer({maxRpm: 30});
const t0 = Date.now();
const events: string[] = [];
let iter = 0;
const loop = startLoop({name: 'poll', logger: log, idleMs: 0}, async () => {
  await pacer.acquire();
  iter++;
  events.push(`claim#${iter} at ${Date.now() - t0}ms`);
  return true;
});
await new Promise((r) => setTimeout(r, 500)); // first claim done; iteration 2 now blocked in acquire
const stopAt = Date.now() - t0;
loop.stop();
events.push(`stop() at ${stopAt}ms`);
await loop.stopped;
events.push(`stopped resolved at ${Date.now() - t0}ms`);
console.log(events.join('\n'));
const claimedAfterStop = iter >= 2;
console.log(claimedAfterStop ? 'REPRODUCED: claim taken after stop(); shutdown waited the pacer gap'
                             : 'NOT reproduced');
