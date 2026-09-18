import type { Messages } from './index.js';

/**
 * Burmese (မြန်မာ).
 *
 * Two conventions worth stating, because they are easy to "fix" wrongly later:
 *
 *  - **Unicode, not Zawgyi.** Every string here is standard Myanmar Unicode.
 *    Pasting Zawgyi-encoded text in would render as garbage on any modern
 *    phone, and the two encodings are visually indistinguishable in an editor.
 *  - **Arabic numerals.** Times, counts and money stay as `19:30`, `12.500 Ks`
 *    rather than Myanmar digits. That is what Myanmar shops overwhelmingly do
 *    on a price list or a receipt, and a till is not the place to be different.
 *
 * Typed as `Messages`, so a key missing here — or one whose interpolation
 * arguments have drifted from English — fails the build.
 */
export const my: Messages = {
  app: {
    name: 'စားသောက်ဆိုင် POS',
    loading: 'ခဏစောင့်ပါ…',
    retry: 'ထပ်စမ်းကြည့်မည်',
    cancel: 'မလုပ်တော့ပါ',
    close: 'ပိတ်မည်',
    somethingWrong: 'တစ်ခုခု မှားယွင်းသွားပါသည်',
  },

  claim: {
    tagline: 'ဝန်ထမ်းသုံး စက်',
    settingUp: 'ဤတက်ဘလက်ကို ပြင်ဆင်နေသည်…',
    noLink: 'ဤစာမျက်နှာအတွက် စက်လင့်ခ် လိုအပ်ပါသည်။',
    failed: 'ဤတက်ဘလက်ကို ပြင်ဆင်၍ မရပါ',
    askAdmin:
      'မန်နေဂျာထံမှ စက်လင့်ခ် အသစ် တောင်းပါ။ လင့်ခ်တစ်ခုလျှင် တစ်ကြိမ်သာ အလုပ်လုပ်ပြီး ဖွင့်လိုက်သည့် တက်ဘလက်ပေါ်တွင်သာ သက်ရောက်ပါသည်။',
    ready: (deviceName) => `ဤတက်ဘလက်ကို ${deviceName} အဖြစ် ပြင်ဆင်ပြီးပါပြီ။`,
  },

  pin: {
    title: 'ဘယ်သူ တာဝန်ကျပါသလဲ?',
    enterPin: (staffName) => `${staffName} ၏ ပင်နံပါတ် ရိုက်ထည့်ပါ`,
    wrongPin: 'ပင်နံပါတ် မကိုက်ညီပါ',
    noStaff: 'ဝန်ထမ်း မထည့်ရသေးပါ။ ရုံးခန်းစာမျက်နှာတွင် ထည့်ပါ။',
    signedInAs: (staffName) => `${staffName} အဖြစ် ဝင်ရောက်ထားသည်`,
    signOut: 'ထွက်မည်',
    switchStaff: 'ပြောင်းမည်',
  },

  roles: {
    waiter: 'စားပွဲထိုး',
    cashier: 'ငွေကိုင်',
    admin: 'မန်နေဂျာ',
  },

  backoffice: {
    sections: {
      products: 'အစားအစာများ',
      categories: 'အမျိုးအစားများ',
      tables: 'စားပွဲများ',
      staff: 'ဝန်ထမ်းများ',
      devices: 'စက်များ',
      today: 'ယနေ့',
    },
    add: 'ထည့်မည်',
    edit: 'ပြင်မည်',
    save: 'သိမ်းမည်',
    saving: 'သိမ်းနေသည်…',
    retire: 'ဖယ်ထားမည်',
    restore: 'ပြန်ထည့်မည်',
    retired: 'ဖယ်ထားသည်',
    showRetired: 'ဖယ်ထားသည်များ ပြမည်',
    empty: 'ဘာမှ မရှိသေးပါ',
    retireHeadline: 'ဖယ်ထားမလား?',
    retireBody: (name) =>
      `${name} ကို တက်ဘလက်များတွင် ပြတော့မည် မဟုတ်ပါ။ မှာပြီးသား၊ ငွေရှင်းပြီးသားများ မပြောင်းလဲပါ၊ အချိန်မရွေး ပြန်ထည့်နိုင်ပါသည်။`,
    fields: {
      name: 'အမည်',
      order: 'အစဉ်',
      price: 'ဈေးနှုန်း',
      category: 'အမျိုးအစား',
      role: 'တာဝန်',
    },
    orderHint: 'ဂဏန်း နည်းသည်က ရှေ့တွင် ရှိမည်',
    priceHint: (symbol) => `${symbol} အပြည့် — ဒဿမ မပါ`,
    priceInvalid: 'ဤသည် ငွေပမာဏ မဟုတ်ပါ',
    categoryRequired: 'အမျိုးအစား အရင်ရွေးပါ',
  },

  staffAdmin: {
    setPin: 'ပင်နံပါတ် သတ်မှတ်မည်',
    changePin: 'ပင်နံပါတ် ပြောင်းမည်',
    pinSet: 'ပင်နံပါတ် ရှိသည်',
    noPin: 'ပင်နံပါတ် မရှိ — ဝင်၍ မရပါ',
    pinHint: 'ဂဏန်း ၄ လုံး။ တက်ဘလက်တွင် ဤဂဏန်းဖြင့် ဝင်ရမည်။',
    pinHeadline: (staffName) => `${staffName} ၏ ပင်နံပါတ်`,
    lastManager: 'ဆိုင်ကို စီမံနိုင်သူ တစ်ဦး ရှိရပါမည်။ အခြား မန်နေဂျာ တစ်ဦး အရင်ခန့်ပါ။',
  },

  devices: {
    claimedOn: (when) => `${when} တွင် ပြင်ဆင်ပြီး`,
    waiting: 'မပြင်ဆင်ရသေးပါ',
    linkPending: 'လင့်ခ် ထုတ်ပြီး — မည်သူမျှ မဖွင့်ရသေးပါ',
    newLink: 'လင့်ခ် အသစ်',
    linkHeadline: 'ဤလင့်ခ်ကို တက်ဘလက်ပေါ်တွင် ဖွင့်ပါ',
    linkBody:
      'တစ်ကြိမ်သာ အလုပ်လုပ်ပြီး ၇ ရက်အတွင်း သက်တမ်းကုန်ပါသည်။ ဤစက်အတွက် လင့်ခ်အသစ် ထုတ်လျှင် ဤလင့်ခ် ပျက်သွားပါမည်။',
    copy: 'လင့်ခ် ကူးမည်',
    copied: 'ကူးပြီးပါပြီ',
    signOut: 'ထွက်စေမည်',
    signOutHeadline: 'ဤတက်ဘလက်ကို ထွက်စေမလား?',
    signOutBody: (name) =>
      `${name} သည် ချက်ချင်း ရပ်သွားပါမည်၊ အော်ဒါ ယူနေဆဲဖြစ်လျှင်လည်း ရပ်ပါမည်။ ပြန်သုံးရန် လင့်ခ်အသစ် လိုအပ်ပါသည်။`,
    thisTablet: 'ဤတက်ဘလက်',
  },

  today: {
    takings: 'ယနေ့ ဝင်ငွေ',
    since: (time) => `${time} မှစ၍`,
    cash: 'ငွေသား',
    card: 'ကတ်',
    other: 'အခြား',
    // Burmese has no plural form, so the count stands on its own and the
    // singular/plural split English needs simply does not arise here.
    checks: (count) => `စာရင်း ${count} ခု`,
  },

  errors: {
    offline: 'ချိတ်ဆက်မှု မရှိပါ — ဆိုင်၏ Wi-Fi ကို စစ်ပါ',
    generic: 'ဆာဗာဘက်တွင် အမှားတစ်ခု ဖြစ်သွားပါသည်',
    deviceNotClaimed: 'ဤတက်ဘလက်ကို မပြင်ဆင်ရသေးပါ',
    signInFirst: 'အရင် ပင်နံပါတ် ရိုက်ထည့်ပါ',
    notAllowed: 'သင့်တာဝန်ဖြင့် ဤအရာကို မလုပ်နိုင်ပါ',
  },
};
