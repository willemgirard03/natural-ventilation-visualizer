// The weather file reader, checked against the outdoor conditions EnergyPlus reported in the
// Example_02 network run (1 to 7 July), when that run and the course weather file are here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dateOf, hourIndex, humidityRatio, outdoorAt, parseEPW } from '../src/model/weather.js';
import { readEso } from '../tools/eso.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EPW = path.join(REPO, '..', 'Weather Files', 'CAN_BC_Vancouver.Intl.AP.718920_TDY-CWEC2020v2.epw');
const WEEK = path.join(REPO, 'runs', 'network', 'week', 'example02_afn_week.eso');

test('dates and hours', () => {
  assert.equal(dateOf(1).label, '1 Jan');
  assert.equal(dateOf(196).label, '15 Jul');
  assert.equal(dateOf(365).label, '31 Dec');
  assert.equal(hourIndex(1, 1), 0);
  assert.equal(hourIndex(365, 24), 8759);
  // Air at 20 degC, dew point 10 degC, sea level: about 7.7 g/kg.
  assert.ok(Math.abs(humidityRatio(10, 101325) - 0.00766) < 0.00005);
});

test('outdoor conditions match what EnergyPlus used for 1-7 July', { skip: existsSync(EPW) && existsSync(WEEK) ? false : 'weather file or EnergyPlus week run not here' }, () => {
  const weather = parseEPW(readFileSync(EPW, 'utf8'));
  assert.equal(weather.location.elevation, 4.3);
  const eso = readEso(WEEK);
  const site = (v) => eso.find(v, 'Environment');
  // At the last 10-minute step of each hour EnergyPlus uses that hour's row exactly.
  for (let day = 0; day < 7; day++) {
    for (let hour = 1; hour <= 24; hour++) {
      const s = day * 144 + hour * 6 - 1, o = outdoorAt(weather, 182 + day, hour);
      const what = `1 Jul + ${day} days, hour ${hour}`;
      assert.ok(Math.abs(o.t - site('Site Outdoor Air Drybulb Temperature')[s]) < 1e-6, `${what} temperature`);
      assert.ok(Math.abs(o.windSpeed - site('Site Wind Speed')[s]) < 1e-6, `${what} wind speed`);
      assert.ok(Math.abs(o.windDirection - site('Site Wind Direction')[s]) < 1e-6, `${what} wind direction`);
      assert.ok(Math.abs(o.pressure - site('Site Outdoor Air Barometric Pressure')[s]) < 1e-6, `${what} pressure`);
      assert.ok(Math.abs(o.w - site('Site Outdoor Air Humidity Ratio')[s]) < 2e-6, `${what} humidity ratio ${o.w} vs ${site('Site Outdoor Air Humidity Ratio')[s]}`);
    }
  }
});

const RESULTS02 = path.join(REPO, '..', 'Example 02', 'Results', '2226_Emmenweidout.eso');
const MODEL02 = path.join(REPO, '..', 'Example 02', 'Results', '2226_Emmenweid.epJSON');
test('zone results from ClimateStudio: every zone, every hour, streamed like the browser does', { skip: existsSync(RESULTS02) ? false : 'Example 02 results not here' }, async () => {
  const { createReadStream } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const { importEpJSON } = await import('../src/model/import-epjson.js');
  const { readZoneResultsStream, zoneAt } = await import('../src/model/results.js');
  const model = importEpJSON(JSON.parse(readFileSync(MODEL02, 'utf8')));
  const r = await readZoneResultsStream(Readable.toWeb(createReadStream(RESULTS02)), model);
  assert.deepEqual(r.missing, []);
  assert.equal(r.zones['2F_Office_8'].t.length, 8760);
  // Ventilation runs only in the five naturally ventilated zones, for part of the year.
  const ventilated = Object.entries(r.zones).filter(([, z]) => z.vent?.some(Boolean)).map(([n]) => n).sort();
  assert.deepEqual(ventilated, Object.values(model.zones).filter((z) => z.ventilation).map((z) => z.name).sort());
  const share = r.zones['2F_Office_8'].vent.filter(Boolean).length / 8760;
  assert.ok(share > 0.02 && share < 0.6, `windows open ${share}`);
  const z = zoneAt(r, '2F_Office_8', 196 * 24 + 14);
  assert.ok(z.t > 10 && z.t < 40 && z.w > 0.002 && z.w < 0.02);
});
