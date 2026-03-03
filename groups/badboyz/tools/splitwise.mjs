#!/usr/bin/env node

// Splitwise API CLI tool
// Usage:
//   node splitwise.mjs groups                  — list all Splitwise groups
//   node splitwise.mjs balances <group_id>     — get simplified debts for a group

import { readFileSync } from "fs";

const API_BASE = "https://secure.splitwise.com/api/v3.0";

// Read API key from the group's key file
let apiKey;
try {
  apiKey = readFileSync("/workspace/group/.splitwise-key", "utf-8").trim();
} catch {
  console.error("Error: Could not read /workspace/group/.splitwise-key");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

async function fetchApi(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`, { headers });
  if (!res.ok) {
    const body = await res.text();
    console.error(`API error ${res.status}: ${body}`);
    process.exit(1);
  }
  return res.json();
}

async function listGroups() {
  const data = await fetchApi("/get_groups");
  const groups = data.groups
    .filter((g) => g.id !== 0) // filter out the "non-group" expenses
    .map((g) => ({
      id: g.id,
      name: g.name,
      members: g.members.map((m) => ({
        id: m.id,
        first_name: m.first_name,
        last_name: m.last_name,
      })),
      updated_at: g.updated_at,
    }));
  console.log(JSON.stringify(groups, null, 2));
}

async function getBalances(groupId) {
  const data = await fetchApi(`/get_group/${groupId}`);
  const group = data.group;

  // Build member lookup
  const members = {};
  for (const m of group.members) {
    members[m.id] = `${m.first_name} ${m.last_name}`.trim();
  }

  // Extract simplified debts
  const debts = (group.simplified_debts || []).map((d) => ({
    from: members[d.from] || `User ${d.from}`,
    to: members[d.to] || `User ${d.to}`,
    amount: parseFloat(d.amount),
    currency: d.currency_code,
  }));

  console.log(
    JSON.stringify(
      {
        group_name: group.name,
        debts,
      },
      null,
      2
    )
  );
}

// --- CLI ---
const command = process.argv[2];

if (command === "groups") {
  await listGroups();
} else if (command === "balances") {
  const groupId = process.argv[3];
  if (!groupId) {
    console.error("Usage: node splitwise.mjs balances <group_id>");
    process.exit(1);
  }
  await getBalances(groupId);
} else {
  console.error("Usage:");
  console.error("  node splitwise.mjs groups");
  console.error("  node splitwise.mjs balances <group_id>");
  process.exit(1);
}
