export class AgentError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// 扣子 V3：创建对话 -> 轮询状态 -> 获取回答。网络依赖可注入用于离线测试。
export class CozeAgent {
  constructor({ token = process.env.COZE_API_TOKEN, botId = process.env.COZE_BOT_ID,
    baseUrl = process.env.COZE_BASE_URL || 'https://api.coze.cn',
    fetchImpl = globalThis.fetch, timeoutMs = 90000, pollMs = 900 } = {}) {
    this.token = token; this.botId = botId; this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.pollMs = pollMs;
    if (!['https://api.coze.cn', 'https://api.coze.com'].includes(this.baseUrl)) {
      throw new Error('COZE_BASE_URL 仅支持扣子官方中国或国际站地址。');
    }
  }
  get configured() { return Boolean(this.token && this.botId); }
  async request(path, { method = 'GET', json, form, signal } = {}) {
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, {
        method, signal, headers: {
          Authorization: `Bearer ${this.token}`,
          ...(json ? { 'Content-Type': 'application/json' } : {})
        }, body: form || (json ? JSON.stringify(json) : undefined)
      });
    } catch (error) {
      if (signal?.aborted) throw new AgentError('请求超时，结果尚未确认。请稍后重试。', 504);
      throw new AgentError('无法连接扣子服务，请检查网络。');
    }
    if (!res.ok) {
      throw new AgentError(res.status === 401 || res.status === 403
        ? '扣子凭据无效或权限不足，请检查服务端配置。'
        : `扣子服务返回 HTTP ${res.status}，请稍后重试。`);
    }
    let data;
    try { data = await res.json(); } catch { throw new AgentError('扣子服务返回了无法解析的内容。'); }
    if (data.code !== undefined && data.code !== 0) {
      throw new AgentError(`扣子接口调用未成功（代码 ${String(data.code).slice(0, 24)}），请检查发布渠道和权限。`);
    }
    return data.data;
  }
  async chat({ message, image, userId, conversationId }) {
    if (!this.configured) throw new AgentError('尚未配置扣子。请在 .env 中填写 COZE_API_TOKEN 和 COZE_BOT_ID 后重启。', 503);
    const signal = AbortSignal.timeout(this.timeoutMs);
    let content = message, contentType = 'text';
    if (image) {
      const form = new FormData();
      form.append('file', new Blob([image.bytes], { type: image.mime }), 'image.' + (image.mime === 'image/png' ? 'png' : 'jpg'));
      const uploaded = await this.request('/v1/files/upload', { method: 'POST', form, signal });
      if (!uploaded?.id) throw new AgentError('图片上传未返回文件编号。');
      content = JSON.stringify([{ type: 'text', text: message }, { type: 'image', file_id: uploaded.id }]);
      contentType = 'object_string';
    }
    const query = conversationId ? '?conversation_id=' + encodeURIComponent(conversationId) : '';
    let chat = await this.request('/v3/chat' + query, { method: 'POST', signal, json: {
      bot_id: this.botId, user_id: userId, stream: false, auto_save_history: true,
      additional_messages: [{ role: 'user', content, content_type: contentType }]
    } });
    if (!chat?.id || !chat?.conversation_id) throw new AgentError('扣子未返回有效对话编号。');
    const params = new URLSearchParams({ conversation_id: chat.conversation_id, chat_id: chat.id });
    const deadline = Date.now() + this.timeoutMs;
    while (chat.status !== 'completed') {
      if (['failed', 'canceled', 'requires_action'].includes(chat.status)) {
        throw new AgentError(chat.status === 'requires_action'
          ? '智能体请求了客户端工具操作，本版本没有启用该操作。请在扣子端配置服务端工具。'
          : '本次生成未完成，请检查扣子智能体配置后重试。');
      }
      if (signal.aborted || Date.now() >= deadline) throw new AgentError('等待回答超时，结果尚未确认。', 504);
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
      chat = await this.request('/v3/chat/retrieve?' + params, { signal });
    }
    const messages = await this.request('/v3/chat/message/list?' + params, { signal });
    const answer = (Array.isArray(messages) ? messages : [])
      .filter(m => m.role === 'assistant' && m.type === 'answer' && m.content_type === 'text')
      .map(m => m.content).join('\n\n');
    if (!answer) throw new AgentError('本次对话没有返回文本回答，请检查扣子端输出配置。');
    return { answer, conversationId: params.get('conversation_id') };
  }
}
