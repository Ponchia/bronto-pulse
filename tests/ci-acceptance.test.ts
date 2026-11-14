import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const gates = ['test:selfhost:hostile', 'test:browser:evidence'] as const;

function assertAcceptance(ci: string) {
  const start = ci.indexOf('  verify:\n');
  const end = ci.indexOf('\n  publisher:', start);
  assert.ok(start >= 0 && end > start, 'the required verification job must exist');
  const verify = ci.slice(start, end);
  assert.doesNotMatch(verify, /^\s*(?:if|continue-on-error|paths|paths-ignore):/m);
  for (const gate of gates)
    assert.ok(
      verify.includes(`      - run: npm run ${gate}\n`),
      `${gate} must run unconditionally`,
    );
  assert.ok(verify.includes('      - run: openssl version\n'), 'TLS fixtures require OpenSSL');
  assert.doesNotMatch(verify, /secrets\.|pull_request_target|\|\|\s*(?:true|:)/);
}

test('required CI runs hostile transport and evidence browser acceptance with no bypass', () => {
  assertAcceptance(workflow);
});

test('acceptance contract rejects omitted, optional or failure-suppressed gates', () => {
  const qualified = workflow.includes('      - run: npm run test:selfhost:hostile\n')
    ? workflow
    : workflow.replace(
        '      - run: npm run check\n',
        `      - run: npm run check\n      - run: openssl version\n${gates.map((gate) => `      - run: npm run ${gate}\n`).join('')}`,
      );
  assertAcceptance(qualified);
  for (const gate of gates) {
    const step = `      - run: npm run ${gate}\n`;
    assert.throws(() => assertAcceptance(qualified.replace(step, '')));
    assert.throws(() => assertAcceptance(qualified.replace(step, `${step}        if: false\n`)));
    assert.throws(() =>
      assertAcceptance(qualified.replace(step, `${step}        continue-on-error: true\n`)),
    );
    assert.throws(() =>
      assertAcceptance(qualified.replace(step, step.replace(gate, `${gate} || true`))),
    );
  }
  assert.throws(() =>
    assertAcceptance(qualified.replace('  verify:\n', '  verify:\n    if: false\n')),
  );
});
