import fs from 'node:fs';
import path from 'node:path';

const DIAGRAMS_DIR = 'public/diagrams';

const CSS_THEME = `    <style>
      :root {
        --bg-card: #ffffff;
        --bg-subtle: #f8f9fa;
        --bg-elevated: #f1f3f5;
        --border: #e2e6ea;
        --border-hover: #c4cacf;
        --text: #1a1f26;
        --text-muted: #57606a;
        --text-subtle: #6e7781;
        --accent: #0b79a8;
        --accent-subtle: rgba(11, 121, 168, 0.08);
        --green: #1a7f37;
        --green-bg: rgba(26, 127, 55, 0.08);
        --green-subtle: rgba(26, 127, 55, 0.08);
        --bad: #cf222e;
        --bad-bg: rgba(207, 34, 46, 0.08);
        --red: #cf222e;
        --red-bg: rgba(207, 34, 46, 0.08);
        --amber: #9a6700;
        --amber-bg: rgba(154, 103, 0, 0.08);
        --purple: #8250df;
        --purple-bg: rgba(130, 80, 223, 0.08);
        --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg-card: #0d1117;
          --bg-subtle: #161b22;
          --bg-elevated: #1c2128;
          --border: #30363d;
          --border-hover: #6e7681;
          --text: #f0f6fc;
          --text-muted: #8b949e;
          --text-subtle: #6e7681;
          --accent: #61c7ef;
          --accent-subtle: rgba(97, 199, 239, 0.12);
          --green: #3fb950;
          --green-bg: rgba(63, 185, 80, 0.12);
          --green-subtle: rgba(63, 185, 80, 0.12);
          --bad: #f85149;
          --bad-bg: rgba(248, 81, 73, 0.12);
          --red: #f85149;
          --red-bg: rgba(248, 81, 73, 0.12);
          --amber: #d29922;
          --amber-bg: rgba(210, 153, 34, 0.12);
          --purple: #bc8cff;
          --purple-bg: rgba(188, 140, 255, 0.12);
        }
      }
      text { font-family: var(--font-sans); }
      .mono { font-family: var(--font-mono); }
      .bg-plate { fill: var(--bg-card); stroke: var(--border); stroke-width: 1; }
      
      .box { fill: var(--bg-card); stroke: var(--border-hover); stroke-width: 1.25; }
      .box-subtle { fill: var(--bg-subtle); stroke: var(--border); stroke-width: 1.25; }
      .box-acc { fill: var(--accent-subtle); stroke: var(--accent); stroke-width: 1.4; }
      .box-bad { fill: var(--bad-bg); stroke: var(--bad); stroke-width: 1.25; stroke-dasharray: 4 3; }
      .box-green { fill: var(--green-bg); stroke: var(--green); stroke-width: 1.25; }
      .box-amber { fill: var(--amber-bg); stroke: var(--amber); stroke-width: 1.25; }
      .box-purple { fill: var(--purple-bg); stroke: var(--purple); stroke-width: 1.25; }
      .box-hollow { fill: none; stroke: var(--accent); stroke-width: 1.4; stroke-dasharray: 6 4; }
      .box-layer { fill: var(--bg-card); stroke: var(--border); stroke-width: 1.2; }
      .box-surface { fill: var(--bg-card); stroke: var(--border-hover); stroke-width: 1.25; }
      .box-cassette { fill: var(--amber-bg); stroke: var(--amber); stroke-width: 1.4; }
      .box-replay { fill: var(--green-bg); stroke: var(--green); stroke-width: 1.4; }
      .stage-box { fill: var(--bg-subtle); stroke: var(--border); stroke-width: 1.2; }
      
      .card-main { fill: var(--bg-card); stroke: var(--accent); stroke-width: 1.5; }
      .card-subtle { fill: var(--bg-card); stroke: var(--border); stroke-width: 1.2; }
      .card-elevated { fill: var(--bg-subtle); stroke: var(--border); stroke-width: 1.2; }
      .card-footer { fill: var(--bg-subtle); stroke: var(--border); stroke-width: 1.2; }
      .card-left { fill: var(--bg-card); stroke: var(--border); stroke-width: 1.25; }
      .card-right { fill: var(--bg-card); stroke: var(--border); stroke-width: 1.25; }
      .card-green { fill: var(--green-bg); stroke: var(--green); stroke-width: 1.4; }
      .card-amber { fill: var(--amber-bg); stroke: var(--amber); stroke-width: 1.4; }
      .card-red { fill: var(--red-bg); stroke: var(--red); stroke-width: 1.4; }
      .card-cached { fill: var(--green-bg); stroke: var(--green); stroke-width: 1.4; }
      .card-dynamic { fill: var(--amber-bg); stroke: var(--amber); stroke-width: 1.4; }
      .card-durable { fill: var(--green-bg); stroke: var(--green); stroke-width: 1.4; }
      .card-eval { fill: var(--green-bg); stroke: var(--green); stroke-width: 1.4; }
      .card-test { fill: var(--purple-bg); stroke: var(--purple); stroke-width: 1.3; }
      .card-warning { fill: var(--bg-subtle); stroke: var(--amber); stroke-width: 1.3; }
      .card-working { fill: var(--red-bg); stroke: var(--red); stroke-width: 1.3; }
      .card-fragile { fill: var(--red-bg); stroke: var(--red); stroke-width: 1.3; }
      .card-seam { fill: var(--bg-card); stroke: var(--accent); stroke-width: 1.5; }
      .card-shadow { fill: var(--bg-card); stroke: var(--accent); stroke-width: 1.5; }
      .card-consumer { fill: var(--accent-subtle); stroke: var(--accent); stroke-width: 1.4; }
      .card-provider { fill: var(--bg-card); stroke: var(--border-hover); stroke-width: 1.25; }
      .card-teardown { fill: var(--bg-subtle); stroke: var(--border); stroke-width: 1.2; }
      .card-terminal { fill: var(--bg-card); stroke: var(--border-hover); stroke-width: 1.4; }
      .card-primitive { fill: var(--bg-card); stroke: var(--accent); stroke-width: 1.5; }
      .card-1 { fill: var(--amber-bg); stroke: var(--amber); stroke-width: 1.3; }
      .card-2 { fill: var(--red-bg); stroke: var(--red); stroke-width: 1.3; }
      .card-3 { fill: var(--purple-bg); stroke: var(--purple); stroke-width: 1.3; }
      .card-loop { fill: var(--bg-card); stroke: var(--accent); stroke-width: 1.5; }
      
      .pill-call { fill: var(--accent-subtle); stroke: var(--accent); stroke-width: 1.4; }
      .pill-safe { fill: var(--green-bg); stroke: var(--green); stroke-width: 1.4; }
      .pill-warn { fill: var(--amber-bg); stroke: var(--amber); stroke-width: 1.4; }
      .pill-danger { fill: var(--red-bg); stroke: var(--red); stroke-width: 1.4; }
      .pill-fold { fill: var(--accent-subtle); stroke: var(--accent); stroke-width: 1.4; }
      
      .title { font-size: 13px; font-weight: 700; fill: var(--text); }
      .title-lg { font-size: 13.5px; font-weight: 700; fill: var(--text); }
      .title-md { font-size: 12px; font-weight: 700; fill: var(--text); }
      .title-card { font-size: 13px; font-weight: 700; fill: var(--text); }
      .title-green { font-size: 13px; font-weight: 700; fill: var(--green); }
      .title-purple { font-size: 13px; font-weight: 700; fill: var(--purple); }
      .title-red { font-size: 12.5px; font-weight: 700; fill: var(--red); }
      .text-main { font-size: 12px; font-weight: 600; fill: var(--text); }
      .text-body { font-size: 11px; fill: var(--text-muted); }
      .text-code { font-size: 11px; font-weight: 600; fill: var(--text); }
      .text-sub { font-size: 11px; fill: var(--text-muted); }
      .text-acc { font-size: 11.5px; font-weight: 600; fill: var(--accent); }
      .text-bad { font-size: 11.5px; font-weight: 700; fill: var(--bad); }
      .text-green { font-size: 11.5px; font-weight: 600; fill: var(--green); }
      .text-rule { font-size: 11.5px; font-weight: 700; fill: var(--text); }
      .header { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; fill: var(--text-subtle); }
      .h { font-size: 10.5px; font-weight: 700; letter-spacing: 0.1em; fill: var(--text-subtle); }
      .t { font-size: 12px; font-weight: 600; fill: var(--text); }
      .s { font-size: 11.5px; fill: var(--text-muted); }
      .la { font-size: 11px; font-weight: 700; fill: var(--accent); }
      
      .tag-text { font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; fill: var(--accent); }
      .tag-accent { font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; fill: var(--accent); }
      .tag-green { font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; fill: var(--green); }
      .tag-amber { font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; fill: var(--amber); }
      .tag-bad { font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; fill: var(--bad); }
      .badge-text { font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em; fill: var(--accent); }
      .badge-pill { font-size: 10px; font-weight: 700; fill: var(--accent); }
      .check-icon { font-size: 12px; font-weight: 800; fill: var(--green); }
      
      .line { stroke: var(--border-hover); stroke-width: 1.4; fill: none; }
      .line-acc { stroke: var(--accent); stroke-width: 1.6; fill: none; }
      .line-bad { stroke: var(--bad); stroke-width: 1.4; fill: none; stroke-dasharray: 4 3; }
      .line-green { stroke: var(--green); stroke-width: 1.5; fill: none; }
      .line-dash { stroke: var(--border-hover); stroke-width: 1.2; fill: none; stroke-dasharray: 4 3; }
      .line-main { stroke: var(--accent); stroke-width: 1.6; fill: none; }
      .line-branch { stroke: var(--border-hover); stroke-width: 1.3; fill: none; }
      .line-break { stroke: var(--green); stroke-width: 1.8; stroke-dasharray: 4 4; fill: none; }
      .line-cut { stroke: var(--red); stroke-width: 1.5; stroke-dasharray: 4 3; fill: none; }
      .line-settle { stroke: var(--accent); stroke-width: 1.5; stroke-dasharray: 4 3; fill: none; }
      .line-sub { stroke: var(--border-hover); stroke-width: 1.3; fill: none; }
      .life { stroke: var(--border); stroke-width: 1.2; stroke-dasharray: 4 4; fill: none; }
    </style>`;

const MARKERS = `    <marker id="arr" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <polygon points="0 1, 9 5, 0 9" fill="var(--border-hover)"/>
    </marker>
    <marker id="arr-acc" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <polygon points="0 1, 9 5, 0 9" fill="var(--accent)"/>
    </marker>
    <marker id="arr-bad" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <polygon points="0 1, 9 5, 0 9" fill="var(--bad)"/>
    </marker>
    <marker id="arr-green" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <polygon points="0 1, 9 5, 0 9" fill="var(--green)"/>
    </marker>
    <marker id="arr-sub" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <polygon points="0 1, 9 5, 0 9" fill="var(--border-hover)"/>
    </marker>`;

const files = fs.readdirSync(DIAGRAMS_DIR).filter(f => f.endsWith('.svg')).sort();

for (const file of files) {
  const filePath = path.join(DIAGRAMS_DIR, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // 1. Check if race condition file needs viewBox adjustment
  const isRaceCondition = file.startsWith('part02-race-condition');
  if (isRaceCondition) {
    content = content.replace(/viewBox="0 0 900 250"/, 'viewBox="0 -10 900 260"');
  }

  // 2. Replace the <defs>...</defs> block
  const newDefs = `  <defs>\n${CSS_THEME}\n${MARKERS}\n  </defs>`;
  content = content.replace(/<defs>[\s\S]*?<\/defs>/, newDefs);

  // 3. Insert background plate after </defs> if not present
  if (!content.includes('class="bg-plate"')) {
    const plateRect = isRaceCondition
      ? `  <rect x="0" y="-10" width="100%" height="260" rx="8" class="bg-plate"/>\n`
      : `  <rect width="100%" height="100%" rx="8" class="bg-plate"/>\n`;
    content = content.replace(/<\/defs>\s*/, `</defs>\n\n${plateRect}\n`);
  }

  // 4. File-specific fixes for hardcoded colors
  if (file === 'part07-ptc-transport.svg') {
    content = content.replace(/fill="rgba\(248,\s*113,\s*113,\s*0\.15\)"/g, 'fill="var(--bad-bg)"');
    content = content.replace(/fill="rgba\(63,\s*185,\s*80,\s*0\.15\)"/g, 'fill="var(--green-bg)"');
  }

  if (file === 'part08-session-log-projection.svg') {
    content = content.replace(/fill="rgba\(210,\s*153,\s*34,\s*0\.15\)"/g, 'fill="var(--amber-bg)"');
  }

  if (file === 'part09-prompt-prefix-cache.svg') {
    content = content.replace(/fill="rgba\(63,\s*185,\s*80,\s*0\.2\)"/g, 'fill="var(--green-bg)"');
    content = content.replace(/fill="rgba\(210,\s*153,\s*34,\s*0\.2\)"/g, 'fill="var(--amber-bg)"');
    content = content.replace(
      /<rect x="405" y="156" width="90" height="20" rx="10" fill="var\(--green\)"\/>\s*<text x="450" y="170" text-anchor="middle" class="tag-green mono" fill="#0d1117" font-weight="800">BREAKPOINT<\/text>/,
      `<rect x="405" y="156" width="90" height="20" rx="10" fill="var(--green-bg)" stroke="var(--green)" stroke-width="1.4"/>\n  <text x="450" y="170" text-anchor="middle" class="tag-green mono" fill="var(--green)" font-weight="800">BREAKPOINT</text>`
    );
  }

  if (file === 'part10-context-budget.svg') {
    content = content.replace(/fill="rgba\(63,\s*185,\s*80,\s*0\.2\)"/g, 'fill="var(--green-bg)"');
    content = content.replace(/fill="rgba\(188,\s*140,\s*255,\s*0\.2\)"/g, 'fill="var(--purple-bg)"');
    content = content.replace(/fill="rgba\(210,\s*153,\s*34,\s*0\.2\)"/g, 'fill="var(--amber-bg)"');
  }

  if (file === 'part11-skills-loader.svg') {
    content = content.replace(/fill="rgba\(63,\s*185,\s*80,\s*0\.15\)"/g, 'fill="var(--green-bg)"');
    content = content.replace(
      /<text x="450" y="95" text-anchor="middle" font-size="10\.5px" font-weight="800" fill="#0d1117" class="mono">skill\(\)<\/text>/,
      `<text x="450" y="95" text-anchor="middle" font-size="10.5px" font-weight="800" fill="var(--accent)" class="mono">skill()</text>`
    );
  }

  if (file === 'part12-cross-session-recall.svg') {
    content = content.replace(/fill="rgba\(248,\s*113,\s*113,\s*0\.15\)"/g, 'fill="var(--bad-bg)"');
    content = content.replace(/fill="rgba\(63,\s*185,\s*80,\s*0\.15\)"/g, 'fill="var(--green-bg)"');
  }

  if (file === 'part19-code-edits.svg') {
    content = content.replace(/fill="rgba\(63,\s*185,\s*80,\s*0\.2\)"/g, 'fill="var(--green-bg)"');
  }

  if (file === 'part20-background-work.svg') {
    content = content.replace(/fill="rgba\(63,\s*185,\s*80,\s*0\.12\)"/g, 'fill="var(--green-bg)"');
  }

  if (file === 'part21-delegation-subagents.svg') {
    content = content.replace(/fill="rgba\(110,\s*118,\s*129,\s*0\.2\)"/g, 'fill="var(--bg-subtle)" stroke="var(--border)" stroke-width="1"');
  }

  if (file === 'part24-todo-plan-goal.svg') {
    content = content.replace(/fill="rgba\(248,\s*113,\s*113,\s*0\.15\)"/g, 'fill="var(--bad-bg)"');
    content = content.replace(/fill="rgba\(63,\s*185,\s*80,\s*0\.15\)"/g, 'fill="var(--green-bg)"');
  }

  if (file === 'part25-model-guards.svg') {
    content = content.replace(/fill="rgba\(210,\s*153,\s*34,\s*0\.2\)"/g, 'fill="var(--amber-bg)"');
    content = content.replace(/fill="rgba\(248,\s*113,\s*113,\s*0\.2\)"/g, 'fill="var(--bad-bg)"');
    content = content.replace(/fill="rgba\(188,\s*140,\s*255,\s*0\.2\)"/g, 'fill="var(--purple-bg)"');
  }

  if (file === 'part28-evals-telemetry.svg') {
    content = content.replace(/fill="rgba\(188,\s*140,\s*255,\s*0\.15\)"/g, 'fill="var(--purple-bg)"');
    content = content.replace(/fill="rgba\(63,\s*185,\s*80,\s*0\.15\)"/g, 'fill="var(--green-bg)"');
  }

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Updated ${file}`);
}

console.log('All 47 diagrams successfully updated!');
