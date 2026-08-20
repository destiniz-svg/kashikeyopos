'use strict';
/* ═══ ONE RULE TABLE ════════════════════════════════════════════════════════
   Allergens and diets are the one thing in this product where being wrong is
   not an accounting problem. The rules therefore live in ONE file that both
   the browser and the server load, and this asserts the behaviour that made
   that necessary:

     · a reef fish labelled "Vegetarian" on a guest's phone, because the phone
       held no recipe and read silence as an absence of meat
     · a coconut curry flagged as dairy, because "cream" matched
     · two allergen tables with different key vocabularies — one saying
       "shellfish", the other "crustacean" — so a diet that blocked one never
       blocked the other
   ═══════════════════════════════════════════════════════════════════════ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = require('../app/kashikeyo-rules.js');
const APP = path.join(__dirname, '..', 'app');

test('the EU 14 ship, each with a rule that can fire', () => {
  assert.strictEqual(R.ALLERGENS.length, 14, 'Regulation 1169/2011 Annex II');
  const keys = R.ALLERGENS.map((a) => a.k);
  ['gluten', 'crustacean', 'egg', 'fish', 'peanut', 'soy', 'milk', 'nuts',
    'celery', 'mustard', 'sesame', 'sulphite', 'lupin', 'mollusc']
    .forEach((k) => assert.ok(keys.indexOf(k) >= 0, k + ' is declarable'));
  assert.strictEqual(new Set(keys).size, keys.length, 'no key twice');
  R.ALLERGENS.forEach((a) => {
    assert.ok(a.re instanceof RegExp, a.k + ' has a name rule');
    assert.ok(a.label, a.k + ' has something to print');
    assert.ok(a.icon, a.k + ' has something to draw');
  });
});

test('every diet blocks by a key that exists', () => {
  const keys = R.ALLERGENS.map((a) => a.k);
  R.DIETS.forEach((d) => {
    (d.blocks || []).forEach((b) => assert.ok(keys.indexOf(b) >= 0,
      d.k + ' blocks "' + b + '", which is not an allergen this table knows'));
  });
});

test('a recipe declares what is in it', () => {
  assert.deepStrictEqual(
    R.allergenKeys([{ name: 'Reef fish fillet' }, { name: 'Coconut cream' }]),
    ['fish'], 'the fish, and not the coconut');
  assert.deepStrictEqual(
    R.allergenKeys([{ name: 'Tiger prawns' }, { name: 'Squid rings' }]).sort(),
    ['crustacean', 'mollusc'], 'shellfish is two entries, not one');
  assert.deepStrictEqual(R.allergenKeys([{ name: 'Cheddar' }]), ['milk']);
  assert.deepStrictEqual(R.allergenKeys([{ name: 'House blend', cat: 'Dairy' }]),
    ['milk'], 'a dairy category catches what a name does not');
});

test('coconut is not a cow', () => {
  ['Coconut milk', 'Coconut cream', 'Almond milk', 'Oat milk', 'Soy milk']
    .forEach((n) => assert.deepStrictEqual(
      R.allergenKeys([{ name: n }]).indexOf('milk'), -1, n + ' is not dairy'));
  // ...and the nut in the almond milk still counts.
  assert.ok(R.allergenKeys([{ name: 'Almond milk' }]).indexOf('nuts') >= 0);
});

test('a reef fish is never vegetarian', () => {
  const fish = [{ name: 'Reef fish fillet' }, { name: 'Coconut cream' }];
  assert.strictEqual(R.dietKeys(fish).indexOf('veg'), -1);
  assert.strictEqual(R.dietKeys(fish).indexOf('vegan'), -1);
  const rice = [{ name: 'Basmati rice' }, { name: 'Coconut milk' }];
  assert.ok(R.dietKeys(rice).indexOf('veg') >= 0);
  assert.ok(R.dietKeys(rice).indexOf('vegan') >= 0);
  assert.ok(R.dietKeys([{ name: 'Pork belly' }]).indexOf('halal') < 0);
  assert.ok(R.dietKeys([{ name: 'Chicken thigh' }]).indexOf('halal') >= 0);
});

test('an unwritten recipe claims nothing', () => {
  // The bug this exists for: no recipe meant no meat meant "Vegetarian".
  assert.deepStrictEqual(R.dietKeys([]), []);
  assert.deepStrictEqual(R.dietKeys(null), []);
  assert.deepStrictEqual(R.allergenKeys([]), []);
});

test('a declared allergen is additive and cannot be argued away', () => {
  // A shared fryer is not in any ingredient list.
  const k = R.allergenKeys([{ name: 'Chips' }], ['fish']);
  assert.ok(k.indexOf('fish') >= 0);
  const d = R.dietKeys([{ name: 'Chips' }], ['fish']);
  assert.strictEqual(d.indexOf('veg'), -1, 'and it removes the diet it blocks');
});

test('there is exactly one copy of the table', () => {
  // The regression: kashikeyo-data.js and src/bootstrap.js each carried their
  // own, with different keys, and only one of them was ever right.
  const data = fs.readFileSync(path.join(APP, 'kashikeyo-data.js'), 'utf8');
  const boot = fs.readFileSync(path.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8');
  assert.strictEqual(/var ALLERGENS = \[/.test(data), false,
    'kashikeyo-data.js must read the shared table, not define one');
  assert.strictEqual(/const ALLERGENS = \[/.test(boot), false,
    'src/bootstrap.js must read the shared table, not define one');
  assert.ok(/kashikeyo-rules/.test(boot), 'the server loads the shared table');
  // And every page that renders a menu loads it before the data file.
  ['index.html', 'guest.html', 'member.html'].forEach((f) => {
    const html = fs.readFileSync(path.join(APP, f), 'utf8');
    const rules = html.indexOf('kashikeyo-rules.js');
    const dataAt = html.indexOf('kashikeyo-data.js"');
    assert.ok(rules > 0, f + ' loads the rules');
    assert.ok(rules < dataAt, f + ' loads the rules BEFORE the data');
  });
});
