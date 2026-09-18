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

  errors: {
    offline: 'ချိတ်ဆက်မှု မရှိပါ — ဆိုင်၏ Wi-Fi ကို စစ်ပါ',
    generic: 'ဆာဗာဘက်တွင် အမှားတစ်ခု ဖြစ်သွားပါသည်',
    deviceNotClaimed: 'ဤတက်ဘလက်ကို မပြင်ဆင်ရသေးပါ',
    signInFirst: 'အရင် ပင်နံပါတ် ရိုက်ထည့်ပါ',
    notAllowed: 'သင့်တာဝန်ဖြင့် ဤအရာကို မလုပ်နိုင်ပါ',
  },
};
