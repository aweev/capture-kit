/**
 * Device profiles (FR-6).
 *
 * Width/height here are CSS pixels; `deviceScaleFactor` is what makes a capture
 * look production-grade on retina (G2 Fidelity). These are the four profiles a
 * user can name in config; anything else must be spelled out as an object.
 */
export type Device = {
  name: string
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}

export const DEVICES: Record<string, Device> = {
  mobile: { name: "mobile", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  tablet: { name: "tablet", width: 834, height: 1112, deviceScaleFactor: 2, mobile: true },
  laptop: { name: "laptop", width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
  desktop: { name: "desktop", width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false },
}

export const DEFAULT_VIEWPORTS = ["mobile", "tablet", "desktop"] as const

export function isDeviceName(value: string): value is keyof typeof DEVICES {
  return Object.hasOwn(DEVICES, value)
}

/** Names a user is allowed to type into `viewports: [...]`. */
export const DEVICE_NAMES = Object.keys(DEVICES)
