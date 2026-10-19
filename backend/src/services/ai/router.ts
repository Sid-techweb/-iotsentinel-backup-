import { METRIC_KEYS, MetricKey } from '../../ml/metrics';
import { allDevices, DeviceRef, ToolName } from './tools';

/**
 * Decides which read-only tools a question needs. This is deliberately a deterministic rule set and not
 * something the language model controls: the model can never pick a tool, choose its arguments or reach
 * data the rules did not select. Adding a capability means adding a rule here and a tool in tools.ts.
 */
export interface PlannedTool { tool: ToolName; args: Record<string, unknown> }
export interface Plan {
  help: boolean;
  devices: DeviceRef[];
  metric: MetricKey | null;
  tools: PlannedTool[];
  needsDevice: boolean;       // the question is about "a device" but none could be identified
}

export const MAX_TOOLS_PER_QUESTION = 4;

const METRIC_WORDS: [MetricKey, RegExp][] = [
  ['temperature', /\b(temperature|temp|hot|hottest|overheat\w*|thermal)\b/],
  ['vibration', /\b(vibration|vibrating|shaking)\b/],
  ['pressure', /\b(pressure|bar)\b/],
  ['current', /\b(motor current|current|amps?|amperage)\b/],
  ['cpu', /\b(cpu|processor|load)\b/],
  ['memory', /\b(memory|ram)\b/],
  ['battery', /\b(battery|charge)\b/],
  ['signal', /\b(signal|rssi|connectivity|wifi|wi-fi)\b/],
];

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function detectMetric(question: string): MetricKey | null {
  const q = question.toLowerCase();
  return METRIC_WORDS.find(([, re]) => re.test(q))?.[0] ?? null;
}

function countFrom(q: string, fallback = 5): number {
  const m = /\b(?:top|first|best|worst)\s+(\d{1,2}|\w+)\b/.exec(q) ?? /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:devices|machines|units|assets)\b/.exec(q);
  if (!m) return fallback;
  const raw = m[1];
  const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  return n && n >= 1 && n <= 25 ? n : fallback;
}

function minutesFrom(q: string): number {
  const m = /\b(?:last|past|previous)\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|h|days?)\b/.exec(q);
  if (m) {
    const n = Number(m[1]);
    return m[2].startsWith('d') ? n * 1440 : m[2].startsWith('h') ? n * 60 : n;
  }
  if (/\b(hour)\b/.test(q)) return 60;
  if (/\b(today|day|24)\b/.test(q)) return 1440;
  return 60;
}

const periodFrom = (q: string): 'today' | '24h' | '7d' => (/\b(week|7 days|seven days)\b/.test(q) ? '7d' : /\b(24 hours|last day|past day)\b/.test(q) ? '24h' : 'today');

/** Find the devices a question talks about: by name, by number ("device 12", "#12"), by UUID - or the selected one. */
export async function resolveDevices(question: string, selected?: DeviceRef | null): Promise<DeviceRef[]> {
  const q = question.toLowerCase();
  const devices = await allDevices();
  const found = new Map<string, DeviceRef>();

  for (const m of q.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) {
    const d = devices.find((x) => x.id === m[0]);
    if (d) found.set(d.id, d);
  }
  for (const m of q.matchAll(/(?:device|machine|asset|unit|sensor|pump|camera|gateway|meter|controller|tracker|cnc)\s*(?:no\.?|number|#)?\s*#?\s*(\d{1,6})\b|#\s*(\d{1,6})\b/g)) {
    const no = Number(m[1] ?? m[2]);
    const d = devices.find((x) => x.assetNo === no);
    if (d) found.set(d.id, d);
  }
  for (const d of devices) {
    if (d.name.length >= 3 && q.includes(d.name.toLowerCase())) found.set(d.id, d);
  }
  if (found.size === 0 && selected && /\b(this|it|its|selected|current|here)\b|\bthe (machine|device|unit)\b/.test(q)) found.set(selected.id, selected);
  return [...found.values()].slice(0, 3);
}

export async function planQuestion(question: string, selected?: DeviceRef | null): Promise<Plan> {
  const q = question.toLowerCase().replace(/\s+/g, ' ').trim();
  const help = q.length === 0 || /^(hi|hello|hey|help|thanks|thank you)\b[!. ]*$/.test(q) || /\b(what can you do|how do you work|what are you)\b/.test(q);
  const devices = await resolveDevices(question, selected);
  const metric = detectMetric(q);
  const tools: PlannedTool[] = [];
  const add = (tool: ToolName, args: Record<string, unknown> = {}) => {
    if (!tools.some((t) => t.tool === tool && JSON.stringify(t.args) === JSON.stringify(args)) && tools.length < MAX_TOOLS_PER_QUESTION) tools.push({ tool, args });
  };
  const dev = devices[0];
  const withDevice = (tool: ToolName, extra: Record<string, unknown> = {}) => devices.slice(0, 2).forEach((d) => add(tool, { deviceId: d.id, ...extra }));
  let needsDevice = false;

  if (help) return { help: true, devices, metric, tools: [], needsDevice: false };

  const asksWhy = /\b(why|explain|reason|how come|what caused)\b/.test(q) && /\b(risk|alert|predict\w*|flag\w*|warn\w*|anomal\w*|elevated|high|breach\w*)\b/.test(q);
  const asksTopRisk = /\b(highest|top|most|greatest|biggest)\b.*\b(risk|likely|danger|probab\w*)\b|\b(at risk|riskiest|likely to (fail|breach|exceed))\b/.test(q);
  const asksHistory = /\b(history|trend|trends|over the (last|past)|past|last \d+|readings|graph|chart|how has)\b/.test(q);
  const asksAnomalyHistory = /\banomal(y|ies)\b|prediction history|predicted before|predictive alert/.test(q);
  const asksMaintHistory = /\b(maintenance|service|servicing|repair|inspection)s?\s*(history|log|record|records|done)\b|\bwhen was\b.*\b(serviced|inspected|repaired|maintained)\b|\blast (service|inspection|repair|maintenance)\b/.test(q);
  const asksAttention = /\b(need|needs|require|requires|want|deserve)\b.*\b(maintenance|attention|inspection|service|servicing)\b|\bmaintenance attention\b|\bwhat should (i|we) (check|inspect|fix|look at)\b|\bprioriti[sz]e\b/.test(q);
  const asksBreachTypes = /\b(machine )?types?\b.*\b(breach\w*|alerts?|exceed\w*|violat\w*)\b|\b(breach\w*|exceed\w*)\b.*\btypes?\b/.test(q);
  const asksExtreme = /\b(highest|maximum|max|hottest|most|lowest|minimum|min|least)\b/.test(q) && !!metric && !asksTopRisk;
  const asksFleet = /\b(how many|count|number of|total)\b.*\b(online|offline|devices|machines|degraded|unhealthy|connected|active|in service)\b|\b(unhealthy|degraded|disconnected)\b|\bnot (healthy|online|working)\b|\bfleet (status|health|overview)\b|\boverall (status|health)\b|\bwhich (devices|machines)\b.*\b(offline|down|unhealthy|degraded)\b/.test(q);
  const asksAlerts = /\balerts?\b/.test(q);
  const asksModel = /\b(model|auc|precision|recall|retrain\w*|accuracy|classifier)\b/.test(q);

  if (asksWhy) {
    if (dev) { withDevice('explain_prediction', { metric }); }
    else { needsDevice = true; add('top_risk', { n: 3 }); }
  }
  if (asksTopRisk) add('top_risk', { n: countFrom(q) });
  if (asksAttention) add('maintenance_attention', { n: countFrom(q) });
  if (asksBreachTypes) add('breaches_by_type', { days: /\b(today|24)\b/.test(q) ? 1 : /\bmonth\b/.test(q) ? 30 : 7 });
  if (asksMaintHistory) { if (dev) withDevice('maintenance_history'); else needsDevice = true; }
  if (asksAnomalyHistory) { if (dev) withDevice('anomaly_history'); else needsDevice = true; }
  if (asksHistory && !asksAnomalyHistory && !asksMaintHistory && !asksWhy) {
    if (dev) withDevice('telemetry_history', { metric, minutes: minutesFrom(q) }); else if (metric) needsDevice = true;
  }
  if (asksExtreme) add('highest_metric', { metric });
  if (asksFleet) add('fleet_status');
  if (asksAlerts && !dev && !asksBreachTypes) add('alerts_summary', { period: periodFrom(q) });
  if (asksModel) add('model_info');

  // nothing specific was recognised but a device is in play: give its profile
  if (dev && tools.length === 0 && !asksModel) withDevice('device_profile');
  if (dev && asksAlerts && !tools.some((t) => t.tool === 'device_profile' || t.tool === 'explain_prediction')) withDevice('device_profile');

  return { help: false, devices, metric, tools, needsDevice };
}

export const KNOWN_METRICS = METRIC_KEYS;
