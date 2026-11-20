import { Logger, PlatformAccessory, CharacteristicValue, API, Service as ServiceType, WithUUID } from 'homebridge';
import { HomeAssistantClient } from './client';

/**
 * Home Assistant backend for accessories that used to be SmartThings devices.
 *
 * A configured accessory keeps its SmartThings device id as its Homebridge UUID, so it stays on
 * this (already paired) bridge with the same HomeKit AID and service/characteristic IIDs: Apple
 * Home keeps its tile, room, scenes and automations. State and commands go to Home Assistant
 * instead of SmartThings, and SmartThings discovery leaves the accessory alone.
 */
export interface HomeAssistantAccessoryConfig {
  smartThingsDeviceId: string;
  name: string;
  switch?: string;          // entity toggled with homeassistant.turn_on/turn_off (switch, input_boolean, light)
  contactSensor?: string;   // binary_sensor: 'on' = open (contact not detected), 'off' = closed
}

export interface HomeAssistantConfig {
  url?: string;
  token?: string;
  accessories?: HomeAssistantAccessoryConfig[];
}

export class HomeAssistantAccessories {
  readonly deviceIds: Set<string>;
  private readonly client?: HomeAssistantClient;
  private readonly entries: HomeAssistantAccessoryConfig[];
  private readonly updaters = new Map<string, Array<(state: string | undefined) => void>>();

  constructor(private readonly log: Logger, private readonly api: API, config: HomeAssistantConfig | undefined,
    private readonly pluginName: string, private readonly platformName: string) {
    this.entries = (config?.accessories ?? []).filter(entry => {
      if (!entry?.smartThingsDeviceId || (!entry.switch && !entry.contactSensor)) {
        this.log.warn(`[Home Assistant] Ignoring incomplete accessory entry: ${JSON.stringify(entry)}`);
        return false;
      }
      return true;
    });
    this.deviceIds = new Set(this.entries.map(entry => entry.smartThingsDeviceId));
    if (this.entries.length === 0) {
      return;
    }
    if (!config?.url || !config.token) {
      this.log.error('[Home Assistant] homeAssistant.url and homeAssistant.token are required; its accessories stay offline.');
      return;
    }
    const entityIds = this.entries.flatMap(entry => [entry.switch, entry.contactSensor].filter((id): id is string => !!id));
    this.client = new HomeAssistantClient(log, config.url, config.token, [...new Set(entityIds)]);
    this.client.onStateChange((entityId, state) => this.updaters.get(entityId)?.forEach(update => update(state)));
  }

  /** Attach the configured accessories (restored from cache, or created) and connect. */
  start(cachedAccessories: PlatformAccessory[]): void {
    for (const entry of this.entries) {
      let accessory = cachedAccessories.find(acc => acc.UUID === entry.smartThingsDeviceId);
      if (accessory) {
        this.log.info(`[Home Assistant] ${accessory.displayName}: served from Home Assistant`);
      } else {
        this.log.warn(`[Home Assistant] ${entry.name}: no cached accessory with UUID ${entry.smartThingsDeviceId}; ` +
          'registering a new one (Apple Home will see a new accessory)');
        accessory = new this.api.platformAccessory(entry.name, entry.smartThingsDeviceId);
        this.api.registerPlatformAccessories(this.pluginName, this.platformName, [accessory]);
      }
      accessory.context.homeAssistant = { switch: entry.switch, contactSensor: entry.contactSensor };
      if (entry.switch) {
        this.bindSwitch(accessory, entry.switch);
      }
      if (entry.contactSensor) {
        this.bindContactSensor(accessory, entry.contactSensor);
      }
      this.api.updatePlatformAccessories([accessory]);
    }
    this.client?.start();
  }

  stop(): void {
    this.client?.stop();
  }

  private service(accessory: PlatformAccessory, type: WithUUID<typeof ServiceType>): ServiceType {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return accessory.getService(type) ?? accessory.addService(type as any, accessory.displayName);
  }

  private failure(): Error {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private knownState(entityId: string): string {
    const state = this.client?.connected ? this.client.states.get(entityId) : undefined;
    if (state === undefined || state === 'unavailable' || state === 'unknown') {
      throw this.failure();
    }
    return state;
  }

  private watch(entityId: string, update: (state: string | undefined) => void): void {
    const list = this.updaters.get(entityId) ?? [];
    list.push(update);
    this.updaters.set(entityId, list);
  }

  private bindSwitch(accessory: PlatformAccessory, entityId: string): void {
    const { Service, Characteristic } = this.api.hap;
    const on = this.service(accessory, Service.Switch).getCharacteristic(Characteristic.On);
    on.onGet(() => this.knownState(entityId) === 'on');
    on.onSet(async (value: CharacteristicValue) => {
      const service = value ? 'turn_on' : 'turn_off';
      this.log.info(`[Home Assistant] ${accessory.displayName}: Apple Home set ${value ? 'on' : 'off'} -> ${service} ${entityId}`);
      try {
        await this.client!.callService('homeassistant', service, entityId);
      } catch (error) {
        this.log.error(`[Home Assistant] ${accessory.displayName}: ${service} ${entityId} failed: ${error}`);
        throw this.failure();
      }
    });
    this.watch(entityId, state => {
      if (state === 'on' || state === 'off') {
        this.log.debug(`[Home Assistant] ${accessory.displayName}: ${entityId} is ${state}`);
        on.updateValue(state === 'on');
      }
    });
  }

  private bindContactSensor(accessory: PlatformAccessory, entityId: string): void {
    const { Service, Characteristic } = this.api.hap;
    const contact = this.service(accessory, Service.ContactSensor).getCharacteristic(Characteristic.ContactSensorState);
    const toHomeKit = (state: string) => state === 'on'
      ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : Characteristic.ContactSensorState.CONTACT_DETECTED;
    contact.onGet(() => toHomeKit(this.knownState(entityId)));
    this.watch(entityId, state => {
      if (state === 'on' || state === 'off') {
        this.log.debug(`[Home Assistant] ${accessory.displayName}: ${entityId} is ${state}`);
        contact.updateValue(toHomeKit(state));
      }
    });
  }
}
