/**
 * English catalogue — the source of truth for the shape of every other locale.
 *
 * Adding a key here without adding it to `my.ts` is a build error, which is the
 * whole point. Entries that take values are functions so the compiler checks
 * the arguments too.
 *
 * A key is added when a screen needs it and not before. Writing strings for a
 * screen nobody has designed is how a catalogue fills up with keys that no
 * longer match what is on the button — and every one of them has to be
 * translated and kept in step in the meantime.
 *
 * What is *not* here is the five words a kitchen ticket carries. They live in
 * `agent/src/index.ts`; the note at the top of `./index.ts` says why.
 */
export const en = {
  app: {
    name: 'Restaurant POS',
    loading: 'Just a moment…',
    retry: 'Try again',
    cancel: 'Cancel',
    close: 'Close',
    somethingWrong: 'Something went wrong',
    /*
     * The shell's two PWA lines.
     *
     * "Add to home screen" rather than "Install", because that is what the
     * gesture is called on every tablet these run on and what the browser's own
     * prompt will say next.
     */
    install: 'Add to home screen',
    // "Ready", not "available": the new build is already downloaded, and the
    // only thing between it and this tablet is a reload — which is something to
    // do between tables rather than something to be nagged about.
    updateReady: 'A new version is ready',
    reload: 'Reload',
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

  /**
   * How long a round has taken, and what to call that.
   *
   * Its own block rather than living under `waiter`, because the cashier's
   * board reads the same words about the same rounds — and two blocks would be
   * two places for "Late" to end up worded differently on two screens that a
   * manager looks at side by side.
   */
  timing: {
    /** The button a waiter taps, and the badge it leaves behind. */
    delivered: 'Delivered',
    due: 'Due now',
    late: 'Late',
    minutes: (count: number) => `${count} min`,
    overdueBy: (count: number) => `${count} min over`,
    /** What the waiter reads out to the customer. */
    readyIn: (count: number) => `about ${count} min`,
    readyNow: 'any moment now',
    took: (count: number) => `took ${count} min`,
    nothingOut: 'Nothing waiting',
  },

  waiter: {
    tables: 'Tables',
    free: 'Free',
    takeaway: 'Takeaway',
    newTakeaway: 'New takeaway',
    pickTable: 'Pick a table to start an order',
    rounds: (count: number) => (count === 1 ? '1 round' : `${count} rounds`),
    unsent: 'Unsent',
    order: 'Order',
    orderEmpty: 'Tap a dish to start the order',
    noProducts: 'Nothing on the menu yet.',
    // No "are you sure" on send — the brief is explicit — so the button says
    // exactly what it does and says it once.
    send: 'Send to kitchen',
    sending: 'Sending…',
    total: 'Total',
    note: 'Note',
    noteHint: 'Anything the kitchen needs to know',
    clear: 'Clear',
    clearHeadline: 'Clear this order?',
    clearBody:
      'Everything not yet sent to the kitchen is removed. Anything already sent stays on the bill.',
    round: (seq: number) => `Round ${seq}`,
    sentAt: (time: string) => `sent ${time}`,
    voided: 'Voided',
    void: 'Void',
    voidHeadline: 'Void this line?',
    voidBody: (name: string) =>
      `${name} comes off the bill and the kitchen is sent a void slip. This cannot be undone.`,
    // The banner after a send whose reply never came back. It says "could not
    // confirm" rather than "failed", because the round may well have landed and
    // telling a waiter it failed is how a table gets its food twice.
    unconfirmed: "Could not confirm the kitchen got this order",
    unconfirmedBody: 'Try again — if it did get through, this will not order it twice.',
    discard: 'Discard',
    discardHeadline: 'Discard this order?',
    discardBody:
      'The kitchen may already have it. Check with them before you send it again.',
  },

  cashier: {
    openChecks: 'Open checks',
    none: 'Nothing open',
    takePayment: 'Take payment',
    paymentHeadline: (name: string) => `Payment for ${name}`,
    paying: 'Taking payment…',
    paid: 'Paid',
    live: 'Live',
    reconnecting: 'Reconnecting…',
    polling: 'Checking every few seconds',
    // The one banner in this app somebody has to walk across the room about.
    printFailed: (count: number) =>
      count === 1
        ? 'A kitchen ticket did not print'
        : `${count} kitchen tickets did not print`,
    printFailedLine: (table: string, error: string) => `${table} — ${error}`,
    printFailedNoReason: 'the printer did not say why',
    retryPrint: 'Print again',
    soundOn: 'Sound on',
    soundOff: 'Sound off',
    // Amber, not red, and the wording carries the difference. Red means the
    // kitchen definitely never got it; this means nothing has even tried to
    // print, which is a different thing to go and check.
    queueStuck: (minutes: number) =>
      `Nothing has printed for ${minutes} minutes — check the kitchen printer`,
    queueStuckBody: 'Orders are queued and will print by themselves once it is back.',
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
    /** The chip that clears the category filter. */
    all: 'All',
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
      prep: 'Prep minutes',
    },
    // The number the whole timing feature is built on, so the hint says what it
    // is *for* rather than what it is: a manager who reads "how long the
    // kitchen takes" types a better number than one who reads "prep time".
    prepHint: 'Roughly how long the kitchen takes. It is what a waiter quotes.',
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
