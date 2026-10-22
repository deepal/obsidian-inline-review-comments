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
