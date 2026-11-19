/** Compare complete recorded retrieval observations, excluding only elapsed time. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { digest } from './fixture.js'

const [referenceDirectory, currentDirectory, output] = process.argv.slice(2)
assert(referenceDirectory && currentDirectory && output, 'Expected reference directory, current directory and output file')
const read = directory => {
  const raw = readFileSync(path.join(directory, 'retrieval.jsonl'), 'utf8')
  const observations = raw.trim().split('\n').map(line => {
    const { elapsedMs, ...result } = JSON.parse(line)
    return result
  })
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  return { rawSha256: digest(raw), observations, source: manifest.source.sha256 }
}
const reference = read(referenceDirectory), current = read(currentDirectory)
assert.deepStrictEqual(current.observations, reference.observations)
writeFileSync(output, JSON.stringify({
  comparisons: current.observations.length, differences: 0, excludedFields: ['elapsedMs'],
  comparedFields: 'All other fields, including case coordinates, returned IDs and order, scores, coverage and errors',
  referenceResultSha256: reference.rawSha256, currentResultSha256: current.rawSha256,
  referenceSource: reference.source, currentSource: current.source,
}, null, 2) + '\n')
console.log(`${current.observations.length} recorded observations equal`)
