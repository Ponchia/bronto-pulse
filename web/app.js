const content = document.querySelector('#content');
const state = {
  view: 'portfolio',
  project: null,
  data: null,
  health: null,
  projectIndex: [],
  loading: 0,
};
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children)
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
};
function fmt(v, unit) {
  if (v === null || v === undefined) return '—';
  if (unit === 'ratio') return (v * 100).toFixed(1) + '%';
  if (unit === 'ms') return v >= 1000 ? (v / 1000).toFixed(2) + ' s' : Math.round(v) + ' ms';
  if (unit === 'score' || unit === 'position') return v.toFixed(2);
  return new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(v);
}
function status(label) {
  const known = [
    'complete',
    'partial',
    'unavailable',
    'healthy',
    'stale',
    'failed',
    'credentials_missing',
    'never_collected',
    'running',
    'disabled',
  ];
  return el('span', {
    class: 'status ' + (known.includes(label) ? label : 'unavailable'),
    text: label.replaceAll('_', ' '),
  });
}
function query() {
  return new URLSearchParams({ from: $('from').value, to: $('to').value }).toString();
}
async function api(path) {
  const response = await fetch('/api/v1' + path, { credentials: 'same-origin' });
  if (response.status === 401) {
    location.assign('/login');
    throw Error('Session expired');
  }
  const data = await response.json();
  if (!response.ok) throw Error(data.error?.message ?? 'Request failed.');
  return data;
}
function period(days) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  $('to').value = end.toISOString().slice(0, 10);
  end.setUTCDate(end.getUTCDate() - days + 1);
  $('from').value = end.toISOString().slice(0, 10);
  document
    .querySelectorAll('[data-days]')
    .forEach((b) => b.classList.toggle('selected', Number(b.dataset.days) === days));
}
function message(text) {
  $('message').textContent = text;
  $('message').hidden = !text;
}
function spark(points, window) {
  if (!points.length)
    return el('div', { class: 'chart-empty', text: 'No observations for this period' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 260 52');
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Daily series; breaks indicate missing dates');
  const max = Math.max(1, ...points.map((x) => x.value)),
    start = Date.parse(window.from),
    span = Math.max(86400000, Date.parse(window.to) - start);
  let path = '',
    last = null;
  for (const p of points) {
    const time = Date.parse(p.date),
      x = 2 + ((time - start) / span) * 256,
      y = 47 - (p.value / max) * 40;
    path +=
      (last === null || time - last > 86400000 ? ' M' : ' L') + x.toFixed(2) + ' ' + y.toFixed(2);
    last = time;
  }
  const base = document.createElementNS(svg.namespaceURI, 'line');
  for (const [key, value] of Object.entries({
    x1: '0',
    x2: '260',
    y1: '49',
    y2: '49',
    class: 'baseline',
  }))
    base.setAttribute(key, value);
  svg.append(base);
  const line = document.createElementNS(svg.namespaceURI, 'path');
  line.setAttribute('d', path);
  line.setAttribute('class', 'data-line');
  svg.append(line);
  return svg;
}
const priority = [
  'cloudflare.pageviews',
  'github.views',
  'npm.downloads',
  'gsc.clicks',
  'sense6.test_started',
  'github.clones',
  'github.stars',
  'gsc.impressions',
  'sense6.test_completed',
];
function sortedCards(cards) {
  return [...cards].sort(
    (a, b) =>
      (priority.indexOf(a.metric) < 0 ? 100 : priority.indexOf(a.metric)) -
      (priority.indexOf(b.metric) < 0 ? 100 : priority.indexOf(b.metric)),
  );
}
function cardValue(card) {
  return fmt(card.value ?? card.latestValue, card.unit);
}
function cardHint(card) {
  if (card.value === null && card.latestValue !== null)
    return 'Latest source bucket only · not a period total';
  if (card.coverage.status === 'unavailable') return 'Not collected or not available';
  if (card.coverage.status === 'partial')
    return `${card.coverage.observedDays}/${card.coverage.expectedDays} dates observed`;
  if (card.coverage.qualities.includes('sampled')) return 'Provider sampling applies';
  if (card.comparison.absoluteChange !== null)
    return (
      (card.comparison.absoluteChange >= 0 ? '+' : '') +
      fmt(card.comparison.absoluteChange, card.unit) +
      ' vs prior period'
    );
  return `${card.coverage.observedDays} observed dates · ${card.timezone}`;
}
function metric(card, window, mini = false) {
  const node = el('article', { class: mini ? 'mini-metric' : 'metric-card' });
  if (!mini) node.append(el('div', { class: 'resource', text: card.resourceId }));
  node.append(
    el('div', { class: 'metric-label', text: card.label }),
    el('div', { class: 'metric-value', text: cardValue(card) }),
    el('div', { class: 'metric-hint', text: cardHint(card) }),
    spark(card.points, window),
  );
  return node;
}
function stats(items) {
  const strip = el('div', { class: 'summary-strip' });
  for (const [label, value, detail] of items) {
    strip.append(
      el('article', { class: 'summary-stat' }, [
        el('div', { class: 'label', text: label }),
        el('div', { class: 'number', text: String(value) }),
        el('div', { class: 'small muted', text: detail }),
      ]),
    );
  }
  return strip;
}
function table(headings, rows, className = '') {
  const wrapper = el('div', { class: 'table-wrap ' + className }),
    table = el('table'),
    head = el('thead'),
    tr = el('tr');
  for (const h of headings) tr.append(el('th', { scope: 'col', text: h }));
  head.append(tr);
  table.append(head);
  const body = el('tbody');
  for (const cells of rows) {
    const row = el('tr');
    for (const cell of cells) row.append(el('td', {}, [cell]));
    body.append(row);
  }
  table.append(body);
  wrapper.append(table);
  return wrapper;
}
function heading(title, note = '') {
  return el('div', { class: 'section-heading' }, [
    el('h2', { text: title }),
    el('span', { class: 'muted', text: note }),
  ]);
}
function empty(text) {
  return el('div', { class: 'empty', text });
}
function renderPortfolio(data) {
  const all = data.reports.flatMap((x) => x.cards),
    sources = new Set(all.map((x) => x.resourceId));
  content.append(
    stats([
      ['Projects', data.reports.length, 'Separate identities, shared context'],
      ['Observed sources', sources.size, 'Provider definitions preserved'],
      [
        'Coverage gaps',
        all.filter((c) => c.coverage.status !== 'complete').length,
        'Unknown is never changed to zero',
      ],
    ]),
  );
  content.append(heading('Projects', 'Select a project to inspect its sources'));
  const grid = el('div', { class: 'project-grid' });
  for (const report of data.reports) {
    const node = el('article', { class: 'project-card' });
    const button = el('button', { text: report.project.label });
    button.addEventListener('click', () => selectProject(report.project.id));
    node.append(
      el('div', { class: 'project-head' }, [
        el('h3', {}, [button]),
        el('span', { class: 'arrow', 'aria-hidden': 'true', text: '↗' }),
      ]),
      el('p', { class: 'project-description', text: report.project.description }),
    );
    const cards = sortedCards(report.cards).slice(0, 4),
      list = el('div', { class: 'project-metrics' });
    for (const card of cards) list.append(metric(card, report.window, true));
    node.append(cards.length ? list : empty('Connect a source to begin collecting.'));
    const sourceNames = [...new Set(report.cards.map((x) => x.provider))].join(' · ');
    node.append(
      el('footer', {}, [
        el('span', { text: sourceNames || 'No configured source' }),
        status(report.cards.some((x) => x.coverage.status !== 'complete') ? 'partial' : 'complete'),
      ]),
    );
    grid.append(node);
  }
  content.append(grid);
  content.append(
    el('aside', { class: 'callout' }, [
      el('span', { class: 'glyph', 'aria-hidden': 'true', text: '↳' }),
      el('div', {}, [
        el('strong', { text: 'Interest and downloads are independent signals.' }),
        el('p', {
          text: 'Compare changes around releases, but do not interpret them as a person-level funnel. Pageviews, clones, downloads and unique viewers have different definitions.',
        }),
      ]),
    ]),
  );
}
function renderProject(report) {
  const back = el('button', { class: 'button quiet back-button', text: '← All projects' });
  back.addEventListener('click', () => selectView('portfolio'));
  content.append(back);
  const grid = el('section', { class: 'metric-grid', 'aria-label': 'Project metrics' });
  for (const c of sortedCards(report.cards).slice(0, 12)) grid.append(metric(c, report.window));
  content.append(
    report.cards.length
      ? grid
      : empty('No metrics are available for this project. Check collection health.'),
  );
  if (report.warnings.length) {
    content.append(heading('Read this data carefully'));
    const list = el('ul', { class: 'warnings' });
    for (const w of report.warnings) list.append(el('li', { text: w }));
    content.append(list);
  }
  if (report.annotations.length) {
    content.append(heading('Project timeline', 'Context, not causal attribution'));
    const timeline = el('div', { class: 'timeline' });
    for (const a of report.annotations)
      timeline.append(
        el('article', {}, [
          el('time', { datetime: a.date, text: a.date }),
          el('span', { text: a.title }),
          el('span', { class: 'badge', text: a.kind }),
        ]),
      );
    content.append(timeline);
  }
  content.append(heading('Metric contract', 'Values retain source scope and timezone'));
  content.append(
    table(
      ['Metric / resource', 'Value', 'Coverage', 'Definition'],
      report.cards.map((c) => [
        el('div', {}, [
          el('strong', { text: c.label }),
          el('small', { text: c.resourceId + ' · ' + c.methodology }),
        ]),
        cardValue(c),
        el('div', {}, [
          status(c.coverage.status),
          el('small', {
            text: `${c.coverage.observedDays}/${c.coverage.expectedDays} dates · ${c.timezone}`,
          }),
        ]),
        el('div', {}, [
          c.caveat || 'Source-reported count.',
          el('small', { text: c.comparison.reason }),
        ]),
      ]),
    ),
  );
  if (report.breakdowns.length) {
    content.append(
      heading('Source breakdowns', 'A separate view of the same events, not extra totals'),
    );
    const rows = report.breakdowns
      .slice(0, 50)
      .map((b) => [
        b.resourceId + ' / ' + b.group,
        JSON.stringify(b.dimensions),
        `${b.period.from} → ${b.period.to}`,
        fmt(b.value, ''),
        b.quality,
      ]);
    content.append(table(['Source', 'Dimension', 'Exact source period', 'Value', 'Quality'], rows));
  }
}
function renderHealth(data) {
  const states = data.resources;
  content.append(
    stats([
      [
        'Healthy jobs',
        states.filter((s) => s.status === 'healthy').length,
        'Successful within freshness policy',
      ],
      [
        'Needs attention',
        states.filter((s) => !['healthy', 'disabled'].includes(s.status)).length,
        'Review access and collection gaps',
      ],
      ['Collection model', 'Bounded', 'Failures preserve prior valid history'],
    ]),
  );
  content.append(heading('Connection and collection health', 'Credentials remain server-side'));
  content.append(
    table(
      ['Resource / group', 'Status', 'Last success', 'Authentication', 'Latest outcome'],
      states.map((s) => [
        el('div', {}, [
          el('strong', { text: s.resourceId }),
          el('small', { text: s.provider + ' / ' + s.group }),
        ]),
        status(s.status),
        s.lastSuccess ? new Date(s.lastSuccess).toLocaleString() : 'Never',
        el('div', {}, [
          s.credentials.method,
          el('small', {
            text: s.credentials.available
              ? 'Credentials available'
              : s.credentials.missing.join(', '),
          }),
        ]),
        s.lastRun?.code
          ? el('div', {}, [s.lastRun.code, el('small', { text: s.lastRun.message ?? '' })])
          : `${s.lastRun?.rows ?? 0} rows in last run`,
      ]),
    ),
  );
  content.append(
    el('aside', { class: 'callout' }, [
      el('span', { class: 'glyph', text: '↳' }),
      el('div', {}, [
        el('strong', { text: 'Collection is managed by the CLI or your scheduler.' }),
        el('p', {
          text: 'This interface is intentionally read-only. Run pulse probe to test permissions, pulse sync to collect, and pulse doctor --json for automation. No browser gets provider credentials.',
        }),
      ]),
    ]),
  );
}
async function load() {
  const generation = ++state.loading;
  $('refresh').disabled = true;
  message('');
  content.replaceChildren(el('div', { class: 'loading', text: 'Reading source-aware history…' }));
  try {
    const data =
      state.view === 'health'
        ? await api('/health')
        : state.view === 'definitions'
          ? await api('/metrics')
          : state.project
            ? await api('/projects/' + encodeURIComponent(state.project) + '/report?' + query())
            : await api('/portfolio?' + query());
    if (generation !== state.loading) return;
    state.data = data;
    content.replaceChildren();
    if (state.view === 'health') {
      renderHealth(data);
      $('page-title').textContent = 'Know what is collecting.';
      $('page-description').textContent =
        'Freshness, permissions and failures without hiding the gaps.';
      $('breadcrumb').textContent = 'COLLECTION HEALTH';
    } else if (state.view === 'definitions') {
      $('page-title').textContent = 'Every number has a contract.';
      $('page-description').textContent =
        'How metrics may be combined, and what they cannot tell you.';
      $('breadcrumb').textContent = 'METRIC DEFINITIONS';
      content.append(
        table(
          ['Metric', 'Unit', 'Aggregation', 'Caveat'],
          data.definitions.map((d) => [
            el('div', {}, [el('strong', { text: d.label }), el('small', { text: d.key })]),
            d.unit,
            d.aggregation,
            d.caveat || 'Source-reported metric.',
          ]),
          'definitions',
        ),
      );
    } else if (state.project) {
      renderProject(data);
      $('page-title').textContent = data.project.label;
      $('page-description').textContent = data.project.description;
      $('breadcrumb').textContent = 'PROJECT / ' + data.project.id.toUpperCase();
    } else {
      renderPortfolio(data);
      $('page-title').textContent = 'Signals, with context.';
      $('page-description').textContent =
        'Follow discovery and distribution without following people.';
      $('breadcrumb').textContent = 'YOUR PORTFOLIO';
    }
    const demo = data.demo ?? false;
    if ('demo' in data) {
      $('mode').textContent = demo ? 'SYNTHETIC DEMO' : 'PRIVATE WORKSPACE';
      $('mode').classList.toggle('demo', demo);
    }
    if (demo)
      message(
        'Demo workspace — all numbers shown here are synthetic fixtures. No provider requests or real visitor data are involved.',
      );
    $('freshness').textContent = data.generatedAt
      ? 'Read ' +
        new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'Definitions v1';
  } catch (error) {
    if (generation !== state.loading) return;
    content.replaceChildren(
      empty('The report could not be loaded. Existing collected history has not been changed.'),
    );
    message(error.message);
  } finally {
    if (generation === state.loading) $('refresh').disabled = false;
  }
}
function selectView(view) {
  state.view = view;
  state.project = null;
  document
    .querySelectorAll('[data-view]')
    .forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  void load();
}
function selectProject(id) {
  state.view = 'portfolio';
  state.project = id;
  void load();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
document
  .querySelectorAll('[data-view]')
  .forEach((b) => b.addEventListener('click', () => selectView(b.dataset.view)));
document.querySelectorAll('[data-days]').forEach((b) =>
  b.addEventListener('click', () => {
    period(Number(b.dataset.days));
    void load();
  }),
);
$('apply').addEventListener('click', () => void load());
$('refresh').addEventListener('click', () => void load());
$('download').addEventListener('click', () => {
  if (!state.data) return;
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' }),
    url = URL.createObjectURL(blob),
    a = el('a', { href: url, download: 'pulse-private-report.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
period(30);
void load();
