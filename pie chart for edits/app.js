/***** CONSTANTS *****/
const YEARS = [2025, 2024, 2023];
const COLORS = [
  '#000', '#e91e63', '#ff9800', '#ffeb3b', '#4caf50', '#00bcd4', '#9c27b0', '#f44336', 
  '#3f51b5', '#2196f3', '#795548'
];
const DIVERSION_TYPES = [
  'Mental Health Diversion (MHD)',
  'Drug Diversion Program',
  'Restorative Justice Program',
  'Other'
];

const DECISION_TYPES = [
  'Prosecuted',
  'Diverted pre‑charge',
  'Diverted post‑charge',
  'Declined'
];

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/***** HOVER BAR PLUGIN *****/
const hoverBar = {
  id: 'hoverBar',
  afterDraw(c) {
     if (c.config.type !== 'line') return;         
    const { ctx, tooltip, chartArea } = c;
    if (!tooltip._active?.length) return;
    const x = tooltip._active[0].element.x;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.07)';
    ctx.fillRect(x - 18, chartArea.top, 36, chartArea.bottom - chartArea.top);
    ctx.restore();
  }
};
Chart.register(hoverBar);

/***** LOAD ALL XLSX FILES *****/
let rows = [], charts = [];
let pieChart = null;
Promise.all(
  YEARS.map(y =>
    fetch(`data_${y}.xlsx`)
      .then(r => r.arrayBuffer())
      .then(buf => ({ y, buf }))
  )
).then(list => {
  list.forEach(({ y, buf }) => {
    const wb = XLSX.read(buf, { type: 'array' });
    wb.SheetNames.forEach(name => {
      const m = MONTH_NAMES.findIndex(n => n.toLowerCase() === name.slice(0, 3).toLowerCase()) + 1;
      if (!m) return;
      XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' })
        .forEach(r => rows.push({ ...r, month: m, year: y }));
    });
  });
  initDimension();
  build();
  initLargeChart();
});

/***** CONTROLS *****/
['metric', 'range', 'dimension'].forEach(id => {
  document.getElementById(id).onchange = build;
});
document.getElementById('pieToggle').onchange = build;
function initDimension() {
  const sel = document.getElementById('dimension');
  const ignore = ['id', 'date', 'year', 'month', 'measure', 'count'];
  sel.innerHTML = Object.keys(rows[0])
    .filter(k => !ignore.includes(k))
    .map(k => `<option value="${k}">${k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>`)
    .join('');
}



/***** HELPERS *****/
const keyOf = (y, m, mode) =>
  mode === 'monthly'   ? `${y}-${m}`       :
  mode === 'quarterly' ? `${y}-Q${Math.ceil(m / 3)}` :
  mode === 'annual'    ? String(y)          :
                         `${y}-${m}`;

/***** BUILD DASHBOARD *****/
function build() {
  if (largeChart) {
  largeChart.data.datasets = [];
  largeChart.data.labels = [];
  largeChart.update();
  document.getElementById('compareSection').style.display = 'none';
}

  alasql('DROP TABLE IF EXISTS cases');
  alasql('CREATE TABLE cases');
  alasql('INSERT INTO cases SELECT * FROM ?', [rows]);

  const range  = document.getElementById('range').value;
  const dim    = document.getElementById('dimension').value;
  const metric = document.getElementById('metric').value;
  const pieChartEnabled = document.getElementById('pieToggle').checked;
  const pieMode = pieChartEnabled && (metric === 'all_cases' || DIVERSION_TYPES.includes(metric) || DECISION_TYPES.includes(metric));

  const buckets = [];
  if (range === 'last12') {
    const { y, m } = alasql('SELECT MAX(year) y, MAX(month) m FROM cases')[0];
    let idx = y * 12 + m;
    for (let i = 11; i >= 0; i--) {
      const yy = Math.floor((idx - i - 1) / 12);
      const mm = (idx - i - 1) % 12 + 1;
      buckets.push({
        y: yy,
        m: mm,
        label: `${MONTH_NAMES[mm - 1]} '${String(yy).slice(-2)}`,
        key: `${yy}-${mm}`
      });
    }
  } else if (range === 'monthly') {
    YEARS.slice().reverse().forEach(yy =>
      MONTH_NAMES.forEach((_, i) =>
        buckets.push({
          y: yy,
          m: i + 1,
          label: `${MONTH_NAMES[i]} '${String(yy).slice(-2)}`,
          key: `${yy}-${i + 1}`
        })
      )
    );
  } else if (range === 'quarterly') {
    YEARS.slice().reverse().forEach(yy =>
      [1, 2, 3, 4].forEach(q =>
        buckets.push({
          y: yy,
          q,
          label: `Q${q} '${String(yy).slice(-2)}`,
          key: `${yy}-Q${q}`
        })
      )
    );
  } else {
    YEARS.slice().reverse().forEach(yy =>
      buckets.push({ y: yy, label: String(yy), key: String(yy) })
    );
  }

  /* ---- aggregates ---- */
const allCounts      = {}, reviewCounts  = {}, decCounts     = {},
      divertedCounts = {}, typeCounts    = {};               // per‑type, all groups
const groupAll   = {}, groupReview  = {}, groupDec  = {},
      groupDiv   = {}, groupType    = {};                    // groupType[type][group][bucket]

rows.forEach(r => {
  if (r.measure !== 'received') return;               // sanity
  const key = keyOf(r.year, r.month, range);
  const g   = r[dim] || 'Unknown';

  /* every case ------------------------------------ */
  allCounts[key] = (allCounts[key] || 0) + 1;
  (groupAll[g] ??= {})[key] = (groupAll[g][key] || 0) + 1;

  /* reviewed subset ------------------------------- */
  if (r.decision) {
    reviewCounts[key] = (reviewCounts[key] || 0) + 1;
    (groupReview[g] ??= {})[key] = (groupReview[g][key] || 0) + 1;
  }

  /* diverted subset ------------------------------- */
  const isDiv = r.decision?.startsWith('Diverted');
  if (isDiv) {
    divertedCounts[key] = (divertedCounts[key] || 0) + 1;
    (groupDiv[g] ??= {})[key] = (groupDiv[g][key] || 0) + 1;

    const t = (r.diversion_type || '').trim();
    if (DIVERSION_TYPES.includes(t)) {
      (typeCounts[t] ??= {})[key] = (typeCounts[t][key] || 0) + 1;

      (groupType[t]      ??= {});
      (groupType[t][g]   ??= {});
      groupType[t][g][key] = (groupType[t][g][key] || 0) + 1;
    }
  }

  /* individual decision subset -------------------- */
  if (r.decision && r.decision === metric) {
    decCounts[key] = (decCounts[key] || 0) + 1;
    (groupDec[g] ??= {})[key] = (groupDec[g][key] || 0) + 1;
  }
});

/* ---- what are we plotting? ---- */
let showCounts, bucketBase, groupBase;

if (metric === 'all_cases') {
  showCounts = true;
  bucketBase = allCounts;
  groupBase  = groupAll;

} else if (metric === 'all_reviewed') {
  showCounts = true;
  bucketBase = reviewCounts;
  groupBase  = groupReview;

} else if (metric === 'all_diverted') {
  showCounts = true;
  bucketBase = divertedCounts;
  groupBase  = groupDiv;

} else if (DIVERSION_TYPES.includes(metric)) {
  showCounts = true;
  bucketBase = typeCounts[metric] || {};
  groupBase  = groupType[metric] || {};

} else if (DECISION_TYPES.includes(metric)) {
  showCounts = true;
  bucketBase = decCounts;
  groupBase  = groupDec;

} else {
  showCounts = true;
  bucketBase = {};
  groupBase  = {};
}


/* helper */
function bucketVal(key, g) {
  if (showCounts) {
    return (g ? groupBase[g]?.[key] : bucketBase[key]) || 0;
  }

  const num = g ? groupNum[g]?.[key] : numMap[key];
  const den = g ? groupBase[g]?.[key] : bucketBase[key];

  if (!den) return null;          // nothing to plot ─ show a gap
  return Math.round((num || 0) / den * 100);
}

  if (pieMode) {
  const lineData = buckets.map(b => bucketBase[b.key] || 0);
  renderLinePie(buckets, lineData, groupBase, metric);
  return;
}

const datasets = [
  {
    label: 'ALL',
    color: '#000',
    values: buckets.map(b => bucketBase[b.key] || 0)
  },
  ...Object.keys(groupBase).map((g, i) => ({
    label: g,
    color: COLORS[(i + 1) % COLORS.length],
    values: buckets.map(b => (groupBase[g]?.[b.key] || 0))
  }))
];

render(datasets, buckets.map(b => b.label), showCounts);

}

// helper for labels
const fmt = (v, isCount) =>
  (v === null || Number.isNaN(v)) ? 'N/A' : v + (isCount ? ' cases' : '%');

// turn #rrggbb into a semi‑transparent rgba string
function fadeColor(hex, a = .18) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

/***** RENDER *****/
function render(datasets, labels, isCount) {
  const grid = document.getElementById('chartGrid');
  grid.innerHTML = '';
  charts.forEach(c => c.destroy());
  charts = [];

  const first = labels[0], last = labels[labels.length - 1];

  datasets.forEach((d, i) => {
    const id = `c${i}`;
    grid.insertAdjacentHTML('beforeend', 
      `<div class="chart-box">
        <div class="chart-head">
          <div class="chart-title">${d.label}</div>
          <div class="chart-month" id="m${i}"></div>
        </div>
        <div class="chart-number" id="v${i}">${fmt(d.values.at(-1), isCount)}
</div>
        <div class="chart-canvas"><canvas id="${id}" width="280" height="100"></canvas></div>
        <div class="range-labels"><span>${first}</span><span>${last}</span></div>
<label style="margin-top: 8px; display: block;">
  <input type="checkbox" onchange="toggleLargeChart(${i})"> Compare
</label>
      </div>`);

    const ctx = document.getElementById(id).getContext('2d');
    const chart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: [{ label: d.label, data: d.values, borderColor: d.color, backgroundColor: d.color, tension: .18, pointRadius: 0, pointHoverRadius: 5 }] },
      options: {
        responsive: false,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: { x: { display: false }, y: { beginAtZero: true, ticks: { callback: v => Number.isInteger(v) ? v : '' } } },
        onHover: (e, els) => els.length ? hover(els[0].index, labels, isCount) : clear(isCount)
      },
      plugins: [hoverBar]
    });
    charts.push(chart);
  });
}

function renderLinePie(buckets, lineData, groupCounts, metricName) {
  const grid = document.getElementById('chartGrid');
grid.innerHTML = `
  <div class="chart-box" style="flex:1 1 100%;">
    <div class="chart-head">
      <div class="chart-title">${metricName} (ALL)</div>
      <div class="chart-month" id="lineMonth"></div>
    </div>
    <div class="chart-number" id="lineValue">${lineData.at(-1)} cases</div>
    <canvas id="lineMain" height="140"></canvas>
  </div>
  <div class="chart-box" style="flex:1 1 320px;">
    <div class="chart-head">
      <div class="chart-title">Breakdown</div>
      <div class="chart-month" id="sliceMonth"></div>
    </div>
    <div class="chart-number" id="sliceValue"></div>
    <canvas id="pieMain" height="140"></canvas>
  </div>
`;



  const lineCtx = document.getElementById('lineMain').getContext('2d');
  const pieCtx  = document.getElementById('pieMain').getContext('2d');
  const labels  = buckets.map(b => b.label);
  let origColors = [];


  new Chart(lineCtx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: metricName,
        data: lineData,
        borderColor: '#000',
        backgroundColor: '#000',
        tension: .18,
        pointRadius: 0,
        pointHoverRadius: 5
      }]
    },
    options: {
      responsive: true,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: { y: { beginAtZero: true } },
      onHover: (e, els) => {
  if (!els.length) return;
  const idx = els[0].index;
  updatePie(idx);
  document.getElementById('lineValue').textContent = lineData[idx] + ' cases';
  document.getElementById('lineMonth').textContent = labels[idx];

}

    }
  });

  pieChart = new Chart(pieCtx, {
    type: 'pie',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [] }] },
    options: {
  plugins: { legend: { position: 'right' }, tooltip: { enabled: false } },
  onHover: (e, els) => {
    const box = document.getElementById('sliceValue');
    if (!els.length) {                                   // mouse left pie
      pieChart.data.datasets[0].backgroundColor = origColors;
      pieChart.update();
      box.textContent = '';
      box.style.color = '#000';
      return;
    }
    const i   = els[0].index;
    const lbl = pieChart.data.labels[i];
    const val = pieChart.data.datasets[0].data[i];

    // fade non‑selected slices
    pieChart.data.datasets[0].backgroundColor =
      origColors.map((c, idx) => idx === i ? c : fadeColor(c));
    pieChart.update();

    box.textContent = `${lbl}: ${val} cases`;
    box.style.color = origColors[i];
  }
}


  });

  function updatePie(idx) {
    const key = buckets[idx].key;
    const sliceLabels = [];
    const sliceData   = [];
    const sliceColors = [];
    let colorIdx = 1;              // skip black

    Object.keys(groupCounts).forEach(g => {
      const v = groupCounts[g]?.[key] || 0;
      if (!v) return;
      sliceLabels.push(g);
      sliceData.push(v);
      sliceColors.push(COLORS[(colorIdx++) % COLORS.length]);
    });

    origColors = sliceColors.slice();                 // remember true colors
pieChart.data.labels = sliceLabels;
pieChart.data.datasets[0].data            = sliceData;
pieChart.data.datasets[0].backgroundColor = sliceColors;
pieChart.update();

  }

  // default pie = most recent bucket
  updatePie(buckets.length - 1);
  document.getElementById('lineMonth').textContent = labels.at(-1);
  document.getElementById('sliceMonth').textContent = labels.at(-1);

}


let largeChart = null;

function initLargeChart() {
  const ctx = document.getElementById('largeChart').getContext('2d');
  largeChart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      plugins: { legend: { position: 'top' } },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: { y: { beginAtZero: true } }
    }
  });
}

function toggleLargeChart(index) {
  const d = charts[index].data.datasets[0];
  const label = d.label;
  const existing = largeChart.data.datasets.find(ds => ds.label === label);

  if (existing) {
    largeChart.data.datasets = largeChart.data.datasets.filter(ds => ds.label !== label);
  } else {
    largeChart.data.datasets.push({
      label,
      data: d.data,
      borderColor: d.borderColor,
      backgroundColor: d.borderColor,
      tension: 0.18,
      pointRadius: 0,
      pointHoverRadius: 4
    });

    if (largeChart.data.labels.length === 0) {
      largeChart.data.labels = charts[index].data.labels;
    }
  }

  document.getElementById('compareSection').style.display = largeChart.data.datasets.length > 0 ? 'block' : 'none';
  largeChart.update();

  if (largeChart.data.datasets.length === 0) {
    largeChart.data.labels = [];
  }
}


function hover(i, labels, isCount) {
  charts.forEach((c, idx) => {
    c.setActiveElements([{ datasetIndex: 0, index: i }]);
    c.update();
    const v = c.data.datasets[0].data[i];
document.getElementById('v' + idx).textContent = fmt(v, isCount);

    document.getElementById('m' + idx).textContent = labels[i];
  });
}

function clear(isCount) {
  charts.forEach((c, idx) => {
    c.setActiveElements([]);
    c.update();
    const v = c.data.datasets[0].data.at(-1);
document.getElementById('v' + idx).textContent = fmt(v, isCount);

    document.getElementById('m' + idx).textContent = '';
  });
}
