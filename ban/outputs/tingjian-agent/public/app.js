const $ = id => document.getElementById(id);
let latestAnswer = '', busy = false, recognition, listening = false;
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function append(role, text) {
  const article = document.createElement('article'); article.className = role;
  const title = document.createElement('h3'); title.textContent = role === 'user' ? '你' : '听见行动';
  const p = document.createElement('p'); p.textContent = text;
  article.append(title, p); $('conversation').append(article);
  return article;
}
function setBusy(value) { busy = value; if (value && listening) recognition?.abort(); for (const id of ['send', 'reset', 'attachment', 'message', 'dictate']) $(id).disabled = value; }
async function api(path, data) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败。'); return result;
}
async function readAttachment(file) {
  if (!file) return undefined;
  if (/\.(png|jpe?g)$/i.test(file.name)) {
    if (file.size > 6 * 1024 * 1024) throw new Error('图片最多6MB。');
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('无法读取图片。')); reader.readAsDataURL(file);
    });
    return { kind: 'image', data };
  }
  if (!/\.(csv|txt|md)$/i.test(file.name)) throw new Error('请使用PNG、JPEG、TXT、MD或CSV文件。');
  if (file.size > 150 * 1024) throw new Error('文本或CSV最多150KB。');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('请将文件另存为UTF-8编码后上传。'); }
  return { kind: /\.csv$/i.test(file.name) ? 'csv' : 'text', data: text };
}
function speak() {
  if (!('speechSynthesis' in window)) { status('当前浏览器不支持朗读，可使用系统读屏工具。', true); return; }
  if (!latestAnswer) { status('还没有可朗读的回答。'); return; }
  speechSynthesis.cancel();
  // 按短句排队，避免部分浏览器长文本朗读截断。
  const parts = latestAnswer.match(/[^。！？\n]{1,160}[。！？\n]?/g) || [latestAnswer];
  parts.forEach(text => { const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'zh-CN'; utterance.rate = .95;
    utterance.onerror = event => { if (!['interrupted', 'canceled'].includes(event.error)) status('朗读未完成，请检查系统中文语音。', true); };
    speechSynthesis.speak(utterance);
  });
}
$('chat-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const message = $('message').value.trim(); if (!message) return;
  const file = $('attachment').files[0]; setBusy(true); status('正在处理，请稍候……');
  try {
    const attachment = await readAttachment(file);
    const result = await api('/api/chat', { message, attachment });
    append('user', message + (file ? '\n附件：' + file.name : ''));
    latestAnswer = result.answer;
    const reply = append('assistant', latestAnswer);
    if (result.report) {
      const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '查看本地CSV计算结果';
      const p = document.createElement('p'); p.textContent = JSON.stringify(result.report, null, 2);
      details.append(summary, p); reply.append(details);
    }
    $('message').value = ''; $('attachment').value = '';
    status('回答已生成，可在对话记录中阅读或选择朗读。');
    reply.tabIndex = -1; reply.focus();
    if ($('auto-speak').checked) speak();
  } catch (error) { status(error.message || '无法连接本地服务。', true); }
  finally { setBusy(false); }
});
$('speak').addEventListener('click', speak);
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
$('dictate').addEventListener('click', () => {
  if (!SpeechRecognition) { status('当前浏览器不支持语音输入，可使用系统听写或键盘输入。', true); return; }
  if (listening) { recognition.stop(); return; }
  recognition = new SpeechRecognition(); recognition.lang = 'zh-CN'; recognition.continuous = false; recognition.interimResults = false;
  recognition.onstart = () => { listening = true; $('dictate').textContent = '结束语音输入'; status('正在听，请说出问题。'); };
  recognition.onresult = event => {
    if (busy) return;
    $('message').value = ($('message').value + event.results[0][0].transcript).slice(0, 8000);
    status('语音已转为文字。请核对后发送。'); $('message').focus();
  };
  recognition.onerror = event => { if (event.error !== 'aborted') status('语音输入失败，请检查麦克风权限或使用键盘输入。', true); };
  recognition.onend = () => { listening = false; $('dictate').textContent = '语音输入'; };
  try { recognition.start(); } catch { status('暂时无法启动语音输入。', true); }
});
$('stop').addEventListener('click', () => { window.speechSynthesis?.cancel(); status('已停止朗读。'); });
$('reset').addEventListener('click', async () => {
  if (busy) return; setBusy(true);
  try { await api('/api/reset', {}); window.speechSynthesis?.cancel(); latestAnswer = ''; $('conversation').replaceChildren();
    status('已开始新对话。扣子云端历史未删除。');
  } catch (error) { status(error.message, true); } finally { setBusy(false); $('message').focus(); }
});
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  if (!busy) { $('message').value = button.dataset.prompt; $('message').focus(); }
}));
fetch('/api/health').then(r => r.json()).then(data => status(data.configured
  ? '服务已配置。可以发送问题。' : '请先在服务端 .env 配置扣子凭据并重启。', !data.configured))
  .catch(() => status('无法连接本地服务，请确认服务器已启动。', true));
