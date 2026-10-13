const assert = require('assert');
process.chdir('/smoke');
const types = require('@simple-monitor/types');
const utils = require('@simple-monitor/utils');
const protocol = require('@simple-monitor/protocol');
assert(types.ErrorTypes && types.BreadCrumbTypes, 'types 枚举缺失');
const masked = utils.maskDeep({ phone: '13812345678', traceId: 't-1' });
assert(masked.phone === '[phone]', 'maskDeep 失效');
assert(masked.traceId === 't-1', '标识键被误伤');
const ok = protocol.validateEnvelope({
  protocolVersion: protocol.PROTOCOL_VERSION, sentAt: 1,
  auth: { apiKey: 'k', sdk: { name: 't', version: '0' } },
  session: { sessionId: 's', trackerId: 't' },
  context: { page: '/' },
  events: [{ kind: 'perf', metrics: [{ name: 'fp', value: 100 }] }],
});
assert(ok.success === true, '信封校验失效');
console.log('node14-smoke OK @ node', process.version);
