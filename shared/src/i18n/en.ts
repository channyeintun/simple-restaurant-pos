/**
 * English catalogue — the source of truth for the shape of every other locale.
 *
 * Adding a key here without adding it to `my.ts` is a build error, which is the
 * whole point. Entries that take values are functions so the compiler checks
 * the arguments too.
 *
 * This is milestone 0's catalogue and it is deliberately small: the claim
 * screen, the PIN screen, and the states those two can fail into. It grows one
 * milestone at a time, alongside the screens that need it. Writing the waiter's
 * strings now would mean translating a screen nobody has designed, which is how
 * a catalogue fills up with keys that no longer match what is on the button.
 */
export const en = {
  app: {
    name: 'Restaurant POS',
    loading: 'Just a moment…',
    retry: 'Try again',
    cancel: 'Cancel',
    close: 'Close',
    somethingWrong: 'Something went wrong',
  },

  claim: {
    tagline: 'Staff device',
    settingUp: 'Setting up this tablet…',
    noLink: 'This page needs a device link.',
    failed: 'Could not set up this tablet',
    askAdmin:
      'Ask the manager for a new device link. Each link works once, and only on the tablet it is opened on.',
    ready: (deviceName: string) => `This tablet is set up as ${deviceName}.`,
  },

  pin: {
    title: 'Who is on?',
    // The name is in the prompt rather than only on the button above it,
    // because by the time the keypad is up the button is behind a thumb.
    enterPin: (staffName: string) => `Enter ${staffName}'s PIN`,
    wrongPin: 'That PIN did not match',
    noStaff: 'Nobody has been set up yet. Add staff in the backoffice.',
    signedInAs: (staffName: string) => `Signed in as ${staffName}`,
    signOut: 'Sign out',
    switchStaff: 'Switch',
  },

  roles: {
    waiter: 'Waiter',
    cashier: 'Cashier',
    admin: 'Manager',
  },

  errors: {
    offline: 'No connection — check the restaurant Wi-Fi',
    generic: 'Something went wrong on our side',
    deviceNotClaimed: 'This tablet has not been set up yet',
    signInFirst: 'Enter your PIN first',
    notAllowed: 'Your role does not cover that',
  },
};
