import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
 entryPoints: ["src/reading-view.ts"], bundle: true, platform: "node", format: "esm", write: false,
 plugins: [{ name: "host", setup(builder) {
  builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test" }));
  builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `export class Component { load() {} unload() {} } export class MarkdownRenderChild {} export class Notice {} export class Scope {} export class TFile {} export const MarkdownRenderer = {}; export function setIcon() {}` }));
 } }],
});
const { ReadingViewManager } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function fixture() {
 let callback, child, cancelled = false, draws = 0;
 const state = {};
 const manager = new ReadingViewManager({});
 manager.ensureState = () => state;
 manager.schedule = () => draws++;
 const el = { dataset: {}, isConnected: false, closest: () => el.isConnected ? {} : null,
  win: { requestAnimationFrame: (cb) => { callback = cb; return 7; }, cancelAnimationFrame: (id) => { cancelled = id === 7; } } };
 manager.handleBlock(el, { sourcePath: "synthetic.md", getSectionInfo: () => ({ text: "%% test %%", lineStart: 0, lineEnd: 0 }), addChild: (value) => { child = value; } });
 return { manager, el, state, load: () => child.onload(), unload: () => child.onunload(), frame: () => callback(), draws: () => draws, cancelled: () => cancelled };
}
test("reading cards attach after detached Markdown blocks enter the view", () => {
 const f = fixture(); f.load(); assert.equal(f.draws(), 0);
 f.el.isConnected = true; f.frame();
 assert.equal(f.draws(), 1); assert.equal(f.state.text, "%% test %%"); assert.equal(f.state.sourcePath, "synthetic.md");
});
test("unloading a block cancels its pending attachment", () => {
 const f = fixture(); f.load(); f.unload(); assert.equal(f.cancelled(), true);
});
test("unloaded manager ignores pending block attachment", () => {
 const f = fixture(); f.load(); f.manager.destroy(); f.el.isConnected = true; f.frame(); assert.equal(f.draws(), 0);
});

test("renderer teardown cancels redraws and removes the gutter class", () => {
 let callback, cancelled, removed, destroyed = false;
 const manager = new ReadingViewManager({});
 const state = { wrapper: {}, frame: null, onScroll() {},
  scroller: { win: { requestAnimationFrame(cb) { callback = cb; return 42; }, cancelAnimationFrame(id) { cancelled = id; } }, removeEventListener() {}, classList: { remove(name) { removed = name; } }, style: { removeProperty() {} } },
  resizeObserver: { disconnect() {} }, tables: { destroy() {} }, layer: { destroy() { destroyed = true; } } };
 manager.states.set(state.wrapper, state);
 manager.draw = () => assert.fail("disposed renderer must not draw");
 manager.schedule(state);
 manager.destroy();
 callback();
 assert.equal(cancelled, 42); assert.equal(removed, "irc-has-comments"); assert.equal(destroyed, true); assert.equal(manager.states.size, 0);
});

for (const kind of ["direct table", "nested table", "foreign-window table", "ambiguous tables", "missing row"]) {
 test(`Reading view retains row anchoring and fallback for ${kind}`, () => {
  const main = new JSDOM(""), foreign = new JSDOM("");
  const previous = globalThis.HTMLTableElement;
  globalThis.HTMLTableElement = main.window.HTMLTableElement;
  try {
   const win = kind === "foreign-window table" ? foreign.window : main.window;
   const doc = win.document;
   const table = doc.createElement("table");
   table.innerHTML = "<thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody>";
   table.rows[1].getBoundingClientRect = () => ({ top: 450 });
   const nested = kind === "nested table" || kind === "ambiguous tables";
   const block = nested ? doc.createElement("div") : table;
   if (nested) block.appendChild(table);
   if (kind === "ambiguous tables") block.appendChild(table.cloneNode(true));
   if (kind === "missing row") table.rows[1].remove();
   block.getBoundingClientRect = () => ({ top: 100 });
   // Model Obsidian's cross-window helper using the element's own constructor.
   block.instanceOf = (type) => block instanceof win[type.name];
   doc.body.appendChild(block);
   doc.body.win = win;
   if (kind === "foreign-window table") assert.equal(table instanceof globalThis.HTMLTableElement, false);
   let items;
   const manager = new ReadingViewManager({ settings: { enabled: true, cardWidth: 240 }, drafts: { observe() {} } });
   manager.collectBlocks = () => [{ el: block, lineStart: 0, lineEnd: 2 }];
   manager.draw({ wrapper: doc.body, scroller: doc.body, sourcePath: "Synthetic.md",
    text: "| Header |\n| --- |\n| Cell %% review %% |", tables: { update() {} },
    layer: { setWidth() {}, setLeft() {}, render(value) { items = value; } } });
   assert.equal(items.length, 1);
   assert.equal(items[0].top, kind === "ambiguous tables" || kind === "missing row" ? 100 : 450);
  } finally { globalThis.HTMLTableElement = previous; main.window.close(); foreign.window.close(); }
 });
}
