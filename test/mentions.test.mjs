import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { hasMention, inlineIdentity } from "../src/agent-bridge.ts";

const bundle = await build({ entryPoints: ["src/mention-format.ts"], bundle: true, platform: "node", format: "esm", write: false });
const formats = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const format = formats.discussionFormat ?? formats.inlineFormat;
const discussion = !!formats.discussionFormat;
const comment = (id, body) => discussion ? `<comment id="${id}" author="Alice">\n${body}\n</comment>` : `%% ::Alice:: ${body} %%`;

test("mentions match complete case-insensitive tags in prose only", () => {
 for (const body of ["@teddy help", "Please @Teddy, explain", "**@teddy**"]) assert.equal(hasMention(body, "teddy"), true, body);
 for (const body of ["@teddybear", "@teddy-more", "name@teddy.com", "\\@teddy", "`@teddy`", "> @teddy\nOrdinary text", "```md\n@teddy\n```", "[example](https://x/@teddy)"]) assert.equal(hasMention(body, "teddy"), false, body);
 assert.equal(hasMention("@teddy", ""), false);
});
test("metadata is removed without changing ordinary comment text", () => {
 assert.deepEqual(inlineIdentity("Normal message"), { body: "Normal message" });
 assert.deepEqual(inlineIdentity("@teddy help <!-- aio-comment:abc-123 -->"), { body: "@teddy help", id: "abc-123" });
});
test("replies append to the correct thread and preserve existing messages", () => {
 let text = "Prose\n" + comment("1", "@teddy question") + (discussion ? "\n\n" : " ") + comment("2", "Follow-up") + "\n\nOther prose";
 const target = format.parse(text)[0];
 text = format.identify(text, target, "identity");
 // Discussions already had an ID: don't add another one.
 if (discussion) text = "Prose\n" + comment("1", "@teddy question") + "\n\n" + comment("2", "Follow-up") + "\n\nOther prose";
 const original = format.parse(text);
 const request = { id: "request-1", commentId: original[0].id, message: original[0].body };
 const result = format.reply(text, request, "teddy", "An answer with %% and </comment> examples");
 const parsed = format.parse(result);
 assert.equal(parsed.length, 3); assert.equal(parsed[0].body, "@teddy question"); assert.equal(parsed[1].body, "Follow-up");
 assert.equal(parsed[2].author, "teddy"); assert.equal(parsed[2].agent, true);
 assert.equal(format.replied(result, "request-1"), true); assert.equal(format.replied(result, "different"), false);
 assert.ok(result.endsWith("Other prose"));
 if (discussion) assert.equal(parsed[2].parentId, "1");
 else assert.equal(format.thread(result, parsed[0]).length, 3);
});
test("deleted targets are rejected rather than attaching elsewhere", () => {
 assert.throws(() => format.reply(comment("2", "different"), { id: "request", commentId: "missing" }, "teddy", "Answer"));
});

const containers = [
 ["paragraph",c=>`Before ${c} after`],
 ["heading",c=>`## Title ${c}`],
 ["list",c=>`- Item ${c}`],
 ["task",c=>`- [ ] Item ${c}`],
 ["nested list",c=>`- Parent\n  1. Item ${c}`],
 ["quote",c=>`> Passage ${c}`],
 ["nested quote",c=>`> > Passage ${c}`],
 ["callout",c=>`> [!note]\n> Passage ${c}`],
 ["footnote",c=>`Text[^1]\n\n[^1]: Detail ${c}`],
 ["table header",c=>`| Header ${c} | Other |\n| --- | --- |\n| Value | Neighbor |`],
 ["table body",c=>`| Header | Other |\n| --- | --- |\n| Value ${c} | Neighbor |`],
 ["quoted table",c=>`> | Header | Other |\n> | --- | --- |\n> | Value ${c} | Neighbor |`],
];
for(const [name,wrap] of containers) test(`mentions and multiline replies remain in the ${name} thread`,()=>{
 let text=wrap(comment("1","@teddy question"));const target=format.parse(text)[0];
 assert.equal(target.body,"@teddy question");assert.equal(hasMention(target.body,"teddy"),true);
 text=format.identify(text,target,"root-id");const original=format.parse(text)[0];
 const body="Answer with a | pipe.\n\n- Item one\n- Item two\n\n```js\nconst example = 1;\n```";
 const result=format.reply(text,{id:"request-one",commentId:original.id},"teddy",body);
 const thread=format.thread(result,format.parse(result)[0]);assert.equal(thread.length,2,name);
 assert.equal(thread[1].body,body);assert.equal(format.parse(result)[1].agent,true);assert.equal(thread[0].body,original.body);
 if(name.includes("table")){
  assert.equal(result.split("\n").length,text.split("\n").length);
  assert.ok(result.endsWith(text.slice(original.to)),"preserve following columns and rows");
 }
});

test("multiline comments inside quotes and callouts expose prose mentions but retain inner quoted examples",()=>{
 for(const prefix of ["> ","> > "]){
  const text=prefix+"%%\n"+prefix+"::Alice:: @teddy question\n"+prefix+"> @other quoted example\n"+prefix+"%%";
  const [parsed]=format.parse(text);assert.equal(parsed.author,"Alice");assert.equal(hasMention(parsed.body,"teddy"),true);assert.equal(hasMention(parsed.body,"other"),false);
 }
});

test("mentions in literal code remain excluded inside tables, quotes and callouts",()=>{
 for(const text of [
  "| A | B |\n| --- | --- |\n| `%% @teddy example %%` | Value |",
  "> ```md\n> %% @teddy example %%\n> ```",
  "> [!note]\n> ~~~md\n> %% @teddy example %%\n> ~~~",
  "```md\n%% @teddy example %%\n```",
 ]) assert.equal(format.parse(text).length,0,text);
});

test("unpaired literal comment markers in code cannot swallow later agent mentions",()=>{
 for(const code of [
  "`literal %% example`",
  "```md\n%% example\n```",
  "> ```md\n> %% example\n> ```",
  "| A | B |\n| --- | --- |\n| `%% example` | end |",
 ]){
  const text=code+"\n\n"+comment("1","@teddy actual request");
  const parsed=format.parse(text);assert.equal(parsed.length,1,code);assert.equal(parsed[0].body,"@teddy actual request");
 }
});
