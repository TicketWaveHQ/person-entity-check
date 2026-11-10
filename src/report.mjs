// Plain-text rendering of a report. No colour and no box-drawing characters,
// so the output pastes cleanly into an issue, a CI log or an email.

const LABEL = Object.freeze({ error: 'ERROR', warn: 'WARN', note: 'NOTE' });
const RESULT_LABEL = Object.freeze({
  ok: 'ok',
  dead: 'dead',
  'moved-host': 'moved host',
  moved: 'moved',
  'server-error': 'server error',
  'http-error': 'http error',
  unreachable: 'unreachable',
  unverifiable: 'unverifiable',
  'not-checked': 'not checked',
});

function pad(s, w) {
  const str = String(s);
  return str.length >= w ? str : str + ' '.repeat(w - str.length);
}

/** Render rows as aligned columns; the last column is not padded. */
export function columns(rows, indent = '  ', gap = '  ') {
  if (!rows.length) return [];
  const widths = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, String(c).length)));
  return rows.map((r) => (indent + r.map((c, i) => (i === r.length - 1 ? String(c) : pad(c, widths[i]))).join(gap)).trimEnd());
}

function urlCheck(report, index) {
  const checks = report.findings.filter((f) => f.page === index).map((f) => f.check);
  const parts = [];
  if (checks.includes('url-missing')) parts.push('missing');
  if (checks.includes('url-invalid')) parts.push('invalid');
  if (checks.includes('url-fragment')) parts.push('fragment');
  if (checks.includes('url-not-canonical')) parts.push('not canonical');
  return parts.length ? parts.join(' + ') : 'ok';
}

function httpOf(chain) {
  if (!chain || !chain.length) return '-';
  return chain.map((h) => (h.error ? h.error : h.status ?? '-')).join(' > ');
}

export function renderText(report) {
  const out = [];
  const { tool, summary } = report;
  const req = report.mode === 'network' ? `${report.requests} request${report.requests === 1 ? '' : 's'}` : `${report.requests} snapshot lookups`;
  out.push(`${tool.name} ${tool.version} | ${report.mode} | ${req} | ${report.generatedAt}`);
  out.push('');

  out.push('Set');
  out.push(...columns(report.set.map((m) => [`[${m.index}]`, m.kind, m.url])));
  out.push('');

  out.push('Pages');
  const pageRows = [['#', 'HTTP', 'Person found by', 'name', 'url', 'sameAs']];
  for (const p of report.pages) {
    pageRows.push([
      `[${p.index}]`,
      httpOf(p.chain),
      p.person ? p.person.via : '-',
      p.person ? p.person.name ?? '(none)' : '-',
      p.person ? urlCheck(report, p.index) : '-',
      p.person ? String(p.person.sameAs.length) : '-',
    ]);
  }
  out.push(...columns(pageRows));
  out.push('');

  if (report.names.length) {
    out.push('Names');
    const nameRows = report.names.map((n) => {
      const where = [];
      if (n.asName.length) where.push(`name on ${n.asName.map((i) => `[${i}]`).join(', ')}`);
      if (n.asAlternateName.length) where.push(`alternateName on ${n.asAlternateName.map((i) => `[${i}]`).join(', ')}`);
      return [`"${n.name}"`, where.join('; ')];
    });
    out.push(...columns(nameRows));
    out.push('');
  }

  const covered = report.pages.filter((p) => p.coverage.length);
  if (covered.length) {
    out.push('sameAs coverage (row: the page; column: the set member its sameAs should list)');
    const head = ['', ...report.set.map((m) => `[${m.index}]`)];
    const rows = [head];
    for (const p of covered) {
      rows.push([`[${p.index}]`, ...p.coverage.map((c) => (c.state === 'self' ? '-' : c.state === 'listed' ? 'yes' : 'NO'))]);
    }
    const widths = head.map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    for (const r of rows) out.push(`  ${r.map((c, i) => pad(c, widths[i])).join('  ')}`.trimEnd());
    out.push('');
  }

  if (report.targets.length) {
    out.push('sameAs targets');
    const rows = [['result', 'HTTP', 'target', 'set', 'listed by']];
    for (const t of report.targets) {
      rows.push([
        RESULT_LABEL[t.result] ?? t.result,
        httpOf(t.chain),
        t.url,
        t.member ? `[${t.member}]` : '-',
        t.listedBy.length ? t.listedBy.map((i) => `[${i}]`).join(', ') : '-',
      ]);
      if (t.finalUrl && t.chain.length > 1) rows.push(['', '', `-> ${t.finalUrl}`, '', '']);
    }
    out.push(...columns(rows));
    out.push('');
  }

  out.push('Findings');
  if (!report.findings.length) out.push('  none');
  else {
    out.push(
      ...columns(report.findings.map((f) => [LABEL[f.severity], f.page ? `[${f.page}]` : '-', f.check, f.message])),
    );
  }
  out.push('');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  out.push(
    `Result: ${plural(summary.errors, 'error')}, ${plural(summary.warnings, 'warning')}, ${plural(summary.notes, 'note')}. Exit ${summary.exitCode} (--fail-on ${summary.failOn}).`,
  );
  return `${out.join('\n')}\n`;
}
