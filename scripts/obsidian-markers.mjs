import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { startSession, setFixture, settle, project, hash } from "./obsidian-marker-session.mjs";

const exactFile = process.env.OBSIDIAN_QA_OVERRIDE_FILE, themeRoot = process.env.OBSIDIAN_QA_THEME_ROOT;
const suite = parseArgs({ options: { suite: { type: 'string', default: 'all' } } }).values.suite;
assert.ok(['all','matrix','compat','windows','runtime'].includes(suite), 'Use --suite=all|matrix|compat|windows|runtime.');
assert.ok(exactFile && themeRoot, "Set OBSIDIAN_QA_OVERRIDE_FILE and OBSIDIAN_QA_THEME_ROOT (read-only inputs).");
assert.ok(process.env.OBSIDIAN_QA_INLINE_DIFF_DIR, "Set OBSIDIAN_QA_INLINE_DIFF_DIR to the corrected Inline Diff assets.");
const exact = await fs.readFile(exactFile), exactHash = hash(exact), session = await startSession();
const { page } = session, cases = [], errors = [], screenshots = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error" && /plugin:inline-review-comment|plugin:inline-diff|Inline Diff:/.test(m.text())) errors.push(m.text()); });
session.browser.contexts()[0].on('page', p => {p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&/plugin:inline-review-comment|plugin:inline-diff|Inline Diff:/.test(m.text()))errors.push(m.text())});});
const c = (i = 0) => `%% ${i % 3 === 2 ? "" : `::Reviewer ${i}:: `}Review this cell ${i}. %%`;
const comments = n => Array.from({ length: n }, (_, i) => c(i)).join(" ");
const proposal = "{~~Earlier wording~>Updated wording~~}", following = "Following sentinel remains unchanged.";
const table = (cell, header = "Item", second = "Stable") => `| ${header} | Value |\n| --- | --- |\n| Previous | Stable |\n| ${cell} | ${second} |\n| ${following} | Stable |`;
const wrap = text => `Intro.\n\n${text}\n\nTail.\n`;
const native = [
 ["empty-one", table(c())], ["empty-four", table(comments(4))],
 ["empty-header-one", table("Body", c())], ["empty-header-four", table("Body", comments(4))],
 ["formatted", table('Text \\| [label](https://example.invalid) `a|b` ' + c() + ' tail')],
 ["repeated-cells", table("Same " + c(), "Same", "Same " + c(1))],
 ["multiple-quoted-tables", table("Same " + c()) + '\n\n> [!note] Context\n>\n' + table("Same " + c(1)).split('\n').map(line => '> ' + line).join('\n')],
];
const pending = [
 ["proposal-one", table(proposal + c())], ["proposal-four", table(proposal + comments(4))],
 ["before-proposal", table(comments(4) + ' ' + proposal)],
 ["between-proposals", table(proposal + comments(4) + ' ' + proposal), 2],
 ["header-proposal", table("Body", proposal + comments(4))],
 ["identical-alternatives", table('{~~Same wording~>Same wording~~}' + c() + ' {~~Same wording~>Same wording~~}' + c(1)), 2],
];
const profiles = [
 ["none", ""], ["exact", exact.toString()],
 ["padding", '.table-cell-wrapper{padding:7px 11px 13px 9px!important}.markdown-reading-view td,.markdown-reading-view th{padding:7px 11px 13px 9px!important}'],
 ["large-type", '.cm-contentContainer,.markdown-rendered{font-size:20px;line-height:200%!important}.table-cell-wrapper{font-size:20px;line-height:30px}'],
];

async function configure(target, profile, palette, width, theme = "") {
 const [id, css] = profiles.find(p => p[0] === profile);
 await fs.mkdir(path.join(session.config, "snippets"), { recursive: true });
 await fs.writeFile(path.join(session.config, "snippets", "marker-qa.css"), css);
 await target.setViewportSize({ width, height: 1200 });
 await target.evaluate(async ({ id, css, palette, theme }) => {
  await app.customCss.setTheme(theme); app.changeTheme(palette === 'light' ? 'moonstone' : 'obsidian');
  globalThis.ircMarkerQa ??= app.workspace.rootSplit.containerEl.ownerDocument.defaultView.ircMarkerQa;
  await app.customCss.readSnippets(); app.customCss.setCssEnabledStatus('marker-qa', !!css); await app.customCss.loadSnippets();
  const doc = app.workspace.activeLeaf.view.contentEl.ownerDocument; doc.body.id = 'irc-marker-qa';
  let style = doc.getElementById('marker-qa-layout'); if (!style) { style = doc.createElement('style'); style.id = 'marker-qa-layout'; doc.head.append(style); }
  style.textContent = '#irc-marker-qa .markdown-source-view table,#irc-marker-qa .markdown-reading-view table{table-layout:fixed;width:500px;min-width:500px;max-width:500px}#irc-marker-qa .markdown-source-view td,#irc-marker-qa .markdown-source-view th,#irc-marker-qa .markdown-reading-view td,#irc-marker-qa .markdown-reading-view th{width:250px;min-width:250px;max-width:250px}';
 }, { id, css, palette, theme });
 await target.waitForFunction(css => css ? app.customCss.extraStyleEls.some(e => e.textContent === css) : !app.customCss.enabledSnippets.has('marker-qa'), css);
 await settle(target);
}
async function integration(enabled) {
 await page.evaluate(async enabled => { if (enabled && !app.plugins.plugins['inline-diff']) await app.plugins.enablePlugin('inline-diff'); if (!enabled && app.plugins.plugins['inline-diff']) await app.plugins.disablePlugin('inline-diff'); }, enabled);
}
async function ready(target, mode, source, proposals = 0) {
 if (proposals && mode !== 'source') await target.waitForFunction(({ mode, proposals }) => app.workspace.activeLeaf.view.contentEl.querySelectorAll((mode === 'reading' ? '.markdown-reading-view' : '.markdown-source-view') + ' .inline-diff-proposal').length === proposals, { mode, proposals });
 await target.waitForFunction(({ mode, source }) => {
  const view = app.workspace.activeLeaf.view, root = view.contentEl.querySelector(mode === 'reading' ? '.markdown-reading-view' : '.markdown-source-view');
  return root && root.querySelectorAll('.irc-inline-avatar').length === ircMarkerQa.parseComments(source).length;
 }, { mode, source });
 await settle(target);
}
async function snapshot(target, mode) {
 return target.evaluate(({ mode, following }) => {
  const view = app.workspace.activeLeaf.view, doc = view.contentEl.ownerDocument, win = doc.defaultView;
  const root = view.contentEl.querySelector(mode === 'reading' ? '.markdown-reading-view' : '.markdown-source-view');
  const rect = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, bottom: b.bottom, right: b.right }; };
  const expected = ircMarkerQa.parseComments(view.getViewData()).map(c => ({ label: c.author ? `Comment by ${c.author}` : 'Comment', id: c.id ?? `${c.from}:${c.to}` }));
  const avatars = [...root.querySelectorAll('.irc-inline-avatar')].map(e => {
   const cell = e.closest('td,th'), row = cell?.closest('tr'), wrapper = cell?.querySelector(':scope > .table-cell-wrapper');
   return { rect: rect(e), label: e.getAttribute('aria-label'), id: e.dataset.ircRenderedMarker ?? null, cell: cell ? rect(cell) : null, row: row ? rect(row) : null, rowIndex: row?.rowIndex, cellIndex: cell?.cellIndex, hasWrapper: !!wrapper, insideOwnWrapper: !!wrapper?.contains(e), insideComparison: !!e.closest('.inline-diff-proposal'), parent: e.parentElement.tagName };
  });
  const found = [], walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT); let node;
  while ((node = walker.nextNode())) { const at = node.data.indexOf(following); if (at < 0) continue; const range = doc.createRange(); range.setStart(node, at); range.setEnd(node, at + following.length); const boxes = [...range.getClientRects()].filter(b => b.width && b.height).map(b => ({x:b.x,y:b.y,w:b.width,h:b.height,right:b.right,bottom:b.bottom})); if (!boxes.length) continue;
   const s = win.getComputedStyle(node.parentElement), block = node.parentElement.closest('tr,.cm-line,p');
   found.push({ boxes, blockHeight: block?.getBoundingClientRect().height, style: Object.fromEntries(['font-family','font-size','font-weight','font-style','line-height','letter-spacing','white-space','color'].map(k => [k,s.getPropertyValue(k)])) });
  }
  return { expected, avatars, following: found, source: view.getViewData(), history: ircMarkerQa.history(view), marginLayers: view.contentEl.querySelectorAll('.irc-margin-layer').length };
 }, { mode, following });
}
function check(actual, baseline, mode) {
 assert.equal(actual.avatars.length, actual.expected.length, 'one marker per comment');
 assert.deepEqual(actual.avatars.map(a => a.label), actual.expected.map(c => c.label), 'source order and author identity');
 if (mode !== 'source') assert.deepEqual(actual.avatars.map(a => a.id), actual.expected.map(c => c.id), 'rendered marker source IDs');
 for (const avatar of actual.avatars) {
  if (avatar.hasWrapper) assert.equal(avatar.insideOwnWrapper, true, 'marker belongs inside its own direct wrapper');
  for (const box of [avatar.cell, avatar.row].filter(Boolean)) { const a = avatar.rect; assert.ok(a.y >= box.y - .5 && a.bottom <= box.bottom + .5 && a.x >= box.x - .5 && a.right <= box.right + .5, 'avatar remains within owning cell/row'); }
  for (const entry of actual.following) for (const box of entry.boxes) assert.ok(Math.min(avatar.rect.right, box.right) - Math.max(avatar.rect.x, box.x) <= .5 || Math.min(avatar.rect.bottom, box.bottom) - Math.max(avatar.rect.y, box.y) <= .5, 'avatar does not overlap following text');
 }
 if (baseline) {
  assert.equal(actual.following.length, baseline.following.length, 'following content occurrence count');
  for (let i = 0; i < actual.following.length; i++) { const a=actual.following[i], b=baseline.following[i]; assert.deepEqual(a.style,b.style,'following typography'); assert.ok(Math.abs(a.blockHeight-b.blockHeight)<=.5,'following row/line height'); assert.equal(a.boxes.length,b.boxes.length,'following wrapping'); for(let j=0;j<a.boxes.length;j++)assert.ok(Math.abs(a.boxes[j].w-b.boxes[j].w)<=.5 && Math.abs(a.boxes[j].h-b.boxes[j].h)<=.5,'following glyph dimensions'); }
 }
}
async function capture(name, run) {
 try { const detail = await run(); cases.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); }
 catch (error) { cases.push({ name, passed: false, error: error.message }); console.log(`FAIL ${name} ${error.message.split('\n')[0]}`); }
}
async function verifyFixture(target, mode, fixture, shared = false) {
 const [id, body, proposals = 0] = fixture, source = wrap(body), control = source.replace(/\{~~([^]*?)~>([^]*?)~~\}/g, '$2');
 await setFixture(target, control, mode); await ready(target, mode, control); const baseline = await snapshot(target, mode);
 await setFixture(target, source, mode); await ready(target, mode, source, proposals); const actual = await snapshot(target, mode);
 check(actual, baseline, mode); assert.equal(actual.source, source); assert.equal(await fs.readFile(path.join(session.vault,'Review.md'),'utf8'),source); if(!shared)assert.deepEqual(actual.history,{undo:0,redo:0});
 return { fixture: id, markers: actual.avatars.length, maxOverflow: Math.max(0,...actual.avatars.flatMap(a=>a.row?[a.rect.bottom-a.row.bottom]:[])) };
}
async function screenshot(target, name) { const file=path.join(project,'.qa',name+'.png'); await target.screenshot({path:file}); screenshots.push({name,sha256:hash(await fs.readFile(file))}); }

try {
 for (const theme of ['Primary','Minimal','Blue Topaz']) { const dest=path.join(session.config,'themes',theme); await fs.mkdir(dest,{recursive:true}); for (const name of ['manifest.json','theme.css']) await fs.copyFile(path.join(themeRoot,theme,name),path.join(dest,name)); }
 if (suite==='all'||suite==='matrix') for (const enabled of [false,true]) {
  await integration(enabled);
  for (const palette of ['light','dark']) for (const profile of profiles.map(p=>p[0])) for (const width of [1280,720]) {
   await configure(page,profile,palette,width);
   for (const mode of ['source','live','reading']) for (const fixture of [...native,...(enabled?pending:[])]) {
    const name=`Default/${palette}/${profile}/${width}/${enabled?'combined':'irc-only'}/${mode}/${fixture[0]}`;
    await capture(name,()=>verifyFixture(page,mode,fixture));
    if (palette==='light' && profile==='exact' && width===1280 && mode!=='source' && fixture[0]===(enabled?'proposal-four':'empty-four')) await screenshot(page,`${enabled?'combined':'native'}-${mode}`);
   }
  }
 }
 await integration(true);
 if (suite==='all'||suite==='compat') for (const theme of ['Primary','Minimal','Blue Topaz']) for (const palette of ['light','dark']) for (const width of [1280,720]) {
  await configure(page,'exact',palette,width,theme);
  for (const mode of ['live','reading']) for (const fixture of [native[1],native[3],pending[1]]) await capture(`${theme}/${palette}/${width}/${mode}/${fixture[0]}`,()=>verifyFixture(page,mode,fixture));
 }
 await configure(page,'exact','light',1280);
 if (suite==='all'||suite==='windows') for (const mode of ['live','reading']) {
  for (const windowKind of ['split','popout']) await capture(`windows/${mode}/${windowKind}`,async()=>{
   await setFixture(page,wrap(pending[1][1]),mode); await ready(page,mode,wrap(pending[1][1]),1);
   await page.evaluate(async kind=>{globalThis.markerQaMain=app.workspace.activeLeaf;globalThis.markerQaExtra=kind==='split'?app.workspace.getLeaf('split'):app.workspace.openPopoutLeaf();await markerQaExtra.openFile(markerQaMain.view.file);app.workspace.setActiveLeaf(markerQaExtra,{focus:true});},windowKind);
   let target=page;
   try {
    if(windowKind==='popout'){for(let i=0;i<150&&target===page;i++){for(const p of session.browser.contexts()[0].pages())if(p!==page&&await p.locator('.markdown-source-view').count()){target=p;break}if(target===page)await new Promise(r=>setTimeout(r,50))}assert.notEqual(target,page,'native popout opened');}
    await configure(target,'exact','light',720); const detail=await verifyFixture(target,mode,pending[1],true),history=await target.evaluate(()=>ircMarkerQa.history(app.workspace.activeLeaf.view));
    await target.evaluate(()=>require('electron').webFrame.setZoomFactor(1.5)); await settle(target); check(await snapshot(target,mode),null,mode);
    await target.evaluate(()=>{const v=app.workspace.activeLeaf.view;v.editor.scrollTo(0,1000)}); await settle(target); check(await snapshot(target,mode),null,mode);
    await target.evaluate(()=>require('electron').webFrame.setZoomFactor(1)); assert.deepEqual(await target.evaluate(()=>ircMarkerQa.history(app.workspace.activeLeaf.view)),history,'window changes preserve existing undo history');return detail;
   } finally {await page.evaluate(()=>{markerQaExtra.detach();app.workspace.setActiveLeaf(markerQaMain,{focus:true});delete globalThis.markerQaExtra;delete globalThis.markerQaMain;});}
  });
 }
 // Lifecycle and UI edits use the default main window; no provider configuration is installed.
 await configure(page,'none','light',1280); await integration(true);
 if (suite==='all'||suite==='runtime') {
 for(const mode of ['live','reading']) await capture(`runtime/${mode}/snippets-reload-unload`,async()=>{
  const fixture=pending[1],source=wrap(fixture[1]);await setFixture(page,source,mode);await ready(page,mode,source,1);const history=await page.evaluate(()=>ircMarkerQa.history(app.workspace.activeLeaf.view));
  for(const profile of ['padding','large-type','exact','none']){await configure(page,profile,'light',1280);check(await snapshot(page,mode),null,mode);}
  await page.evaluate(async()=>{await app.plugins.disablePlugin('inline-review-comment')});await settle(page);assert.equal((await snapshot(page,mode)).avatars.length,0);
  await page.evaluate(async()=>{await app.plugins.enablePlugin('inline-review-comment')});await ready(page,mode,source,1);check(await snapshot(page,mode),null,mode);
  assert.equal(await page.evaluate(()=>app.workspace.activeLeaf.view.getViewData()),source);assert.deepEqual(await page.evaluate(()=>ircMarkerQa.history(app.workspace.activeLeaf.view)),history,'reload and snippets preserve existing undo history');
 });
 for(const mode of ['live','reading']) await capture(`runtime/${mode}/virtualized-scroll-return`,async()=>{
  await integration(true);
  const source=wrap(pending[1][1])+'\n\n'+Array.from({length:100},(_,i)=>`Unrelated paragraph ${i}.`).join('\n\n');
  await setFixture(page,source,mode);await ready(page,mode,source,1);
  const selector=mode==='live'?'.workspace-leaf.mod-active .markdown-source-view .cm-scroller':'.workspace-leaf.mod-active .markdown-preview-view';
  const scroller=page.locator(selector).first();
  await scroller.evaluate(el=>{el.scrollTop=el.scrollHeight});await settle(page);assert.ok(await scroller.evaluate(el=>el.scrollTop)>0,'actually scrolled away');
  await scroller.evaluate(el=>{el.scrollTop=0});await ready(page,mode,source,1);check(await snapshot(page,mode),null,mode);
  assert.equal(await page.evaluate(()=>app.workspace.activeLeaf.view.getViewData()),source);
 });
 await capture('runtime/native-cell-editing-and-comment-composer',async()=>{
  const source=wrap(table('Text '+c()+' tail'));await integration(false);await setFixture(page,source,'live');await ready(page,'live',source);
  const cell=page.locator('.workspace-leaf.mod-active .cm-table-widget tbody td').nth(2);await cell.dblclick();
  await page.waitForFunction(()=>app.workspace.activeLeaf.view.contentEl.querySelector('.cm-table-widget .cm-editor'));
  await page.keyboard.press('End');await page.keyboard.type(' edited');
  await page.locator('.workspace-leaf.mod-active .markdown-source-view .cm-content').first().click({position:{x:5,y:5}});
  await page.evaluate(()=>app.workspace.activeLeaf.view.editor.setCursor(app.workspace.activeLeaf.view.editor.lastLine(),0));await settle(page);
  let edited=await page.evaluate(()=>app.workspace.activeLeaf.view.getViewData());assert.ok(edited.includes(' edited'));await ready(page,'live',edited);check(await snapshot(page,'live'),null,'live');
  await page.locator('.irc-margin-layer [aria-label="Edit comment"]').first().click();
  const input=page.locator('.irc-margin-layer textarea[aria-label="Edit comment"]');await input.fill('Updated review body.');await input.press('Meta+Enter');
  await page.waitForFunction(()=>app.workspace.activeLeaf.view.getViewData().includes('Updated review body.'));await page.evaluate(()=>ircMarkerQa.save(app.workspace.activeLeaf.view));
  edited=await page.evaluate(()=>app.workspace.activeLeaf.view.getViewData());await ready(page,'live',edited);check(await snapshot(page,'live'),null,'live');
  assert.equal(await fs.readFile(path.join(session.vault,'Review.md'),'utf8'),edited);
 });
 }
 assert.equal(hash(await fs.readFile(exactFile)),exactHash,'private override input unchanged');
} finally {
 const runtime=await page.evaluate(()=>({version:ircMarkerQa.version,versions:process.versions})).catch(()=>null);
 const report={date:new Date().toISOString(),runtime,artifacts:session.artifacts,exactOverrideSha256:exactHash,cases,errors,screenshots,summary:{total:cases.length,passed:cases.filter(c=>c.passed).length,failed:cases.filter(c=>!c.passed).length}};
 await fs.writeFile(path.join(project,'.qa',suite==='all'?'marker-report.json':`marker-${suite}-report.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report.summary));await session.close();if(report.summary.failed||errors.length)process.exitCode=1;
}
