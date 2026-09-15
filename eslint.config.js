import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The important part of this file is the `src/sim/**` block.
 *
 * Everything under src/sim is a pure, deterministic simulation: same inputs =>
 * bit-identical outputs, on every JS engine, forever. That property is what
 * gives us ghosts, replays, reproducible bug reports and (later) server-side
 * verification. It is extremely easy to break by accident and almost impossible
 * to notice when you do, so it is enforced mechanically here rather than by
 * discipline.
 */
const SIM_BANNED_PROPERTIES = [
  // Implementation-defined in ECMA-262: engines are free to return different
  // last-place bits. src/sim/math/trig.ts implements deterministic versions.
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'pow', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p',
  'hypot', 'cbrt', 'fround',
  // Non-deterministic by definition.
  'random',
].map((property) => ({
  object: 'Math',
  property,
  message: `Math.${property} is implementation-defined or non-deterministic. Use the deterministic equivalent from src/sim/math/ (trig.ts, prng.ts).`,
}));

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.wrangler/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error', ...SIM_BANNED_PROPERTIES],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'The sim must run headless in Node. No DOM access.' },
        { name: 'document', message: 'The sim must run headless in Node. No DOM access.' },
        { name: 'navigator', message: 'The sim must run headless in Node. No DOM access.' },
        { name: 'localStorage', message: 'The sim is pure. Persistence belongs in src/storage.' },
        { name: 'performance', message: 'No wall-clock time in the sim. The sim only knows tick count.' },
        { name: 'requestAnimationFrame', message: 'The sim is driven by a fixed timestep, not by frames.' },
        { name: 'fetch', message: 'The sim is pure. Load data outside it and pass it in.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Date']",
          message: 'No wall-clock time in the sim. The sim only knows tick count.',
        },
        {
          selector: 'NewExpression[callee.name=/^(Date|Map|Set|WeakMap|WeakSet)$/]',
          message: 'Iteration order of Map/Set and the value of Date are not safe for determinism. Use arrays with fixed indices.',
        },
        {
          selector: "CallExpression[callee.object.name='Object'][callee.property.name=/^(keys|values|entries)$/]",
          message: 'Object key order must never affect sim output. Use arrays with fixed indices.',
        },
        {
          selector: 'BinaryExpression[operator="**"]',
          message: '`**` is Math.pow and is implementation-defined for non-integer exponents. Write the multiplications out, or use powi() from src/sim/math/trig.ts.',
        },
        {
          selector: "CallExpression[callee.property.name='toSorted']",
          message: 'Sort comparators must be total and explicit in the sim. Use an explicit, deterministic comparator on a plain array.',
        },
      ],
    },
  },
  {
    // The route baker and tests run in Node and are allowed to use whatever they like:
    // their *output* is data that gets committed, not code that runs inside the sim.
    files: ['tools/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        Blob: 'readonly',
        Response: 'readonly',
        CompressionStream: 'readonly',
        DecompressionStream: 'readonly',
      },
    },
    rules: { 'no-restricted-properties': 'off', 'no-restricted-syntax': 'off' },
  },
);
