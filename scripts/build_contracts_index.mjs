// Writes public/contracts.json: the 15 incoming drafts (id, title, words, text) for the web page's picker.
import fs from "node:fs";
import { listContracts } from "../lib/pipeline.mjs";
const list = listContracts("data/incoming").map(({ id, title, words, text, file }) => ({ id, title, words, text, file }));
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync("public/contracts.json", JSON.stringify(list));
console.log(`${list.length} contracts written to public/contracts.json`);
