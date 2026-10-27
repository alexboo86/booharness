import { FAMILY_LOGOS } from '../generated/family-logos'

const families = Object.keys(FAMILY_LOGOS)

/** A mark is a registry-owned key, never an id made from daemon text. */
export function familyLabel(family: string, name = family, prefix = '') {
  return { name, prefix, mark: families.find(key => key === family) || '' }
}
