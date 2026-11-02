#!/usr/bin/env node
/**
 * Offline demonstration of the IRCTC endpoint sequence observed in
 * docs/api-flow.md. This uses synthetic responses only: it has no network
 * transport, accepts no credentials, and stops when fare preparation returns
 * the documented 403 response. Payment initialization is never called.
 */

import assert from 'node:assert/strict';

const sequence = [
  {name: 'login', method: 'POST', path: '/authprovider/webtoken', status: 200},
  {name: 'validate user', method: 'GET', path: '/eticketing/protected/mapps1/validateUser?source=3', status: 200},
  {name: 'train search', method: 'POST', path: '/eticketing/protected/mapps1/altAvlEnq/TC', status: 200},
  {name: 'availability', method: 'POST', path: '/eticketing/protected/mapps1/allLapAvlEnq', status: 200},
  {name: 'boarding options', method: 'POST', path: '/eticketing/protected/mapps1/boardingStationEnq', status: 200},
  {name: 'fare preparation', method: 'POST', path: '/eticketing/protected/mapps1/allLapAvlFareEnq/Y', status: 403},
];

const attempted = [];
const mockTransport = async request => {
  const expected = sequence[attempted.length];
  assert.ok(expected, `Unexpected request: ${request.name}`);
  assert.equal(request.name, expected.name);
  attempted.push(request.name);
  return {status: expected.status};
};

async function run() {
  console.log('Offline API-flow mock — no network calls or credentials.');

  for (const request of sequence) {
    const response = await mockTransport(request);
    console.log(`${request.method} ${request.path} -> ${response.status}`);
    if (response.status === 403) {
      console.log('Stopped at fare preparation. No payment or booking-init request was attempted.');
      break;
    }
    assert.equal(response.status, 200, `${request.name} did not succeed in the mock`);
  }

  assert.deepEqual(attempted, sequence.map(item => item.name));
  assert.equal(attempted.includes('booking initialization'), false);
  assert.equal(attempted.includes('payment redirect'), false);
  console.log('Mock checks passed.');
}

await run();
