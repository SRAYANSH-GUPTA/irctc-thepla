import test from 'node:test';
import assert from 'node:assert/strict';
import {isOfficial, localDebugUrl} from '../scripts/lib/cdp.mjs';
import {PATH, nextStage, assertPreparationButton, checkPassenger, checkAmount} from '../scripts/lib/flow.mjs';

test('payment page is terminal, including on a repeated invocation', () => {
  assert.equal(nextStage({path:PATH.payment}), 'done');
  assert.equal(nextStage({path:PATH.payment, loginRequired:true}), 'done');
});
test('payment submission and add-money controls cannot be used by preparation', () => {
  for (const label of ['Pay & Book', 'ADD & PAY 1,923.65', 'Click to pay', 'Pay']) assert.throws(()=>assertPreparationButton(label));
  assert.doesNotThrow(()=>assertPreparationButton('Continue To Payment'));
});
test('unverified sessions and challenges stop preparation', () => {
  assert.throws(()=>nextStage({path:PATH.details, challenge:true}), /CAPTCHA or OTP/);
  assert.throws(()=>nextStage({path:PATH.details, loginRequired:true}), /Sign in/);
  assert.throws(()=>nextStage({path:'/eticketing/PaymentRedirect'}), /Open the selected/);
});
test('existing passenger must match exactly and must be the only passenger', () => {
  assert.equal(checkPassenger([], 'Example Person'), false);
  assert.equal(checkPassenger(['example person '], 'Example Person'), true);
  assert.throws(()=>checkPassenger(['Someone Else'], 'Example Person'));
  assert.throws(()=>checkPassenger(['Example Person', 'Someone Else'], 'Example Person'));
});
test('invalid and excessive fares fail closed', () => {
  assert.doesNotThrow(()=>checkAmount(1898.60,1910.85));
  for (const value of [NaN,0,-1,Infinity]) assert.throws(()=>checkAmount(value,2000));
  assert.throws(()=>checkAmount(2000.01,2000));
});
test('debug access stays local and credential entry origin stays exact', () => {
  assert.equal(localDebugUrl(), 'http://127.0.0.1:9222');
  assert.throws(()=>localDebugUrl('http://example.com:9222'));
  assert.throws(()=>localDebugUrl('http://name:password@localhost:9222'));
  assert.equal(isOfficial('https://www.irctc.co.in/eticket/train-search'),true);
  for (const url of ['http://www.irctc.co.in','https://www.irctc.co.in.evil.example','https://evil.example/?irctc.co.in','https://secure.paytmpayments.com']) assert.equal(isOfficial(url),false);
});
