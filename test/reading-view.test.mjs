import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
 entryPoints: ["src/reading-view.ts"], bundle: true, platform: "node", format: "esm", write: false,
 plugins: [{ name: "host", setup(builder) {
  builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test" }));
  builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `export class MarkdownRenderChild {} export class Notice {} export class TFile {} export const MarkdownRenderer = {}; export function setIcon() {}` }));
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
  scroller: { win: { requestAnimationFrame(cb) { callback = cb; return 42; }, cancelAnimationFrame(id) { cancelled = id; } }, removeEventListener() {}, classList: { remove(name) { removed = name; } } },
  resizeObserver: { disconnect() {} }, layer: { destroy() { destroyed = true; } } };
 manager.states.set(state.wrapper, state);
 manager.draw = () => assert.fail("disposed renderer must not draw");
 manager.schedule(state);
 manager.destroy();
 callback();
 assert.equal(cancelled, 42); assert.equal(removed, "irc-has-comments"); assert.equal(destroyed, true); assert.equal(manager.states.size, 0);
});
