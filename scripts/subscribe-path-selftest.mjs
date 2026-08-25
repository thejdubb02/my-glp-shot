#!/usr/bin/env node
// Subscribe-path self-test.
//
// Lin (first paying-intent user, 2026-08-25) wrote in: "it says to try all the
// premium bits and to subscribe before the trial ends. So, how do you subscribe?"
// She could not, and she was right not to find it.
//
// isPremium() is TRUE during the free trial — that is the whole point, the trial
// unlocks everything. But both Upgrade buttons were hidden with
// `classList.toggle('hidden', isPremium())`, and both Manage buttons were hidden
// behind hasStripeCustomer, which a trial user without a card does not have. The
// Premium tab therefore rendered "Subscribe before the trial ends to keep access"
// above an empty button row for eleven of the fourteen days; the only escape was a
// banner that did not appear until 3 days remained, and that banner was dismissible.
//
// The rule this file pins: **anyone who is not already on a paid plan must be able
// to see a way to pay.** Access level and billing state are different questions and
// must never share a predicate again.
//
//   node scripts/subscribe-path-selftest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('subscribe-path');
const { R, nodeFor } = await loadApp({ domMode: 'sticky' });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = fs.readFileSync(path.join(HERE, '..', 'web', 'app', 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(HERE, '..', 'web', 'app', 'index.html'), 'utf8');

const isPremium   = R('isPremium');
const hasPaidPlan = R('hasPaidPlan');
const isOnTrial   = R('isOnTrial');
const refreshUpgradeCopy = R('refreshUpgradeCopy');

const setUser = (u) => R(`account.user = ${JSON.stringify(u)};`);
const DAY = 86400;
const inDays = (n) => Math.floor(Date.now() / 1000) + n * DAY;

// The five states an account can actually be in. `showsBuyButton` is the whole
// specification: it is simply "not already paying".
const STATES = [
  { name: 'signed out',        user: null,                                                                      premium: false, paid: false, trial: false },
  { name: 'free tier',         user: { subscriptionStatus: 'free',     isPremium: false },                      premium: false, paid: false, trial: false },
  { name: 'mid trial',         user: { subscriptionStatus: 'trial',    isPremium: true,  trialEndsAt: inDays(11) }, premium: true,  paid: false, trial: true  },
  { name: 'trial last day',    user: { subscriptionStatus: 'trial',    isPremium: true,  trialEndsAt: inDays(1) },  premium: true,  paid: false, trial: true  },
  { name: 'trial expired',     user: { subscriptionStatus: 'trial',    isPremium: false, trialEndsAt: inDays(-2) }, premium: false, paid: false, trial: false },
  { name: 'paid premium',      user: { subscriptionStatus: 'premium',  isPremium: true },                       premium: true,  paid: true,  trial: false },
  { name: 'lifetime',          user: { subscriptionStatus: 'lifetime', isPremium: true },                       premium: true,  paid: true,  trial: false },
];

for (const s of STATES) {
  setUser(s.user);
  A.eq(`${s.name}: isPremium`,   isPremium(),   s.premium);
  A.eq(`${s.name}: hasPaidPlan`, hasPaidPlan(), s.paid);
  A.eq(`${s.name}: isOnTrial`,   isOnTrial(),   s.trial);
  // The invariant itself, stated once per state.
  A.check(`${s.name}: a non-paying account can see a buy button`,
    s.paid ? hasPaidPlan() === true : hasPaidPlan() === false,
    `hasPaidPlan()=${hasPaidPlan()} for ${JSON.stringify(s.user)}`);
}

// The exact regression Lin hit: premium access without a paid plan.
setUser({ subscriptionStatus: 'trial', isPremium: true, trialEndsAt: inDays(11) });
A.check('a trial user has premium access AND still needs to buy',
  isPremium() === true && hasPaidPlan() === false,
  'if these are ever equal the Upgrade button disappears mid-trial again');

// A lifetime supporter is the mirror case — never pitch them a subscription.
setUser({ subscriptionStatus: 'lifetime', isPremium: true });
A.check('lifetime is never shown a buy button', hasPaidPlan() === true);

// ---------- copy ----------
// Same checkout call either way (the server refuses a second trial via
// _has_used_trial), so the only thing that can lie here is the wording.
setUser({ subscriptionStatus: 'trial', isPremium: true, trialEndsAt: inDays(9) });
refreshUpgradeCopy();
const cta   = nodeFor('#upgrade-cta');
const hero  = nodeFor('#premium-hero-upgrade');
const title = nodeFor('#upgrade-title');
const sub   = nodeFor('#upgrade-sub');
const confirm = nodeFor('#upgrade-confirm');

A.check('trial CTA says subscribe, not upgrade', /Subscribe/i.test(cta.textContent), cta.textContent);
A.check('trial hero button says subscribe', /Subscribe/i.test(hero.textContent), hero.textContent);
A.check('trial dialog title is not "Upgrade"', !/^Upgrade/i.test(title.textContent), title.textContent);
A.check('trial dialog does not promise a second free trial',
  !/14-day free trial/i.test(sub.textContent), sub.textContent);
A.check('mid-trial copy says the remaining days are kept',
  /keep the rest of your trial/i.test(sub.textContent), sub.textContent);
A.check('mid-trial copy is not "billed today"',
  !/billed today/i.test(sub.textContent), sub.textContent);

// Inside Stripe's 48-hour floor the card really is charged today, and the copy has
// to flip with it — the server cannot pass a trial_end that close.
setUser({ subscriptionStatus: 'trial', isPremium: true, trialEndsAt: inDays(1) });
refreshUpgradeCopy();
A.check('last-day copy says billed today', /billed today/i.test(sub.textContent), sub.textContent);
A.check('last-day copy does not promise kept days',
  !/keep the rest/i.test(sub.textContent), sub.textContent);
setUser({ subscriptionStatus: 'trial', isPremium: true, trialEndsAt: inDays(9) });
refreshUpgradeCopy();
A.check('trial confirm button does not say "Start free trial"',
  !/start free trial/i.test(confirm.textContent), confirm.textContent);

setUser({ subscriptionStatus: 'free', isPremium: false });
refreshUpgradeCopy();
A.check('free-tier CTA says upgrade', /Upgrade/i.test(cta.textContent), cta.textContent);
A.check('free-tier dialog still offers the 14-day trial',
  /14-day free trial/i.test(sub.textContent), sub.textContent);
A.check('free-tier confirm button starts the trial',
  /start free trial/i.test(confirm.textContent), confirm.textContent);

// ---------- source guards ----------
// These catch the regression at the exact line that caused it, which the runtime
// predicates above cannot see: someone could re-introduce isPremium() in the toggle
// while hasPaidPlan() keeps returning the right answer to nobody.
A.check('#upgrade-cta visibility is gated on hasPaidPlan, not isPremium',
  /\$\('#upgrade-cta'\)\.classList\.toggle\('hidden', hasPaidPlan\(\)\)/.test(APP_JS));
A.check('premium hero button visibility is gated on hasPaidPlan, not isPremium',
  /phUp\.classList\.toggle\('hidden', hasPaidPlan\(\)\)/.test(APP_JS));
// Deliberately narrow: lock pills SHOULD follow isPremium(), because a trial user
// has access and must not see a padlock. Only the buy surfaces are the bug.
const buyGatedOnAccess = APP_JS.split('\n')
  .filter(l => /classList\.toggle\('hidden', isPremium\(\)\)/.test(l))
  .filter(l => /upgrade|phUp|subscribe|billing/i.test(l));
A.check('no buy surface is hidden behind isPremium() any more',
  buyGatedOnAccess.length === 0,
  buyGatedOnAccess.join(' | ') || 'a buy surface is gated on access level again');

// The trial-end banner must not depend on a hidden button existing to be clicked.
A.check('trial-end banner opens the dialog directly',
  !/trial_end_banner_clicked'\);[\s\S]{0,120}getElementById\('upgrade-cta'\)\?\.click\(\)/.test(APP_JS));

// The ids refreshUpgradeCopy() writes to have to exist in the page, or the copy
// silently stays on the free-tier wording.
for (const id of ['upgrade-title', 'upgrade-sub', 'upgrade-cta', 'premium-hero-upgrade', 'upgrade-confirm']) {
  A.check(`index.html has #${id}`, INDEX_HTML.includes(`id="${id}"`));
}

A.report();
