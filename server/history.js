// What Tend has actually done, one record per carried-out action. Used to skip work that
// is already done, to keep handled items out of the queue, and as evidence for the AI.
// Stored in server/data/history.json (git-ignored: it describes this sandbox's state).
import { readFile, writeFile } from 'node:fs/promises';

const HISTORY_FILE = new URL('./data/history.json', import.meta.url);

let records = null;
let writing = Promise.resolve();

async function load() {
  if (records) return records;
  try {
    records = JSON.parse(await readFile(HISTORY_FILE, 'utf8'));
  } catch {
    records = [];
  }
  return records;
}

// Writes are queued so two quick actions can't overwrite each other's file write.
function persist() {
  writing = writing.then(() => writeFile(HISTORY_FILE, `${JSON.stringify(records, null, 2)}\n`)).catch((err) => {
    console.error('Could not save history:', err.message);
  });
  return writing;
}

// The same row, action and amount is the same piece of work.
export const workKey = (itemId, action, amount) => `${itemId}|${action}|${Math.round(Number(amount ?? 0) * 100)}`;

export async function record(entry) {
  await load();
  records.push({ ...entry, at: new Date().toISOString() });
  await persist();
}

export async function findDone(key) {
  return (await load()).find((entry) => entry.key === key && entry.status === 'done') ?? null;
}

// Every successful action per item, oldest first, for the queue and the AI.
export async function doneByItem() {
  const byItem = new Map();
  for (const entry of await load()) {
    if (entry.status !== 'done') continue;
    if (!byItem.has(entry.itemId)) byItem.set(entry.itemId, []);
    byItem.get(entry.itemId).push(entry);
  }
  return byItem;
}
