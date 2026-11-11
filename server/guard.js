// Protection for the public, hosted link:
//   - an owner passcode before anything is carried out in PayPal (if OWNER_PASSCODE is set)
//   - rate limits so visitors can't burn through the Gemini key
// All in memory: a restart clears the counters, which is fine for a demo.
import { createHash, timingSafeEqual } from 'node:crypto';

export const passcodeRequired = () => Boolean(process.env.OWNER_PASSCODE);

const digest = (text) => createHash('sha256').update(String(text)).digest();

// Counts events per key in a sliding window.
function limiter({ max, windowMs }) {
  const hits = new Map();
  return {
    // Returns how many seconds to wait, or 0 if this event is allowed (and counts it).
    take(key) {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return Math.ceil((windowMs - (now - recent[0])) / 1000);
      }
      recent.push(now);
      hits.set(key, recent);
      return 0;
    },
  };
}

const wrongPasscodes = limiter({ max: 5, windowMs: 10 * 60_000 });
const commands = limiter({ max: 30, windowMs: 10 * 60_000 });
const freshReviews = limiter({ max: 1, windowMs: 60_000 });

const tooMany = (res, seconds, what) =>
  res
    .status(429)
    .set('Retry-After', String(seconds))
    .json({ error: `${what} Try again in ${seconds} second${seconds === 1 ? '' : 's'}.` });

// Express middleware: the request must carry the owner passcode in X-Tend-Passcode.
export function requirePasscode(req, res, next) {
  if (!passcodeRequired()) return next();
  const given = req.get('X-Tend-Passcode') ?? '';
  // Compared as hashes, in constant time, so the check can't leak how close a guess was.
  if (given && timingSafeEqual(digest(given), digest(process.env.OWNER_PASSCODE))) return next();

  const wait = wrongPasscodes.take(req.ip);
  if (wait) return tooMany(res, wait, 'Too many wrong passcodes.');
  return res.status(401).json({ error: given ? 'That passcode is not right.' : 'The owner passcode is needed to carry out actions.', passcode: true });
}

// Typed commands: 30 per visitor every 10 minutes.
export function limitCommands(req, res, next) {
  const wait = commands.take(req.ip);
  return wait ? tooMany(res, wait, 'That is a lot of commands in a short time.') : next();
}

// A fresh AI review of the whole queue: at most once a minute, for everyone together.
export function freshReviewWait() {
  return freshReviews.take('all');
}
