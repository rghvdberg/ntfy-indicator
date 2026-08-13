import { parseTopicUrl, getNotificationFile, getApiKey } from '../utils.js';
import { assert, runMain } from './helpers.js';

function expectParse(input, baseUrl, topic, name) {
  const r = parseTopicUrl(input);
  assert(r.baseUrl === baseUrl && r.topic === topic,
    `${name}: parseTopicUrl(${JSON.stringify(input)}) -> {baseUrl:${JSON.stringify(r.baseUrl)}, topic:${JSON.stringify(r.topic)}}`);
}

async function main() {
  expectParse('mytopic', null, 'mytopic', 'bare topic');
  expectParse('with-dash-123', null, 'with-dash-123', 'bare topic with dash');
  expectParse('https://ntfy.sh/alerts', 'https://ntfy.sh', 'alerts', 'simple url');
  expectParse('http://host/topic', 'http://host', 'topic', 'http scheme');
  expectParse('https://host:8080/topic', 'https://host:8080', 'topic', 'with port');
  expectParse('https://host/a/b', 'https://host', 'b', 'multi-segment keeps last');
  expectParse('https://host', 'https://host', '', 'no path');
  expectParse('https://host/', 'https://host', '', 'trailing slash');
  expectParse('https://[::1]:8080/topic', 'https://[::1]:8080', 'topic', 'ipv6 re-bracketed');
  expectParse('https://server.cup.cake:12707/testing', 'https://server.cup.cake:12707', 'testing', 'dev server');

  const f = getNotificationFile('https://server.cup.cake:12707/testing');
  assert(f.endsWith('/https___server_cup_cake_12707_testing.json'),
    `getNotificationFile safe name: ${f}`);

  const mockSettings = s => ({ get_string: () => s });
  assert(getApiKey(mockSettings('{"https://srv":"k1"}'), 'https://srv') === 'k1', 'getApiKey hit');
  assert(getApiKey(mockSettings('{"https://srv":"k1"}'), 'https://other') === null, 'getApiKey miss');
  assert(getApiKey(mockSettings('not json'), 'https://srv') === null, 'getApiKey malformed');
  assert(getApiKey({ get_string: () => { throw new Error('boom'); } }, 'https://srv') === null, 'getApiKey throws');
}

runMain(main);
