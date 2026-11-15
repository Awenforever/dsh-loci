import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectHostVersion, hostLineOf } from '../../src/host/host-version.js';

/**
 * `engines.dsh` declares a range; a range is a promise nobody tested. These tests pin
 * the two properties that make the detector useful in a bug report: it names the
 * installed version when it can, and it never throws when it cannot.
 */
test('a missing host is reported as unknown, not as an exception', () => {
  const previous = process.env.DSH_INSTALL_DIR;
  delete process.env.DSH_INSTALL_DIR;
  try {
    const detected = detectHostVersion();
    assert.ok(detected === undefined || typeof detected.version === 'string');
  } finally {
    if (previous !== undefined) process.env.DSH_INSTALL_DIR = previous;
  }
});

test('a broken DSH_INSTALL_DIR is ignored rather than fatal', () => {
  const previous = process.env.DSH_INSTALL_DIR;
  process.env.DSH_INSTALL_DIR = 'Z:/definitely/not/a/host';
  try {
    assert.equal(detectHostVersion(), undefined);
  } finally {
    if (previous === undefined) delete process.env.DSH_INSTALL_DIR;
    else process.env.DSH_INSTALL_DIR = previous;
  }
});

test('the declared line is classified, so a 0.3 host is not silently "fine"', () => {
  assert.equal(hostLineOf('0.2.2-rc.3'), 'same-line');
  assert.equal(hostLineOf('0.2.2'), 'same-line');
  assert.equal(hostLineOf('0.3.0-rc.1'), 'other-line');
  assert.equal(hostLineOf(undefined), 'unknown');
  assert.equal(hostLineOf(''), 'unknown');
});
