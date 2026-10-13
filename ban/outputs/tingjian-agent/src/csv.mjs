// RFC 4180 风格解析：支持引号、逗号、换行与双引号转义。
export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(field); field = ''; closed = false;
      if (c !== ',') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        if (row.some(v => v !== '')) rows.push(row);
        row = [];
      }
    } else if (c === '"' && field === '' && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new Error('CSV 引号格式不正确。');
      field += c;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合。');
  row.push(field);
  if (row.some(v => v !== '')) rows.push(row);
  if (!rows.length) throw new Error('CSV 文件为空。');
  if (rows.length > 5001) throw new Error('CSV 最多支持5000条数据，请拆分文件。');
  if (rows.some(r => r.length !== rows[0].length)) throw new Error('CSV 各行列数不一致，请核对文件。');
  const headers = rows[0].map(v => v.trim());
  if (headers.some(v => !v) || new Set(headers).size !== headers.length) throw new Error('CSV 表头不能为空或重复。');
  return { headers, rows: rows.slice(1) };
}

function cents(value) {
  const str = value.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(str)) return null;
  const [a, b = ''] = str.replace('-', '').split('.');
  return (str.startsWith('-') ? -1n : 1n) * (BigInt(a) * 100n + BigInt(b.padEnd(2, '0')));
}
function money(n) { return `${n < 0n ? '-' : ''}${(n < 0n ? -n : n) / 100n}.${String((n < 0n ? -n : n) % 100n).padStart(2, '0')}`; }

export function analyzeCSV(text) {
  const { headers, rows } = parseCSV(text);
  const amount = headers.findIndex(h => /^(实收金额|金额|amount|received_amount)$/i.test(h));
  const currency = headers.findIndex(h => /^(币种|currency)$/i.test(h));
  const id = headers.findIndex(h => /^(编号|id)$/i.test(h));
  const groups = new Map(), invalidRows = [], negativeRows = [], duplicates = [], seen = new Set();
  rows.forEach((r, i) => {
    const rowNumber = i + 2;
    if (id >= 0 && r[id].trim()) {
      if (seen.has(r[id])) duplicates.push(rowNumber);
      seen.add(r[id]);
    }
    if (amount < 0) return;
    const n = cents(r[amount]);
    if (n === null) { invalidRows.push(rowNumber); return; }
    if (n < 0n) negativeRows.push(rowNumber);
    const unit = currency < 0 ? '未注明币种' : (r[currency].trim().toUpperCase() || '未注明币种');
    groups.set(unit, (groups.get(unit) || 0n) + n);
  });
  return {
    headers, recordCount: rows.length, amountColumn: amount < 0 ? null : headers[amount],
    totals: Object.fromEntries([...groups].map(([k, v]) => [k, money(v)])),
    invalidRows, negativeRows, duplicateIdRows: duplicates,
    scope: '按原始记录汇总，不自动去重；无效金额排除。行号为表头计入的逻辑记录号，不是含换行字段的物理文本行。未注明币种不可假定可跨记录比较。',
    sample: rows.slice(0, 20), sampleIsPartial: rows.length > 20,
    warning: amount < 0 ? '未找到金额列，没有计算总额。支持表头：实收金额、金额、amount、received_amount。' : '仅接受最多两位小数的纯数字金额。负数和重复编号仅提示核查，不等于错误或欺诈。'
  };
}
