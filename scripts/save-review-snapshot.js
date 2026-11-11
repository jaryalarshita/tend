// Saves the latest Gemini review as server/data/review-snapshot.json (committed), so a
// fresh clone or a Render cold start can show the queue without calling Gemini.
// Proposals are kept for items open in PayPal right now, and for items this computer has
// already handled (Render doesn't share this computer's history, so it still shows them).
//
// Use after reseeding: npm run seed -- --reset, load the app once (one Gemini review),
// then npm run snapshot, then commit the snapshot with sales.json and reminders.json.
import { readFile, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import { doneByItem } from '../server/history.js';
import { collectItems } from '../server/sources.js';

dotenv.config({ quiet: true });

const LAST_REVIEW = new URL('../server/data/last-review.json', import.meta.url);
const SNAPSHOT = new URL('../server/data/review-snapshot.json', import.meta.url);

async function main() {
  let review;
  try {
    review = JSON.parse(await readFile(LAST_REVIEW, 'utf8'));
  } catch {
    throw new Error('No saved review yet. Run the app and load the queue once (or press "Ask the AI again"), then retry.');
  }

  const { items, errors } = await collectItems();
  if (errors.length) throw new Error(`Couldn't read PayPal: ${errors.map((e) => e.message).join('; ')}`);

  const open = new Set([...items.map((item) => item.id), ...(await doneByItem()).keys()]);
  const proposals = Object.fromEntries(Object.entries(review.proposals).filter(([id]) => open.has(id)));
  const missing = items.filter((item) => !proposals[item.id]);

  await writeFile(
    SNAPSHOT,
    `${JSON.stringify(
      {
        reviewedAt: review.reviewedAt,
        model: review.model,
        note: 'Committed snapshot of a Gemini review of the demo items. Used when no fresh review exists (e.g. a Render cold start), for items whose evidence is unchanged.',
        proposals,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`Saved ${Object.keys(proposals).length} proposals from the ${review.model} review of ${review.reviewedAt}.`);
  if (missing.length) {
    console.log(`Not in that review (they will go to Gemini on first load): ${missing.map((item) => item.customer).join(', ')}`);
  }
  console.log('Commit server/data/review-snapshot.json (with sales.json and reminders.json if you reseeded).');
}

main().catch((err) => {
  console.error(`Snapshot failed: ${err.message}`);
  process.exit(1);
});
