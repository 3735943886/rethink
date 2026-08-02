import { type DeviceDiscovery } from '../homeassistant'

/**
 * Rename a device's components into Korean.
 *
 * The appliances here are Korean-market units: their own panel, the LG app and the cloud
 * integration all use Korean, so a driver that labels half its entities in English leaves the
 * device reading in two languages. Only display names are touched — entity ids, topics and
 * unique_ids derive from the component keys, so renaming orphans nothing.
 *
 * A component with `name: null` is the one carrying the device's own name; it is left alone.
 */
export function applyKoreanNames(config: DeviceDiscovery, names: Record<string, string>) {
    for (const [key, comp] of Object.entries(config.components)) {
        const kr = names[key]
        const c = comp as { name?: string | null }
        if (kr && c.name != null) c.name = kr
    }
}
