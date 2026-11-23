// Writes the 30,000 most common English words (most common first) for the term scorer.
// Run with: node scripts/build-wordlist.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const subtlexWordFrequencies = JSON.parse(
  readFileSync(new URL('../node_modules/subtlex-word-frequencies/index.json', import.meta.url), 'utf8')
)

const words = subtlexWordFrequencies
  .map((e) => e.word.toLowerCase())
  .filter((w) => /^[a-z]{2,}$/.test(w))
const unique = [...new Set(words)].slice(0, 30000)
writeFileSync(new URL('../src/renderer/src/lib/common-words.json', import.meta.url), JSON.stringify(unique.join(' ')))
console.log(unique.length, 'words;', 'rank of', ['the', 'attention', 'model', 'layer', 'sequence', 'encoder', 'softmax', 'position', 'translation', 'architecture'].map((w) => `${w}=${unique.indexOf(w)}`).join(' '))
