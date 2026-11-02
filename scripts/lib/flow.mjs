export const PATH = Object.freeze({
  results:'/eticket/booking/train-list',
  details:'/eticket/booking/psgninput',
  review:'/eticket/booking/reviewBooking',
  payment:'/eticket/payment/bkgPaymentOptions',
});

const PREPARATION_BUTTONS = new Set(['Existing Passenger', 'Add', 'Calculate Fare', 'Continue To Payment']);
export function assertPreparationButton(label) {
  if (!PREPARATION_BUTTONS.has(label)) throw new Error(`Button is outside the preparation workflow: ${label}`);
}

export function nextStage(state) {
  if (state.path === PATH.payment) return 'done';
  if (state.challenge) throw new Error('Complete the CAPTCHA or OTP in Chromium, then run the script again.');
  if (state.loginRequired) throw new Error('Sign in through Chromium or run the login command first.');
  if (state.path === PATH.results) return 'choose-train';
  if (state.path === PATH.details) return 'passenger';
  if (state.path === PATH.review) return 'review';
  throw new Error('Open the selected journey results, passenger form, or review page first.');
}

export function checkPassenger(selected, requested) {
  const normalized = selected.map(s=>s.trim().toLowerCase());
  if (normalized.length === 0) return false;
  if (normalized.length !== 1 || normalized[0] !== requested.trim().toLowerCase()) throw new Error('The form contains a different passenger selection. Review it manually.');
  return true;
}

export function checkAmount(amount, maxAmount) {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Could not verify the payable amount.');
  if (maxAmount !== undefined && Math.round(amount*100) > Math.round(maxAmount*100)) throw new Error('The fare exceeds --max-amount.');
}
