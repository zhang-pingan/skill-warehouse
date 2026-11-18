/** Reproduce the confirmation protocol's sample-size assumptions without loading evaluation questions. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const designPath = new URL('./confirmation-design.json', import.meta.url);
const designBytes = await readFile(designPath);
const design = JSON.parse(designBytes);

function normalCdf(value) {
  const x = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * x);
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * t
    * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return value >= 0 ? 1 - tail : tail;
}

function confirmationAlpha(index) {
  assert(Number.isInteger(index) && index > 0);
  return design.inference.overallFalseApplicationBudget / (index * (index + 1));
}

function intervalHalfWidth(n, variance, alpha) {
  assert(Number.isInteger(n) && n >= 2);
  assert(Number.isFinite(variance) && variance >= 0);
  assert(alpha > 0 && alpha < 1);
  const log = Math.log(4 / alpha);
  return Math.sqrt(2 * variance * log / n) + 14 * log / (3 * (n - 1));
}

function approximatePower({ n, q, delta, index, route }) {
  assert(q >= Math.abs(delta) && q <= 1);
  const variance = q - delta * delta;
  const standardError = Math.sqrt(variance / n);
  const halfWidth = intervalHalfWidth(n, variance, confirmationAlpha(index));
  const requiredObservedDifference = route === 'quality'
    ? Math.max(design.qualityRoute.minimumAbsoluteImprovement, halfWidth)
    : halfWidth - design.efficiencyRoute.qualityNoninferiorityMargin;
  const power = standardError === 0
    ? Number(delta > requiredObservedDifference)
    : 1 - normalCdf((requiredObservedDifference - delta) / standardError);
  return { n, q, delta, index, route, alpha: confirmationAlpha(index), variance, halfWidth, standardError, requiredObservedDifference, approximatePower: power };
}

function planSample({ q, delta, index, route }) {
  const config = design.samplePlanning;
  const floor = route === 'quality' ? config.qualityMinimumFamiliesPerPrimary : config.efficiencyMinimumFamiliesPerQualityMetric;
  const multiple = config.familyCountMultiple;
  const first = Math.ceil(floor / multiple);
  const last = Math.floor(config.maximumSearchFamilies / multiple);
  const at = unit => approximatePower({ n: unit * multiple, q, delta, index, route });
  if (at(last).approximatePower < config.targetApproximatePower) {
    return { q, delta, index, route, families: null, reason: 'Target planning power is not reached within the registered search range.', maximum: at(last) };
  }
  let low = first;
  let high = last;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (at(middle).approximatePower >= config.targetApproximatePower) high = middle;
    else low = middle + 1;
  }
  return { ...at(low), families: low * multiple, pairedVersionRepetitions: low * multiple * design.sampling.pairedRepeats * 2 };
}

assert(Math.abs(normalCdf(0) - 0.5) < 1e-7);
assert(Math.abs(normalCdf(1.959963984540054) - 0.975) < 1e-6);
assert(confirmationAlpha(1) <= 0.05);
assert(intervalHalfWidth(12, 0, confirmationAlpha(1)) > 0.01);
assert(intervalHalfWidth(48, 0, confirmationAlpha(1)) > 0.01);
assert(intervalHalfWidth(1200, 0.25, confirmationAlpha(1)) > intervalHalfWidth(50000, 0.25, confirmationAlpha(1)));
assert(approximatePower({ n: 2000000, q: 0.25, delta: 0.05, index: 1, route: 'quality' }).approximatePower < 0.500001);

const firstThreeConfirmations = [1, 2, 3].map(index => ({
  index,
  quality: planSample({ q: design.samplePlanning.assumedPairedDiscordance, delta: design.samplePlanning.qualityTrueImprovementAlternative, index, route: 'quality' }),
  efficiencyQualityNoninferiority: planSample({ q: design.samplePlanning.assumedPairedDiscordance, delta: 0, index, route: 'noninferiority' }),
}));
const qualitySensitivity = design.samplePlanning.sensitivityDiscordance.flatMap(q => design.samplePlanning.sensitivityQualityTrueImprovements.map(delta => planSample({ q, delta, index: 1, route: 'quality' })));
const noninferioritySensitivity = design.samplePlanning.sensitivityDiscordance.map(q => planSample({ q, delta: 0, index: 1, route: 'noninferiority' }));
const currentSampleLimits = [12, 48].map(n => ({
  families: n,
  zeroObservedVarianceHalfWidth: intervalHalfWidth(n, 0, confirmationAlpha(1)),
  planning: approximatePower({ n, q: 0.25, delta: 0.08, index: 1, route: 'quality' }),
  interpretation: 'A baseline/development cohort; repetitions do not make this a powered confirmation cohort.',
}));
const report = {
  schemaVersion: 1,
  protocolId: design.protocolId,
  designSha256: createHash('sha256').update(designBytes).digest('hex'),
  scriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  calculation: 'Deterministic normal planning approximation using an empirical Bernstein half-width at the assumed variance; no corpus, holdout or model output is read.',
  targetApproximatePower: design.samplePlanning.targetApproximatePower,
  firstThreeConfirmations,
  qualitySensitivity,
  noninferioritySensitivity,
  currentSampleLimits,
  limitations: [
    'Planning probabilities are conditional on the stated effect, discordance and approximate normal sampling distribution; they are not measured or guaranteed power.',
    'The confidence formula requires independent admitted source families. Template copies and repeated calls do not supply that independence.',
    'Efficiency family counts cover quality noninferiority only; the registered cost-primary effect, variance and bound can require a larger cohort.',
    'Every required quality metric must have its own minimum number of eligible families; disjoint eligibility can increase the total cohort size.',
    'The +5pp point gate cannot have 80% power at a true effect of exactly +5pp under the symmetric planning approximation.',
    'No fresh confirmation cohort or candidate comparison has been generated or executed by this analysis.',
  ],
};
for (const item of [...firstThreeConfirmations.flatMap(row => [row.quality, row.efficiencyQualityNoninferiority]), ...qualitySensitivity, ...noninferioritySensitivity]) {
  if (item.families !== null) {
    assert(item.families % design.samplePlanning.familyCountMultiple === 0);
    assert(item.approximatePower >= design.samplePlanning.targetApproximatePower);
  }
}
const output = `${JSON.stringify(report, null, 2)}\n`;
const outputPath = process.argv[2];
if (outputPath) await writeFile(outputPath, output, { flag: 'wx' });
else process.stdout.write(output);
