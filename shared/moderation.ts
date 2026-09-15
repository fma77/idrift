/**
 * Display-name moderation.
 *
 * Shared verbatim between the browser and the Worker. The client copy gives
 * immediate feedback as the player types; the server copy is the one that
 * actually decides, because the client can be edited by anyone with devtools.
 * Keeping them the same module means the two can never drift apart and start
 * disagreeing about what is acceptable.
 *
 * Rejected names are rejected, never silently altered -- a player whose name
 * quietly turns into asterisks has no idea why, and will just try again.
 *
 * English and Portuguese, since that is who plays this. Kids will read this
 * leaderboard, so the list errs toward strictness.
 */

export const MAX_NAME_LENGTH = 14;
export const MIN_NAME_LENGTH = 2;

/**
 * Words blocked anywhere in the name, including inside another word.
 *
 * Reserved for terms with essentially no innocent substring use. Everything
 * milder goes in WORD_LIST, which only matches whole words -- that is what
 * keeps the classic "Scunthorpe problem" from rejecting real names.
 */
const SUBSTRING_LIST = [
  'fuck', 'shit', 'cunt', 'nigger', 'nigga', 'faggot', 'retard', 'rape',
  'paedo', 'pedo', 'nazi', 'hitler',
  // Deliberate misspellings, listed explicitly. The alternative -- fuzzy
  // matching on consonant skeletons -- catches these but also rejects "shot"
  // and "asset", and a filter that rejects ordinary words gets switched off.
  'fock', 'fok', 'fuk', 'fcuk', 'fvck', 'phuck', 'fuc',
  'caralho', 'foda', 'fodase', 'puta', 'merda', 'piroca', 'pariu',
];

/**
 * Names that contain a banned substring but are entirely innocent.
 *
 * Checked before the substring scan. Short, because it only needs to cover the
 * collisions that actually happen: "Scunthorpe" contains a slur, "grape" and
 * "therapist" contain "rape", "torpedo" and "speedo" contain "pedo". Matched
 * against the normalised form, so it survives the same folding as everything else.
 */
const ALLOW_LIST = [
  'scunthorpe', 'penistone', 'clitheroe',
  'grape', 'grapes', 'therapist', 'therapy', 'scrape', 'drape', 'rapeseed',
  'torpedo', 'speedo', 'speedos', 'tuxedo',
  'shiitake', 'matsushita', 'ashit',
  'reputation', 'disputa', 'computador', 'amputa',
  'assassin', 'cockburn', 'analysis',
];

/** Blocked only as a standalone word, so "assassin" and "Bassett" survive. */
const WORD_LIST = [
  'ass', 'arse', 'bitch', 'bastard', 'dick', 'cock', 'piss', 'slut', 'whore',
  'wank', 'twat', 'prick', 'sex', 'porn', 'penis',
  'vagina', 'boob', 'tits', 'anal', 'anus', 'kys',
  // "cona" lives here rather than in the substring list: as a substring it
  // rejects "Conan" and "Conor".
  'cona',
  'burro', 'idiota', 'estupido', 'cabrao', 'corno', 'broche', 'punheta',
  'cu', 'rabo', 'peida', 'chupa', 'pila', 'badalhoco',
];

/** Reserved so nobody can impersonate the game or an admin on the board. */
const RESERVED = ['admin', 'idrift', 'moderator', 'system', 'official', 'anonymous'];

/**
 * Fold the obvious evasions before matching.
 *
 * Leetspeak, padding characters and repeated letters are the entire toolkit
 * most people reach for, and normalising them costs a few lines. This is not
 * meant to defeat a determined adversary -- it is meant to stop a ten-year-old
 * getting something rude onto a board their cousins will see.
 */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    // Strip combining accents so "pütã" folds to "puta".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[4@]/g, 'a')
    .replace(/[3€]/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z0-9]/g, '')
    // Collapse runs of the same letter: "fuuuuck" -> "fuck".
    .replace(/(.)\1{1,}/g, '$1');
}

export type NameRejection =
  | 'tooShort'
  | 'tooLong'
  | 'empty'
  | 'noLetters'
  | 'profanity'
  | 'reserved';

export interface NameCheck {
  ok: boolean;
  reason?: NameRejection;
  message?: string;
}

const MESSAGES: Record<NameRejection, string> = {
  empty: 'Pick a name first.',
  tooShort: `At least ${MIN_NAME_LENGTH} characters.`,
  tooLong: `At most ${MAX_NAME_LENGTH} characters.`,
  noLetters: 'Names need at least one letter.',
  profanity: 'Pick a different name — kids read this board.',
  reserved: 'That name is reserved. Pick another.',
};

export function checkName(raw: string): NameCheck {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fail('empty');
  if (trimmed.length < MIN_NAME_LENGTH) return fail('tooShort');
  if (trimmed.length > MAX_NAME_LENGTH) return fail('tooLong');

  // The letter requirement is checked against the RAW name, not the normalised
  // one. Normalisation folds leetspeak, so "!!!!" becomes "i" and "12345"
  // becomes "i2eas" -- both would pass a letter check on the folded form while
  // being obvious junk as a display name.
  if (!/\p{L}/u.test(trimmed)) return fail('noLetters');

  const normalised = normaliseName(trimmed);
  if (normalised.length === 0) return fail('noLetters');

  if (ALLOW_LIST.some((word) => normaliseName(word) === normalised)) {
    return checkReserved(normalised, trimmed);
  }

  for (const word of SUBSTRING_LIST) {
    if (normalised.includes(normaliseName(word))) return fail('profanity');
  }

  // Whole-word matching against the milder list. The normalised string has lost
  // its separators, so split the original on non-letters instead.
  const words = trimmed.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const word of words) {
    const n = normaliseName(word);
    if (WORD_LIST.includes(n)) return fail('profanity');
    if (RESERVED.includes(n)) return fail('reserved');
  }
  // A single run-together word still needs checking against the word list.
  if (WORD_LIST.includes(normalised)) return fail('profanity');

  return checkReserved(normalised, trimmed);
}

function checkReserved(normalised: string, raw: string): NameCheck {
  if (RESERVED.includes(normalised)) return fail('reserved');
  for (const word of raw.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    if (RESERVED.includes(normaliseName(word))) return fail('reserved');
  }
  return { ok: true };
}

function fail(reason: NameRejection): NameCheck {
  return { ok: false, reason, message: MESSAGES[reason] };
}
