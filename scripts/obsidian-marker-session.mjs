import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { build } from "esbuild";

export const project = path.resolve(import.meta.dirname, "..");
export const hash = value => createHash("sha256").update(value).digest("hex");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Only creates a new, sentinel-verified vault; never attaches to a personal app. */
export async function startSession() {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), "irc-marker-qa-"));
 const vault = path.join(root, `IRC Marker QA ${path.basename(root).slice(-6)}`), profile = path.join(root, "profile"), token = randomUUID();
 const config = path.join(vault, ".obsidian");
 await fs.mkdir(config, { recursive: true }); await fs.mkdir(profile);
 await fs.writeFile(path.join(vault, ".irc-marker-qa.json"), JSON.stringify({ token, disposable: true }));
 await fs.writeFile(path.join(profile, "obsidian.json"), JSON.stringify({ vaults: { [randomUUID()]: { path: vault, ts: Date.now(), open: true } } }));
 await fs.writeFile(path.join(config, "app.json"), JSON.stringify({ livePreview: true, safeMode: false, readableLineLength: true, showInlineTitle: false }));
 await fs.writeFile(path.join(config, "community-plugins.json"), '["inline-review-comment"]');
 await fs.writeFile(path.join(vault, "Review.md"), "Intro.\n\nTail.\n");
 const artifacts = {};
 async function copyPlugin(dir, id) {
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
  if (manifest.id !== id) throw Error(`Unexpected plugin ID: ${manifest.id}`);
  const dest = path.join(config, "plugins", id); await fs.mkdir(dest, { recursive: true });
  const sha256 = {};
  for (const name of ["main.js", "manifest.json", "styles.css"]) { const bytes = await fs.readFile(path.join(dir, name)); await fs.writeFile(path.join(dest, name), bytes); sha256[name] = hash(bytes); }
  artifacts[id] = { version: manifest.version, sha256 };
 }
 await copyPlugin(project, "inline-review-comment");
 if (process.env.OBSIDIAN_QA_INLINE_DIFF_DIR) await copyPlugin(path.resolve(process.env.OBSIDIAN_QA_INLINE_DIFF_DIR), "inline-diff");
 const oracle = path.join(config, "plugins", "irc-marker-qa-oracle"); await fs.mkdir(oracle, { recursive: true });
 await fs.writeFile(path.join(oracle, "manifest.json"), JSON.stringify({ id: "irc-marker-qa-oracle", name: "IRC marker QA oracle", author: "QA", description: "Disposable marker regression tools.", version: "0.0.0", minAppVersion: "1.13.0", isDesktopOnly: true }));
 const parser = await build({ stdin: { contents: "export {parseComments} from './src/parser.ts';", resolveDir: project }, bundle: true, platform: "node", format: "cjs", write: false });
 await fs.writeFile(path.join(oracle, "main.js"), `
const {Plugin,apiVersion}=require('obsidian'),commands=require('@codemirror/commands');
const parseComments=(()=>{const module={exports:{}};${parser.outputFiles[0].text};return module.exports.parseComments;})();
module.exports=class extends Plugin {
 onload(){globalThis.ircMarkerQa={version:apiVersion,parseComments,
  history(view){return {undo:commands.undoDepth(view.editor.cm.state),redo:commands.redoDepth(view.editor.cm.state)}},
  async save(view){await view.save();for(let i=0;i<300;i++){if(!view.saving&&!view.saveAgain)return;await new Promise(r=>setTimeout(r,10))}throw Error('Save did not settle')},
 };}
 onunload(){delete globalThis.ircMarkerQa;}
};`);
 const child = spawn(process.env.OBSIDIAN_EXECUTABLE || "/Applications/Obsidian.app/Contents/MacOS/Obsidian", [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], { stdio: ["ignore", "ignore", "pipe"] });
 let stderr = "", browser; child.stderr.on("data", b => { stderr += b; });
 try {
  let port, page;
  for (let i = 0; i < 150 && !port; i++) { try { port = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { if (child.exitCode !== null) throw Error(stderr); await pause(100); } }
  if (!port) throw Error(`Disposable debugger did not start: ${stderr}`);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let i = 0; i < 150 && !page; i++) { for (const candidate of browser.contexts()[0].pages()) if (await candidate.evaluate(() => !!globalThis.app?.workspace?.layoutReady).catch(() => false)) { page = candidate; break; } if (!page) await pause(100); }
  if (!page) throw Error("Disposable workspace did not load");
  page.setDefaultTimeout(15000);
  const actual = await page.evaluate(() => app.vault.adapter.getBasePath()), sentinel = JSON.parse(await fs.readFile(path.join(actual, ".irc-marker-qa.json"), "utf8"));
  if (actual !== vault || !sentinel.disposable || sentinel.token !== token) throw Error("Refusing a non-disposable vault");
  await page.waitForFunction(() => !!app.plugins.plugins['inline-review-comment'] || [...document.querySelectorAll('.modal button')].some(b => b.textContent === 'Trust author and enable plugins'));
  const trust = page.getByRole("button", { name: "Trust author and enable plugins", exact: true }); if (await trust.count()) await trust.click();
  await page.waitForFunction(() => !!app.plugins.plugins['inline-review-comment']);
  await page.evaluate(async () => { app.setting?.close(); await app.plugins.loadManifests(); await app.plugins.enablePlugin('irc-marker-qa-oracle'); await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('Review.md')); });
  await page.waitForFunction(() => !!globalThis.ircMarkerQa);
  await fs.mkdir(path.join(project, ".qa"), { recursive: true });
  await fs.writeFile(path.join(project, ".qa", "marker-session.json"), JSON.stringify({ root, vault, profile, token, port, pid: child.pid }, null, 2));
  return { root, vault, config, artifacts, page, browser, async close() { try { await browser.close(); } finally { child.kill(); } } };
 } catch (error) { await browser?.close().catch(() => {}); child.kill(); throw error; }
}

export async function setFixture(page, source, mode) {
 await page.evaluate(async ({ source, mode }) => {
  const leaf = app.workspace.activeLeaf;
  if (leaf.view.getViewType() === 'markdown') await ircMarkerQa.save(leaf.view);
  await leaf.setViewState({ type: 'empty', state: {} });
  const file = app.vault.getAbstractFileByPath('Review.md'); await app.vault.modify(file, source); await leaf.openFile(file);
  await leaf.setViewState({ type: 'markdown', state: { file: 'Review.md', mode: 'source', source: mode === 'source' } });
 }, { source, mode });
 await page.waitForFunction(source => { const v=app.workspace.activeLeaf.view; return v.file?.path==='Review.md' && v.editor.getValue()===source && v.data===source; }, source);
 await page.evaluate(async mode => {
  const leaf = app.workspace.activeLeaf, v=leaf.view; v.editor.setCursor(v.editor.lastLine(),0); v.editor.scrollIntoView({from:{line:0,ch:0},to:{line:0,ch:0}},true);
  if (mode==='reading') await leaf.setViewState({type:'markdown',state:{file:'Review.md',mode:'preview'}});
  app.plugins.plugins['inline-diff']?.overlays.get(v.contentEl.ownerDocument)?.hide();
 },mode);
 if (mode==='reading') await page.waitForFunction(source => {const r=app.workspace.activeLeaf.view.previewMode.renderer;return r.lastText===source&&!r.parsing&&!r.queued&&!r.rendered;},source);
}

export async function settle(page) {
 await page.evaluate(async () => {const doc=app.workspace.activeLeaf.view.contentEl.ownerDocument;await doc.fonts.ready;for(let i=0;i<12;i++)await new Promise(r=>doc.defaultView.requestAnimationFrame(r));});
}
