// Loads the reddit tracker's config the way README:201 runs the api
// (ROLE=api API_TOKEN=devtoken, .env carrying a bot token, no ALERT_TRANSPORT),
// and prints which transport it resolves to. No network.
import {loadConfig} from '../../../../trackers/reddit/src/config.ts';
const c = loadConfig();
console.log(JSON.stringify({role: c.role, alertTransport: c.alertTransport, reactionsLoopStarts: c.role === 'api' && c.alertTransport === 'telegram'}));
