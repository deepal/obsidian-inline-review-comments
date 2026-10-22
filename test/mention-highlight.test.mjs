import assert from "node:assert/strict";
import { test } from "node:test";
import { highlightMentionMarkdown, highlightMentionText } from "../src/mention-highlight.ts";

const mark = (text) => `<span class="aio-mention-tag">${text}</span>`;
test("highlight matches only complete prose tags, retaining spelling and Markdown", () => {
 const body = "Please **@Teddy**, then @teddy. @teddybear @teddy-extra";
 assert.equal(highlightMentionMarkdown(body, "teddy"), `Please **${mark("@Teddy")}**, then ${mark("@teddy")}. @teddybear @teddy-extra`);
});
test("code, quotes, links, escaped mentions and email are left alone without merging surrounding tokens", () => {
 const body = "`@teddy`\n> @teddy\n```md\n@teddy\n```\n[link](https://example.com/@teddy) name@teddy.com \\@teddy @ted`code`dy <a title='@teddy'>link</a>";
 assert.equal(highlightMentionMarkdown(body, "teddy"), body);
 assert.equal(highlightMentionMarkdown(body + "\n@teddy", "teddy"), body + "\n" + mark("@teddy"));
 assert.equal(highlightMentionMarkdown("@teddy", ""), "@teddy");
 assert.equal(highlightMentionMarkdown("@teddy bear", "teddy bear"), "@teddy bear");
});
test("plain text highlighting uses text nodes and preserves literal content", () => {
 const parts=[];
 const el={ownerDocument:{createTextNode:text=>({text})},setText(text){parts.splice(0,parts.length,{text});},empty(){parts.length=0;},append:node=>parts.push(node),createSpan:options=>parts.push({text:options.text,cls:options.cls})};
 const body="<literal> @Teddy & text";
 highlightMentionText(el,body,"teddy");
 assert.equal(parts.map(p=>p.text).join(""),body);assert.equal(parts[1].cls,"aio-mention-tag");
 highlightMentionText(el,body,"");assert.deepEqual(parts,[{text:body}]);
});
