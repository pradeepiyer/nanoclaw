#!/usr/bin/env node

import { readFileSync } from "fs";

const [src, tgt, ...words] = process.argv.slice(2);
const text = words.join(" ");

if (!src || !tgt || !text) {
  console.error("Usage: translate.mjs <source_lang> <target_lang> <text>");
  process.exit(1);
}

const key = readFileSync("/workspace/group/.sarvam-key", "utf8").trim();

const res = await fetch("https://api.sarvam.ai/translate", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "API-Subscription-Key": key,
  },
  body: JSON.stringify({
    input: text,
    source_language_code: src,
    target_language_code: tgt,
    model: "sarvam-translate:v1",
  }),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`Sarvam API error ${res.status}: ${body}`);
  process.exit(1);
}

const data = await res.json();
console.log(data.translated_text);
