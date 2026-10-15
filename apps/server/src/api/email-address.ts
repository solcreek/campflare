// Email addresses as Campflare keeps and compares them: trimmed, lower case.

/** An address in the form it is stored and looked up by. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase()

const SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Whether text (already normalized) looks like an address: something@domain.tld, no spaces. */
export const isEmail = (email: string) => SHAPE.test(email)
