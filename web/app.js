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
    'lagging',
    'interrupted',
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
  svg.setAttribute('aria-label', 'Source observations; breaks indicate missing dates');
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
  if (points.length === 1) {
    const dot = document.createElementNS(svg.namespaceURI, 'circle');
    dot.setAttribute('cx', String(2 + ((Date.parse(points[0].date) - start) / span) * 256));
    dot.setAttribute('cy', String(47 - (points[0].value / max) * 40));
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', 'currentColor');
    svg.append(dot);
  }

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
  if (card.aggregation === 'latest')
    return card.comparison.absoluteChange !== null
      ? `${card.comparison.absoluteChange >= 0 ? '+' : ''}${fmt(card.comparison.absoluteChange, card.unit)} net change · snapshot ${card.latestPeriod?.to ?? 'unknown'}`
      : `Snapshot ${card.latestPeriod?.to ?? 'unavailable'} · not a period total`;
  if (card.coverage.status === 'unavailable') return 'Not collected or not available';
  const uncertain = card.coverage.qualities.filter((q) => q !== 'observed');
  if (uncertain.length)
    return uncertain.join(' · ').replaceAll('_', ' ') + ' · not an exact-population claim';
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
    sources = new Set(all.filter((x) => x.points.length).map((x) => x.resourceId));
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
  const csv = el('a', {
    class: 'button secondary',
    text: 'Download CSV',
    href:
      '/api/v1/projects/' +
      encodeURIComponent(report.project.id) +
      '/report?' +
      query() +
      '&format=csv',
  });
  const briefing = el('a', {
    class: 'button quiet',
    text: 'Download briefing',
    href:
      '/api/v1/projects/' +
      encodeURIComponent(report.project.id) +
      '/brief?' +
      query() +
      '&format=markdown',
  });
  content.append(el('div', { class: 'report-actions' }, [back, csv, briefing]));
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
      ['Resource / group', 'Status', 'Last success / observed date', 'Authentication', 'Next step'],
      states.map((s) => [
        el('div', {}, [
          el('strong', { text: s.resourceId }),
          el('small', { text: s.provider + ' / ' + s.group }),
        ]),
        status(s.status),
        el('div', {}, [
          s.lastSuccess ? new Date(s.lastSuccess).toLocaleString() : 'Never',
          el('small', { text: 'Observed through: ' + (s.observedThrough ?? 'no observed dates') }),
          el('small', {
            text:
              s.dataState === 'no_observations'
                ? 'Successful empty response — not proof of zero.'
                : '',
          }),
        ]),
        el('div', {}, [
          s.credentials.method,
          el('small', {
            text: s.credentials.available
              ? 'Credentials available'
              : s.credentials.missing.join(', '),
          }),
        ]),
        el('div', {}, [
          s.nextAction.message,
          el('small', { text: s.nextAction.command?.join(' ') ?? '' }),
          ...(s.lastRun?.code
            ? [el('small', { text: s.lastRun.code + ': ' + (s.lastRun.message ?? '') })]
            : []),
        ]),
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
function renderBrief(data) {
  content.append(
    heading('Evidence-based briefing', 'Deterministic findings, not an AI growth score'),
  );
  content.append(
    el('a', {
      class: 'button quiet',
      text: 'Download Markdown briefing',
      href: '/api/v1/brief?' + query() + '&format=markdown',
    }),
  );
  for (const brief of data.briefs) {
    const panel = el('article', { class: 'brief-panel' });
    const button = el('button', { class: 'text-button', text: brief.project.label });
    button.addEventListener('click', () => selectProject(brief.project.id));
    panel.append(el('h2', {}, [button]));
    const list = el('ul', { class: 'findings' });
    for (const finding of brief.findings)
      list.append(
        el('li', {}, [
          el('span', { class: 'badge', text: finding.kind }),
          el('p', { text: finding.message }),
          ...(finding.kind === 'change'
            ? [
                el('small', {
                  text: `${finding.resourceId} · ${finding.evidence.timezone} · ${finding.evidence.methodology}`,
                }),
              ]
            : []),
        ]),
      );
    panel.append(list, el('p', { class: 'muted small', text: brief.limitation }));
    if (brief.omittedFindings)
      panel.append(
        el('p', {
          text: `${brief.omittedFindings} further findings omitted; inspect the project report.`,
        }),
      );
    content.append(panel);
  }
}
function renderPlan(data) {
  content.append(
    el('aside', { class: 'callout' }, [
      el('strong', { text: 'Preview only — no provider requests, writes or scheduled jobs.' }),
    ]),
  );
  content.append(
    heading('Bounded collection jobs', `${data.jobs.length} of ${data.totalJobs} jobs shown`),
  );
  content.append(
    table(
      ['Resource / group', 'Source dates', 'Mode / timezone', 'Explicit CLI command'],
      data.jobs.map((j) => [
        j.resourceId + ' / ' + j.group,
        j.window.from + ' → ' + j.window.to,
        j.mode + ' · ' + j.timezone,
        el('code', { text: j.command.join(' ') }),
      ]),
    ),
  );
  if (data.omittedJobs)
    content.append(
      el('p', {
        class: 'notice',
        text: `${data.omittedJobs} jobs omitted by the preview budget. Narrow your selection before execution.`,
      }),
    );
  const notes = el('ul', { class: 'warnings' });
  for (const note of data.notices) notes.append(el('li', { text: note }));
  content.append(notes);
}
function saveView() {
  const params = new URLSearchParams({
    view: state.view,
    from: $('from').value,
    to: $('to').value,
  });
  if (state.project) params.set('project', state.project);
  history.replaceState(null, '', '/?' + params);
}
async function load() {
  const generation = ++state.loading;
  $('refresh').disabled = true;
  $('download').disabled = true;
  state.data = null;
  $('error').hidden = true;
  message('');
  saveView();
  content.replaceChildren(el('div', { class: 'loading', text: 'Reading source-aware history…' }));
  try {
    const data =
      state.view === 'health'
        ? await api('/health')
        : state.view === 'brief'
          ? await api('/brief?' + query())
          : state.view === 'plan'
            ? await api('/plan?' + query())
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
    } else if (state.view === 'brief') {
      renderBrief(data);
      $('page-title').textContent = 'What changed, and what did not.';
      $('page-description').textContent =
        'Traceable changes, missing baselines and explicit limits.';
      $('breadcrumb').textContent = 'PROJECT BRIEFING';
    } else if (state.view === 'plan') {
      renderPlan(data);
      $('page-title').textContent = 'Know what a sync will do.';
      $('page-description').textContent =
        'Review date windows and provider limits before collection.';
      $('breadcrumb').textContent = 'COLLECTION PLAN';
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
    $('error').textContent = error.message;
    $('error').hidden = false;
  } finally {
    if (generation === state.loading) {
      $('refresh').disabled = false;
      $('download').disabled = !state.data;
    }
  }
}
function selectView(view) {
  state.view = view;
  state.project = null;
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
    b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
  });
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
const initial = new URLSearchParams(location.search);
if (['portfolio', 'brief', 'plan', 'health', 'definitions'].includes(initial.get('view')))
  state.view = initial.get('view');
if (state.view === 'portfolio' && /^[a-z][a-z0-9_-]{0,63}$/.test(initial.get('project') ?? ''))
  state.project = initial.get('project');
for (const id of ['from', 'to'])
  if (/^\d{4}-\d{2}-\d{2}$/.test(initial.get(id) ?? '')) $(id).value = initial.get(id);
document
  .querySelectorAll('[data-view]')
  .forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
void load();
