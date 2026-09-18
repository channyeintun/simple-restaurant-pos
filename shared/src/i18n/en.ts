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

  backoffice: {
    sections: {
      products: 'Products',
      categories: 'Categories',
      tables: 'Tables',
      staff: 'Staff',
      devices: 'Devices',
      today: 'Today',
    },
    add: 'Add',
    edit: 'Edit',
    save: 'Save',
    saving: 'Saving…',
    // "Retire", not "Delete", and the word is doing work: nothing here is ever
    // deleted, because last month's checks point at these rows and have to keep
    // meaning what they meant.
    retire: 'Retire',
    restore: 'Bring back',
    retired: 'Retired',
    showRetired: 'Show retired',
    empty: 'Nothing here yet',
    retireHeadline: 'Retire this?',
    retireBody: (name: string) =>
      `${name} stops appearing on the tablets. Everything already ordered or paid for is untouched, and you can bring it back whenever you like.`,
    fields: {
      name: 'Name',
      order: 'Order',
      price: 'Price',
      category: 'Category',
      role: 'Role',
    },
    // The sort field is a number somebody types, because a touch screen has no
    // good drag-to-reorder and inventing a gesture nobody will guess is worse
    // than a field with a hint under it.
    orderHint: 'Lower numbers come first',
    priceHint: (symbol: string) => `Whole ${symbol} — no decimals`,
    priceInvalid: 'That is not an amount',
    categoryRequired: 'Pick a category first',
  },

  staffAdmin: {
    setPin: 'Set PIN',
    changePin: 'Change PIN',
    pinSet: 'PIN set',
    noPin: 'No PIN — cannot sign in',
    pinHint: 'Four digits. This is how they sign in on a tablet.',
    pinHeadline: (staffName: string) => `PIN for ${staffName}`,
    lastManager: 'Somebody has to be able to manage this restaurant. Make another manager first.',
  },

  devices: {
    claimedOn: (when: string) => `Set up ${when}`,
    waiting: 'Not set up yet',
    linkPending: 'Link issued — nobody has opened it',
    newLink: 'New link',
    linkHeadline: 'Open this on the tablet',
    linkBody:
      'It works once and expires in 7 days. Issuing another link for this tablet replaces it.',
    copy: 'Copy link',
    copied: 'Copied',
    signOut: 'Sign out',
    signOutHeadline: 'Sign this tablet out?',
    signOutBody: (name: string) =>
      `${name} stops working straight away, mid-order if it is in use. It needs a new link to come back.`,
    thisTablet: 'This tablet',
  },

  today: {
    takings: "Today's takings",
    since: (time: string) => `Since ${time}`,
    cash: 'Cash',
    card: 'Card',
    other: 'Other',
    checks: (count: number) => (count === 1 ? '1 check' : `${count} checks`),
  },

  errors: {
    offline: 'No connection — check the restaurant Wi-Fi',
    generic: 'Something went wrong on our side',
    deviceNotClaimed: 'This tablet has not been set up yet',
    signInFirst: 'Enter your PIN first',
    notAllowed: 'Your role does not cover that',
  },
};
