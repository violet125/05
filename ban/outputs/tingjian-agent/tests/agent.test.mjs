import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { CozeAgent } from '../src/coze.mjs';
import { analyzeCSV, parseCSV } from '../src/csv.mjs';
import { createApp } from '../server.mjs';

test('CSV准确计算、币种分组、负数与重复编号核查', () => {
  const report = analyzeCSV('编号,币种,实收金额\nA,CNY,100.10\nB,CNY,200.20\nC,CNY,-50.30\nA,USD,20\nE,CNY,未知');
  assert.deepEqual(report.totals, { CNY: '250.00', USD: '20.00' });
  assert.deepEqual(report.negativeRows, [4]); assert.deepEqual(report.duplicateIdRows, [5]); assert.deepEqual(report.invalidRows, [6]);
});
test('CSV支持带引号换行、转义与BOM，并拒绝格式错误', () => {
  assert.deepEqual(parseCSV('\uFEFF名称,备注\r\n甲,"第一行\n含""引号"""').rows, [['甲', '第一行\n含"引号"']]);
  assert.throws(() => parseCSV('a,b\n"未闭合'));
  assert.throws(() => parseCSV('a,b\n1,2,3'));
  assert.throws(() => parseCSV('a,a\n1,2'));
});
test('CSV缺少金额列时不生成总额，大样本明确截断', () => {
  const report = analyzeCSV('名称\n' + Array.from({ length: 21 }, (_, i) => '项目' + i).join('\n'));
  assert.equal(report.amountColumn, null); assert.deepEqual(report.totals, {});
  assert.equal(report.sample.length, 20); assert.equal(report.sampleIsPartial, true);
});
function mockFetch(responses, calls) { return async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(responses.shift()), { status: 200 }); }; }
test('扣子创建、轮询、文本结果筛选和对话续接', async () => {
  const calls = [];
  const agent = new CozeAgent({ token: 'test', botId: 'bot', pollMs: 0, fetchImpl: mockFetch([
    { code: 0, data: { id: 'c1', conversation_id: 'v1', status: 'in_progress' } },
    { code: 0, data: { id: 'c1', conversation_id: 'v1', status: 'completed' } },
    { code: 0, data: [{ role: 'assistant', type: 'answer', content_type: 'text', content: '需要回复邮件。' },
      { role: 'assistant', type: 'verbose', content_type: 'text', content: '不要显示' }] }
  ], calls) });
  const result = await agent.chat({ message: '待办', userId: 'u1', conversationId: 'v1' });
  assert.equal(result.answer, '需要回复邮件。'); assert.equal(result.conversationId, 'v1');
  assert.match(calls[0].url, /conversation_id=v1/); assert.equal(JSON.parse(calls[0].options.body).stream, false);
});
test('图片先上传，再作为object_string传入', async () => {
  const calls = [];
  const agent = new CozeAgent({ token: 'test', botId: 'bot', fetchImpl: mockFetch([
    { code: 0, data: { id: 'file1' } }, { code: 0, data: { id: 'c', conversation_id: 'v', status: 'completed' } },
    { code: 0, data: [{ role: 'assistant', type: 'answer', content_type: 'text', content: '图片描述' }] }
  ], calls) });
  await agent.chat({ message: '描述', userId: 'u', image: { bytes: Buffer.from('mock'), mime: 'image/png' } });
  assert.match(calls[0].url, /files\/upload$/);
  const message = JSON.parse(calls[1].options.body).additional_messages[0];
  assert.equal(message.content_type, 'object_string'); assert.equal(JSON.parse(message.content)[1].file_id, 'file1');
});
test('未配置、认证失败、需要客户端操作时均不伪造成功', async () => {
  await assert.rejects(new CozeAgent({ token: '', botId: '' }).chat({}), /尚未配置/);
  const auth = new CozeAgent({ token: 'test', botId: 'bot', fetchImpl: async () => new Response('', { status: 401 }) });
  await assert.rejects(auth.chat({ message: 'a', userId: 'u' }), /权限不足/);
  const action = new CozeAgent({ token: 'test', botId: 'bot', fetchImpl: mockFetch([{ code: 0, data: { id: 'a', conversation_id: 'b', status: 'requires_action' } }], []) });
  await assert.rejects(action.chat({ message: 'a', userId: 'u' }), /客户端工具/);
});
test('扣子超时返回明确错误', async () => {
  const agent = new CozeAgent({ token: 'test', botId: 'bot', timeoutMs: 5, fetchImpl: async (_url, { signal }) => {
    await new Promise(resolve => setTimeout(resolve, 20)); signal.throwIfAborted();
  } });
  await assert.rejects(agent.chat({ message: 'a', userId: 'u' }), /超时/);
});
test('HTTP端到端：主页、会话隔离、续接、重置、CSV及跨域阻止', async t => {
  const calls = [];
  const agent = { configured: true, chat: async input => { calls.push(input); return { answer: '模拟回答', conversationId: input.conversationId || 'v' + calls.length }; } };
  const server = createApp({ agent }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, data, cookie = '', origin = base) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin }, body: JSON.stringify(data) });
  assert.match(await (await fetch(base)).text(), /听见行动/);
  const first = await post('/api/chat', { message: '你好' }); assert.equal(first.status, 200);
  const cookie = first.headers.get('set-cookie').split(';')[0]; await first.json();
  await (await post('/api/chat', { message: '继续' }, cookie)).json(); assert.equal(calls[1].conversationId, 'v1');
  await (await post('/api/chat', { message: '其他用户' })).json(); assert.notEqual(calls[2].userId, calls[0].userId); assert.equal(calls[2].conversationId, undefined);
  await (await post('/api/reset', {}, cookie)).json();
  const csv = await post('/api/chat', { message: '汇总', attachment: { kind: 'csv', data: '金额,币种\n100,CNY' } }, cookie);
  assert.equal((await csv.json()).report.totals.CNY, '100.00'); assert.equal(calls[3].conversationId, undefined);
  assert.equal((await post('/api/chat', { message: 'a' }, cookie, 'https://example.com')).status, 403);
  assert.equal((await post('/api/chat', { message: 'a', attachment: { kind: 'image', data: 'YWJj' } }, cookie)).status, 400);
  assert.equal((await post('/api/chat', { message: '' }, cookie)).status, 400);
});
