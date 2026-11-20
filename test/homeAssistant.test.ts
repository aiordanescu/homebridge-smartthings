import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { WebSocketServer, WebSocket as WsSocket } from 'ws';
import { PlatformAccessory } from 'homebridge/lib/platformAccessory';
import * as hap from 'hap-nodejs';
import { applyStateMessage } from '../src/homeAssistant/client';
import { makePlatform, sleep, stubAdapter } from './coreHelpers';

const NIGHT = '663af05a-a5da-4e7f-995d-6a66d0548f50';
const OTHER = 'e8532956-38ed-4f01-b14f-29e3b1ddd28f';

test('applyStateMessage handles adds, diffs and removals', () => {
  const states = new Map<string, string>();
  assert.deepEqual(applyStateMessage(states, { a: { 'input_boolean.x': { s: 'off' } } }), ['input_boolean.x']);
  assert.deepEqual(applyStateMessage(states, { c: { 'input_boolean.x': { '+': { s: 'off' } } } }), []);
  assert.deepEqual(applyStateMessage(states, { c: { 'input_boolean.x': { '+': { s: 'on' } } } }), ['input_boolean.x']);
  assert.equal(states.get('input_boolean.x'), 'on');
  assert.deepEqual(applyStateMessage(states, { c: { 'input_boolean.x': { '-': { a: ['icon'] } } } }), []);
  assert.deepEqual(applyStateMessage(states, { r: ['input_boolean.x'] }), ['input_boolean.x']);
  assert.equal(states.has('input_boolean.x'), false);
});

// A fake Home Assistant: token auth, subscribe_entities, call_service on two entities.
function fakeHomeAssistant(token: string) {
  const states: Record<string, string> = { 'input_boolean.night_time': 'off', 'binary_sensor.night_time_contact': 'off' };
  const calls: string[] = [];
  const subscribers: Array<{ ws: WsSocket; id: number }> = [];
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const set = (entityId: string, state: string) => {
    states[entityId] = state;
    for (const s of subscribers) {
      s.ws.send(JSON.stringify({ id: s.id, type: 'event', event: { c: { [entityId]: { '+': { s: state } } } } }));
    }
  };
  server.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'auth_required' }));
    ws.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.type === 'auth') {
        ws.send(JSON.stringify({ type: m.access_token === token ? 'auth_ok' : 'auth_invalid' }));
      } else if (m.type === 'subscribe_entities') {
        subscribers.push({ ws, id: m.id });
        ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: null }));
        const a = Object.fromEntries(m.entity_ids.filter((e: string) => e in states).map((e: string) => [e, { s: states[e] }]));
        ws.send(JSON.stringify({ id: m.id, type: 'event', event: { a } }));
      } else if (m.type === 'call_service') {
        calls.push(`${m.domain}.${m.service} ${m.target.entity_id}`);
        ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: {} }));
        if (m.target.entity_id === 'input_boolean.night_time') {
          set('input_boolean.night_time', m.service === 'turn_on' ? 'on' : 'off');
          set('binary_sensor.night_time_contact', m.service === 'turn_on' ? 'on' : 'off');
        }
      }
    });
  });
  const url = () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/websocket`;
  return { server, url, calls, set };
}

async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('timed out');
    }
    await sleep(10);
  }
}

test('a configured accessory keeps its cached services and is driven by Home Assistant', async () => {
  const ha = fakeHomeAssistant('secret');
  await new Promise(resolve => ha.server.once('listening', resolve));
  const { platform, api } = makePlatform({
    homeAssistant: {
      url: ha.url(), token: 'secret',
      accessories: [{ smartThingsDeviceId: NIGHT, name: 'Night Time',
        switch: 'input_boolean.night_time', contactSensor: 'binary_sensor.night_time_contact' }],
    },
  });

  // Cached accessory as the SmartThings plugin left it.
  const cached = new PlatformAccessory('Night Time', NIGHT);
  const sw = cached.addService(hap.Service.Switch, 'Night Time');
  const contact = cached.addService(hap.Service.ContactSensor, 'Night Time');
  const servicesBefore = cached.services.length;
  platform.configureAccessory(cached);
  const other = new PlatformAccessory('Kitchen 2', OTHER);
  platform.configureAccessory(other);

  try {
    platform.homeAssistant.start(platform.accessories);
    assert.equal(cached.services.length, servicesBefore, 'no services added');
    assert.equal(api.registered.length, 0, 'nothing newly registered');

    const on = sw.getCharacteristic(hap.Characteristic.On);
    const state = contact.getCharacteristic(hap.Characteristic.ContactSensorState);
    await waitFor(() => (platform.homeAssistant as unknown as { client: { connected: boolean } }).client.connected);
    assert.equal(await on.handleGetRequest(), false);
    assert.equal(await state.handleGetRequest(), hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

    // Apple Home turns it on: Home Assistant gets the service call, the contact opens.
    await on.handleSetRequest(true);
    assert.deepEqual(ha.calls, ['homeassistant.turn_on input_boolean.night_time']);
    await waitFor(() => state.value === hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    assert.equal(on.value, true);

    // A change made in Home Assistant reaches HomeKit.
    ha.set('input_boolean.night_time', 'off');
    await waitFor(() => on.value === false);

    // SmartThings discovery skips the device and never unregisters its accessory.
    stubAdapter(platform, () => ({ status: 200, data: { items: [{ deviceId: NIGHT, label: 'Night Time' }, { deviceId: OTHER, label: 'Kitchen 2' }] } }));
    const devices = await platform.getOnlineDevices() as Array<{ deviceId: string }>;
    assert.deepEqual(devices.map(d => d.deviceId), [OTHER]);
    platform.unregisterDevices([], true);
    assert.deepEqual(api.unregistered.flat().map(a => a.UUID), [OTHER]);
  } finally {
    platform.homeAssistant.stop();
    ha.server.close();
  }
});

test('a rejected token leaves the accessory not responding instead of guessing', async () => {
  const ha = fakeHomeAssistant('secret');
  await new Promise(resolve => ha.server.once('listening', resolve));
  const { platform, log } = makePlatform({
    homeAssistant: { url: ha.url(), token: 'wrong', accessories: [{ smartThingsDeviceId: NIGHT, name: 'Night Time', switch: 'input_boolean.night_time' }] },
  });
  const cached = new PlatformAccessory('Night Time', NIGHT);
  const sw = cached.addService(hap.Service.Switch, 'Night Time');
  platform.configureAccessory(cached);
  try {
    platform.homeAssistant.start(platform.accessories);
    await waitFor(() => log.lines.some(l => l.includes('access token was rejected')));
    await assert.rejects(sw.getCharacteristic(hap.Characteristic.On).handleGetRequest());
  } finally {
    platform.homeAssistant.stop();
    ha.server.close();
  }
});
