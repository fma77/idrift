import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkName, normaliseName, MAX_NAME_LENGTH } from '../shared/moderation.ts';

/**
 * This is the one piece of the project with a safety obligation: the board is
 * public and kids read it. It is also the piece most likely to be quietly
 * broken by a well-meaning edit to the word lists, so it gets real tests.
 */

const accepted = [
  'FILIPE', 'Ana', 'MAX', 'Zé', 'JOÃO', 'drift_king', 'AE86', 'R32',
  // Names that a naive substring filter would wrongly reject -- the classic
  // Scunthorpe problem. All of these must pass.
  'Assassin', 'Bassett', 'Cockburn', 'Dickinson', 'Scunthorpe', 'Cumbria',
  'Analysis', 'Sexton', 'Hellman', 'Cuba', 'Cutler', 'Rabona',
];

const rejected = [
  'fuck', 'FUCK', 'f u c k', 'fuuuck', 'f0ck', 'phuck-off',
  'sh1t', '5h1t', 'SH!T', 'bitch', 'B1TCH',
  'caralho', 'C4R4LH0', 'puta', 'pÜtã', 'merda', 'M3RD4',
  'admin', 'ADMIN', 'iDrift', 'moderator',
];

test('ordinary names are accepted', () => {
  for (const name of accepted) {
    const result = checkName(name);
    assert.ok(result.ok, `"${name}" should be accepted but was rejected as ${result.reason}`);
  }
});

test('profanity and evasions are rejected', () => {
  for (const name of rejected) {
    const result = checkName(name);
    assert.ok(!result.ok, `"${name}" should have been rejected`);
    assert.ok(result.message, `"${name}" was rejected without a message to show the player`);
  }
});

test('normalisation folds the usual evasion tricks', () => {
  assert.equal(normaliseName('F.U.C.K'), 'fuck');
  assert.equal(normaliseName('fuuuuuck'), 'fuck');
  assert.equal(normaliseName('5H1T'), 'shit');
  assert.equal(normaliseName('pÜtã'), 'puta');
  assert.equal(normaliseName('  M e R d A  '), 'merda');
});

test('length and content limits are enforced', () => {
  assert.equal(checkName('').reason, 'empty');
  assert.equal(checkName('   ').reason, 'empty');
  assert.equal(checkName('a').reason, 'tooShort');
  assert.equal(checkName('x'.repeat(MAX_NAME_LENGTH + 1)).reason, 'tooLong');
  // The letter requirement reads the raw name. Checking the normalised form
  // instead would let both of these through, because leetspeak folding turns
  // "!" into "i" and "1" into "i".
  assert.equal(checkName('12345').reason, 'noLetters');
  assert.equal(checkName('!!!!').reason, 'noLetters');
  assert.ok(checkName('AE86').ok, 'letters plus digits is a fine name');
  assert.ok(checkName('R32').ok);
});

test('a rejection always carries a message the player can act on', () => {
  for (const name of ['', 'a', 'x'.repeat(40), '123', 'fuck', 'admin']) {
    const result = checkName(name);
    assert.ok(!result.ok);
    assert.ok(
      typeof result.message === 'string' && result.message.length > 0,
      `"${name}" produced no message`,
    );
  }
});

test('names are rejected, never silently altered', () => {
  // The brief is explicit about this: a player whose name quietly turns into
  // asterisks has no idea why. checkName only ever reports; it returns no
  // cleaned-up string to substitute.
  const result = checkName('fuck');
  assert.equal(result.ok, false);
  assert.ok(!('cleaned' in result) && !('sanitised' in result));
});
