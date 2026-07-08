const state = {
  rows: [],
  headers: [],
  filteredRows: [],
  charts: {}
};

const sampleCsv = `시도,작물명,측정일자,평균기온(℃),평균습도(%),CO2농도(ppm),일사량(W/㎡),생육지수
경산시,딸기,2025-01-06,14.3,72.5,781,134.2,85.6
경산시,오이,2025-01-27,21.8,82.7,792,187.3,100
경산시,파프리카,2025-02-17,23.6,58.7,836,210.7,90
경산시,토마토,2025-03-10,23.3,62.6,800,226.9,96.5
경산시,오이,2025-03-31,25.9,71.9,779,263.1,95.9
경산시,딸기,2025-04-14,20.4,66.1,715,212.3,82.1
경산시,딸기,2025-05-05,22.2,66.6,720,251.8,79.6
경산시,토마토,2025-06-16,25.6,64.4,791,267.4,90.8`;

const $ = (id) => document.getElementById(id);

function setStatus(message) {
  $('status').textContent = message;
}

function decodeCsvBuffer(buffer) {
  const candidates = ['utf-8', 'euc-kr', 'windows-949'];
  let best = { text: '', encoding: candidates[0], score: -Infinity };

  for (const encoding of candidates) {
    try {
      const decoder = new TextDecoder(encoding, { fatal: false });
      const text = decoder.decode(buffer);
      const badChars = (text.match(/�/g) || []).length;
      const koreanChars = (text.match(/[가-힣]/g) || []).length;
      const delimiterScore = (text.match(/[,\t;]/g) || []).length;
      const score = koreanChars * 3 + delimiterScore - badChars * 100;
      if (score > best.score) best = { text, encoding, score };
    } catch (err) {
      console.warn(`${encoding} 디코딩 실패`, err);
    }
  }
  return best;
}

function detectDelimiter(text) {
  const firstLines = text
    .split(/\r\n|\n|\r/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 5);

  const delimiters = [',', '\t', ';', '|'];
  let best = { delimiter: ',', score: -Infinity };

  for (const delimiter of delimiters) {
    const counts = firstLines.map(line => splitCsvLine(line, delimiter).length);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    const score = max * 10 - (max - min) * 5;
    if (max > 1 && score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

function splitCsvLine(line, delimiter) {
  const result = [];
  let value = '';
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && insideQuotes && next === '"') {
      value += '"';
      i++;
    } else if (char === '"') {
      insideQuotes = !insideQuotes;
    } else if (char === delimiter && !insideQuotes) {
      result.push(value.trim());
      value = '';
    } else {
      value += char;
    }
  }
  result.push(value.trim());
  return result;
}

function parseCSV(text) {
  const delimiter = detectDelimiter(text);
  const rows = [];
  let current = [];
  let value = '';
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && insideQuotes && next === '"') {
      value += '"';
      i++;
    } else if (char === '"') {
      insideQuotes = !insideQuotes;
    } else if (char === delimiter && !insideQuotes) {
      current.push(value.trim());
      value = '';
    } else if ((char === '\n' || char === '\r') && !insideQuotes) {
      if (char === '\r' && next === '\n') i++;
      current.push(value.trim());
      if (current.some(v => v !== '')) rows.push(current);
      current = [];
      value = '';
    } else {
      value += char;
    }
  }
  current.push(value.trim());
  if (current.some(v => v !== '')) rows.push(current);

  if (!rows.length) return [];
  const headers = rows.shift().map(h => h.replace(/^\uFEFF/, '').trim());
  const normalized = rows.map(row => {
    const obj = {};
    headers.forEach((h, idx) => obj[h] = row[idx] ?? '');
    return obj;
  }).filter(row => Object.values(row).some(v => String(v).trim() !== ''));

  normalized._meta = { delimiter };
  return normalized;
}

function isNumericColumn(header, rows) {
  const values = rows.map(r => r[header]).filter(v => v !== '' && v != null);
  if (!values.length) return false;
  const numericCount = values.filter(v => !Number.isNaN(Number(String(v).replace(/,/g, '')))).length;
  return numericCount / values.length >= 0.85;
}

function isDateColumn(header, rows) {
  const values = rows.map(r => r[header]).filter(Boolean).slice(0, 20);
  return values.length > 0 && values.filter(v => !Number.isNaN(Date.parse(v))).length / values.length >= 0.8;
}

function getNumericHeaders(rows) {
  return state.headers.filter(h => isNumericColumn(h, rows));
}

function getCategoricalHeaders(rows) {
  return state.headers.filter(h => !isNumericColumn(h, rows) && !isDateColumn(h, rows));
}

function toNumber(v) {
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function avg(nums) {
  const valid = nums.filter(n => n !== null && Number.isFinite(n));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

function median(nums) {
  const valid = nums.filter(n => n !== null && Number.isFinite(n)).sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function std(nums) {
  const m = avg(nums);
  const valid = nums.filter(n => n !== null && Number.isFinite(n));
  if (m === null || valid.length < 2) return 0;
  return Math.sqrt(valid.reduce((sum, n) => sum + Math.pow(n - m, 2), 0) / (valid.length - 1));
}

function fmt(n, digits = 2) {
  if (n === null || !Number.isFinite(n)) return '-';
  return Number(n.toFixed(digits)).toLocaleString('ko-KR');
}

function groupBy(rows, key) {
  return rows.reduce((acc, row) => {
    const v = row[key] || '미입력';
    acc[v] = acc[v] || [];
    acc[v].push(row);
    return acc;
  }, {});
}

function destroyCharts() {
  Object.values(state.charts).forEach(chart => chart.destroy());
  state.charts = {};
}

function populateFilters() {
  const regionKey = state.headers.includes('시도') ? '시도' : state.headers[0];
  const cropKey = state.headers.includes('작물명') ? '작물명' : state.headers[1] || state.headers[0];
  fillSelect('regionFilter', uniqueValues(state.rows, regionKey));
  fillSelect('cropFilter', uniqueValues(state.rows, cropKey));
}

function fillSelect(id, values) {
  const select = $(id);
  select.innerHTML = '<option value="__ALL__">전체</option>';
  values.forEach(v => {
    const option = document.createElement('option');
    option.value = v;
    option.textContent = v;
    select.appendChild(option);
  });
}

function uniqueValues(rows, key) {
  return [...new Set(rows.map(r => r[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'ko'));
}

function applyFilters() {
  const regionKey = state.headers.includes('시도') ? '시도' : state.headers[0];
  const cropKey = state.headers.includes('작물명') ? '작물명' : state.headers[1] || state.headers[0];
  const region = $('regionFilter').value;
  const crop = $('cropFilter').value;
  const keyword = $('searchInput').value.trim().toLowerCase();

  state.filteredRows = state.rows.filter(row => {
    const regionOk = region === '__ALL__' || row[regionKey] === region;
    const cropOk = crop === '__ALL__' || row[cropKey] === crop;
    const searchOk = !keyword || Object.values(row).join(' ').toLowerCase().includes(keyword);
    return regionOk && cropOk && searchOk;
  });
  renderAll();
}

function renderAll() {
  renderKpis();
  renderNumericStats();
  renderFrequencies();
  renderCharts();
  renderTable();
  setStatus(`완료: 전체 ${state.rows.length.toLocaleString('ko-KR')}건 중 ${state.filteredRows.length.toLocaleString('ko-KR')}건을 분석했습니다.`);
}

function renderKpis() {
  const rows = state.filteredRows;
  const numericHeaders = getNumericHeaders(rows);
  const growthKey = state.headers.includes('생육지수') ? '생육지수' : numericHeaders[numericHeaders.length - 1];
  const regionCount = uniqueValues(rows, state.headers.includes('시도') ? '시도' : state.headers[0]).length;
  const cropCount = uniqueValues(rows, state.headers.includes('작물명') ? '작물명' : state.headers[1] || state.headers[0]).length;
  const growthAvg = growthKey ? avg(rows.map(r => toNumber(r[growthKey]))) : null;

  $('kpiArea').innerHTML = `
    <div class="kpi"><div class="label">분석 건수</div><div class="value">${rows.length.toLocaleString('ko-KR')}</div><div class="sub">필터 적용 후 데이터 수</div></div>
    <div class="kpi"><div class="label">시도 수</div><div class="value">${regionCount}</div><div class="sub">고유 지역 개수</div></div>
    <div class="kpi"><div class="label">작물 수</div><div class="value">${cropCount}</div><div class="sub">고유 작물 개수</div></div>
    <div class="kpi"><div class="label">평균 ${growthKey || '수치'}</div><div class="value">${fmt(growthAvg)}</div><div class="sub">핵심 성과 지표</div></div>
  `;
}

function renderNumericStats() {
  const rows = state.filteredRows;
  const headers = getNumericHeaders(rows);
  const table = $('numericStatsTable');
  if (!headers.length) {
    table.innerHTML = '<tr><td>수치형 컬럼이 없습니다.</td></tr>';
    return;
  }
  const body = headers.map(h => {
    const nums = rows.map(r => toNumber(r[h])).filter(n => n !== null);
    return `<tr><td>${h}</td><td>${nums.length}</td><td>${fmt(avg(nums))}</td><td>${fmt(median(nums))}</td><td>${fmt(Math.min(...nums))}</td><td>${fmt(Math.max(...nums))}</td><td>${fmt(std(nums))}</td></tr>`;
  }).join('');
  table.innerHTML = `<thead><tr><th>컬럼</th><th>개수</th><th>평균</th><th>중앙값</th><th>최소</th><th>최대</th><th>표준편차</th></tr></thead><tbody>${body}</tbody>`;
}

function renderFrequencies() {
  const rows = state.filteredRows;
  const headers = getCategoricalHeaders(rows);
  const area = $('frequencyArea');
  if (!headers.length) {
    area.innerHTML = '<p class="status">목록형 컬럼이 없습니다.</p>';
    return;
  }
  area.innerHTML = headers.map(h => {
    const counts = Object.entries(groupBy(rows, h)).sort((a, b) => b[1].length - a[1].length).slice(0, 10);
    const rowsHtml = counts.map(([name, arr]) => `<div class="freq-row"><span>${name}</span><strong>${arr.length.toLocaleString('ko-KR')}건</strong></div>`).join('');
    return `<div class="freq-box"><h4>${h}</h4>${rowsHtml}</div>`;
  }).join('');
}

function renderCharts() {
  destroyCharts();
  const rows = state.filteredRows;
  if (!rows.length) return;
  const numericHeaders = getNumericHeaders(rows);
  const dateKey = state.headers.find(h => isDateColumn(h, rows)) || '측정일자';
  const growthKey = state.headers.includes('생육지수') ? '생육지수' : numericHeaders[numericHeaders.length - 1];
  const tempKey = state.headers.includes('평균기온(℃)') ? '평균기온(℃)' : numericHeaders[0];
  const cropKey = state.headers.includes('작물명') ? '작물명' : state.headers[1] || state.headers[0];
  const regionKey = state.headers.includes('시도') ? '시도' : state.headers[0];

  renderTrendChart(rows, dateKey, growthKey);
  renderBarAverage('cropChart', rows, cropKey, growthKey, '작물명', '평균 생육지수');
  renderScatterChart(rows, tempKey, growthKey);
  renderRegionCropChart(rows, regionKey, cropKey, growthKey);
}

function makeChart(id, config) {
  const ctx = $(id).getContext('2d');
  state.charts[id] = new Chart(ctx, config);
}

function renderTrendChart(rows, dateKey, valueKey) {
  const grouped = groupBy(rows, dateKey);
  const data = Object.entries(grouped).map(([date, arr]) => ({
    date,
    value: avg(arr.map(r => toNumber(r[valueKey])))
  })).sort((a, b) => new Date(a.date) - new Date(b.date));
  makeChart('trendChart', {
    type: 'line',
    data: { labels: data.map(d => d.date), datasets: [{ label: `평균 ${valueKey}`, data: data.map(d => d.value), tension: 0.28, fill: false }] },
    options: chartOptions('측정일자', valueKey)
  });
}

function renderBarAverage(canvasId, rows, groupKey, valueKey, xLabel, yLabel) {
  const data = Object.entries(groupBy(rows, groupKey)).map(([name, arr]) => ({
    name,
    value: avg(arr.map(r => toNumber(r[valueKey])))
  })).sort((a, b) => b.value - a.value);
  makeChart(canvasId, {
    type: 'bar',
    data: { labels: data.map(d => d.name), datasets: [{ label: yLabel, data: data.map(d => d.value), borderWidth: 1 }] },
    options: chartOptions(xLabel, yLabel)
  });
}

function renderScatterChart(rows, xKey, yKey) {
  const data = rows.map(r => ({ x: toNumber(r[xKey]), y: toNumber(r[yKey]) })).filter(p => p.x !== null && p.y !== null);
  makeChart('scatterChart', {
    type: 'scatter',
    data: { datasets: [{ label: `${xKey} vs ${yKey}`, data }] },
    options: chartOptions(xKey, yKey)
  });
}

function renderRegionCropChart(rows, regionKey, cropKey, valueKey) {
  const combined = rows.map(r => ({ ...r, '__지역작물': `${r[regionKey] || '미입력'} / ${r[cropKey] || '미입력'}` }));
  const data = Object.entries(groupBy(combined, '__지역작물')).map(([name, arr]) => ({
    name,
    value: avg(arr.map(r => toNumber(r[valueKey])))
  })).sort((a, b) => b.value - a.value).slice(0, 15);
  makeChart('regionCropChart', {
    type: 'bar',
    data: { labels: data.map(d => d.name), datasets: [{ label: `평균 ${valueKey}`, data: data.map(d => d.value) }] },
    options: { ...chartOptions('시도 / 작물명', valueKey), indexAxis: 'y' }
  });
}

function chartOptions(xLabel, yLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: true }, tooltip: { mode: 'nearest', intersect: false } },
    scales: {
      x: { title: { display: true, text: xLabel }, grid: { display: false } },
      y: { title: { display: true, text: yLabel }, beginAtZero: false }
    }
  };
}

function renderTable() {
  const rows = state.filteredRows.slice(0, 500);
  const head = state.headers.map(h => `<th>${h}</th>`).join('');
  const body = rows.map(row => `<tr>${state.headers.map(h => `<td>${row[h] ?? ''}</td>`).join('')}</tr>`).join('');
  $('dataTable').innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
}

function loadRows(rows) {
  state.rows = rows;
  state.headers = rows.length ? Object.keys(rows[0]) : [];
  state.filteredRows = rows;
  populateFilters();
  renderAll();
}

function downloadCsv(filename, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function getStatsRows() {
  return getNumericHeaders(state.filteredRows).map(h => {
    const nums = state.filteredRows.map(r => toNumber(r[h])).filter(n => n !== null);
    return { 컬럼: h, 개수: nums.length, 평균: fmt(avg(nums)), 중앙값: fmt(median(nums)), 최소: fmt(Math.min(...nums)), 최대: fmt(Math.max(...nums)), 표준편차: fmt(std(nums)) };
  });
}

$('csvFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus(`읽는 중: ${file.name}`);
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const decoded = decodeCsvBuffer(reader.result);
      const rows = parseCSV(decoded.text);
      loadRows(rows);
      const delimiterName = rows._meta?.delimiter === '\t' ? 'TAB' : rows._meta?.delimiter || ',';
      setStatus(`완료: ${file.name} / 인코딩 ${decoded.encoding.toUpperCase()} / 구분자 ${delimiterName} / ${state.filteredRows.length.toLocaleString('ko-KR')}건 분석`);
    } catch (err) {
      setStatus(`오류: CSV를 읽지 못했습니다. ${err.message}`);
    }
  };
  reader.readAsArrayBuffer(file);
});

$('loadSampleBtn').addEventListener('click', () => loadRows(parseCSV(sampleCsv)));
$('regionFilter').addEventListener('change', applyFilters);
$('cropFilter').addEventListener('change', applyFilters);
$('searchInput').addEventListener('input', applyFilters);
$('resetBtn').addEventListener('click', () => {
  $('regionFilter').value = '__ALL__';
  $('cropFilter').value = '__ALL__';
  $('searchInput').value = '';
  applyFilters();
});
$('downloadFilteredBtn').addEventListener('click', () => downloadCsv('filtered_data.csv', state.filteredRows));
$('downloadStatsBtn').addEventListener('click', () => downloadCsv('numeric_stats.csv', getStatsRows()));

loadRows(parseCSV(sampleCsv));
